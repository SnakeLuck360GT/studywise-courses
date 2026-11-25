import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { z } from 'zod'
import { TASK_INFO, type TaskId } from '@shared/tasks'
import type { AiProvider, ModelChoice, OutputMode, Preset } from '@shared/types'
import { renderTemplate } from '@shared/template'
import { getPreset, defaultPreset } from './presets'
import { resolveModel } from './models'
import { schemaFor, jsonSchemaFor, formatInstructions, extractJson } from './schemas'
import { runClaude, CliError, emitRateLimit, type CliResult, type AiLiveEvent } from './cli'
import { runOllama } from './ollama'
import { Semaphore } from './queue'
import { mockResponse, mockStream, mockLive } from './mock'
import { logAiCall, getDeck, getSetting, courseNoteForDeck } from '../db/repo'
import { isOffline, OfflineError } from '../offline'

export { CliError }
export type { AiLiveEvent }

export const aiQueue = new Semaphore(3)

export function isMock(): boolean {
  return process.env.AI_MOCK === '1'
}

export interface RunAIOptions {
  task: TaskId
  presetId?: string
  vars?: Record<string, unknown>
  files?: string[]
  deckId?: string | null
  onDelta?: (text: string) => void
  /** Thinking, file reads and partial output while Claude works. */
  onEvent?: (e: AiLiveEvent) => void
  signal?: AbortSignal
  /** Resume an earlier session (auto-continue). */
  resume?: string
  /** Prompt to send instead of the rendered template (e.g. "continue"). */
  rawPrompt?: string
  workDir?: string
  persistSession?: boolean
  timeoutMs?: number
  model?: ModelChoice
  /** Unsaved preset text, for Settings > Prompts test runs. */
  presetOverride?: Pick<Preset, 'system' | 'user_template' | 'output_mode'>
  /** Force an output mode (custom actions making cards). */
  outputMode?: OutputMode
  /** Skip the concurrency queue (already inside a job slot). */
  noQueue?: boolean
}

export interface RunAIResult<T> {
  data: T
  text: string
  sessionId: string | null
  stopReason: string | null
  truncated: boolean
  preset: Preset
  model: ModelChoice
  workDir: string | null
  prompt: string
}

export interface RenderedPrompt {
  system: string
  prompt: string
  mode: OutputMode
  schema: Record<string, unknown> | null
  preset: Preset
  model: ModelChoice
  provider: AiProvider
}

/** Build the exact prompt that will be sent. Used by runAI and the live preview. */
export function renderPrompt(opts: RunAIOptions): RenderedPrompt {
  const base = opts.presetId ? getPreset(opts.presetId) : defaultPreset(opts.task)
  const preset: Preset = opts.presetOverride ? { ...base, ...opts.presetOverride } : base
  const mode: OutputMode = opts.outputMode ?? preset.output_mode
  const vars = { ...(opts.vars ?? {}) }
  // The level picked in onboarding fills {{level}} when a caller doesn't set one.
  if (!vars.level) vars.level = getSetting<string>('profile.level', '')
  if (opts.deckId && vars.deck_name === undefined) {
    try {
      vars.deck_name = getDeck(opts.deckId).name
    } catch {
      /* ignore */
    }
  }
  let prompt = renderTemplate(preset.user_template, vars).replace(/\n{3,}/g, '\n\n').trim()

  // Things the template doesn't mention are appended so custom prompts can't lose them.
  const tpl = preset.user_template
  if (vars.source_text && !/\{\{\s*source_text\s*\}\}/.test(tpl)) prompt += `\n\n<source>\n${String(vars.source_text)}\n</source>`
  const model = resolveModel(opts.task, opts.deckId, opts.model)
  const provider: AiProvider = model.provider ?? 'claude'
  if (opts.files?.length && provider === 'ollama') {
    const names = opts.files.map((f) => basename(f)).join(', ')
    prompt += `

The source file${opts.files.length > 1 ? 's' : ''} (${names}) ${opts.files.length > 1 ? 'are' : 'is'} included at the end of this message inside <file> tags. PDF text has [page N] markers. Use all of it, including tables and figure captions.`
  } else if (opts.files?.length) {
    const names = opts.files.map((f) => basename(f)).join(', ')
    prompt += `\n\nThe source file${opts.files.length > 1 ? 's are' : ' is'} in your current working directory: ${names}. Read ${opts.files.length > 1 ? 'them' : 'it'} with the Read tool first. Look at every page, including images, screenshots, tables and diagrams, not just the text.`
  }
  if (vars.part_info && !/\{\{\s*part_info\s*\}\}/.test(tpl)) prompt += `\n\n${String(vars.part_info)}`
  // Instructions typed for this run (planning, level of detail, rewrites) mustn't vanish from an edited prompt.
  if (vars.instructions && !/\{\{\s*instructions\s*\}\}/.test(tpl)) prompt += `\n\n${String(vars.instructions)}`
  if (opts.deckId) {
    try {
      const extra = getDeck(opts.deckId).extra_instructions.trim()
      if (extra) prompt += `\n\nExtra instructions for this deck:\n${extra}`
    } catch {
      /* ignore */
    }
    // Every call for a course (planning, topics, marking, trimming, explaining its cards) carries its note.
    const note = courseNoteForDeck(opts.deckId)
    if (note) prompt += `\n\nMy note about this course (always keep it in mind and tailor everything to it):\n${note}`
  }
  // The JSON format is the same on every call, so it goes with the fixed
  // instructions in the system prompt, which Claude caches across calls.
  let schema: Record<string, unknown> | null = null
  let system = preset.system
  if (mode === 'json') {
    schema = jsonSchemaFor(opts.task)
    system += formatInstructions(opts.task)
  }
  return { system, prompt, mode, schema, preset, model, provider }
}

