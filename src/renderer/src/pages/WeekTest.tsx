import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Brain, CheckCircle2, ClipboardCheck, Lightbulb, RotateCcw, Trophy, X, XCircle } from 'lucide-react'
import { WEEK_TEST_INFO, markCourseAnswer, shuffleOptions, type CourseAnswer, type WeekFull, type WeekTestQuestion } from '@shared/course'
import type { Mark } from '@shared/questions'
import { useStore } from '../lib/store'
import { useCommands } from '../lib/commands'
import { api, errorText } from '../lib/api'
import { IS_MOBILE } from '../lib/platform'
import { Markdown } from '../components/Markdown'
import { Button, Kbd, Pill, cx } from '../components/ui'
import { CourseQuestionView } from '../learn/CourseQuestions'
import { SUBMIT_EVENT } from '../learn/Questions'

interface Slot {
  answer: CourseAnswer | null
  mark: Mark | null
  hint: boolean
}

/** The questions in a new order, each with its options shuffled, every time you take it. */
function deal(questions: WeekTestQuestion[]): WeekTestQuestion[] {
  const qs = questions.map((q) => ({ ...q, ...shuffleOptions(q.options, q.answer) }))
  for (let i = qs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[qs[i], qs[j]] = [qs[j], qs[i]]
  }
  return qs
}

const pctText = (score: number, total: number) => `${Math.round((score / Math.max(1, total)) * 100)}%`

/**
 * A week's end-of-week test: multiple choice across the whole week, from
 * memory. Each answer is marked straight away with why; the score at the end
 * is saved as the last go (and the best, if it beats it).
 */
