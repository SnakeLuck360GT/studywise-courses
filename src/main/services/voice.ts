import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting, setSetting } from '../db/repo'
import { getSecret, setSecret } from '../secrets'
import { isOffline } from '../offline'
import { paths } from '../paths'
import { runAI } from '../ai'
import {
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_MODEL,
  DEFAULT_VOICE_PROMPT,
  VOICE_CHUNK,
  VOICE_MODELS,
  VOICE_SETTINGS,
  modelHasTags,
  onlyTagsAdded,
  type VoiceOption,
  type VoiceStatus
} from '@shared/voice'

// Voice mode: text goes to ElevenLabs' text-to-speech API with your own key,
// and the audio comes back to the page to play. With auto-tag on (and a model
// that understands audio tags), Claude first adds tags like [excited] or
// [pause], following your voice prompt, without changing a word. Audio is kept
// in the cache folder, so a card you hear again costs nothing.

const API = 'https://api.elevenlabs.io'
const KEY = 'secret.elevenlabs' as const

const key = (): string | null => getSecret(KEY) ?? process.env.ELEVENLABS_API_KEY?.trim() ?? null

export function voiceStatus(): VoiceStatus {
  const hasKey = !!key()
  const enabled = getSetting<boolean>(VOICE_SETTINGS.enabled, false) === true
  const model = getSetting<string>(VOICE_SETTINGS.model, DEFAULT_VOICE_MODEL)
  return {
    hasKey,
    enabled,
    autoplay: getSetting<boolean>(VOICE_SETTINGS.autoplay, true) !== false,
    voiceId: getSetting<string>(VOICE_SETTINGS.voiceId, '') || DEFAULT_VOICE_ID,
    model: VOICE_MODELS.some((m) => m.id === model) ? model : DEFAULT_VOICE_MODEL,
    autoTag: getSetting<boolean>(VOICE_SETTINGS.autoTag, true) !== false,
    prompt: getSetting<string>(VOICE_SETTINGS.prompt, '') || DEFAULT_VOICE_PROMPT,
    ready: hasKey && enabled
  }
}

export interface VoiceConfig {
  /** A string sets it, null removes it, undefined leaves it alone. */
  apiKey?: string | null
  enabled?: boolean
  autoplay?: boolean
  voiceId?: string
  model?: string
  autoTag?: boolean
  prompt?: string
}

export function setVoiceConfig(c: VoiceConfig): VoiceStatus {
  if (c.apiKey !== undefined) setSecret(KEY, c.apiKey)
  if (c.enabled !== undefined) setSetting(VOICE_SETTINGS.enabled, c.enabled)
  if (c.autoplay !== undefined) setSetting(VOICE_SETTINGS.autoplay, c.autoplay)
  if (c.voiceId !== undefined) {
    const id = c.voiceId.trim()
    if (id && !/^[\w-]{4,64}$/.test(id)) throw new Error('A voice ID is letters and numbers, like JBFqnCBsd6RMkjVDRZzb. Copy it from the voice in ElevenLabs.')
    setSetting(VOICE_SETTINGS.voiceId, id)
  }
  if (c.model !== undefined) {
    if (!VOICE_MODELS.some((m) => m.id === c.model)) throw new Error(`Unknown ElevenLabs model: ${c.model}`)
    setSetting(VOICE_SETTINGS.model, c.model)
  }
  if (c.autoTag !== undefined) setSetting(VOICE_SETTINGS.autoTag, c.autoTag)
  if (c.prompt !== undefined) setSetting(VOICE_SETTINGS.prompt, c.prompt.trim())
  return voiceStatus()
}

function needKey(): string {
  const k = key()
  if (!k) throw new Error('Add your ElevenLabs API key in Settings → Voice first.')
  return k
}

/** What ElevenLabs said went wrong, in words you can act on. */
async function apiError(res: Response, voiceId?: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await res.json()) as { detail?: { message?: string; status?: string } | string }
    detail = typeof body.detail === 'string' ? body.detail : body.detail?.message ?? ''
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return new Error(`ElevenLabs didn’t accept your API key${detail ? `: ${detail}` : '.'} Check it in Settings → Voice.`)
  if (res.status === 404 && voiceId) return new Error(`ElevenLabs has no voice with the ID ${voiceId}. Pick another in Settings → Voice.`)
  if (res.status === 429) return new Error(`ElevenLabs is busy or you’ve run out of characters this month${detail ? `: ${detail}` : '.'}`)
  return new Error(`ElevenLabs couldn’t read this out (${res.status})${detail ? `: ${detail}` : '.'}`)
}

