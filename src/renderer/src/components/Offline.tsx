import { Wifi, WifiOff } from 'lucide-react'
import { useStore } from '../lib/store'
import { cx } from './ui'

/**
 * Offline mode in the top bar. On, it's a pill that says so (tap to turn it
 * off); off, a green wifi icon (AI is on) that turns it on. The phone only
 * shows it while on.
 */
export function OfflineButton({ mobile = false }: { mobile?: boolean }) {
  const offline = useStore((s) => s.offline)
  const setOffline = useStore((s) => s.setOffline)
  if (offline)
    return (
      <button
        onClick={() => setOffline(false)}
        title="Offline mode: nothing uses AI, and studying only asks questions marked without it. Click to turn it off."
        className={cx(
          'no-drag flex shrink-0 items-center gap-1.5 rounded-full bg-warn-soft font-semibold text-warn ring-1 ring-warn/40 transition-transform active:scale-95',
          mobile ? 'h-9 px-3 text-[0.85rem]' : 'h-7 px-2.5 text-[0.8rem]'
        )}
      >
        <WifiOff className={mobile ? 'size-4' : 'size-3.5'} /> Offline
      </button>
    )
  if (mobile) return null
  return (
    <button
      onClick={() => setOffline(true)}
      title="Online: AI is on. Click for offline mode (study without AI, only questions marked without it)."
      aria-label="Online. Turn on offline mode"
      className="no-drag hidden size-8 shrink-0 place-items-center rounded-lg text-good transition-colors hover:bg-good-soft sm:grid"
    >
      <Wifi className="size-4" />
    </button>
  )
}
