import { useEffect, useState } from 'react'
import { Play, X } from 'lucide-react'
import { api } from '../lib/api'
import { LAST_SESSION_SETTING, forgetSession, type LastSession } from '../lib/lastSession'
import { Button, Kbd } from './ui'
import { timeAgo } from './PhoneSync'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export interface Resumable {
  session: LastSession
  kind: string
  detail: string
}

/**
 * The study session you left partway through, if it's still there to go back
 * to: the topic still exists (and isn't finished), the deck still has cards
 * (still due, for a due review). One that's gone or done is forgotten.
 * `setting`: which remembered session, the last of any kind (home) or the
 * last course one (Courses).
 */
export function useResumable(version: number, setting = LAST_SESSION_SETTING): [Resumable | null, () => void] {
  const [r, setR] = useState<Resumable | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      const s = (await api.settings.all().catch(() => ({}) as Record<string, unknown>))[setting] as LastSession | null | undefined
      if (!s?.route) return alive && setR(null)
      try {
        const route = s.route
        let title = s.title
        let kind: string
        let detail: string
        if (route.name === 'topic') {
          const t = await api.courses.topic({ id: route.id })
          if (!t.content || (!route.test && t.progress.done)) throw new Error('done')
          title = t.content.title
          const total = route.test ? t.content.check.length : t.content.sections.length
          kind = route.test ? 'Topic test' : 'Topic'
          detail = route.test ? plural(total, 'question') : `Section ${Math.min(t.progress.section + 1, total)} of ${total}`
        } else if (route.name === 'learn') {
          title = (await api.decks.get({ id: route.deckId })).name
          kind = 'Learn'
          detail = route.cardIds?.length ? `${plural(route.cardIds.length, 'card')} picked` : 'A new set of questions on this deck'
        } else {
          const cards = route.courseId ? await api.courses.due({ courseId: route.courseId }) : route.mode === 'due' ? await api.decks.due({ id: route.deckId }) : await api.cards.list({ deckId: route.deckId })
          if (!cards.length) throw new Error('done')
          kind = 'Flashcards'
          detail = route.mode === 'due' ? `${plural(cards.length, 'card')} due` : plural(cards.length, 'card')
        }
        if (alive) setR({ session: { ...s, title }, kind, detail })
      } catch {
        if (alive) setR(null)
        void forgetSession(s.route)
      }
    })()
    return () => {
      alive = false
    }
  }, [version, setting])
  const dismiss = () => {
    if (r) void forgetSession(r.session.route)
    setR(null)
  }
  return [r, dismiss]
}

/** "Pick up where you left off": Continue goes back into the session, × forgets it. */
export function ResumeCard({ r, onContinue, onDismiss, enterKey = false }: { r: Resumable; onContinue: () => void; onDismiss: () => void; enterKey?: boolean }) {
  return (
    <section className="pop-in mb-8 flex flex-wrap items-center gap-4 rounded-xl border border-accent/30 bg-accent-soft px-5 py-4">
      <div className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
        <Play className="ml-0.5 size-5" fill="currentColor" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[0.85rem] text-muted">Pick up where you left off · {r.kind}</div>
        <div className="truncate text-[1.1rem] font-semibold tracking-[-0.01em]">{r.session.title}</div>
        <div className="text-[0.88rem] text-muted">
          {r.detail} · {timeAgo(r.session.at)}
        </div>
      </div>
      <Button variant="primary" size="lg" onClick={onContinue}>
        Continue {enterKey && <Kbd className="ml-1 border-white/30 text-white/80">↩</Kbd>}
      </Button>
      <button onClick={onDismiss} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink" aria-label="Dismiss" title="Forget this session">
        <X className="size-4" />
      </button>
    </section>
  )
}
