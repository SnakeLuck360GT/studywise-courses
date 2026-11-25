import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Lightbulb, CheckCircle2, XCircle, CircleDot, BookOpen, Trophy, Brain, ArrowRight, Sparkles, Shuffle, NotebookPen, RotateCcw, RefreshCw, HelpCircle, ClipboardCheck, ArrowLeft, Undo2, ChevronDown, Check } from 'lucide-react'
import {
  COURSE_QUESTION_LABELS,
  NOTE_LEVELS,
  NOTE_LEVEL_INFO,
  expectedText,
  markCourseAnswer,
  questionText,
  questionHints,
  reshuffleQuestion,
  shuffleMcqs,
  type CourseAnswer,
  type NoteLevel,
  type CourseQuestion,
  type Topic,
  type TopicProgress,
  type TopicSection
} from '@shared/course'
import type { Mark } from '@shared/questions'
import type { Card } from '@shared/types'
import { useStore, toast, rememberCoursesPlace } from '../lib/store'
import { useStudySession } from '../lib/lastSession'
import { IS_MOBILE } from '../lib/platform'
import { api, errorText, streamCall } from '../lib/api'
import { Markdown } from '../components/Markdown'
import { Button, Dots, Kbd, Menu, MenuItem, Modal, Pill, Textarea, cx } from '../components/ui'
import { switchLevel } from '../lib/courseFlows'
import { CourseQuestionView } from '../learn/CourseQuestions'
import { insertRetry } from '@shared/retry'
import { GREENS_TO_PASS, RED_GAP, nextPile, type PileRating } from '@shared/cardPile'
import { DEFAULT_SCHEDULER } from '@shared/scheduler'
import { SUBMIT_EVENT } from '../learn/Questions'

/** Chance of a surprise recall card from another topic after a section. */
const RECALL_CHANCE = 0.25

type Step =
  | { kind: 'notes'; section: number }
  /** The section's flashcards, between its notes and its questions. */
  | { kind: 'cards'; section: number }
  // section -1 = topic check; retry counts how many times it's come back
  | { kind: 'q'; section: number; index: number; q: CourseQuestion; retry?: number }
  | { kind: 'recall'; after: number }
  | { kind: 'check_intro' }
  | { kind: 'summary' }

interface Slot {
  answer: CourseAnswer | null
  mark: Mark | null
  marking: boolean
  /** How many of the question's hints you've asked for. */
  hint: number
  correction: string
  overridden: boolean
  /** The mark before "I was right", so it can be undone. */
  before?: Mark | null
  /** Already queued to come back, so going back and continuing again doesn't add it twice. */
  requeued?: boolean
}
const emptySlot = (): Slot => ({ answer: null, mark: null, marking: false, hint: 0, correction: '', overridden: false })

/** Learning: each section's notes, flashcards and questions. The test (the topic's check questions) is separate, started from the course page. */
function buildSteps(t: Topic, test: boolean, offline = false): Step[] {
  const c = t.content!
  const steps: Step[] = []
  // Offline leaves out written answers (only AI can mark them); the rest keep their numbers, so your place still resumes.
  const ask = (q: CourseQuestion) => !(offline && q.type === 'explain')
  // Answers go in new places every time you do the topic or the test again.
  if (test) {
    steps.push({ kind: 'check_intro' })
    shuffleMcqs(c.check).forEach((q, j) => ask(q) && steps.push({ kind: 'q', section: -1, index: j, q }))
    steps.push({ kind: 'summary' })
    return steps
  }
  c.sections.forEach((s, i) => {
    steps.push({ kind: 'notes', section: i })
    if (s.cards?.length) steps.push({ kind: 'cards', section: i })
    shuffleMcqs(s.questions).forEach((q, j) => ask(q) && steps.push({ kind: 'q', section: i, index: j, q }))
    // Never two recall cards in a row: there's always a section between them.
    if (i < c.sections.length - 1 && Math.random() < RECALL_CHANCE) steps.push({ kind: 'recall', after: i })
  })
  steps.push({ kind: 'summary' })
  return steps
}

const credit = (m: Mark | null) => (!m ? 0 : m.verdict === 'correct' ? 1 : m.verdict === 'partial' ? 0.5 : 0)

/** Put a missed question back in a few steps on (answers in new places), always before the summary. */
function withRetry(steps: Step[], at: number): Step[] {
  const s = steps[at]
  if (!s || s.kind !== 'q') return steps
  const summary = steps.findIndex((x) => x.kind === 'summary')
  return insertRetry(steps, at, { ...s, q: reshuffleQuestion(s.q), retry: (s.retry ?? 0) + 1 }, summary === -1 ? steps.length : summary).list
}

/** Where you are in a set of key-term cards: the pile still to go, how often each came back, and its greens. */
interface CardsState {
  queue: number[]
  tries: Record<number, number>
  /** Times you've said "Knew it" (green). Two greens and the card is done. */
  greens?: Record<number, number>
  /** Cards already rated for spaced repetition in this pile (only your first rating counts). */
  rated?: Record<number, true>
}

/**
 * Learning sessions kept while the app is open: leave a topic (another tab, the
 * course page) and come back, and you carry on exactly where you were, answers,
 * questions to try again and the card pile included. Across restarts the saved
 * step (progress.step) is the fallback.
 */
interface TopicSession {
  content: string
  steps: Step[]
  at: number
  slots: Record<number, Slot>
  cards: Record<number, CardsState>
  /** Changes each time the topic starts over, so shuffled questions shuffle differently. */
  run: string
}
const sessions = new Map<string, TopicSession>()