/** Your voices (your own, cloned and the default ones), for the picker in Settings. */
export async function listVoices(): Promise<VoiceOption[]> {
  const k = needKey()
  const res = await fetch(`${API}/v1/voices`, { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw await apiError(res)
  const body = (await res.json()) as { voices?: { voice_id: string; name?: string; category?: string; description?: string; labels?: Record<string, string> }[] }
  return (body.voices ?? [])
    .map((v) => ({
      id: v.voice_id,
      name: v.name || v.voice_id,
      category: v.category ?? '',
      description: v.description || Object.values(v.labels ?? {}).filter(Boolean).join(', ')
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** How long auto-tagging may take before the plain text is read instead. */
export const TAG_DEADLINE_MS = { first: 12_000, later: 45_000 }

/**
 * Claude adds audio tags, or the text comes back as it was: when that fails,
 * changes any words, or isn't back by the deadline (a slow model shouldn't
 * keep you waiting for the voice). It skips the AI job queue: it's one small
 * call, and a card shouldn't wait behind a week being planned.
 */
export async function addTags(text: string, prompt: string, opts: { signal?: AbortSignal; deadlineMs?: number } = {}): Promise<string> {
  if (opts.signal?.aborted) return text
  const ctl = new AbortController()
  const stop = () => ctl.abort()
  opts.signal?.addEventListener('abort', stop)
  const timer = setTimeout(stop, opts.deadlineMs ?? TAG_DEADLINE_MS.later)
  try {
    const call = runAI<string>({ task: 'voice_tag', vars: { voice_prompt: prompt, text }, signal: ctl.signal, noQueue: true, timeoutMs: opts.deadlineMs ?? TAG_DEADLINE_MS.later })
    const late = new Promise<null>((resolve) => ctl.signal.addEventListener('abort', () => resolve(null)))
    const r = await Promise.race([call, late])
    call.catch(() => {})
    if (!r) return text
    const tagged = r.text.trim().replace(/^```\w*\n?|\n?```$/g, '').trim()
    return onlyTagsAdded(text, tagged) ? tagged : text
  } catch {
    return text
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', stop)
  }
}

/** Requests the page may cancel (it moved on to another card), by its request id. */
const inFlight = new Map<string, AbortController>()

export function cancelSpeak(requestId: string): void {
  inFlight.get(requestId)?.abort()
  inFlight.delete(requestId)
}

const cacheDir = () => join(paths.cache, 'voice')

/** One piece of text (at most VOICE_CHUNK characters) as speech: an mp3 data URL. */
export async function speak(text: string, opts: { model?: string; voiceId?: string; requestId?: string; first?: boolean } = {}): Promise<{ audio: string }> {
  const ctl = new AbortController()
  if (opts.requestId) inFlight.set(opts.requestId, ctl)
  try {
    return await speakOnce(text, opts, ctl.signal)
  } finally {
    if (opts.requestId) inFlight.delete(opts.requestId)
  }
}

async function speakOnce(text: string, opts: { model?: string; voiceId?: string; first?: boolean }, signal: AbortSignal): Promise<{ audio: string }> {
  const t = text.trim().slice(0, VOICE_CHUNK + 200)
  if (!t) throw new Error('Nothing to read out.')
  const st = voiceStatus()
  const model = opts.model ?? st.model
  const voiceId = opts.voiceId?.trim() || st.voiceId
  const tags = st.autoTag && modelHasTags(model)
  const id = createHash('sha256').update(JSON.stringify([t, voiceId, model, tags ? st.prompt : ''])).digest('hex').slice(0, 32)
  const file = join(cacheDir(), `${id}.mp3`)
  if (existsSync(file)) return { audio: `data:audio/mpeg;base64,${readFileSync(file).toString('base64')}` }
  if (isOffline()) throw new Error('Voice mode needs a connection for anything you haven’t heard before. Turn offline mode off to hear it.')
  const k = needKey()
  const spoken = tags ? await addTags(t, st.prompt, { signal, deadlineMs: opts.first ? TAG_DEADLINE_MS.first : TAG_DEADLINE_MS.later }) : t
  if (signal.aborted) throw new Error('Stopped.')
  const res = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': k, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: spoken, model_id: model }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)])
  })
  if (!res.ok) throw await apiError(res, voiceId)
  const audio = Buffer.from(await res.arrayBuffer())
  try {
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(file, audio)
  } catch {
    /* plays anyway, just isn't kept */
  }
  return { audio: `data:audio/mpeg;base64,${audio.toString('base64')}` }
}
