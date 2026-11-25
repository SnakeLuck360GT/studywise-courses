import { useEffect, useMemo, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import { X, Undo2, Pencil, MessageCircleQuestion, PartyPopper, RotateCcw } from 'lucide-react'
import type { Card as CardT, ReviewState } from '@shared/types'
import { schedule, newState, withDefaults, DEFAULT_SCHEDULER, type SchedulerKind } from '@shared/scheduler'
import { insertRetry } from '@shared/retry'
import { useStore, toast } from '../lib/store'
import { useStudySession } from '../lib/lastSession'
import { IS_MOBILE } from '../lib/platform'
import { api, errorText } from '../lib/api'
import { useCommands } from '../lib/commands'
import { Button, Kbd, ProgressBar, cx } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { CardEditor, type CardDraft } from '../components/CardEditor'

const RATINGS = [
  { r: 1 as const, label: 'Again', tone: 'bg-bad-soft text-bad hover:bg-bad hover:text-white', cmd: 'study.again' },
  { r: 2 as const, label: 'Hard', tone: 'bg-warn-soft text-warn hover:bg-warn hover:text-white', cmd: 'study.hard' },
  { r: 3 as const, label: 'Good', tone: 'bg-good-soft text-good hover:bg-good hover:text-white', cmd: 'study.good' },
  { r: 4 as const, label: 'Easy', tone: 'bg-accent-soft text-accent hover:bg-accent hover:text-accent-ink', cmd: 'study.easy' }
]

function fmtInterval(from: Date, due: string): string {
  const mins = Math.round((new Date(due).getTime() - from.getTime()) / 60000)
  if (mins < 60) return `${mins}m`
  const days = Math.round(mins / 1440)
  if (days < 30) return `${days}d`
  if (days < 365) return `${Math.round(days / 30)}mo`
  return `${(days / 365).toFixed(1)}y`
}

/** Review one deck, or (with courseId) the due cards from every week of a course. */
export function Flashcards({ deckId, mode, courseId }: { deckId: string; mode: 'due' | 'all'; courseId?: string }) {
  const go = useStore((s) => s.go)
  const openExplain = useStore((s) => s.openExplain)
  const [queue, setQueue] = useState<CardT[] | null>(null)
  const [i, setI] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [state, setState] = useState<ReviewState | null>(null)
  const [history, setHistory] = useState<{ index: number; card: CardT; prev: ReviewState | null; requeuedAt: number | null }[]>([])
  const [counts, setCounts] = useState({ 1: 0, 2: 0, 3: 0, 4: 0 })
  const [editing, setEditing] = useState<CardDraft | null>(null)
  const [deckName, setDeckName] = useState('')
  const [kind, setKind] = useState<SchedulerKind>(DEFAULT_SCHEDULER)
  // Home offers Continue for a review left with cards still to go.
  useStudySession(queue ? { name: 'flashcards', deckId, mode, ...(courseId ? { courseId } : {}) } : null, deckName, !!queue && i >= queue.length)
  useEffect(() => void api.settings.all().then((s) => setKind((s['review.scheduler'] as SchedulerKind) ?? DEFAULT_SCHEDULER)), [])

  useEffect(() => {
    if (courseId) {
      void api.courses.get({ id: courseId }).then((c) => setDeckName(c.name))
      void api.courses.due({ courseId }).then(setQueue)
      return
    }
    void api.decks.get({ id: deckId }).then((d) => setDeckName(d.name))
    void (mode === 'due' ? api.decks.due({ id: deckId }) : api.cards.list({ deckId })).then((cards) => {
      setQueue(mode === 'all' ? [...cards].sort(() => Math.random() - 0.5) : cards)
    })
  }, [deckId, mode, courseId])
  // Leaving goes back to where the review started.
  const leave = () => (courseId ? go({ name: 'course', id: courseId }) : go({ name: 'deck', id: deckId }))

  const card = queue?.[i]
  useEffect(() => {
    setFlipped(false)
    if (card) void api.cards.reviewState({ cardId: card.id }).then(setState)
  }, [card?.id, i])

  const now = useMemo(() => new Date(), [card?.id, flipped])
  const previews = useMemo(() => {
    const base = state ? withDefaults(state) : newState(now)
    return Object.fromEntries(RATINGS.map(({ r }) => [r, fmtInterval(now, schedule(kind, base, r, now).due)]))
  }, [state, now, kind])

  const rate = async (r: 1 | 2 | 3 | 4) => {
    if (!card || !flipped || !queue) return
    try {
      const prev = state
      await api.cards.review({ cardId: card.id, rating: r })
      // Again: the card comes back a few cards later, and keeps coming back until you know it.
      const again = r === 1 ? insertRetry(queue, i, card) : null
      setHistory((h) => [...h, { index: i, card, prev, requeuedAt: again?.at ?? null }])
      setCounts((c) => ({ ...c, [r]: c[r] + 1 }))
      if (again) setQueue(again.list)
      setI(i + 1)
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const undo = async () => {
    const last = history[history.length - 1]
    if (!last || !queue) return
    await api.cards.restoreReview({ cardId: last.card.id, state: last.prev ? { ease: last.prev.ease, interval: last.prev.interval, repetitions: last.prev.repetitions, lapses: last.prev.lapses, due: last.prev.due, last_reviewed: last.prev.last_reviewed, difficulty: last.prev.difficulty, sr_state: last.prev.sr_state, good_count: last.prev.good_count } : null })
    if (last.requeuedAt !== null) setQueue([...queue.slice(0, last.requeuedAt), ...queue.slice(last.requeuedAt + 1)])
    setHistory(history.slice(0, -1))
    setI(last.index)
    setTimeout(() => setFlipped(true), 0)
  }

  useCommands(
    {
      'study.flip': () => card && setFlipped((f) => !f),
      'study.again': () => rate(1),
      'study.hard': () => rate(2),
      'study.good': () => rate(3),
      'study.easy': () => rate(4),
      'study.undo': undo,
      'study.editCard': () => card && setEditing({ ...card }),
      'ai.explain': () => card && openExplain({ ctx: { cardId: card.id, deckId: card.deck_id }, title: card.front.split('\n')[0] }),
      'study.end': leave,
      'learn.submit': () => (card ? (flipped ? rate(3) : setFlipped(true)) : leave())
    },
    [card, flipped, state, queue, i, history]
  )

  if (!queue) return <div className="grid h-full place-items-center"><div className="skeleton h-80 w-[min(640px,90vw)]" /></div>
  const done = i >= queue.length
  const reviewed = history.length

  return (
    <div className="flex min-h-full flex-col px-[clamp(16px,3vw,40px)] pt-5 pb-8">
      <div className="mx-auto flex w-full max-w-[860px] items-center gap-4">
        <Button variant="ghost" size="icon" onClick={leave} title="End (esc)">
          <X className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between text-[0.85rem] text-muted">
            <span className="truncate font-semibold">{deckName} · {mode === 'due' ? 'Due' : 'All cards'}</span>
            <span>
              {Math.min(i + 1, queue.length)} / {queue.length}
            </span>
          </div>
          <ProgressBar value={queue.length ? i / queue.length : 1} />
        </div>
        <Button variant="ghost" size="icon" onClick={undo} disabled={!history.length} title={keyLabel("Undo (U / ⌘Z)")}>
          <Undo2 className="size-5" />
        </Button>
      </div>

      {done ? (
        <div className="pop-in mx-auto mt-[8vh] flex max-w-md flex-col items-center gap-4 text-center">
          <div className="text-accent">
            <PartyPopper className="size-8" strokeWidth={1.6} />
          </div>
          <h2 className="text-3xl font-semibold tracking-tight">{queue.length ? 'Session done!' : 'Nothing due right now'}</h2>
          {reviewed > 0 && (
            <div className="flex gap-2">
              {RATINGS.map((x) => (
                <span key={x.r} className={cx('rounded-full px-3 py-1 text-[0.85rem] font-semibold', x.tone.split(' hover')[0])}>
                  {x.label} {counts[x.r]}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {courseId ? (
              <Button variant="primary" onClick={leave}>
                Back to the course
              </Button>
            ) : (
              <>
                <Button variant="primary" onClick={() => go({ name: 'learn', deckId })}>
                  Start Learn
                </Button>
                {mode === 'due' && (
                  <Button onClick={() => go({ name: 'flashcards', deckId, mode: 'all' })}>
                    Review all cards
                  </Button>
                )}
                <Button variant="ghost" onClick={leave}>
                  Back to deck
                </Button>
              </>
            )}
          </div>
        </div>
      ) : (
        card && (
          <>
            {/* The card takes the room down to the buttons, within limits, so they stay together on any window size. */}
            <div className="mx-auto mt-6 flex max-h-[680px] min-h-[280px] w-full max-w-[860px] flex-1 flex-col">
              <div key={`${card.id}:${i}`} className={cx('flip pop-in flex flex-1 cursor-pointer flex-col select-text', flipped && 'is-flipped')} onClick={() => !flipped && setFlipped(true)}>
                <div className="flip-inner flex-1">
                  <Face label="Question" card={card}>
                    <Markdown className="text-[clamp(1.2rem,2.4vw,1.7rem)] leading-snug font-semibold">{card.front}</Markdown>
                    {card.kind === 'multiple_choice' && (
                      <ul className="mt-5 grid gap-2 sm:grid-cols-2">
                        {card.options.map((o, j) => (
                          <li key={j} className="rounded-lg border border-line px-4 py-2.5">
                            {String.fromCharCode(65 + j)}. {o.text}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-auto pt-6 text-center text-[0.85rem] text-muted">
                      {IS_MOBILE ? 'Tap to flip' : <>Click or press <Kbd>Space</Kbd> to flip</>}
                    </div>
                  </Face>
                  <Face label="Answer" back card={card}>
                    <div className="mb-4 line-clamp-2 text-[0.95rem] text-muted">{card.front}</div>
                    {card.kind === 'multiple_choice' ? (
                      <ul className="grid gap-2 sm:grid-cols-2">
                        {card.options.map((o, j) => (
                          <li key={j} className={cx('rounded-lg border px-4 py-2.5', o.correct ? 'border-good bg-good-soft font-semibold text-good' : 'border-line opacity-60')}>
                            {String.fromCharCode(65 + j)}. {o.text}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <Markdown className="text-[clamp(1.05rem,2vw,1.35rem)] leading-relaxed">{card.back}</Markdown>
                    )}
                    {card.explanation && (
                      <details className="mt-5 rounded-lg bg-surface-2 p-3 text-[0.92rem]" onClick={(e) => e.stopPropagation()}>
                        <summary className="cursor-pointer font-semibold">Saved explanation</summary>
                        <Markdown className="mt-2">{card.explanation}</Markdown>
                      </details>
                    )}
                  </Face>
                </div>
              </div>
            </div>

            <div className="mx-auto mt-5 w-full max-w-[860px]">
              {flipped ? (
                <div className="pop-in grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {RATINGS.map((x) => (
                    <button
                      key={x.r}
                      onClick={() => rate(x.r)}
                      className={cx('flex flex-col items-center gap-0.5 rounded-xl py-3.5 font-semibold transition-[transform,background,color] duration-300 ease-out-soft active:scale-95', x.tone)}
                    >
                      <span className="text-[1.05rem]">{x.label}</span>
                      <span className="text-[0.8rem] font-medium opacity-80">
                        {previews[x.r]}{!IS_MOBILE && <> · <Kbd className="border-current/30">{x.r}</Kbd></>}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <Button variant="ink" size="lg" className="w-full justify-center" onClick={() => setFlipped(true)}>
                  Show answer <Kbd className="ml-2 border-current/30">Space</Kbd>
                </Button>
              )}
              <div className="mt-3 flex justify-center gap-2">
                <Button size="sm" variant="ghost" className="text-muted hover:text-ink" onClick={() => openExplain({ ctx: { cardId: card.id, deckId: card.deck_id }, title: card.front.split('\n')[0] })}>
                  <MessageCircleQuestion className="size-4" /> Explain <Kbd>⌘E</Kbd>
                </Button>
                <Button size="sm" variant="ghost" className="text-muted hover:text-ink" onClick={() => setEditing({ ...card })}>
                  <Pencil className="size-4" /> Edit <Kbd>E</Kbd>
                </Button>
              </div>
            </div>
          </>
        )
      )}
      {editing && (
        <CardEditor
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null)
            setQueue((q) => q?.map((x) => (x.id === c.id ? c : x)) ?? null)
          }}
        />
      )}
    </div>
  )
}

function Face({ children, back, label, card }: { children: React.ReactNode; back?: boolean; label: string; card: CardT }) {
  return (
    <div className={cx('flip-face flex flex-col overflow-y-auto rounded-xl border border-line bg-surface p-[clamp(20px,4vw,44px)]', back && 'flip-back')}>
      <div className="mb-4 flex items-center justify-between text-[0.75rem] font-semibold text-muted">
        <span>{label}</span>
        <span className="flex gap-1.5">
          {card.tags.slice(0, 3).map((t) => (
            <span key={t} className="rounded-full bg-surface-2 px-2 py-0.5 text-[0.75rem] font-semibold">
              #{t}
            </span>
          ))}
        </span>
      </div>
      {children}
    </div>
  )
}
