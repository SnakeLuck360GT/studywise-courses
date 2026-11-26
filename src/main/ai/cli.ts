import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { childEnv, getClaudeStatus, getResolvedPath, spawnTarget } from './claudePath'

export interface CliRequest {
  prompt: string
  system?: string
  model: string
  effort?: string | null
  jsonSchema?: object
  stream?: boolean
  onDelta?: (text: string) => void
  /** Live view of what Claude is doing: thinking, tool calls, and partial output (text or structured JSON). */
  onEvent?: (e: AiLiveEvent) => void
  /** Files copied into the temp cwd; only the read-only Read tool is enabled when present. */
  files?: string[]
  resume?: string
  /** Keep the session on disk so it can be resumed (needed for auto-continue). */
  persistSession?: boolean
  /** Reuse a working dir (resumed sessions must run from the same cwd). */
  workDir?: string
  maxTurns?: number
  timeoutMs: number
  signal?: AbortSignal
}

export interface CliResult {
  text: string
  structured: unknown
  sessionId: string | null
  stopReason: string | null
  isError: boolean
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  workDir: string
  raw: string
}

export type AiLiveEvent =
  /** Claude Code reports a running estimate of thinking tokens; the thinking text itself isn't shown to other programs. */
  | { kind: 'thinking'; tokens?: number; text?: string }
  | { kind: 'tool'; name: string }
  | { kind: 'read'; file: string; pages?: string }
  /** Output as it's written: reply text, or the structured-output tool's JSON. */
  | { kind: 'output'; text: string }

type RateLimitInfo = Record<string, unknown>
const rateListeners = new Set<(info: RateLimitInfo) => void>()
export function onRateLimit(fn: (info: RateLimitInfo) => void): () => void {
  rateListeners.add(fn)
  return () => rateListeners.delete(fn)
}
export function emitRateLimit(info: RateLimitInfo): void {
  rateListeners.forEach((l) => l(info))
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly kind: 'not_installed' | 'not_logged_in' | 'timeout' | 'cancelled' | 'transient' | 'failed',
    public readonly stderr = ''
  ) {
    super(message)
  }
}

export function makeWorkDir(): string {
  return mkdtempSync(join(tmpdir(), 'studywise-ai-'))
}

/**
 * Removes a call's temporary folder. On Windows a folder can't be deleted
 * while a process is still running in it, which happens when a call is
 * cancelled or times out (claude is still stopping): then it's removed once
 * claude has exited, quietly. A temporary folder left behind never matters
 * enough to fail anything.
 */
export function removeWorkDir(dir: string, child?: { exitCode: number | null; signalCode: NodeJS.Signals | null; once(ev: 'exit', fn: () => void): unknown }): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    const later = () => void rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {})
    if (child && child.exitCode === null && child.signalCode === null) child.once('exit', later)
    else setTimeout(later, 500)
  }
}

/** Build the argument list. Exported for tests. */
export function buildArgs(req: CliRequest): string[] {
  // Always stream-json: it carries rate_limit_event lines (plan usage) as well
  // as the final result envelope.
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (req.stream) args.push('--include-partial-messages')
  args.push('--model', req.model)
  if (req.effort) args.push('--effort', req.effort)
  if (req.system) args.push('--system-prompt', req.system)
  if (req.files && req.files.length > 0) {
    args.push('--tools', 'Read', '--allowedTools', 'Read', '--permission-mode', 'dontAsk')
  } else {
    args.push('--tools', '')
  }
  if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema))
  const turns = req.maxTurns ?? (req.files?.length ? 12 + req.files.length * 4 : req.jsonSchema ? 4 : 2)
  args.push('--max-turns', String(turns))
  // No user/project settings, MCP servers, slash commands or skills.
  args.push('--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands')
  if (req.resume) args.push('--resume', req.resume)
  if (!req.persistSession && !req.resume) args.push('--no-session-persistence')
  return args
}

const TRANSIENT = /(overloaded|rate.?limit|529|503|502|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|internal server error)/i