export function TopicPage({ id, section, test = false }: { id: string; section?: number; test?: boolean }) {
  const go = useStore((s) => s.go)
  const openExplain = useStore((s) => s.openExplain)
  const offline = useStore((s) => s.offline)
  const [topic, setTopic] = useState<Topic | null>(null)
  const [siblings, setSiblings] = useState<Topic[]>([])
  const [error, setError] = useState<string | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [at, setAt] = useState(0)
  const [slots, setSlots] = useState<Record<number, Slot>>({})
  const [notesOpen, setNotesOpen] = useState(false)
  const [rewriteOpen, setRewriteOpen] = useState(false)
  /** Bumped after switching depth, to load the topic again at that depth. */
  const [reloadKey, setReloadKey] = useState(0)
  const progress = useRef<TopicProgress | null>(null)
  const sessionKey = `${id}:${test ? 'test' : 'learn'}`
  const cards = useRef<Record<number, CardsState>>({})
  const contentKey = useRef('')
  const run = useRef(Math.random().toString(36).slice(2, 8))

  useEffect(() => {
    let alive = true
    api.courses
      .topic({ id })
      .then(async (t) => {
        if (!alive) return
        if (!t.content) throw new Error('This topic hasn’t been written yet.')
        if (test && !t.content.check.length) throw new Error('This topic has no test questions. Write it again to get some.')
        if (test && offline && t.content.check.every((q) => q.type === 'explain'))
          throw new Error('This topic’s test is all written answers, which only AI can mark. Turn off offline mode to take it.')
        const p = t.progress
        // A session kept from before offline mode changed has the wrong questions in it, so it starts fresh from your saved place.
        contentKey.current = `${offline ? 'offline:' : ''}${JSON.stringify(t.content)}`
        // Carry on exactly where you were, unless you picked a section, the topic was
        // rewritten, or its progress was reset since.
        const kept = sessions.get(sessionKey)
        const reset = !test && !p.done && p.section === 0 && !p.step && !p.lastStudied
        if (kept && section === undefined && kept.content === contentKey.current && !reset) {
          progress.current = { ...p }
          cards.current = kept.cards
          run.current = kept.run
          setTopic(t)
          setSteps(kept.steps)
          setAt(kept.at)
          // An answer still being marked when you left is asked again.
          setSlots(Object.fromEntries(Object.entries(kept.slots).map(([k, v]) => [k, v.marking ? { ...v, marking: false, answer: null } : v])))
          const c = await api.courses.get({ id: t.course_id })
          if (alive) setSiblings(c.weeks.flatMap((w) => w.topics))
          return
        }
        sessions.delete(sessionKey)
        cards.current = {}
        run.current = Math.random().toString(36).slice(2, 8)
        const s = buildSteps(t, test, offline)
        // Open at the section picked on the week page, or resume where you left off; a
        // finished topic starts over. A test always starts at the beginning.
        let start = 0
        if (!test && section !== undefined && section >= 0 && section < t.content.sections.length) {
          start = Math.max(0, s.findIndex((x) => x.kind === 'notes' && x.section === section))
        } else if (!test && !p.done && (p.section > 0 || p.step)) {
          // The exact step you saved at, else the start of that section.
          const exact = p.step ? s.findIndex((x) => x.kind === p.step!.kind && 'section' in x && x.section === p.step!.section && (x.kind !== 'q' || (x.index === p.step!.index && !x.retry))) : -1
          const i = exact >= 0 ? exact : p.section >= t.content.sections.length ? s.findIndex((x) => x.kind === 'summary') : s.findIndex((x) => x.kind === 'notes' && x.section === p.section)
          start = Math.max(0, i)
        }
        progress.current = p.done && !test ? { ...p, section: 0, answered: 0, correct: 0, step: null } : { ...p }
        setTopic(t)
        setSteps(s)
        setAt(start)
        setSlots({})
        const c = await api.courses.get({ id: t.course_id })
        if (alive) setSiblings(c.weeks.flatMap((w) => w.topics))
      })
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [id, section, test, offline, reloadKey])

  // Keep the session up to date as you go; a finished one is let go, so Again starts over.
  useEffect(() => {
    if (!topic || !steps.length) return
    if (steps[at]?.kind === 'summary') {
      sessions.delete(sessionKey)
      // Done: the Courses tab goes back to the week rather than into a finished topic.
      rememberCoursesPlace({ name: 'week', courseId: topic.course_id, weekId: topic.week_id })
      return
    }
    sessions.set(sessionKey, { content: contentKey.current, steps, at, slots, cards: cards.current, run: run.current })
  }, [topic, steps, at, slots, sessionKey])

  const step = steps[at]
  // Home offers Continue for a topic (or test) left partway through.
  useStudySession(topic?.content ? { name: 'topic', id, ...(test ? { test: true } : {}) } : null, topic?.content?.title ?? '', step?.kind === 'summary')
  const slot = slots[at] ?? emptySlot()
  const patch = (i: number, p: Partial<Slot>) => setSlots((cur) => ({ ...cur, [i]: { ...(cur[i] ?? emptySlot()), ...p } }))

  const save = (p: Partial<TopicProgress>) => {
    if (!progress.current || !topic) return
    progress.current = { ...progress.current, ...p }
    void api.courses.progress({ topicId: topic.id, progress: progress.current }).catch(() => {})
  }

  // Remember where you are, and wrap up at the end.
  useEffect(() => {
    if (!step || !topic?.content) return
    // Learning saves your place at every step, so leaving and coming back carries on exactly here.
    if (!test && (step.kind === 'notes' || step.kind === 'cards' || (step.kind === 'q' && step.section >= 0 && !step.retry)))
      save({ section: step.section, step: { kind: step.kind, section: step.section, ...(step.kind === 'q' ? { index: step.index } : {}) } })
    if (step.kind === 'summary') {
      if (test) {
        // Only your first try at each question counts.
        const checks = steps.map((s, i) => [s, i] as const).filter(([s]) => s.kind === 'q' && s.section === -1 && !s.retry)
        const score = checks.reduce((n, [, i]) => n + credit(slots[i]?.mark ?? null), 0)
        save({ checkScore: Math.round(score * 10) / 10, checkTotal: checks.length })
      } else save({ section: topic.content.sections.length, done: true, step: null })
      useStore.getState().bump()
    }
  }, [at, step?.kind])

  /** One step back: from questions to the notes, from a section to the one before. Answers you gave stay as they were. */
  const back = () => setAt((i) => Math.max(0, i - 1))

  const next = () => {
    // Not right yet: it comes back a little later in this session.
    if (step?.kind === 'q' && slot.mark && slot.mark.verdict !== 'correct' && !slot.requeued) {
      patch(at, { requeued: true })
      const updated = withRetry(steps, at)
      setSteps(updated)
      setAt(Math.min(updated.length - 1, at + 1))
      return
    }
    setAt((i) => Math.min(steps.length - 1, i + 1))
  }

  const submit = async (a: CourseAnswer) => {
    if (!step || step.kind !== 'q' || !topic || slot.mark || slot.marking) return
    const i = at
    const q = step.q
    patch(i, { answer: a, marking: true })
    try {
      let mark: Mark | null
      let correction = ''
      if (q.type === 'explain') {
        const r = await api.courses.mark({ courseId: topic.course_id, topicId: topic.id, question: q, answer: a.type === 'free_answer' ? a.text : '' })
        mark = r.mark
        correction = r.wrong
      } else mark = markCourseAnswer(q, a)
      patch(i, { mark, marking: false, correction })
      if (progress.current && !step.retry && !test) save({ answered: progress.current.answered + 1, correct: progress.current.correct + credit(mark) })
    } catch (e) {
      patch(i, { marking: false, answer: null })
      toast(errorText(e), 'bad')
    }
  }

  const counts = () => !(step?.kind === 'q' && step.retry) && !test
  const override = () => {
    if (!slot.mark || slot.mark.verdict === 'correct' || !progress.current) return
    const before = credit(slot.mark)
    // An essay question you say you got right gets full marks too.
    const marks = slot.mark.detail?.marks
    const detail = marks ? { ...slot.mark.detail, marks: { ...marks, got: marks.total } } : slot.mark.detail
    patch(at, { mark: { ...slot.mark, score: 10, verdict: 'correct', detail }, overridden: true, before: slot.mark })
    if (counts()) save({ correct: progress.current.correct + 1 - before })
  }
  /** Take back "I was right": the original mark comes back (and it'll come round again if it was wrong). */
  const undoOverride = () => {
    if (!slot.overridden || !slot.before || !progress.current) return
    const was = slot.before
    patch(at, { mark: was, overridden: false, before: null })
    if (counts()) save({ correct: progress.current.correct - 1 + credit(was) })
  }

  const explain = () => {
    if (!step || step.kind !== 'q' || !topic?.content) return
    const sec = step.section >= 0 ? topic.content.sections[step.section] : null
    const userAnswer = slot.answer?.type === 'free_answer' ? slot.answer.text : slot.mark ? (slot.mark.verdict === 'correct' ? '(answered correctly)' : '(answered incorrectly)') : null
    openExplain({
      ctx: { question: questionText(step.q), expectedAnswer: expectedText(step.q), userAnswer, selection: sec ? `${sec.heading}\n\n${sec.notes}` : null },
      title: questionText(step.q).split('\n')[0],
      mode: slot.mark && slot.mark.verdict !== 'correct' ? 'why_wrong' : 'explain'
    })
  }

  /** Ask about a section. Nothing runs until you type a question or pick Simpler/Example/…, and only the section's notes are sent. */
  const askAbout = (sec: TopicSection) =>
    openExplain({ ctx: { selection: `${sec.heading}\n\n${sec.notes}` }, title: sec.heading, mode: 'explain' })

  const rewrite = async (instructions: string, level: NoteLevel) => {
    if (!topic) return
    try {
      await api.courses.write({ topicIds: [topic.id], instructions, levels: [level] })
      setRewriteOpen(false)
      toast('Rewriting this topic. It’ll be ready on the week page.', 'good')
      go({ name: 'week', courseId: topic.course_id, weekId: topic.week_id })
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }

  // Keys: ↩ continues or submits, t/f for true or false, h for a hint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('[data-modal]')) return
      if (!step) return
      if (e.key === 'Escape') {
        if (!test && step.kind !== 'summary') toast('Progress saved. You’ll carry on from here.', 'good')
        return void go({ name: 'week', courseId: topic!.course_id, weekId: topic!.week_id })
      }
      if ((e.key === 'b' || e.key === 'B') && step.kind !== 'cards') return void back()
      if (step.kind === 'notes' || step.kind === 'check_intro') {
        if (e.key === 'Enter') (e.preventDefault(), next())
        return
      }
      if (step.kind !== 'q') return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (slot.mark) next()
        else window.dispatchEvent(new Event(SUBMIT_EVENT))
      } else if (!slot.mark && step.q.type === 'true_false' && (e.key === 't' || e.key === 'f')) void submit({ type: 'true_false', value: e.key === 't' })
      else if (!slot.mark && e.key === 'h' && step?.kind === 'q') patch(at, { hint: Math.min(questionHints(step.q).length, Number(slot.hint) + 1) })
      else if (slot.mark && e.key === 'r') slot.overridden ? undoOverride() : override()
      else if (slot.overridden && e.key === 'u') undoOverride()
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
          <Button onClick={() => history.length && useStore.getState().goBack()}>Back</Button>
        </div>
      </div>
    )
  if (!topic?.content || !step) return null
  const content = topic.content
  const sectionCount = content.sections.length
  const curSection = step.kind === 'notes' || step.kind === 'cards' || step.kind === 'q' ? step.section : step.kind === 'recall' ? step.after : sectionCount
  // Test questions being asked (offline leaves out written answers).
  const qCount = test ? steps.filter((s) => s.kind === 'q' && s.section === -1 && !s.retry).length : content.check.length
  const qDone = steps.slice(0, at).filter((s) => s.kind === 'q' && s.section === -1 && !s.retry).length
  const idx = siblings.findIndex((t) => t.id === topic.id)
  const nextTopic = siblings.slice(idx + 1).find((t) => t.status === 'ready' && !t.progress.done)
  const verdict = slot.mark?.verdict
  // Hints come one at a time, only when asked for.
  const hints = step?.kind === 'q' ? questionHints(step.q) : []
  const shownHints = Math.min(hints.length, Number(slot.hint) || 0)

  return (
    <div className={cx('flex min-h-full flex-col px-[clamp(16px,3vw,40px)] pb-10', IS_MOBILE ? 'pt-2' : 'pt-5')}>
      <div className={cx('mx-auto flex w-full max-w-[860px] items-center', IS_MOBILE ? 'gap-1' : 'gap-3')}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // Your place is saved at every step; this just says so on the way out.
            if (!test && step.kind !== 'summary') toast('Progress saved. You’ll carry on from here.', 'good')
            go({ name: 'week', courseId: topic.course_id, weekId: topic.week_id })
          }}
          title={test ? 'Leave the test (esc)' : 'Save your place and go back to the week (esc)'}
          aria-label={test ? 'Exit test' : 'Save and exit'}
          className={cx('shrink-0', IS_MOBILE && 'size-10 px-0')}
        >
          <X className={IS_MOBILE ? 'size-5' : 'size-4'} /> {!IS_MOBILE && (test ? 'Exit test' : 'Save & exit')}
        </Button>
        <Button variant="ghost" size="icon" onClick={back} disabled={at === 0} title="Back a step (B)">
          <ArrowLeft className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-[0.85rem] text-muted">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate font-semibold">{content.title}</span>
              {!test && topic.levels.length > 1 ? (
                // Written at more than one depth: switch here, and carry on from your place at that depth.
                <Menu
                  trigger={(open) => (
                    <button onClick={open} className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 font-normal hover:bg-surface-2 hover:text-ink" title="Switch depth">
                      · {NOTE_LEVEL_INFO[topic.level].label}
                      <ChevronDown className="size-3.5" />
                    </button>
                  )}
                >
                  {(close) =>
                    topic.levels.map((l) => (
                      <MenuItem
                        key={l}
                        icon={l === topic.level ? <Check className="size-4" /> : <span className="size-4" />}
                        onClick={() => {
                          close()
                          if (l !== topic.level) void switchLevel(topic, l).then((t) => t && setReloadKey((k) => k + 1))
                        }}
                      >
                        {NOTE_LEVEL_INFO[l].label}
                      </MenuItem>
                    ))
                  }
                </Menu>
              ) : (
                (topic.levels.length > 1 || topic.level !== 'standard') && <span className="shrink-0 font-normal"> · {NOTE_LEVEL_INFO[topic.level].label}</span>
              )}
            </span>
            <span className="shrink-0 tabular">
              {test
                ? step.kind === 'summary'
                  ? 'Done'
                  : `${IS_MOBILE ? '' : 'Topic test · '}${Math.min(qDone + (step.kind === 'q' ? 1 : 0), qCount)}${IS_MOBILE ? '/' : ' of '}${qCount}`
                : step.kind === 'summary'
                  ? 'Done'
                  : IS_MOBILE
                    ? `${Math.min(curSection + 1, sectionCount)}/${sectionCount}`
                    : `Section ${Math.min(curSection + 1, sectionCount)} of ${sectionCount}`}
            </span>
          </div>
          <div className="flex gap-1">
            {test
              ? Array.from({ length: qCount }, (_, i) => (
                  <div key={i} className={cx('h-2 flex-1 rounded-full transition-colors duration-500', i < qDone || step.kind === 'summary' ? 'bg-good' : i === qDone && step.kind === 'q' ? 'bg-accent' : 'bg-surface-2')} />
                ))
              : content.sections.map((_, i) => (
                  <div key={i} className={cx('h-2 flex-1 rounded-full transition-colors duration-500', i < curSection || step.kind === 'summary' ? 'bg-good' : i === curSection ? 'bg-accent' : 'bg-surface-2')} />
                ))}
          </div>
        </div>
        {/* A test is from memory: no notes, and nothing to rewrite mid-test. */}
        {!test && (
          <>
            {!offline && (
              <Button variant="ghost" size="icon" className="desktop-only" onClick={() => setRewriteOpen(true)} title="Rewrite this topic">
                <RefreshCw className="size-5" />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => setNotesOpen(true)} title="All notes so far">
              <BookOpen className="size-5" />
            </Button>
          </>
        )}
      </div>

      <div className={cx('mx-auto w-full max-w-[860px] flex-1', IS_MOBILE ? 'mt-4' : 'mt-7')}>
        {step.kind === 'notes' && <NotesStep key={at} section={content.sections[step.section]} first={step.section === 0} goal={content.goal} onNext={next} onAsk={offline ? null : () => askAbout(content.sections[step.section])} />}

        {step.kind === 'cards' && (
          <CardsStep
            key={at}
            cards={content.sections[step.section].cards ?? []}
            section={content.sections[step.section]}
            topicId={topic.id}
            saved={cards.current[at]}
            onSave={(st) => {
              cards.current = { ...cards.current, [at]: st }
              sessions.set(sessionKey, { content: contentKey.current, steps, at, slots, cards: cards.current, run: run.current })
            }}
            onNext={next}
            onBack={back}
          />
        )}

        {step.kind === 'recall' && <RecallStep key={at} courseId={topic.course_id} topicId={topic.id} onNext={next} />}

        {step.kind === 'check_intro' && (
          <div className="pop-in flex flex-col items-start gap-4 rounded-xl border border-line bg-surface p-[clamp(18px,3.4vw,36px)]">
            <Brain className="size-8 text-accent" strokeWidth={1.6} />
            <h2 className="text-[clamp(1.4rem,2.6vw,1.9rem)] leading-tight font-semibold tracking-tight">Topic test</h2>
            <p className="text-muted">
              {qCount} questions across the whole topic, a bit harder than the ones while you learn it. No notes this time. Only your first try at each counts towards your score.
              {offline && qCount < content.check.length && ` Offline mode leaves out ${content.check.length - qCount} written ${content.check.length - qCount === 1 ? 'answer' : 'answers'}, since only AI can mark them.`}
            </p>
            <Button variant="primary" size="lg" onClick={next}>
              Start the test <Kbd className="ml-1 border-current/30">↩</Kbd>
            </Button>
          </div>
        )}

        {step.kind === 'q' && (
          <div key={at} className="pop-in">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Pill tone="accent">{COURSE_QUESTION_LABELS[step.q.type]}</Pill>
              {step.retry ? (
                <Pill tone="warn">
                  <RotateCcw className="size-3" /> Try again
                </Pill>
              ) : null}
              <span className="flex-1" />
              {!slot.mark && hints.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => patch(at, { hint: shownHints + 1 })} disabled={shownHints >= hints.length} title="Hint (H)">
                  <Lightbulb className="size-4" /> {shownHints === 0 ? 'Hint' : shownHints < hints.length ? `Another hint (${shownHints + 1} of ${hints.length})` : 'No more hints'}
                </Button>
              )}
              {!offline && (
                <Button size="sm" variant="ghost" onClick={explain} title="Explain">
                  Explain
                </Button>
              )}
            </div>
            {shownHints > 0 && !slot.mark && (
              <div className="pop-in mb-4 flex flex-col gap-1.5 rounded-lg bg-warn-soft px-4 py-2.5 text-[0.95rem]">
                {hints.slice(0, shownHints).map((h, i) => (
                  <div key={i} className="pop-in flex items-start gap-2">
                    <Lightbulb className="mt-0.5 size-4 shrink-0 text-warn" /> <span>{h}</span>
                  </div>
                ))}
              </div>
            )}
            <div className={cx('rounded-xl border bg-surface p-[clamp(18px,3.4vw,36px)] transition-colors duration-500', verdict === 'correct' ? 'border-good/50' : verdict === 'partial' ? 'border-warn/50' : verdict === 'wrong' ? 'border-bad/50' : 'border-line')}>
              <CourseQuestionView q={step.q} qid={`${topic.id}:${run.current}:${at}`} mark={slot.mark} answer={slot.answer} onAnswer={submit} disabled={!!slot.mark || slot.marking} />
              {slot.marking && (
                <div className="mt-4 flex items-center gap-2 text-muted">
                  Marking <Dots />
                </div>
              )}
            </div>
            {slot.mark && (
              <div className="pop-in mt-4 flex flex-col gap-3">
                <div className={cx('flex flex-wrap items-center gap-3 rounded-xl px-5 py-4', verdict === 'correct' ? 'bg-good-soft text-good' : verdict === 'partial' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad')}>
                  {verdict === 'correct' ? <CheckCircle2 className="size-6" /> : verdict === 'partial' ? <CircleDot className="size-6" /> : <XCircle className="size-6" />}
                  <span className="text-lg font-semibold">{verdict === 'correct' ? (slot.overridden ? 'Marked correct' : 'Correct!') : verdict === 'partial' ? 'Partly right' : 'Not quite'}</span>
                  <span className="flex-1" />
                  {verdict !== 'correct' && (
                    <Button size="sm" variant="outline" onClick={override} title="I was right (R)">
                      I was right
                    </Button>
                  )}
                  {slot.overridden && (
                    <Button size="sm" variant="outline" onClick={undoOverride} title="Undo: put back the original mark (U)">
                      <Undo2 className="size-4" /> Undo
                    </Button>
                  )}
                  <Button size="sm" variant="ink" onClick={next}>
                    Continue <Kbd className="ml-1 border-current/30">↩</Kbd>
                  </Button>
                </div>
                {(step.q.why || slot.correction) && (
                  <div className="rounded-xl border border-line bg-surface p-5">
                    {slot.correction && (
                      <p className="mb-2">
                        <span className="font-semibold text-bad">Careful: </span>
                        {slot.correction}
                      </p>
                    )}
                    {step.q.why && (
                      <>
                        <h3 className="mb-1 text-[0.78rem] font-semibold text-muted">Why</h3>
                        <Markdown>{step.q.why}</Markdown>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {!slot.mark && !slot.marking && (
              <div className="mt-4 flex justify-end">
                <Button size="sm" variant="ghost" onClick={next}>
                  Skip
                </Button>
              </div>
            )}
          </div>
        )}

        {step.kind === 'summary' && (
          <Summary
            steps={steps}
            slots={slots}
            title={content.title}
            onCourse={() => go({ name: 'week', courseId: topic.course_id, weekId: topic.week_id })}
            onNext={nextTopic ? () => go({ name: 'topic', id: nextTopic.id }) : null}
            nextTitle={nextTopic?.content?.title ?? nextTopic?.plan.title}
            test={test}
            onTest={!test && content.check.length ? () => go({ name: 'topic', id: topic.id, test: true }) : null}
            onSaveNote={async () => {
              const noteId = await api.courses.saveNote({ topicId: topic.id })
              go({ name: 'notes', id: noteId })
            }}
          />
        )}
      </div>

      <Modal open={notesOpen} onClose={() => setNotesOpen(false)} title={content.title} wide>
        <div className="flex flex-col gap-6">
          {content.sections.slice(0, Math.max(1, Math.min(sectionCount, step.kind === 'summary' ? sectionCount : curSection + 1))).map((s, i) => (
            <section key={i}>
              <h2 className="mb-2 text-[1.15rem] font-semibold">{s.heading}</h2>
              <Markdown>{s.notes}</Markdown>
            </section>
          ))}
        </div>
      </Modal>

      {rewriteOpen && (
        <RewriteDialog
          level={topic.level}
          levels={topic.levels}
          section={step.kind === 'notes' || (step.kind === 'q' && step.section >= 0) ? content.sections[step.section]?.heading ?? null : null}
          onClose={() => setRewriteOpen(false)}
          onRewrite={rewrite}
        />
      )}
    </div>
  )
}

/**
 * Write the topic again, at the level it's shown at or another one, optionally
 * saying what to change. Another level is added alongside (both are kept); the
 * same level replaces its notes and questions and resets progress on it.
 */
function RewriteDialog({ level, levels, section, onClose, onRewrite }: { level: NoteLevel; levels: NoteLevel[]; section: string | null; onClose: () => void; onRewrite: (instructions: string, level: NoteLevel) => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [pick, setPick] = useState<NoteLevel>(level)
  const go = async () => {
    setBusy(true)
    await onRewrite(text.trim() ? `What I want changed in this rewrite: ${text.trim()}` : '', pick)
    setBusy(false)
  }
  const replaces = levels.includes(pick)
  const keepsCards = levels.some((l) => l !== pick)
  return (
    <Modal
      open
      onClose={onClose}
      title="Rewrite this topic?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={replaces ? 'danger' : 'primary'} loading={busy} onClick={go}>
            {replaces ? 'Rewrite' : `Write ${NOTE_LEVEL_INFO[pick].inline}`}
          </Button>
        </>
      }
    >
      <div className="mb-3 text-[0.84rem] font-medium text-ink/80">Level of detail</div>
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        {NOTE_LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setPick(l)}
            aria-pressed={pick === l}
            className={cx('rounded-xl border px-3 py-2.5 text-left transition-colors', pick === l ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-[color-mix(in_oklab,var(--ink)_22%,transparent)]')}
          >
            <div className="font-semibold">{NOTE_LEVEL_INFO[l].label}</div>
            <div className="text-[0.78rem] text-muted">{levels.includes(l) ? (l === level ? 'Showing now' : 'Written') : 'Not written yet'}</div>
          </button>
        ))}
      </div>
      <p className="mb-3 text-[0.92rem] text-muted">{NOTE_LEVEL_INFO[pick].about}</p>
      <p className="mb-3 text-muted">
        {replaces
          ? `You get new ${NOTE_LEVEL_INFO[pick].inline} notes and questions, and your progress on them starts again. ${keepsCards ? 'Your other levels and the recall cards stay.' : 'Its recall cards are replaced.'}`
          : `This is added alongside the ${levels.map((l) => NOTE_LEVEL_INFO[l].inline).join(' and ')} notes, which stay. Switch between them on the week page.`}{' '}
        It costs about the same as writing the topic the first time.
      </p>
      <Textarea
        rows={3}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={section ? `Optional: what should be different? e.g. “${section}” was confusing, explain it more simply with an example` : 'Optional: what should be different? e.g. simpler wording, more examples'}
      />
      <p className="mt-2 text-[0.85rem] text-muted">Just confused by one bit? Use “I don’t get this” on the notes instead. It only sends that section and costs far less.</p>
    </Modal>
  )
}

function NotesStep({ section, first, goal, onNext, onAsk }: { section: TopicSection; first: boolean; goal: string; onNext: () => void; onAsk: (() => void) | null }) {
  const [img, setImg] = useState<string | null>(null)
  const [imgErr, setImgErr] = useState(false)
  const [zoom, setZoom] = useState(false)
  useEffect(() => {
    if (!section.figure) return
    api.courses
      .figure({ fileId: section.figure.fileId, page: section.figure.page })
      .then(setImg)
      .catch(() => setImgErr(true))
  }, [section.figure?.fileId, section.figure?.page])
  return (
    <div className="pop-in flex flex-col gap-5">
      <div className="rounded-xl border border-line bg-surface p-[clamp(18px,3.4vw,36px)]">
        {first && goal && <div className="mb-2 text-[0.85rem] font-semibold text-accent">{goal}</div>}
        {section.added && (
          <div className="mb-2 inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-[0.75rem] font-semibold text-accent-ink" title="Added from notes you added later">
            New · added {new Date(section.added).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
          </div>
        )}
        <h2 className="mb-4 text-[clamp(1.35rem,2.6vw,1.85rem)] leading-tight font-semibold tracking-tight">{section.heading}</h2>
        <Markdown className="text-[1.05rem] leading-relaxed">{section.notes}</Markdown>
        {section.figure && !imgErr && (
          <figure className="mt-6">
            {img ? (
              <button onClick={() => setZoom(true)} className="block w-full overflow-hidden rounded-lg border border-line bg-white" title="Click to enlarge">
                <img src={img} alt={section.figure.caption} className="mx-auto max-h-[60vh] w-auto object-contain" />
              </button>
            ) : (
              <div className="skeleton aspect-[4/3] w-full" />
            )}
            {section.figure.caption && <figcaption className="mt-2 text-[0.9rem] text-muted">{section.figure.caption}</figcaption>}
          </figure>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="lg" onClick={onNext}>
          Got it <ArrowRight className="size-4" /> <Kbd className="ml-1 border-current/30">↩</Kbd>
        </Button>
        {onAsk && (
          <Button variant="ghost" size="lg" onClick={onAsk} title="Ask about this section">
            <HelpCircle className="size-4" /> I don’t get this
          </Button>
        )}
      </div>
      {zoom && img && (
        <Modal open onClose={() => setZoom(false)} full>
          <img src={img} alt={section.figure?.caption ?? ''} className="mx-auto max-h-full rounded-lg bg-white" />
        </Modal>
      )}
    </div>
  )
}

type CardRating = PileRating
const CARD_RATINGS: { r: CardRating; label: string; tone: string }[] = [
  { r: 1, label: 'Didn’t know', tone: 'border-bad/40 bg-bad-soft text-bad' },
  { r: 2, label: 'Sort of', tone: 'border-warn/40 bg-warn-soft text-warn' },
  { r: 3, label: 'Knew it', tone: 'border-good/40 bg-good-soft text-good' }
]
/**
 * The section's key terms before its questions. Think of the answer, flip, and
 * rate yourself. A card is done after two "Knew it"s (see nextPile). Your first
 * rating of each card feeds spaced repetition. After "Didn't know" or "Sort of"
 * you can choose how to go over it: move on, re-read the section's notes (no
 * AI), or have Claude explain it in depth (one AI call, only when you ask).
 * Keys: Space turns the card over and back (as often as you like), ↩ shows the
 * answer then continues, 1–3 rate, N notes, E explain with AI.
 */
function CardsStep({
  cards,
  section,
  topicId,
  saved,
  onSave,
  onNext,
  onBack
}: {
  cards: { front: string; back: string; id?: string }[]
  section: TopicSection
  topicId: string
  /** Where you were in this pile, if you left and came back. */
  saved?: CardsState
  onSave: (s: CardsState) => void
  onNext: () => void
  onBack: () => void
}) {
  // Card indexes still to go, in order.
  const [queue, setQueue] = useState(() => (saved?.queue.length ? saved.queue.filter((i) => i < cards.length) : cards.map((_, i) => i)))
  const [tries, setTries] = useState<Record<number, number>>(() => saved?.tries ?? {})
  const [greens, setGreens] = useState<Record<number, number>>(() => saved?.greens ?? {})
  const [srDone, setSrDone] = useState<Record<number, true>>(() => saved?.rated ?? {})
  const [scheduler, setScheduler] = useState<string>(DEFAULT_SCHEDULER)
  useEffect(() => void api.settings.all().then((st) => setScheduler((st['review.scheduler'] as string) ?? DEFAULT_SCHEDULER)), [])
  useEffect(() => onSave({ queue, tries, greens, rated: srDone }), [queue, tries, greens, srDone])
  const [flipped, setFlipped] = useState(false)
  // Seen the answer at least once: you can then rate it, and turn the card over as often as you like.
  const [revealed, setRevealed] = useState(false)
  const turn = () =>
    setFlipped((f) => {
      if (!f) setRevealed(true)
      return !f
    })
  const reveal = () => {
    setFlipped(true)
    setRevealed(true)
  }
  const [rated, setRated] = useState<CardRating | null>(null)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [explaining, setExplaining] = useState(false)
  const offline = useStore((s) => s.offline)
  /** After a miss: the card with your choices, the section's notes, or the AI explanation. */
  const [view, setView] = useState<'card' | 'notes' | 'ai'>('card')
  const idx = queue[0]
  const card = cards[idx]
  const again = (tries[idx] ?? 0) > 0
  const done = cards.length - new Set(queue).size

  const advance = (r: CardRating) => {
    const n = (tries[idx] ?? 0) + 1
    const pile = nextPile(queue, greens, r)
    setGreens(pile.greens)
    if (!pile.queue.length) return onNext()
    setTries({ ...tries, [idx]: n })
    setQueue(pile.queue)
    setFlipped(false)
    setRevealed(false)
    setRated(null)
    setExplanation(null)
    setView('card')
  }

  /** Back from the notes or explanation to the card; from the card, back out of the step. */
  const goBack = () => (view !== 'card' ? setView('card') : onBack())

  const explain = async (r: CardRating) => {
    if (explaining || !card) return
    setView('ai')
    if (explanation) return
    setExplaining(true)
    setExplanation('')
    try {
      const ctx = card.id ? { cardId: card.id } : { question: card.front, expectedAnswer: card.back }
      const request = `${r === 1 ? 'I didn’t know this card at all.' : 'I only partly knew this card.'} Explain it properly, more in depth than the card: what it means in plain everyday words first, then the exact term or definition, why it matters, one small worked example walked through step by step, and the usual mistake people make. End with a one-line way to remember it. Use only what the card and my notes say, Markdown with short sections, and keep it to about one screen.`
      await streamCall((streamId) => api.explain.run({ ctx, mode: request, explanationId: null, streamId }), setExplanation)
    } catch (e) {
      setExplanation(null)
      toast(errorText(e), 'bad')
    } finally {
      setExplaining(false)
    }
  }

  const rate = (r: CardRating) => {
    if (!revealed || rated) return
    // With the StudySmarter scheduler the pile is its learning pipeline, so every
    // rating counts until the card is learnt (or reviewed); with the others only
    // your first go counts. The rest is practice.
    if (!srDone[idx]) {
      const i = idx
      if (scheduler !== 'studysmarter') setSrDone((d) => ({ ...d, [i]: true }))
      void api.courses
        .rateCard({ topicId, front: card.front, cardId: card.id, rating: r })
        .then((res) => res.learnt && setSrDone((d) => ({ ...d, [i]: true })))
        .catch(() => {})
    }
    if (r === 3) return advance(r)
    setRated(r)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('[data-modal]')) return
      // Space turns the card over (and back); Enter shows the answer, then moves on once rated.
      if (e.key === ' ') {
        e.preventDefault()
        turn()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (!revealed) reveal()
        else if (rated && !explaining) advance(rated)
      } else if (revealed && !rated && ['1', '2', '3'].includes(e.key)) rate(Number(e.key) as CardRating)
      else if (e.key === 'b' || e.key === 'B') goBack()
      else if (rated && (e.key === 'n' || e.key === 'N')) setView('notes')
      else if (rated && !offline && (e.key === 'e' || e.key === 'E')) void explain(rated)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (!card) return null

  const backButton = (
    <Button variant="ghost" size="lg" onClick={goBack} disabled={explaining}>
      <ArrowLeft className="size-4" /> Back to the card <Kbd className="ml-1">B</Kbd>
    </Button>
  )
  const comesBackNote = (
    <span className="text-[0.85rem] text-muted">
      {rated === 1 ? `This card comes back in ${RED_GAP} cards.` : 'This card goes to the back of the pile.'} Press Knew it twice to finish it.
    </span>
  )
  const nextButton = (label: string) => (
    <Button variant="primary" size="lg" onClick={() => rated && advance(rated)} disabled={explaining}>
      {label} <ArrowRight className="size-4" /> <Kbd className="ml-1 border-current/30">↩</Kbd>
    </Button>
  )
  const aiButton = offline ? null : (
    <Button variant="ghost" size="lg" onClick={() => rated && void explain(rated)}>
      <Sparkles className="size-4" /> Explain it with AI <Kbd className="ml-1">E</Kbd>
    </Button>
  )

  // You chose to re-read the section: its notes again, no AI.
  if (rated && view === 'notes')
    return (
      <div className="pop-in flex flex-col gap-5">
        <div className="flex items-center gap-2 text-[0.85rem] text-muted">
          <Pill tone="accent">Key terms</Pill>
          <span>Back to the notes for “{card.front.replace(/\?$/, '')}”</span>
        </div>
        <div className="rounded-xl border border-line bg-surface p-[clamp(18px,3.4vw,36px)]">
          <h2 className="mb-4 text-[clamp(1.35rem,2.6vw,1.85rem)] leading-tight font-semibold tracking-tight">{section.heading}</h2>
          <Markdown className="text-[1.05rem] leading-relaxed">{section.notes}</Markdown>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {nextButton('Got it, next')}
          {backButton}
          {aiButton}
          {comesBackNote}
        </div>
      </div>
    )

  // You chose an AI explanation: a page that goes through it properly.
  if (rated && view === 'ai')
    return (
      <div key={`explain-${idx}-${tries[idx] ?? 0}`} className="pop-in flex flex-col gap-5">
        <div className="flex items-center gap-2 text-[0.85rem] text-muted">
          <Pill tone="accent">Key terms</Pill>
          <Pill tone={rated === 1 ? 'bad' : 'warn'}>{rated === 1 ? 'Didn’t know' : 'Sort of'}</Pill>
        </div>
        <div className="rounded-xl border border-line bg-surface p-[clamp(18px,3.4vw,36px)]">
          <div className="mb-2 flex items-center gap-1.5 text-[0.85rem] font-semibold text-accent">
            <Sparkles className="size-4" /> Let’s go through it properly
          </div>
          <Markdown className="mb-4 text-[clamp(1.35rem,2.6vw,1.85rem)] leading-tight font-semibold tracking-tight">{card.front}</Markdown>
          {explanation ? (
            <Markdown className="text-[1.05rem] leading-relaxed" streaming={explaining}>
              {explanation}
            </Markdown>
          ) : explanation === '' ? (
            <div className="flex items-center gap-2 text-muted">
              Explaining <Dots />
            </div>
          ) : (
            // The explanation failed: fall back to the card's own answer.
            <Markdown className="text-[1.05rem] leading-relaxed">{card.back}</Markdown>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {nextButton('Got it, next')}
          {backButton}
          {comesBackNote}
        </div>
      </div>
    )

  return (
    <div className="pop-in flex flex-col gap-5">
      <div className="flex items-center gap-2 text-[0.85rem] text-muted">
        <Pill tone="accent">Key terms</Pill>
        {again && (
          <Pill tone="warn">
            <RotateCcw className="size-3" /> Again
          </Pill>
        )}
        <span>
          {done} of {cards.length} done
        </span>
        <span className="ml-auto flex items-center gap-1" title={`Knew it ${greens[idx] ?? 0} of ${GREENS_TO_PASS} times`}>
          {Array.from({ length: GREENS_TO_PASS }, (_, i) => (
            <span key={i} className={cx('size-2.5 rounded-full border', i < (greens[idx] ?? 0) ? 'border-good bg-good' : 'border-line')} />
          ))}
        </span>
      </div>
      {/* A div, not a button: a focused button would also react to the keys the step handles. */}
      <div
        role="button"
        onClick={turn}
        className="flex min-h-[220px] cursor-pointer flex-col items-stretch rounded-xl border border-line bg-surface p-[clamp(18px,3.4vw,36px)] text-left transition-colors hover:border-[color-mix(in_oklab,var(--ink)_22%,transparent)]"
        title={flipped ? 'Turn back to the question (space)' : 'Show the answer (space)'}
      >
        <Markdown className="text-[clamp(1.2rem,2.4vw,1.6rem)] leading-snug font-semibold">{card.front}</Markdown>
        {flipped ? (
          <div className="pop-in mt-5 border-t border-line pt-5">
            <Markdown className="text-[1.05rem] leading-relaxed">{card.back}</Markdown>
          </div>
        ) : (
          <span className="mt-auto pt-6 text-[0.9rem] text-muted">{revealed ? 'Tap or press space to see the answer again' : 'Say the answer in your head first, then tap to check'}</span>
        )}
        {flipped && <span className="mt-auto pt-4 text-[0.8rem] text-muted">Tap or press space to turn it back over</span>}
      </div>

      {!revealed ? (
        <Button variant="primary" size="lg" className="self-start" onClick={reveal}>
          Show answer <Kbd className="ml-1 border-current/30">↩</Kbd>
        </Button>
      ) : rated ? (
        <div className="flex flex-col gap-2">
          <span className="text-[0.85rem] text-muted">Want to go over it before the next card?</span>
          <div className="flex flex-wrap items-center gap-2">
            {nextButton('Next')}
            <Button variant="outline" size="lg" onClick={() => setView('notes')}>
              <BookOpen className="size-4" /> Re-read the notes <Kbd className="ml-1">N</Kbd>
            </Button>
            {aiButton}
          </div>
          {comesBackNote}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="text-[0.85rem] text-muted">
            How well did you know it? {(greens[idx] ?? 0) > 0 ? 'One more Knew it and this card is done.' : 'A card is done once you’ve pressed Knew it twice.'}
          </span>
          <div className="grid grid-cols-3 gap-2 max-sm:grid-cols-1">
            {CARD_RATINGS.map(({ r, label, tone }) => (
              <button key={r} onClick={() => rate(r)} className={cx('flex items-center justify-center gap-2 rounded-xl border px-4 py-3 font-semibold transition-transform active:scale-[0.98]', tone)}>
                {label} <Kbd className="border-current/30">{r}</Kbd>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function RecallStep({ courseId, topicId, onNext }: { courseId: string; topicId: string; onNext: () => void }) {
  const [data, setData] = useState<{ card: Card; topicTitle: string } | null | undefined>(undefined)
  const [typed, setTyped] = useState('')
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.courses
      .recall({ courseId, excludeTopicId: topicId, exclude: [...shownCards] })
      .then((r) => {
        if (!r) return onNext() // nothing to recall yet
        shownCards.add(r.card.id)
        setData(r)
      })
      .catch(() => onNext())
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || document.querySelector('[data-modal]')) return
      const inField = (e.target as HTMLElement).tagName === 'TEXTAREA'
      if (e.key === 'Enter' && !e.shiftKey && !shown) (e.preventDefault(), setShown(true))
      else if (shown && !inField && (e.key === '1' || e.key === '2')) rate(e.key === '2')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const rate = async (knew: boolean) => {
    if (!data || busy) return
    setBusy(true)
    await api.courses.recallReview({ cardId: data.card.id, knew }).catch(() => {})
    onNext()
  }
  if (data === undefined) return <div className="skeleton h-48" />
  if (!data) return null
  return (
    <div className="pop-in flex flex-col gap-4">
      <div className="flex items-center gap-2 text-[0.85rem] font-semibold text-accent">
        <Shuffle className="size-4" /> Quick recall · from {data.topicTitle}
      </div>
      <div className="rounded-xl border border-line bg-surface p-[clamp(18px,3.4vw,36px)]">
        <Markdown className="text-[clamp(1.2rem,2.4vw,1.6rem)] leading-snug font-semibold">{data.card.front}</Markdown>
        {!shown ? (
          <div className="mt-5 flex flex-col gap-3">
            <Textarea rows={2} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type it if you like, or just think it…" autoFocus />
            <Button variant="primary" size="lg" className="self-start" onClick={() => setShown(true)}>
              Show answer <Kbd className="ml-1 border-current/30">↩</Kbd>
            </Button>
          </div>
        ) : (
          <div className="pop-in mt-5 flex flex-col gap-4">
            {typed.trim() && (
              <div className="rounded-lg bg-surface-2 p-4">
                <div className="mb-1 text-[0.75rem] font-semibold text-muted">You wrote</div>
                <div className="whitespace-pre-wrap">{typed}</div>
              </div>
            )}
            <div className="rounded-lg bg-accent-soft p-4">
              <div className="mb-1 text-[0.75rem] font-semibold text-accent">Answer</div>
              <Markdown>{data.card.back}</Markdown>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="lg" loading={busy} onClick={() => rate(false)}>
                Didn’t know <Kbd className="ml-1">1</Kbd>
              </Button>
              <Button variant="primary" size="lg" loading={busy} onClick={() => rate(true)}>
                Knew it <Kbd className="ml-1 border-current/30">2</Kbd>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
/** Recall cards already shown this session, so the same one doesn't come back. */
const shownCards = new Set<string>()

function Summary({
  steps,
  slots,
  title,
  onCourse,
  onNext,
  nextTitle,
  test,
  onTest,
  onSaveNote
}: {
  steps: Step[]
  slots: Record<number, Slot>
  title: string
  onCourse: () => void
  onNext: (() => void) | null
  nextTitle?: string
  test: boolean
  onTest: (() => void) | null
  onSaveNote: () => void
}) {
  const tally = useMemo(() => {
    const out = { sections: { got: 0, of: 0 }, check: { got: 0, of: 0 } }
    steps.forEach((s, i) => {
      if (s.kind !== 'q') return
      const bucket = s.section === -1 ? out.check : out.sections
      bucket.of += 1
      bucket.got += credit(slots[i]?.mark ?? null)
    })
    return out
  }, [steps, slots])
  const shown = test ? tally.check : tally.sections
  const pct = shown.of ? shown.got / shown.of : 1
  const what = test ? 'Test' : 'Topic'
  return (
    <div className="pop-in mx-auto flex w-full max-w-lg flex-col items-center gap-5 pt-6 text-center">
      <Trophy className="size-8 text-accent" strokeWidth={1.6} />
      <div>
        <h2 className="text-[2rem] leading-tight font-semibold tracking-tight">{pct >= 0.8 ? `${what} done. Nice.` : pct >= 0.5 ? `${what} done.` : `${what} done. Worth another go.`}</h2>
        <p className="text-muted">{title}</p>
      </div>
      <div className="w-full rounded-xl bg-surface-2 p-4">
        <div className="text-3xl font-semibold">{shown.of ? `${Math.round(pct * 100)}%` : '–'}</div>
        <div className="text-[0.82rem] font-semibold text-muted">
          {test ? 'Topic test' : 'As you went'} {shown.of ? `· ${shown.got}/${shown.of}` : ''}
        </div>
      </div>
      {onTest && <p className="text-[0.9rem] text-muted">Ready to check it stuck? Take the topic test now, or later from the course page.</p>}
      <p className="text-[0.9rem] text-muted">
        <Sparkles className="mr-1 inline size-4 text-accent" />
        This topic’s recall cards will pop up while you learn other topics, and in spaced review.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {onTest && (
          <Button variant="primary" onClick={onTest}>
            <ClipboardCheck className="size-4" /> Take the test
          </Button>
        )}
        {onNext && (
          <Button variant={onTest ? 'outline' : 'primary'} onClick={onNext}>
            Next: {nextTitle} <ArrowRight className="size-4" />
          </Button>
        )}
        <Button variant={onNext || onTest ? 'outline' : 'primary'} onClick={onCourse}>
          Back to the week
        </Button>
        <Button variant="ghost" onClick={onSaveNote}>
          <NotebookPen className="size-4" /> Open the notes
        </Button>
      </div>
    </div>
  )
}
