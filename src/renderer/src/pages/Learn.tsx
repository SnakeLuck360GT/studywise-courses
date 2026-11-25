import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import { X, Settings2, Lightbulb, RefreshCw, MessageCircleQuestion, ThumbsUp, SkipForward, ArrowRight, Sparkles, Trophy, Brain, CheckCircle2, XCircle, CircleDot, Database, RotateCcw, Undo2, WifiOff } from 'lucide-react'
import { reshuffleLearnQuestion, type LearnQuestion, type LearnAnswer, type Mark } from '@shared/questions'
import { insertRetry } from '@shared/retry'
import { QUESTION_LABELS, QUESTION_TYPES, type LearnSettings, type CustomAction, type QuestionType } from '@shared/types'
import { useStore, toast } from '../lib/store'
import { useStudySession } from '../lib/lastSession'
import { api, errorText } from '../lib/api'
import { useCommands } from '../lib/commands'
import { QuestionView, SUBMIT_EVENT } from '../learn/Questions'
import { Markdown } from '../components/Markdown'
import { Button, Dots, Field, Kbd, Modal, Pill, ProgressBar, Toggle, cx, Input } from '../components/ui'

const BATCH = 8

type Feedback = { kind: 'right'; takeaways: string[]; pro_tip: string } | { kind: 'wrong'; why_wrong: string; takeaways: string[]; how_to_remember: string }

interface Slot {
  answer: LearnAnswer | null
  mark: Mark | null
  attemptId: string | null
  marking: boolean
  feedback: Feedback | null
  feedbackError: string | null
  feedbackLoading: boolean
  overridden: boolean
  hints: string[]
}
const emptySlot = (): Slot => ({ answer: null, mark: null, attemptId: null, marking: false, feedback: null, feedbackError: null, feedbackLoading: false, overridden: false, hints: [] })

/** One turn in the session: which question (by its place in the plan) and how many times it's come back. */
type Turn = { base: number; retry: number }

