import { useEffect, useSyncExternalStore } from 'react'
import { speakableText, voiceChunks, type VoiceStatus } from '@shared/voice'
import { api, errorText } from './api'
import { toast, useStore } from './store'

// Voice mode in the page: what's set up (from the main process) and what's
// playing. One thing plays at a time; starting something new stops the last.
// Long text is read in pieces, fetching the next while this one plays.

let status: VoiceStatus | null = null
let loading: Promise<void> | null = null
/** What's being read: its key (a card, an explanation), and whether its audio is still coming. */
let speaking: { key: string; loading: boolean } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function refreshVoice(): Promise<void> {
  loading ??= api.voice
    .status()
    .then((s) => setVoiceStatus(s))
    .catch(() => setVoiceStatus(null))
    .finally(() => (loading = null))
  return loading
}

export function setVoiceStatus(s: VoiceStatus | null): void {
  status = s
  if (!s?.ready) stopVoice()
  emit()
}

/** Voice mode's settings, loaded the first time something asks. */
export function useVoiceStatus(): VoiceStatus | null {
  const s = useSyncExternalStore(subscribe, () => status)
  useEffect(() => {
    if (!status) void refreshVoice()
  }, [])
  return s
}

export const useSpeaking = () => useSyncExternalStore(subscribe, () => speaking)

let run = 0
let audio: HTMLAudioElement | null = null
let endPlayback: (() => void) | null = null

function setSpeaking(s: typeof speaking): void {
  speaking = s
  emit()
}

export function stopVoice(): void {
  run++
  audio?.pause()
  audio = null
  endPlayback?.()
  endPlayback = null
  if (speaking) setSpeaking(null)
}

function play(src: string): Promise<void> {
  return new Promise((resolve) => {
    const a = new Audio(src)
    audio = a
    endPlayback = resolve
    a.onended = () => resolve()
    a.onerror = () => resolve()
    a.play().catch(() => resolve())
  })
}

/**
 * Read Markdown aloud (notes, an explanation). Resolves when it's finished or
 * stopped. Quiet: a failure just stops, with no message (reading by itself offline).
 */
export async function speak(markdown: string, key: string, opts: { quiet?: boolean } = {}): Promise<void> {
  stopVoice()
  const my = run
  const chunks = voiceChunks(speakableText(markdown))
  if (!chunks.length) return
  setSpeaking({ key, loading: true })
  const fetchChunk = (text: string) => {
    const p = api.voice.speak({ text })
    p.catch(() => {}) // fetched ahead and maybe never awaited
    return p
  }
  let next = fetchChunk(chunks[0])
  for (let i = 0; i < chunks.length; i++) {
    let r: { audio: string }
    try {
      r = await next
    } catch (e) {
      if (my === run) {
        if (!opts.quiet) toast(errorText(e), 'bad')
        stopVoice()
      }
      return
    }
    if (my !== run) return
    if (i + 1 < chunks.length) next = fetchChunk(chunks[i + 1])
    setSpeaking({ key, loading: false })
    await play(r.audio)
    if (my !== run) return
    if (i + 1 < chunks.length) setSpeaking({ key, loading: true })
  }
  if (my === run) setSpeaking(null)
}

/**
 * Reads `text` aloud once when voice mode is on, set to play by itself, and
 * `when` is true (a notes card opening, an explanation finishing), and stops
 * when the component goes. Set to "when I click", the speaker button does it.
 */
export function useReadAloud(text: string | null | undefined, key: string, when = true): void {
  const st = useVoiceStatus()
  const ready = !!st?.ready && st.autoplay
  // Offline, cards you've heard before still play; the rest are skipped without a message.
  const offline = useStore((s) => s.offline)
  useEffect(() => {
    if (!ready || !when || !text?.trim()) return
    void speak(text, key, { quiet: offline })
    return () => {
      if (speaking?.key === key) stopVoice()
    }
  }, [ready, when, key])
}