function timeoutFor(task: TaskId): number {
  const base = getSetting<number>('ai.timeoutSec', 120) * 1000
  return TASK_INFO[task].long ? Math.max(base, getSetting<number>('ai.longTimeoutSec', 900) * 1000) : base
}

export async function runAI<T = unknown>(opts: RunAIOptions): Promise<RunAIResult<T>> {
  // One gate for every AI call: offline mode means none at all.
  if (isOffline()) throw new OfflineError()
  const r = renderPrompt(opts)
  const sendPrompt = opts.rawPrompt ?? r.prompt
  const timeoutMs = opts.timeoutMs ?? timeoutFor(opts.task)

  /** noFiles: a follow-up that doesn't need the source files again (fixing a reply's format). */
  const attempt = async (prompt: string, resume?: string, noFiles = false): Promise<CliResult> => {
    const started = Date.now()
    try {
      let res: CliResult
      if (isMock()) {
        const m = mockResponse(opts.task, r.mode, opts.vars ?? {}, prompt)
        emitRateLimit({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 7200, status: 'allowed' }, seven_day: { utilization: 0.18, resetsAt: Math.floor(Date.now() / 1000) + 4 * 86400, status: 'allowed' } } })
        if (opts.onEvent) await mockLive(m.text, noFiles ? [] : (opts.files ?? []), opts.onEvent, opts.signal)
        await mockStream(m.text, opts.onDelta, opts.signal)
        res = {
          text: m.text,
          structured: m.structured,
          sessionId: resume ?? `mock-${randomUUID()}`,
          stopReason: 'end_turn',
          isError: false,
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: Math.ceil(m.text.length / 4),
          costUsd: 0,
          workDir: opts.workDir ?? '',
          raw: m.text
        }
      } else if (r.provider === 'ollama') {
        res = await runOllama({
          prompt,
          system: r.system,
          model: r.model.model,
          effort: r.model.effort,
          jsonSchema: r.mode === 'json' ? r.schema ?? undefined : undefined,
          onDelta: opts.onDelta,
          onEvent: opts.onEvent,
          files: resume || noFiles ? undefined : opts.files,
          resume,
          persistSession: opts.persistSession,
          timeoutMs,
          signal: opts.signal
        })
      } else {
        res = await runClaude({
          prompt,
          system: r.system,
          model: r.model.model,
          effort: r.model.effort,
          jsonSchema: r.mode === 'json' && !resume ? r.schema ?? undefined : undefined,
          stream: !!(opts.onDelta || opts.onEvent),
          onDelta: opts.onDelta,
          onEvent: opts.onEvent,
          files: resume || noFiles ? undefined : opts.files,
          resume,
          persistSession: opts.persistSession,
          workDir: opts.workDir,
          timeoutMs,
          signal: opts.signal
        })
      }
      logAiCall({
        task: opts.task,
        preset_id: r.preset.id,
        preset_name: r.preset.name,
        preset_version: r.preset.version,
        model: modelLabel(r),
        duration_ms: Date.now() - started,
        input_tokens: res.inputTokens,
        output_tokens: res.outputTokens,
        cost_usd: res.costUsd,
        ok: true,
        error: null
      })
      return res
    } catch (e) {
      logAiCall({
        task: opts.task,
        preset_id: r.preset.id,
        preset_name: r.preset.name,
        preset_version: r.preset.version,
        model: modelLabel(r),
        duration_ms: Date.now() - started,
        input_tokens: null,
        output_tokens: null,
        cost_usd: null,
        ok: false,
        error: (e as Error).message.slice(0, 500)
      })
      throw e
    }
  }

  const withRetry = async (prompt: string, resume?: string, noFiles = false): Promise<CliResult> => {
    try {
      return await attempt(prompt, resume, noFiles)
    } catch (e) {
      if (e instanceof CliError && e.kind === 'transient' && !opts.signal?.aborted) {
        await new Promise((res) => setTimeout(res, 1500))
        return attempt(prompt, resume, noFiles)
      }
      throw e
    }
  }

  const exec = async (): Promise<RunAIResult<T>> => {
    let res = await withRetry(sendPrompt, opts.resume)
    let data: unknown = res.text
    if (r.mode === 'json') {
      const schema = schemaFor(opts.task) as z.ZodType<T>
      const parse = (cr: CliResult) => {
        const candidate = cr.structured ?? extractJson(cr.text)
        return schema.safeParse(candidate)
      }
      let parsed: ReturnType<typeof parse>
      try {
        parsed = parse(res)
      } catch (err) {
        parsed = { success: false, error: err } as ReturnType<typeof parse>
      }
      if (!parsed.success) {
        const msg = parsed.error instanceof Error ? parsed.error.message : String(parsed.error)
        const tryParse = (cr: CliResult) => {
          try {
            return parse(cr)
          } catch (err) {
            return { success: false, error: err } as ReturnType<typeof parse>
          }
        }
        // First, cheaply: send back just the reply and the problem, without the
        // sources, so nothing is read or written twice. A reply with nothing to
        // fix (empty or cut off early) goes straight to the full retry.
        const previous = (res.structured != null ? JSON.stringify(res.structured) : res.text).trim()
        if (previous.length > 200 && /[[{]/.test(previous)) {
          res = await withRetry(repairPrompt(previous, msg), undefined, true)
          parsed = tryParse(res)
        }
        // Then the old way: the whole request again, with the problem noted.
        if (!parsed.success) {
          res = await withRetry(`${r.prompt}\n\nYour previous reply could not be used because it did not match the schema:\n${msg.slice(0, 1500)}\nReturn corrected JSON only.`)
          try {
            parsed = parse(res)
          } catch (err) {
            throw new Error(`${who(r)}'s reply was not valid JSON: ${(err as Error).message}`)
          }
          if (!parsed.success) throw new Error(`${who(r)}'s reply did not match the expected format: ${parsed.error.message.slice(0, 400)}`)
        }
      }
      data = parsed.data
    }
    return {
      data: data as T,
      text: res.text,
      sessionId: res.sessionId,
      stopReason: res.stopReason,
      truncated: res.stopReason === 'max_tokens',
      preset: r.preset,
      model: r.model,
      workDir: res.workDir || null,
      prompt: sendPrompt
    }
  }

  if (opts.noQueue) return exec()
  return aiQueue.run(exec, opts.signal)
}

/** Ask for a reply's own content back as valid JSON, without the sources. */
export function repairPrompt(previous: string, problem: string): string {
  return `This reply was meant to match the JSON format in your instructions, but it doesn't:

<reply>
${previous.slice(0, 200_000)}
</reply>

The problem: ${problem.slice(0, 1500)}

Return the same content as corrected JSON only. Keep everything that's already there and only fix what the problem describes.`
}

function modelLabel(r: RenderedPrompt): string {
  const name = (r.provider === 'ollama' ? `ollama:${r.model.model}` : r.model.model) || '(no model)'
  return name + (r.model.effort ? ` (${r.model.effort})` : '')
}

const who = (r: RenderedPrompt) => (r.provider === 'ollama' ? 'The model' : 'Claude')

export function friendlyError(e: unknown): string {
  if (e instanceof CliError) {
    if (e.kind === 'not_installed') return 'Claude Code is not installed. Install it with `npm install -g @anthropic-ai/claude-code`, then press Re-check in Settings.'
    if (e.kind === 'not_logged_in') return 'Claude Code is not logged in. Open Terminal, run `claude` and sign in, then try again.'
    if (e.kind === 'timeout') return e.message
    if (e.kind === 'cancelled') return 'Cancelled'
  }
  return (e as Error)?.message ?? String(e)
}
