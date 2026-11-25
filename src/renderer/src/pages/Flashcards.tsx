import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import { X, Undo2, Pencil, MessageCircleQuestion, PartyPopper, Check } from 'lucide-react'
import type { Card as CardT, ReviewState } from '@shared/types'
import { DEFAULT_SCHEDULER, isLearnt, nextReviewDays, type SchedulerKind } from '@shared/scheduler'
import { RED_GAP } from '@shared/cardPile'
import { useStore, toast } from '../lib/store'
import { useStudySession } from '../lib/lastSession'
import { IS_MOBILE } from '../lib/platform'
import { api, errorText } from '../lib/api'
import { useCommands } from '../lib/commands'
import { Button, Kbd, ProgressBar, cx } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { CardEditor, type CardDraft } from '../components/CardEditor'

// Red, yellow, green, the way StudySmarter does it. Cards come in sets of 15.
// A new card is learnt after two greens (the first makes it light green);
// yellow sends it to the back of the set and red brings it back three cards
// later. A card you've already learnt needs one green to count as reviewed; a
// yellow or red puts it through learning again. Spaced repetition itself is in
// trafficReview (src/shared/scheduler.ts).
const SET_SIZE = 15

type Colour = 'new' | 'due' | 'red' | 'yellow' | 'light' | 'learnt' | 'reviewed'
const DOT: Record<Colour, string> = {
  new: 'bg-surface-2 ring-1 ring-inset ring-line',
  due: 'bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]',
  red: 'bg-bad',
  yellow: 'bg-warn',
  light: 'bg-[color-mix(in_oklab,var(--good)_40%,transparent)]',
  learnt: 'bg-good',
  reviewed: 'bg-good'
}

const COLOUR_NAME: Record<Colour, string> = {
  new: 'New',
  due: 'To review',
  red: 'Didn’t know',
  yellow: 'Sort of',
  light: 'Knew it once',
  learnt: 'Learnt',
  reviewed: 'Reviewed'
}

const RATINGS = [
  {
    r: 1 as const,
    label: 'Didn’t know',
    tone: 'bg-bad-soft text-bad hover:bg-bad hover:text-white',
    key: '1'
  },
  {
    r: 2 as const,
    label: 'Sort of',
    tone: 'bg-warn-soft text-warn hover:bg-warn hover:text-white',
    key: '2'
  },
  {
    r: 3 as const,
    label: 'Knew it',
    tone: 'bg-good-soft text-good hover:bg-good hover:text-white',
    key: '3'
  }
]

const days = (n: number) => (n < 30 ? `${n} day${n === 1 ? '' : 's'}` : n < 365 ? `${Math.round(n / 30)} mo` : `${(n / 365).toFixed(1)} y`)

/** Where a card starts in a set: learnt ones need one green, part-learnt ones are light green. */
function startColour(s: ReviewState | null): Colour {
  if (isLearnt(s)) return 'due'
  return (s?.good_count ?? 0) >= 1 ? 'light' : 'new'
}

interface Snapshot {
  cardId: string
  prev: ReviewState | null
  queue: string[]
  colours: Record<string, Colour>
  finishedIds: string[]
  scored: boolean
}

