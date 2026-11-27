import { Loader2, Square, Volume2 } from 'lucide-react'
import { speak, stopVoice, useSpeaking, useVoiceStatus } from '../lib/voice'
import { cx } from './ui'

/** With voice mode on: read this aloud again, or stop. Shows while it's loading or playing. */
export function VoiceButton({ text, voiceKey, className }: { text: string; voiceKey: string; className?: string }) {
  const st = useVoiceStatus()
  const speaking = useSpeaking()
  if (!st?.ready || !text.trim()) return null
  const mine = speaking?.key === voiceKey
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (mine) stopVoice()
        else void speak(text, voiceKey)
      }}
      title={mine ? 'Stop reading' : 'Read it aloud'}
      aria-label={mine ? 'Stop reading' : 'Read it aloud'}
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.8rem] font-semibold transition-colors',
        mine ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink',
        className
      )}
    >
      {mine && speaking.loading ? <Loader2 className="size-4 animate-spin" /> : mine ? <Square className="size-3.5 fill-current" /> : <Volume2 className="size-4" />}
      {mine ? (speaking.loading ? 'Getting voice…' : 'Stop') : 'Read aloud'}
    </button>
  )
}