export function runClaude(req: CliRequest): Promise<CliResult> {
  const status = getClaudeStatus()
  if (!status.path) return Promise.reject(new CliError(status.error ?? 'Claude Code not found', 'not_installed'))
  const workDir = req.workDir ?? makeWorkDir()
  const ownsDir = !req.workDir && !req.persistSession
  for (const f of req.files ?? []) copyFileSync(f, join(workDir, basename(f)))
  const args = buildArgs(req)

  return new Promise<CliResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      const target = spawnTarget(status.path!, getResolvedPath())
      child = spawn(target.cmd, [...target.prefix, ...args], { cwd: workDir, env: childEnv(getResolvedPath()), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true })
    } catch (e) {
      reject(new CliError(`Could not start claude: ${(e as Error).message}`, 'not_installed'))
      return
    }
    let stdout = ''
    let stderr = ''
    let lineBuf = ''
    let finalEnvelope: Record<string, unknown> | null = null
    let streamed = ''
    let currentTool = ''
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onAbort)
      if (ownsDir) removeWorkDir(workDir, child)
      fn()
    }
    const kill = () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 2000)
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish(() => reject(new CliError(`Claude took longer than ${Math.round(req.timeoutMs / 1000)}s and was stopped`, 'timeout')))
    }, req.timeoutMs)
    const onAbort = () => {
      kill()
      finish(() => reject(new CliError('Cancelled', 'cancelled')))
    }
    if (req.signal?.aborted) return onAbort()
    req.signal?.addEventListener('abort', onAbort)

    const handleLine = (line: string) => {
      if (!line.trim()) return
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'stream_event') {
        const e = ev.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }; content_block?: { type?: string; name?: string } }
        if (ev.parent_tool_use_id != null) return
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
          streamed += e.delta.text
          req.onDelta?.(e.delta.text)
          req.onEvent?.({ kind: 'output', text: e.delta.text })
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'thinking_delta' && e.delta.thinking) {
          req.onEvent?.({ kind: 'thinking', text: e.delta.thinking })
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'thinking') {
          req.onEvent?.({ kind: 'thinking' })
        } else if (e?.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && e.delta.partial_json && currentTool !== 'Read') {
          req.onEvent?.({ kind: 'output', text: e.delta.partial_json })
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
          currentTool = e.content_block.name ?? ''
          req.onEvent?.({ kind: 'tool', name: currentTool })
        }
      } else if (ev.type === 'system' && ev.subtype === 'thinking_tokens' && typeof ev.estimated_tokens === 'number') {
        req.onEvent?.({ kind: 'thinking', tokens: ev.estimated_tokens })
      } else if (ev.type === 'assistant' && ev.parent_tool_use_id == null) {
        const content = ((ev.message as { content?: unknown[] })?.content ?? []) as { type?: string; name?: string; input?: { file_path?: string; pages?: string } }[]
        for (const c of content) if (c.type === 'tool_use' && c.name === 'Read' && c.input?.file_path) req.onEvent?.({ kind: 'read', file: basename(c.input.file_path), pages: c.input.pages })
      } else if (ev.type === 'result') {
        finalEnvelope = ev
      } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
        emitRateLimit(ev.rate_limit_info as RateLimitInfo)
      }
    }

    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      stdout += chunk
      lineBuf += chunk
      let i: number
      while ((i = lineBuf.indexOf('\n')) !== -1) {
        handleLine(lineBuf.slice(0, i))
        lineBuf = lineBuf.slice(i + 1)
      }
    })
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (c: string) => (stderr += c))
    child.on('error', (e) => finish(() => reject(new CliError(`claude failed to start: ${e.message}`, 'not_installed'))))
    child.on('close', (code) => {
      if (lineBuf) handleLine(lineBuf)
      const env: Record<string, unknown> | null = finalEnvelope
      if (!env) {
        const msg = (stderr || stdout).trim().slice(0, 800) || `claude exited with code ${code}`
        const kind = /not logged in|login|authenticat|\/login/i.test(msg) ? 'not_logged_in' : TRANSIENT.test(msg) ? 'transient' : 'failed'
        finish(() => reject(new CliError(msg, kind, stderr)))
        return
      }
      const usage = (env.usage ?? {}) as Record<string, number>
      const isError = !!env.is_error
      const resultText = typeof env.result === 'string' ? env.result : streamed
      if (isError) {
        const msg = String(env.result ?? env.subtype ?? 'Claude returned an error')
        const kind = /login|authenticat|credit|subscription/i.test(msg) ? 'not_logged_in' : TRANSIENT.test(msg) ? 'transient' : 'failed'
        // error_max_turns still carries useful text; let callers see it via the message.
        finish(() => reject(new CliError(msg, kind, stderr)))
        return
      }
      finish(() =>
        resolve({
          text: resultText,
          structured: env!.structured_output ?? null,
          sessionId: (env!.session_id as string) ?? null,
          stopReason: (env!.stop_reason as string) ?? null,
          isError,
          inputTokens: usage.input_tokens != null ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : null,
          outputTokens: usage.output_tokens ?? null,
          costUsd: typeof env!.total_cost_usd === 'number' ? (env!.total_cost_usd as number) : null,
          workDir,
          raw: stdout.slice(-20000)
        })
      )
    })
    child.stdin!.end(req.prompt)
  })
}