/** Review one deck, or (with courseId) the due cards from every week of a course. */
export function Flashcards({ deckId, mode, courseId }: { deckId: string; mode: 'due' | 'all'; courseId?: string }) {
  const go = useStore((s) => s.go)
  const openExplain = useStore((s) => s.openExplain)
  const [all, setAll] = useState<CardT[] | null>(null)
  const [setStart, setSetStart] = useState(0)
  // The set being studied: card ids still to go, in order.
  const [queue, setQueue] = useState<string[]>([])
  const [colours, setColours] = useState<Record<string, Colour>>({})
  // Cards learnt or reviewed this set, in the order you finished them.
  const [finishedIds, setFinishedIds] = useState<string[]>([])
  const [states, setStates] = useState<Record<string, ReviewState | null>>({})
  // Cards whose first rating this set has gone to the scheduler (the older schedulers only take one a session).
  const [scored, setScored] = useState<Set<string>>(new Set())
  const [flipped, setFlipped] = useState(false)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [editing, setEditing] = useState<CardDraft | null>(null)
  const [deckName, setDeckName] = useState('')
  const [kind, setKind] = useState<SchedulerKind>(DEFAULT_SCHEDULER)
  const [busy, setBusy] = useState(false)
  const setCards = useMemo(() => all?.slice(setStart, setStart + SET_SIZE) ?? [], [all, setStart])
  const byId = useMemo(() => new Map((all ?? []).map((c) => [c.id, c])), [all])
  const finished = !!all && setCards.length > 0 && queue.length === 0
  const allDone = !!all && (all.length === 0 || (finished && setStart + SET_SIZE >= all.length))
  // Home offers Continue for a review left with cards still to go.
  useStudySession(all ? { name: 'flashcards', deckId, mode, ...(courseId ? { courseId } : {}) } : null, deckName, allDone)
  useEffect(() => void api.settings.all().then((s) => setKind((s['review.scheduler'] as SchedulerKind) ?? DEFAULT_SCHEDULER)), [])

  useEffect(() => {
    if (courseId) {
      void api.courses.get({ id: courseId }).then((c) => setDeckName(c.name))
      void api.courses.due({ courseId }).then(setAll)
      return
    }
    void api.decks.get({ id: deckId }).then((d) => setDeckName(d.name))
    void (mode === 'due' ? api.decks.due({ id: deckId }) : api.cards.list({ deckId })).then((cards) => {
      setAll(mode === 'all' ? [...cards].sort(() => Math.random() - 0.5) : cards)
    })
  }, [deckId, mode, courseId])

  // A new set: where each card stands, from its review state.
  useEffect(() => {
    if (!setCards.length) return
    let live = true
    void Promise.all(setCards.map((c) => api.cards.reviewState({ cardId: c.id }).catch(() => null))).then((list) => {
      if (!live) return
      const st: Record<string, ReviewState | null> = {}
      const col: Record<string, Colour> = {}
      setCards.forEach((c, j) => {
        st[c.id] = list[j]
        col[c.id] = startColour(list[j])
      })
      setStates(st)
      setColours(col)
      setQueue(setCards.map((c) => c.id))
      setFinishedIds([])
      setScored(new Set())
      setHistory([])
      setFlipped(false)
    })
    return () => {
      live = false
    }
  }, [setCards])
  // Leaving goes back to where the review started.
  const leave = () => (courseId ? go({ name: 'course', id: courseId }) : go({ name: 'deck', id: deckId }))

  const card = queue.length ? byId.get(queue[0]) : undefined
  const colour = card ? colours[card.id] : undefined
  const learnt = card ? isLearnt(states[card.id]) : false
  useEffect(() => setFlipped(false), [card?.id, queue.length])

  /** What each button does to this card, shown under it. */
  const hint = (r: 1 | 2 | 3): string => {
    if (!card) return ''
    if (r === 1) return learnt ? 'Learn it again · 3 cards on' : 'Back in 3 cards'
    if (r === 2) return learnt ? 'Learn it again · at the back' : 'To the back'
    if (learnt) return `Reviewed · next in ${days(nextReviewDays(states[card.id]?.interval ?? 0))}`
    return colour === 'light' ? 'Learnt · next in 1 day' : 'Light green · to the back'
  }

  const rate = async (r: 1 | 2 | 3) => {
    if (!card || !flipped || busy) return
    const id = card.id
    const prev = states[id] ?? null
    setBusy(true)
    try {
      // StudySmarter's pile mirrors its scheduler, so every rating counts; the others count your first go only.
      const send = kind === 'studysmarter' || !scored.has(id)
      const next = send ? await api.cards.review({ cardId: id, rating: r }) : prev
      const done = r === 3 && (send ? isLearnt(next) : true)
      setHistory((h) => [
        ...h,
        {
          cardId: id,
          prev,
          queue,
          colours,
          finishedIds,
          scored: scored.has(id)
        }
      ])
      if (done) setFinishedIds((f) => [...f, id])
      if (send) {
        setStates((s) => ({ ...s, [id]: next }))
        setScored((s) => new Set(s).add(id))
      }
      setColours((c) => ({
        ...c,
        [id]: r === 1 ? 'red' : r === 2 ? 'yellow' : done ? (learnt ? 'reviewed' : 'learnt') : 'light'
      }))
      const rest = queue.slice(1)
      setQueue(done ? rest : r === 1 ? [...rest.slice(0, RED_GAP), id, ...rest.slice(RED_GAP)] : [...rest, id])
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  const undo = async () => {
    const last = history[history.length - 1]
    if (!last) return
    const p = last.prev
    if (kind === 'studysmarter' || !last.scored) {
      await api.cards.restoreReview({
        cardId: last.cardId,
        state: p
          ? {
              ease: p.ease,
              interval: p.interval,
              repetitions: p.repetitions,
              lapses: p.lapses,
              due: p.due,
              last_reviewed: p.last_reviewed,
              difficulty: p.difficulty,
              sr_state: p.sr_state,
              good_count: p.good_count
            }
          : null
      })
      setStates((s) => ({ ...s, [last.cardId]: p }))
      if (!last.scored)
        setScored((s) => {
          const n = new Set(s)
          n.delete(last.cardId)
          return n
        })
    }
    setQueue(last.queue)
    setColours(last.colours)
    setFinishedIds(last.finishedIds)
    setHistory(history.slice(0, -1))
    setTimeout(() => setFlipped(true), 0)
  }
  const nextSet = () => setSetStart((n) => n + SET_SIZE)

  useCommands(
    {
      'study.flip': () => card && setFlipped((f) => !f),
      'study.again': () => rate(1),
      'study.hard': () => rate(2),
      'study.good': () => rate(3),
      'study.easy': () => rate(3),
      'study.undo': undo,
      'study.editCard': () => card && setEditing({ ...card }),
      'ai.explain': () =>
        card &&
        openExplain({
          ctx: { cardId: card.id, deckId: card.deck_id },
          title: card.front.split('\n')[0]
        }),
      'study.end': leave,
      'learn.submit': () => (card ? (flipped ? rate(3) : setFlipped(true)) : finished && !allDone ? nextSet() : leave())
    },
    [card, flipped, states, colours, queue, finishedIds, history, scored, kind, busy, finished, allDone]
  )

  if (!all || (setCards.length && !queue.length && !history.length && !finished))
    return (
      <div className="grid h-full place-items-center">
        <div className="skeleton h-80 w-[min(640px,90vw)]" />
      </div>
    )
  const sets = Math.max(1, Math.ceil(all.length / SET_SIZE))
  const setNo = Math.floor(setStart / SET_SIZE) + 1
  const tally = (cs: Colour[]) => setCards.filter((c) => cs.includes(colours[c.id])).length
  const doneHere = tally(['learnt', 'reviewed'])

  return (
    <div className="flex min-h-full flex-col px-[clamp(16px,3vw,40px)] pt-5 pb-8">
      <div className="mx-auto flex w-full max-w-[860px] items-center gap-4">
        <Button variant="ghost" size="icon" onClick={leave} title="End (esc)">
          <X className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-3 text-[0.85rem] text-muted">
            <span className="truncate font-semibold">
              {deckName} · {mode === 'due' ? 'Due' : 'All cards'}
              {sets > 1 && (
                <span className="font-normal">
                  {' '}
                  · set {setNo} of {sets}
                </span>
              )}
            </span>
            <span className="shrink-0">
              {doneHere} / {setCards.length} done
            </span>
          </div>
          <PileBars order={[...finishedIds, ...queue]} cards={byId} colours={colours} current={card?.id} />
        </div>
        <Button variant="ghost" size="icon" onClick={undo} disabled={!history.length} title={keyLabel('Undo (U / ⌘Z)')}>
          <Undo2 className="size-5" />
        </Button>
      </div>

      {!setCards.length || finished ? (
        <div className="pop-in mx-auto mt-[8vh] flex max-w-md flex-col items-center gap-4 text-center">
          <div className="text-accent">
            <PartyPopper className="size-8" strokeWidth={1.6} />
          </div>
          <h2 className="text-3xl font-semibold tracking-tight">{!setCards.length ? 'Nothing due right now' : allDone ? 'All done!' : `Set ${setNo} done`}</h2>
          {setCards.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2">
              {tally(['learnt']) > 0 && <span className="rounded-full bg-good-soft px-3 py-1 text-[0.85rem] font-semibold text-good">{tally(['learnt'])} learnt</span>}
              {tally(['reviewed']) > 0 && <span className="rounded-full bg-good-soft px-3 py-1 text-[0.85rem] font-semibold text-good">{tally(['reviewed'])} reviewed</span>}
            </div>
          )}
          {!allDone && (
            <p className="text-muted">
              {all.length - setStart - SET_SIZE} more card
              {all.length - setStart - SET_SIZE === 1 ? '' : 's'} to go.
            </p>
          )}
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {!allDone && (
              <Button variant="primary" onClick={nextSet}>
                Next {Math.min(SET_SIZE, all.length - setStart - SET_SIZE)} cards <Kbd className="ml-1 border-current/30">↩</Kbd>
              </Button>
            )}
            {courseId ? (
              <Button variant={allDone ? 'primary' : 'ghost'} onClick={leave}>
                Back to the course
              </Button>
            ) : (
              <>
                {allDone && (
                  <Button variant="primary" onClick={() => go({ name: 'learn', deckId })}>
                    Start Learn
                  </Button>
                )}
                {allDone && mode === 'due' && <Button onClick={() => go({ name: 'flashcards', deckId, mode: 'all' })}>Review all cards</Button>}
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
              <div
                key={`${card.id}:${history.length}`}
                className={cx('flip pop-in flex flex-1 cursor-pointer flex-col select-text', flipped && 'is-flipped')}
                onClick={() => !flipped && setFlipped(true)}
              >
                <div className="flip-inner flex-1">
                  <Face label="Question" card={card} colour={colour}>
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
                      {IS_MOBILE ? (
                        'Tap to flip'
                      ) : (
                        <>
                          Click or press <Kbd>Space</Kbd> to flip
                        </>
                      )}
                    </div>
                  </Face>
                  <Face label="Answer" back card={card} colour={colour}>
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
                <div className="pop-in grid grid-cols-3 gap-2.5">
                  {RATINGS.map((x) => (
                    <button
                      key={x.r}
                      onClick={() => rate(x.r)}
                      disabled={busy}
                      className={cx(
                        'flex flex-col items-center gap-0.5 rounded-xl px-2 py-3.5 font-semibold transition-[transform,background,color] duration-300 ease-out-soft active:scale-95',
                        x.tone
                      )}
                    >
                      <span className="text-[1.05rem]">{x.label}</span>
                      <span className="text-center text-[0.78rem] font-medium opacity-80">
                        {hint(x.r)}
                        {!IS_MOBILE && (
                          <>
                            {' '}
                            · <Kbd className="border-current/30">{x.key}</Kbd>
                          </>
                        )}
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
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted hover:text-ink"
                  onClick={() =>
                    openExplain({
                      ctx: { cardId: card.id, deckId: card.deck_id },
                      title: card.front.split('\n')[0]
                    })
                  }
                >
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
            setAll((list) => list?.map((x) => (x.id === c.id ? c : x)) ?? null)
          }}
        />
      )}
    </div>
  )
}

/**
 * A bar per card in the set, in pile order: the cards you've finished on the
 * left, then the pile with the card you're on first (outlined). A card sent to
 * the back slides to the end in its new colour.
 */
function PileBars({ order, cards, colours, current }: { order: string[]; cards: Map<string, CardT>; colours: Record<string, Colour>; current?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const last = useRef(new Map<string, number>())
  // FLIP: each bar starts where it was and slides to its new place.
  useLayoutEffect(() => {
    const els = [...(box.current?.children ?? [])] as HTMLElement[]
    const now = new Map(els.map((el) => [el.dataset.id!, el.getBoundingClientRect().left]))
    for (const el of els) {
      const was = last.current.get(el.dataset.id!)
      const dx = was === undefined ? 0 : was - now.get(el.dataset.id!)!
      if (!dx) continue
      el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    }
    last.current = now
  }, [order.join(',')])
  return (
    <div ref={box} className="flex gap-1" aria-label="Cards in this set">
      {order.map((id) => {
        const col = colours[id] ?? 'new'
        const c = cards.get(id)
        return (
          <span
            key={id}
            data-id={id}
            title={`${(c?.front ?? '').split('\n')[0].slice(0, 80)} · ${COLOUR_NAME[col]}`}
            className={cx('grid h-3 min-w-0 flex-1 place-items-center rounded-full transition-colors duration-300', DOT[col], id === current && 'outline-2 outline-offset-2 outline-accent')}
          >
            {(col === 'learnt' || col === 'reviewed') && <Check className="size-2.5 text-white" strokeWidth={3.5} />}
          </span>
        )
      })}
    </div>
  )
}

function Face({ children, back, label, card, colour }: { children: React.ReactNode; back?: boolean; label: string; card: CardT; colour?: Colour }) {
  return (
    <div className={cx('flip-face flex flex-col overflow-y-auto rounded-xl border border-line bg-surface p-[clamp(20px,4vw,44px)]', back && 'flip-back')}>
      <div className="mb-4 flex items-center justify-between gap-3 text-[0.75rem] font-semibold text-muted">
        <span className="flex items-center gap-2">
          {label}
          {colour && colour !== 'new' && (
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 font-medium">
              <span className={cx('h-2 w-3.5 rounded-full', DOT[colour])} />
              {COLOUR_NAME[colour]}
            </span>
          )}
        </span>
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