export function Learn({ deckId, cardIds }: { deckId: string; cardIds?: string[] }) {
  const go = useStore((s) => s.go)
  const openExplain = useStore((s) => s.openExplain)
  const offline = useStore((s) => s.offline)
  const [session, setSession] = useState<{ id: string; total: number; settings: LearnSettings } | null>(null)
  const [questions, setQuestions] = useState<(LearnQuestion | undefined)[]>([])
  // idx is the position in `order`; questions[] stays indexed by the plan, so batches still land in place.
  const [idx, setIdx] = useState(0)
  const [order, setOrder] = useState<Turn[]>([])
  const [slots, setSlots] = useState<Record<number, Slot>>({})
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [finished, setFinished] = useState<{ answered: number; correct: number; partial: number; wrong: number } | null>(null)
  const [hinting, setHinting] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [actions, setActions] = useState<CustomAction[]>([])
  const [deckName, setDeckName] = useState('')
  const loading = useRef(new Set<number>())
  const [restartKey, setRestartKey] = useState(0)
  // Home offers Continue for a Learn session you quit before the end (it starts a new one on the deck).
  useStudySession(session && !error ? { name: 'learn', deckId, ...(cardIds?.length ? { cardIds } : {}) } : null, deckName, !!finished)

  const loadBatch = useCallback(
    async (sid: string, b: number) => {
      if (loading.current.has(b)) return
      loading.current.add(b)
      try {
        const qs = await api.learn.batch({ sessionId: sid, batch: b })
        setQuestions((cur) => {
          const next = [...cur]
          qs.forEach((q, i) => (next[b * BATCH + i] = q))
          return next
        })
      } catch (e) {
        loading.current.delete(b)
        setError(errorText(e))
      }
    },
    []
  )

  useEffect(() => {
    let alive = true
    loading.current = new Set()
    setQuestions([])
    setOrder([])
    setSlots({})
    setIdx(0)
    setFinished(null)
    setError(null)
    void api.decks.get({ id: deckId }).then((d) => setDeckName(d.name))
    void api.actions.list().then(setActions)
    // Turning offline mode on or off starts again, with questions made the new way.
    api.learn
      .start({ deckId, cardIds })
      .then((s) => {
        if (!alive) return
        setSession({ id: s.sessionId, total: s.total, settings: s.settings })
        setQuestions(Array(s.total).fill(undefined))
        setOrder(Array.from({ length: s.total }, (_, i) => ({ base: i, retry: 0 })))
        void loadBatch(s.sessionId, 0)
        // Prefetch the next batch straight away so there's never a wait.
        if (s.total > BATCH) void loadBatch(s.sessionId, 1)
      })
      .catch((e) => setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [deckId, cardIds, loadBatch, restartKey, offline])

  // Keep one batch ahead.
  useEffect(() => {
    if (!session) return
    const base = order[idx]?.base ?? idx
    const next = Math.floor(base / BATCH) + 1
    if (next * BATCH < session.total && base % BATCH >= 2) void loadBatch(session.id, next)
  }, [idx, order, session, loadBatch])

  const turn = order[idx]
  const base = turn?.base ?? idx
  // A missed question that comes back has its answers in new places.
  const asked = questions[base]
  const retryNo = turn?.retry ?? 0
  const q = useMemo(() => (asked && retryNo > 0 ? reshuffleLearnQuestion(asked, `retry${retryNo}`) : asked), [asked, retryNo])
  const slot = slots[idx] ?? emptySlot()
  const patchSlot = (i: number, p: Partial<Slot>) => setSlots((cur) => ({ ...cur, [i]: { ...(cur[i] ?? emptySlot()), ...p } }))

  const submit = async (a: LearnAnswer) => {
    if (!q || !session || slot.mark || slot.marking) return
    const at = idx
    patchSlot(at, { answer: a, marking: true })
    try {
      const r = await api.learn.submit({ sessionId: session.id, deckId, question: q, answer: a, retry: (turn?.retry ?? 0) > 0 })
      patchSlot(at, { mark: r.mark, attemptId: r.attemptId, marking: false })
      if (q.type === 'read_understand') next()
    } catch (e) {
      patchSlot(at, { marking: false, answer: null })
      toast(errorText(e), 'bad')
    }
  }

  const next = () => {
    if (!session) return
    let len = order.length
    // Not right yet: it comes back a few questions later, and again until it's right.
    if (slot.mark && slot.mark.verdict !== 'correct' && q?.type !== 'read_understand') {
      const updated = insertRetry(order, idx, { base: order[idx].base, retry: order[idx].retry + 1 }).list
      setOrder(updated)
      len = updated.length
    }
    if (idx + 1 >= len) return void finish()
    setIdx((i) => i + 1)
  }
  const finish = async () => {
    if (!session) return
    const stats = await api.learn.end({ sessionId: session.id }).catch(() => null)
    setFinished(stats ?? { answered: 0, correct: 0, partial: 0, wrong: 0 })
  }
  // Feedback is only written when asked for, and never blocks moving on.
  const getFeedback = () => {
    if (!slot.attemptId || slot.feedback || slot.feedbackLoading) return
    const at = idx
    patchSlot(at, { feedbackLoading: true, feedbackError: null })
    api.learn
      .feedback({ attemptId: slot.attemptId })
      .then((fb) => patchSlot(at, { feedback: fb as Feedback, feedbackLoading: false }))
      .catch((e) => patchSlot(at, { feedbackError: errorText(e), feedbackLoading: false }))
  }

  const hint = async () => {
    if (!q || slot.mark || slot.hints.length >= 2 || hinting) return
    setHinting(true)
    try {
      const r = await api.learn.hint({ cardId: q.card_id, question: q, index: slot.hints.length, previous: slot.hints })
      patchSlot(idx, { hints: [...slot.hints, r.hint] })
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setHinting(false)
    }
  }
  const override = async () => {
    if (!slot.attemptId || slot.mark?.verdict === 'correct') return
    try {
      const m = await api.learn.override({ attemptId: slot.attemptId })
      patchSlot(idx, { mark: m, overridden: true })
      const at = idx
      const attemptId = slot.attemptId
      toast('Marked as correct. Your schedule was updated.', 'good', { label: 'Undo', run: () => void undoOverride(at, attemptId) })
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  /** Take back "I was right": the first mark and the schedule it gave come back. */
  const undoOverride = async (at = idx, attemptId = slot.attemptId) => {
    if (!attemptId) return
    try {
      const m = await api.learn.undoOverride({ attemptId })
      patchSlot(at, { mark: m, overridden: false })
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const regenerate = async () => {
    if (!q || slot.mark || regenerating) return
    setRegenerating(true)
    try {
      const nq = await api.learn.regenerate({ deckId, question: q })
      setQuestions((cur) => cur.map((x, i) => (i === base ? nq : x)))
      setSlots((cur) => ({ ...cur, [idx]: emptySlot() }))
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setRegenerating(false)
    }
  }
  const explain = (mode = 'explain') => {
    if (!q) return
    const texts = slot.answer ? api.learn.texts({ question: q, answer: slot.answer }) : api.learn.texts({ question: q })
    void texts.then((t) =>
      openExplain({
        ctx: { cardId: q.card_id, deckId, question: t.question, userAnswer: t.answer, expectedAnswer: t.expected },
        title: t.question.split('\n')[0],
        mode
      })
    )
  }
  const runAction = (a: CustomAction) => {
    if (!q) return
    void api.learn.texts({ question: q, answer: slot.answer ?? undefined }).then((t) =>
      openExplain({ ctx: { cardId: q.card_id, deckId, question: t.question, userAnswer: t.answer, expectedAnswer: t.expected }, title: t.question.split('\n')[0], action: { id: a.id, name: a.name } })
    )
  }

  useCommands(
    {
      'learn.submit': () => {
        if (finished) return go({ name: 'deck', id: deckId })
        if (slot.mark) next()
        else if (q?.type === 'read_understand') void submit({ type: 'read_understand' })
        else window.dispatchEvent(new Event(SUBMIT_EVENT))
      },
      'learn.true': () => q?.type === 'true_false' && !slot.mark && submit({ type: 'true_false', value: true }),
      'learn.false': () => q?.type === 'true_false' && !slot.mark && submit({ type: 'true_false', value: false }),
      'learn.hint': hint,
      'learn.feedback': () => slot.mark && !offline && getFeedback(),
      'learn.skip': () => !slot.marking && next(),
      'learn.override': () => (slot.overridden ? undoOverride() : override()),
      'learn.regenerate': !offline && regenerate,
      'learn.settings': () => setSettingsOpen(true),
      'ai.explain': () => explain(),
      'study.end': () => (finished ? go({ name: 'deck', id: deckId }) : finish())
    },
    [q, slot, idx, order, session, finished, hinting, offline]
  )

  if (error)
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="pop-in flex max-w-md flex-col items-center gap-3 text-center">
          <XCircle className="size-10 text-bad" />
          <h2 className="text-xl font-semibold">Couldn’t start Learn</h2>
          <p className="text-muted">{error}</p>
          <div className="flex gap-2">
            <Button onClick={() => setSettingsOpen(true)}>Learn settings</Button>
            <Button variant="primary" onClick={() => go({ name: 'deck', id: deckId })}>
              Back to deck
            </Button>
          </div>
        </div>
        {settingsOpen && <LearnSettingsModal deckId={deckId} onClose={() => setSettingsOpen(false)} onRestart={() => (setSettingsOpen(false), setRestartKey((k) => k + 1))} />}
      </div>
    )

  if (finished) {
    const pct = finished.answered ? Math.round((finished.correct / finished.answered) * 100) : 0
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="pop-in flex w-full max-w-lg flex-col items-center gap-5 text-center">
          <div className="text-accent">
            <Trophy className="size-8" strokeWidth={1.6} />
          </div>
          <div>
            <h2 className="text-[2.2rem] leading-tight font-semibold tracking-tight">{pct >= 80 ? 'Great session' : pct >= 50 ? 'Nice work.' : 'Good practice.'}</h2>
            <p className="text-muted">{deckName}</p>
          </div>
          <div className="grid w-full grid-cols-3 gap-2.5">
            {[
              ['Correct', finished.correct, 'bg-good-soft text-good', CheckCircle2],
              ['Partial', finished.partial, 'bg-warn-soft text-warn', CircleDot],
              ['Wrong', finished.wrong, 'bg-bad-soft text-bad', XCircle]
            ].map(([label, n, cls, Icon]) => {
              const I = Icon as typeof CheckCircle2
              return (
                <div key={label as string} className={cx('rounded-xl p-4', cls as string)}>
                  <I className="mx-auto mb-1 size-5" />
                  <div className="text-3xl font-semibold">{n as number}</div>
                  <div className="text-[0.82rem] font-semibold">{label as string}</div>
                </div>
              )
            })}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => setRestartKey((k) => k + 1)}>
              Another round
            </Button>
            <Button onClick={() => go({ name: 'flashcards', deckId, mode: 'due' })}>Review due cards</Button>
            <Button variant="ghost" onClick={() => go({ name: 'deck', id: deckId })}>
              Back to deck <Kbd className="ml-1">↩</Kbd>
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const total = order.length || session?.total || 0
  const verdict = slot.mark?.verdict
  // Offline: no AI buttons at all (custom actions are AI too).
  const beforeActions = offline ? [] : actions.filter((a) => a.placements.includes('learn_question'))
  const afterActions = offline ? [] : actions.filter((a) => a.placements.includes('after_answer'))

  return (
    <div className="flex min-h-full flex-col px-[clamp(16px,3vw,40px)] pt-5 pb-10">
      <div className="mx-auto flex w-full max-w-[900px] items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => finish()} title="End session (esc)">
          <X className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[0.85rem] text-muted">
            <span className="truncate font-semibold">{deckName}</span>
            <span>
              {Math.min(idx + 1, total)} / {total}
            </span>
          </div>
          <div className="flex gap-1">
            {Array.from({ length: Math.min(total, 60) }).map((_, i) => {
              const s = slots[i]?.mark?.verdict
              return (
                <div
                  key={i}
                  className={cx(
                    'h-2 flex-1 rounded-full transition-colors duration-500',
                    s === 'correct' ? 'bg-good' : s === 'partial' ? 'bg-warn' : s === 'wrong' ? 'bg-bad' : i === idx ? 'bg-accent' : 'bg-surface-2'
                  )}
                />
              )
            })}
          </div>
          {total > 60 && <ProgressBar value={idx / total} className="mt-1 h-1" />}
        </div>
        <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} title={keyLabel("Learn settings (⌥⌘,)")}>
          <Settings2 className="size-5" />
        </Button>
      </div>

      <div className="mx-auto mt-6 w-full max-w-[900px] flex-1">
        {!q ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-muted">
              <Sparkles className="size-4 text-accent" /> {offline ? 'Getting questions ready' : 'Writing questions'} <Dots />
            </div>
            <div className="skeleton h-10 w-3/4" />
            <div className="grid gap-2.5 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton h-16" />
              ))}
            </div>
          </div>
        ) : (
          <div key={`${q.id}:${idx}`} className="pop-in" data-qtype={QUESTION_LABELS[q.type]}>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Pill tone="accent">{QUESTION_LABELS[q.type]}</Pill>
              {(turn?.retry ?? 0) > 0 && (
                <Pill tone="warn">
                  <RotateCcw className="size-3" /> Try again
                </Pill>
              )}
              {q.cached && (
                <Pill>
                  <Database className="size-3" /> cached
                </Pill>
              )}
              {offline && (
                <Pill tone="warn">
                  <WifiOff className="size-3" /> Offline
                </Pill>
              )}
              {/* The tools wrap as one right-aligned group rather than one button at a time. */}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
              {!slot.mark && q.type !== 'read_understand' && q.type !== 'match_pairs' && (
                <Button size="sm" variant="ghost" onClick={hint} loading={hinting} disabled={slot.hints.length >= 2}>
                  Hint {slot.hints.length > 0 && `${slot.hints.length}/2`}
                </Button>
              )}
              {!offline && !slot.mark && q.type !== 'match_pairs' && q.type !== 'fill_blank' && (
                <Button size="sm" variant="ghost" onClick={regenerate} loading={regenerating} title={keyLabel("Regenerate (⌥⌘R)")}>
                  Regenerate
                </Button>
              )}
              {!offline && (
                <Button size="sm" variant="ghost" onClick={() => explain()} title={keyLabel("Explain (⌘E)")}>
                  Explain
                </Button>
              )}
              {!slot.mark &&
                beforeActions.map((a) => (
                  <Button key={a.id} size="sm" variant="ghost" onClick={() => runAction(a)}>
                    {a.name}
                  </Button>
                ))}
              </div>
            </div>

            {slot.hints.length > 0 && (
              <div className="mb-4 flex flex-col gap-2">
                {slot.hints.map((h, i) => (
                  <div key={i} className="pop-in flex items-start gap-2 rounded-lg bg-warn-soft px-4 py-2.5 text-[0.95rem]">
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-warn" /> <span>{h}</span>
                  </div>
                ))}
              </div>
            )}

            <div className={cx('rounded-xl border bg-surface p-[clamp(18px,3.4vw,36px)] transition-colors duration-500', verdict === 'correct' ? 'border-good/50' : verdict === 'partial' ? 'border-warn/50' : verdict === 'wrong' ? 'border-bad/50' : 'border-line')}>
              <QuestionView q={q} mark={slot.mark} answer={slot.answer} onAnswer={submit} disabled={!!slot.mark || slot.marking} />
              {slot.marking && (
                <div className="mt-4 flex items-center gap-2 text-muted">
                  Marking <Dots />
                </div>
              )}
            </div>

            {slot.mark && q.type !== 'read_understand' && (
              <div className="pop-in mt-4 flex flex-col gap-3">
                <div
                  className={cx(
                    'flex flex-wrap items-center gap-3 rounded-xl px-5 py-4',
                    verdict === 'correct' ? 'bg-good-soft text-good' : verdict === 'partial' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad'
                  )}
                >
                  {verdict === 'correct' ? <CheckCircle2 className="size-6" /> : verdict === 'partial' ? <CircleDot className="size-6" /> : <XCircle className="size-6" />}
                  <span className="text-lg font-semibold">{verdict === 'correct' ? (slot.overridden ? 'Marked correct' : 'Correct!') : verdict === 'partial' ? 'Partly right' : 'Not quite'}</span>
                  <span className="flex-1" />
                  {verdict !== 'correct' && (
                    <Button size="sm" variant="outline" onClick={override} title="I was right (R)">
                      I was right
                    </Button>
                  )}
                  {slot.overridden && (
                    <Button size="sm" variant="outline" onClick={() => void undoOverride()} title="Undo: put back the original mark (R)">
                      <Undo2 className="size-4" /> Undo
                    </Button>
                  )}
                  <Button size="sm" variant="ink" onClick={next}>
                    Continue <Kbd className="ml-1 border-current/30">↩</Kbd>
                  </Button>
                </div>
                {offline ? (
                  verdict !== 'correct' && q.type === 'fill_blank' && <p className="text-[0.88rem] text-muted">Offline, a blank only counts when it matches exactly. If yours means the same, press I was right.</p>
                ) : (
                  <FeedbackPanel slot={slot} onFeedback={getFeedback} onExplain={explain} actions={afterActions} onAction={runAction} />
                )}
              </div>
            )}

            {!slot.mark && !slot.marking && (
              <div className="mt-4 flex justify-end">
                <Button size="sm" variant="ghost" onClick={next} title="Skip (S)">
                  Skip
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      {settingsOpen && <LearnSettingsModal deckId={deckId} onClose={() => setSettingsOpen(false)} onRestart={() => (setSettingsOpen(false), setRestartKey((k) => k + 1))} />}
    </div>
  )
}

function FeedbackPanel({
  slot,
  onFeedback,
  onExplain,
  actions,
  onAction
}: {
  slot: Slot
  onFeedback: () => void
  onExplain: (mode?: string) => void
  actions: CustomAction[]
  onAction: (a: CustomAction) => void
}) {
  const fb = slot.feedback
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      {slot.feedbackLoading && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[0.85rem] text-muted">
            <Sparkles className="size-4 text-accent" /> Writing feedback <Dots />
          </div>
          <div className="skeleton h-4 w-5/6" />
          <div className="skeleton h-4 w-2/3" />
        </div>
      )}
      {slot.feedbackError && <div className="mb-3 text-[0.9rem] text-muted">Feedback unavailable: {slot.feedbackError}</div>}
      {fb && (
        <div className="fade-in flex flex-col gap-4">
          {fb.kind === 'wrong' && (
            <section>
              <h3 className="mb-1 text-[0.78rem] font-semibold text-bad">Why your answer was wrong</h3>
              <Markdown>{fb.why_wrong}</Markdown>
            </section>
          )}
          <section>
            <h3 className="mb-1 text-[0.78rem] font-semibold text-muted">Key takeaways</h3>
            <ul className="flex flex-col gap-1.5">
              {fb.takeaways.map((t, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                  <Markdown>{t}</Markdown>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-lg bg-accent-soft p-4">
            <h3 className="mb-1 text-[0.78rem] font-semibold text-accent">{fb.kind === 'wrong' ? 'How to remember' : 'Pro tip'}</h3>
            <Markdown>{fb.kind === 'wrong' ? fb.how_to_remember : fb.pro_tip}</Markdown>
          </section>
        </div>
      )}
      <div className={cx('flex flex-wrap gap-2', (fb || slot.feedbackLoading) && 'mt-4')}>
        {!fb && !slot.feedbackLoading && (
          <Button size="sm" variant="primary" onClick={onFeedback} title="Get feedback (W)">
            Get feedback
          </Button>
        )}
        <Button size="sm" variant="soft" onClick={() => onExplain()}>
          Explain
        </Button>
        {slot.mark?.verdict !== 'correct' && (
          <Button size="sm" variant="soft" onClick={() => onExplain('why_wrong')}>
            Why is my answer wrong?
          </Button>
        )}
        {actions.map((a) => (
          <Button key={a.id} size="sm" variant="ghost" onClick={() => onAction(a)}>
            {a.name}
          </Button>
        ))}
      </div>
    </div>
  )
}

function LearnSettingsModal({ deckId, onClose, onRestart }: { deckId: string; onClose: () => void; onRestart: () => void }) {
  const [s, setS] = useState<LearnSettings | null>(null)
  useEffect(() => void api.learn.settings({ deckId }).then(setS), [deckId])
  if (!s) return null
  const save = async (restart: boolean) => {
    await api.learn.saveSettings({ deckId, settings: s })
    toast('Learn settings saved for this deck', 'good')
    if (restart) onRestart()
    else onClose()
  }
  const setType = (t: QuestionType, v: boolean) => setS({ ...s, types: { ...s.types, [t]: v } })
  return (
    <Modal
      open
      onClose={onClose}
      title="Learn settings"
      footer={
        <>
          <Button variant="ghost" onClick={() => save(false)}>
            Save
          </Button>
          <Button variant="primary" onClick={() => save(true)}>
            Save & restart
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div>
          <div className="mb-2 text-[0.8rem] font-semibold text-muted">Question types</div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {QUESTION_TYPES.map((t) => (
              <Toggle key={t} checked={s.types[t] !== false} onChange={(v) => setType(t, v)} label={QUESTION_LABELS[t]} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Session length">
            <Input type="number" min={1} max={500} value={s.sessionLength} onChange={(e) => setS({ ...s, sessionLength: Math.max(1, Math.min(500, Number(e.target.value) || 1)) })} />
          </Field>
          <Field label="Order">
            <div className="pt-2">
              <Toggle checked={s.shuffle} onChange={(v) => setS({ ...s, shuffle: v })} label="Shuffle" />
            </div>
          </Field>
        </div>
      </div>
    </Modal>
  )
}