export function WeekTestPage({ courseId, weekId }: { courseId: string; weekId: string }) {
  const go = useStore((s) => s.go)
  const [week, setWeek] = useState<WeekFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped to take the test again: a fresh deal.
  const [run, setRun] = useState(0)
  const [at, setAt] = useState(-1) // -1: the intro; questions.length: the summary
  const [slots, setSlots] = useState<Record<number, Slot>>({})

  useEffect(() => {
    api.courses
      .get({ id: courseId })
      .then((c) => {
        const w = c.weeks.find((x) => x.id === weekId)
        if (!w) throw new Error('This week isn’t in the course any more.')
        if (!w.test?.questions.length) throw new Error(`${w.label} has no end-of-week test yet. Write one from the week page.`)
        setWeek(w)
      })
      .catch((e) => setError(errorText(e)))
  }, [courseId, weekId])

  const questions = useMemo(() => (week?.test ? deal(week.test.questions) : []), [week, run])
  const total = questions.length
  const leave = () => go({ name: 'week', courseId, weekId })
  const q = at >= 0 && at < total ? questions[at] : null
  const slot: Slot = slots[at] ?? { answer: null, mark: null, hint: false }
  const score = Object.values(slots).filter((s) => s.mark?.verdict === 'correct').length

  const submit = (a: CourseAnswer) => {
    if (!q || slot.mark) return
    setSlots((cur) => ({ ...cur, [at]: { ...slot, answer: a, mark: markCourseAnswer(q, a) } }))
  }
  const next = () => {
    if (at + 1 === total) {
      // The last question: save the score before the summary shows it.
      const got = Object.values(slots).filter((s) => s.mark?.verdict === 'correct').length
      void api.courses
        .weekTestScore({ weekId, score: got, total })
        .then(() => useStore.getState().bump())
        .catch(() => {})
    }
    setAt((i) => Math.min(total, i + 1))
  }
  const again = () => {
    setSlots({})
    setAt(0)
    setRun((r) => r + 1)
  }

  // Esc (End session) leaves the test, back to the week.
  useCommands({ 'study.end': leave }, [courseId, weekId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('[data-modal]')) return
      if (e.key === 'Escape') return leave()
      if (e.key !== 'Enter') return
      e.preventDefault()
      if (at === -1) setAt(0)
      else if (q && slot.mark) next()
      else if (q) window.dispatchEvent(new Event(SUBMIT_EVENT))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (error)
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <XCircle className="size-10 text-bad" />
          <p className="text-muted">{error}</p>
          <Button onClick={leave}>Back to the week</Button>
        </div>
      </div>
    )
  if (!week?.test) return null
  const test = week.test
  const level = WEEK_TEST_INFO[test.difficulty].label
  const verdict = slot.mark?.verdict

  return (
    <div className={cx('flex min-h-full flex-col px-[clamp(16px,3vw,40px)] pb-10', IS_MOBILE ? 'pt-2' : 'pt-5')}>
      <div className={cx('mx-auto flex w-full max-w-[860px] items-center', IS_MOBILE ? 'gap-1' : 'gap-3')}>
        <Button variant="ghost" size="sm" onClick={leave} title="Leave the test (esc)" aria-label="Exit test" className={cx('shrink-0', IS_MOBILE && 'size-10 px-0')}>
          <X className={IS_MOBILE ? 'size-5' : 'size-4'} /> {!IS_MOBILE && 'Exit test'}
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setAt((i) => Math.max(-1, i - 1))} disabled={at <= 0 || at >= total} title="Back a question">
          <ArrowLeft className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[0.85rem] text-muted">
            <span className="truncate font-semibold">
              {week.label} · end-of-week test · {level}
            </span>
            <span className="shrink-0 tabular">{at >= total ? 'Done' : at < 0 ? `${total} questions` : `${at + 1}${IS_MOBILE ? '/' : ' of '}${total}`}</span>
          </div>
          <div className="flex gap-1">
            {questions.map((_, i) => {
              const m = slots[i]?.mark
              return <div key={i} className={cx('h-2 flex-1 rounded-full transition-colors duration-500', m ? (m.verdict === 'correct' ? 'bg-good' : 'bg-bad') : i === at ? 'bg-accent' : 'bg-surface-2')} />
            })}
          </div>
        </div>
      </div>

      <div className={cx('mx-auto w-full max-w-[860px] flex-1', IS_MOBILE ? 'mt-4' : 'mt-7')}>
        {at === -1 && (
          <div className="pop-in flex flex-col items-start gap-4 rounded-xl border border-line bg-surface p-[clamp(18px,3.4vw,36px)]">
            <Brain className="size-8 text-accent" strokeWidth={1.6} />
            <h2 className="text-[clamp(1.4rem,2.6vw,1.9rem)] leading-tight font-semibold tracking-tight">End-of-week test</h2>
            <p className="text-muted">
              {total} multiple-choice questions across every topic of {week.label}, at <span className="font-semibold text-ink">{level.toLowerCase()}</span>. No notes: it’s from memory. Each one is marked as you go.
            </p>
            {test.best && (
              <p className="text-[0.9rem] text-muted">
                Best so far {test.best.score}/{test.best.total} ({pctText(test.best.score, test.best.total)}){test.last && test.last.at !== test.best.at ? ` · last time ${test.last.score}/${test.last.total}` : ''}.
              </p>
            )}
            <Button variant="primary" size="lg" onClick={() => setAt(0)}>
              Start the test <Kbd className="ml-1 border-current/30">↩</Kbd>
            </Button>
          </div>
        )}

        {q && (
          <div key={`${run}:${at}`} className="pop-in">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Pill tone="accent">Multiple choice</Pill>
              {q.topic && <span className="truncate text-[0.85rem] text-muted">{q.topic}</span>}
              <span className="flex-1" />
              {!slot.mark && q.hint && (
                <Button size="sm" variant="ghost" onClick={() => setSlots((cur) => ({ ...cur, [at]: { ...slot, hint: true } }))} disabled={slot.hint}>
                  <Lightbulb className="size-4" /> Hint
                </Button>
              )}
            </div>
            {slot.hint && !slot.mark && (
              <div className="pop-in mb-4 flex items-start gap-2 rounded-lg bg-warn-soft px-4 py-2.5 text-[0.95rem]">
                <Lightbulb className="mt-0.5 size-4 shrink-0 text-warn" /> <span>{q.hint}</span>
              </div>
            )}
            <div className={cx('rounded-xl border bg-surface p-[clamp(18px,3.4vw,36px)] transition-colors duration-500', verdict === 'correct' ? 'border-good/50' : verdict ? 'border-bad/50' : 'border-line')}>
              <CourseQuestionView q={q} qid={`${weekId}:${run}:${at}`} mark={slot.mark} answer={slot.answer} onAnswer={submit} disabled={!!slot.mark} />
            </div>
            {slot.mark && (
              <div className="pop-in mt-4 flex flex-col gap-3">
                <div className={cx('flex flex-wrap items-center gap-3 rounded-xl px-5 py-4', verdict === 'correct' ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad')}>
                  {verdict === 'correct' ? <CheckCircle2 className="size-6" /> : <XCircle className="size-6" />}
                  <span className="text-lg font-semibold">{verdict === 'correct' ? 'Correct!' : 'Not quite'}</span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ink" onClick={next}>
                    {at + 1 === total ? 'See your score' : 'Continue'} <Kbd className="ml-1 border-current/30">↩</Kbd>
                  </Button>
                </div>
                {q.why && (
                  <div className="rounded-xl border border-line bg-surface p-5">
                    <h3 className="mb-1 text-[0.78rem] font-semibold text-muted">Why</h3>
                    <Markdown>{q.why}</Markdown>
                  </div>
                )}
              </div>
            )}
            {!slot.mark && (
              <div className="mt-4 flex justify-end">
                <Button size="sm" variant="ghost" onClick={next}>
                  Skip
                </Button>
              </div>
            )}
          </div>
        )}

        {at >= total && total > 0 && <Summary questions={questions} slots={slots} score={score} label={week.label} onAgain={again} onWeek={leave} />}
      </div>
    </div>
  )
}

function Summary({ questions, slots, score, label, onAgain, onWeek }: { questions: WeekTestQuestion[]; slots: Record<number, Slot>; score: number; label: string; onAgain: () => void; onWeek: () => void }) {
  const total = questions.length
  const pct = score / Math.max(1, total)
  // How you did on each topic, weakest first, so you know what to go back over.
  const topics = useMemo(() => {
    const m = new Map<string, { got: number; of: number }>()
    questions.forEach((q, i) => {
      const k = q.topic || 'Other'
      const t = m.get(k) ?? { got: 0, of: 0 }
      t.of += 1
      if (slots[i]?.mark?.verdict === 'correct') t.got += 1
      m.set(k, t)
    })
    return [...m.entries()].sort((a, b) => a[1].got / a[1].of - b[1].got / b[1].of)
  }, [questions, slots])
  const missed = questions.map((q, i) => ({ q, s: slots[i] })).filter((x) => x.s?.mark?.verdict !== 'correct')
  return (
    <div className="pop-in mx-auto flex w-full max-w-2xl flex-col items-center gap-5 pt-6 text-center">
      <Trophy className="size-8 text-accent" strokeWidth={1.6} />
      <div>
        <h2 className="text-[2rem] leading-tight font-semibold tracking-tight">{pct >= 0.8 ? 'Test done. Nice.' : pct >= 0.5 ? 'Test done.' : 'Test done. Worth another go.'}</h2>
        <p className="text-muted">{label} · end-of-week test</p>
      </div>
      <div className="w-full rounded-xl bg-surface-2 p-4">
        <div className="text-3xl font-semibold">{pctText(score, total)}</div>
        <div className="text-[0.82rem] font-semibold text-muted">
          {score}/{total} correct
        </div>
      </div>
      {topics.length > 1 && (
        <div className="w-full rounded-xl border border-line bg-surface p-4 text-left">
          <h3 className="mb-2 text-[0.78rem] font-semibold text-muted">By topic</h3>
          <ul className="flex flex-col gap-1.5">
            {topics.map(([t, r]) => (
              <li key={t} className="flex items-center gap-3 text-[0.92rem]">
                <span className="min-w-0 flex-1 truncate">{t}</span>
                <span className={cx('tabular font-semibold', r.got === r.of ? 'text-good' : r.got / r.of < 0.5 ? 'text-bad' : 'text-warn')}>
                  {r.got}/{r.of}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {missed.length > 0 && (
        <details className="w-full rounded-xl border border-line bg-surface p-4 text-left">
          <summary className="cursor-pointer text-[0.92rem] font-semibold">
            The {missed.length} you missed{missed.length === total ? '' : ' or skipped'}
          </summary>
          <ol className="mt-3 flex flex-col gap-4">
            {missed.map(({ q }, i) => (
              <li key={i} className="flex flex-col gap-1">
                <Markdown className="font-semibold">{q.q}</Markdown>
                <div className="text-[0.92rem] text-good">✓ {q.options[q.answer]}</div>
                {q.why && <Markdown className="text-[0.88rem] text-muted">{q.why}</Markdown>}
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={onAgain}>
          <RotateCcw className="size-4" /> Take it again
        </Button>
        <Button variant="outline" onClick={onWeek}>
          <ClipboardCheck className="size-4" /> Back to the week
        </Button>
      </div>
    </div>
  )
}
