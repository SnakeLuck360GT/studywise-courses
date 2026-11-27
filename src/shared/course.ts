import { z } from 'zod'
import { normalizeAnswer, blankMatches, markInCode, verdictFor } from './marking'
import type { BlankSegment } from './blanks'
import type { LearnQuestion, LearnAnswer, Mark } from './questions'
import type { Thresholds } from './types'

// Courses: an outline of topics, each topic a run of short sections
// (notes, then a few questions), a topic check at the end, and recall cards.

// ---------------------------------------------------------------------------
// What Claude returns

export const OutlineSource = z.object({ file: z.string(), where: z.string().default('') })
export const OutlineTopic = z.object({
  id: z.string(),
  title: z.string().min(1),
  goal: z.string().default(''),
  sections: z.array(z.string()).default([]),
  sources: z.array(OutlineSource).default([]),
  needs: z.array(z.string()).default([]),
  stressed: z.array(z.string()).default([]),
  minutes: z.number().default(15),
  /** When "Add new notes" added this topic to an already planned week. */
  added: z.string().optional()
})
export type OutlineTopic = z.infer<typeof OutlineTopic>
export const CourseOutline = z.object({ course: z.string().default(''), topics: z.array(OutlineTopic).min(1) })
export type CourseOutline = z.infer<typeof CourseOutline>

const extra = { hint: z.string().default(''), why: z.string().default('') }
// Kept loose on purpose: one bad question shouldn't throw away a whole topic.
// sanitizeQuestion() drops the ones that can't be used.
export const CourseQuestion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcq'), q: z.string(), options: z.array(z.string()), answer: z.number().int(), ...extra }),
  z.object({ type: z.literal('true_false'), q: z.string(), answer: z.boolean(), ...extra }),
  z.object({ type: z.literal('fill_blank'), text: z.string(), ...extra }),
  z.object({ type: z.literal('wrong_word'), text: z.string(), wrong: z.string(), correct: z.string(), ...extra }),
  z.object({ type: z.literal('order'), q: z.string(), items: z.array(z.string()), ...extra }),
  z.object({ type: z.literal('match'), q: z.string(), pairs: z.array(z.object({ term: z.string(), meaning: z.string() })), ...extra }),
  z.object({ type: z.literal('sort'), q: z.string(), buckets: z.array(z.string()), items: z.array(z.object({ item: z.string(), bucket: z.string() })), ...extra }),
  z.object({ type: z.literal('explain'), q: z.string(), model: z.string(), points: z.array(z.string()), ...extra })
])
export type CourseQuestion = z.infer<typeof CourseQuestion>
export type CourseQuestionType = CourseQuestion['type']

export const COURSE_QUESTION_LABELS: Record<CourseQuestionType, string> = {
  mcq: 'Multiple choice',
  true_false: 'True or false',
  fill_blank: 'Fill in the blank',
  wrong_word: 'Spot the wrong word',
  order: 'Put in order',
  match: 'Match up',
  sort: 'Sort',
  explain: 'In your own words'
}

export const AiFigure = z.object({ file: z.string(), page: z.number().int(), caption: z.string().default('') })
export const AiSection = z.object({
  heading: z.string(),
  notes: z.string(),
  figure: AiFigure.nullable().default(null),
  questions: z.array(CourseQuestion).default([])
})
export const AiTopic = z.object({
  id: z.string().default(''),
  title: z.string(),
  goal: z.string().default(''),
  sections: z.array(AiSection).min(1),
  check: z.array(CourseQuestion).default([]),
  /** section: 1-based number of the section that teaches the card, so it's shown before that section's questions. */
  cards: z.array(z.object({ front: z.string(), back: z.string(), section: z.number().int().nullable().default(null) })).default([])
})
export type AiTopic = z.infer<typeof AiTopic>

/** Adding new material to a planned week: what it adds to existing topics, and any new topics. */
export const CourseUpdate = z.object({
  summary: z.string().default(''),
  updates: z
    .array(
      z.object({
        topic: z.string(),
        sections: z.array(z.string()).default([]),
        sources: z.array(OutlineSource).default([]),
        stressed: z.array(z.string()).default([])
      })
    )
    .default([]),
  topics: z.array(OutlineTopic).default([])
})
export type CourseUpdate = z.infer<typeof CourseUpdate>

/** Just the new sections for a topic that's already written (plus a few test questions and recall cards for them). */
export const CourseExtendOut = z.object({
  sections: z.array(AiSection).min(1),
  check: z.array(CourseQuestion).default([]),
  cards: z.array(z.object({ front: z.string(), back: z.string(), section: z.number().int().nullable().default(null) })).default([])
})
export type CourseExtendOut = z.infer<typeof CourseExtendOut>

export const CourseMarkOut = z.object({
  score: z.number().min(0).max(10),
  /** Marks awarded, one per key point (explainMarks). Older prompts don't return it. */
  marks: z.number().nullable().default(null),
  got: z.array(z.string()).default([]),
  missed: z.array(z.string()).default([]),
  wrong: z.string().default(''),
  feedback: z.string().default('')
})
export type CourseMarkOut = z.infer<typeof CourseMarkOut>

/** An end-of-week test: multiple choice only, across the whole week. */
export const AiWeekTest = z.object({
  questions: z
    .array(
      z.object({
        type: z.literal('mcq').default('mcq'),
        q: z.string(),
        options: z.array(z.string()),
        answer: z.number().int(),
        hint: z.string().default(''),
        why: z.string().default(''),
        /** The topic it tests, by title. */
        topic: z.string().default('')
      })
    )
    .min(1)
})
export type AiWeekTest = z.infer<typeof AiWeekTest>

/** Which recall cards aren't worth keeping, by their number in the list sent. */
export const CourseTrimOut = z.object({
  remove: z.array(z.object({ n: z.number().int(), reason: z.string().default('') })).default([])
})
export type CourseTrimOut = z.infer<typeof CourseTrimOut>

/** Questions from two copies of a week that ask the same thing: which of each pair to keep, word for word. */
export const CourseDedupeOut = z.object({
  same: z.array(z.object({ group: z.number().int(), a: z.number().int(), b: z.number().int(), keep: z.enum(['a', 'b']) })).default([])
})
export type CourseDedupeOut = z.infer<typeof CourseDedupeOut>

/**
 * Combining two copies of a topic's notes when merging weeks: for each part,
 * which of version A's sections each of version B's covers the same material
 * as, and the combined notes (A's, plus everything B adds, repeats taken out).
 */
export const CourseCombineOut = z.object({
  parts: z
    .array(
      z.object({
        part: z.number().int(),
        sections: z.array(z.object({ a: z.number().int(), b: z.array(z.number().int()).default([]), notes: z.string() })).default([])
      })
    )
    .default([])
})
export type CourseCombineOut = z.infer<typeof CourseCombineOut>

// ---------------------------------------------------------------------------
// What the app stores

export interface Figure {
  fileId: string
  page: number
  caption: string
}
export interface TopicSection {
  heading: string
  notes: string
  figure: Figure | null
  /** Flashcards for what this section teaches, shown after its notes and before its questions. Missing on topics written before this. */
  cards?: { front: string; back: string; /** The deck card it was saved as, for rating it. */ id?: string }[]
  questions: CourseQuestion[]
  /** When "Add new notes" added this section to a topic that was already written. */
  added?: string
}
export interface TopicContent {
  title: string
  goal: string
  sections: TopicSection[]
  check: CourseQuestion[]
}

export interface TopicProgress {
  /** Section to resume at. Equal to sections.length once the sections are done. */
  section: number
  done: boolean
  answered: number
  correct: number
  checkScore: number | null
  checkTotal: number | null
  lastStudied: string | null
  /** The exact step you were on (notes, flashcards or a question), so you carry on from there. */
  step?: TopicPlace | null
}
/** A place in a topic that survives the steps being rebuilt (recall cards are random). */
export interface TopicPlace {
  kind: 'notes' | 'cards' | 'q'
  section: number
  /** Which question, for kind 'q'. */
  index?: number
}
/**
 * Sections added by "Add new notes" that you haven't reviewed yet (by index).
 * Everything before where you've got to, or in a finished topic, is reviewed.
 */
export function unreviewedSections(t: { content: TopicContent | null; progress: TopicProgress }): number[] {
  if (!t.content || t.progress.done) return []
  return t.content.sections.flatMap((s, i) => (s.added && i >= t.progress.section ? [i] : []))
}

export const emptyProgress = (): TopicProgress => ({ section: 0, done: false, answered: 0, correct: 0, checkScore: null, checkTotal: null, lastStudied: null })

export type TopicStatus = 'planned' | 'writing' | 'ready' | 'error'

/**
 * How much detail a topic's notes go into. Standard is the usual write-up;
 * quick revision sticks to the main ideas and takes far less time; in-depth takes longer
 * and goes slowly through everything, for topics you struggle with. A topic
 * can be written at several levels and keeps each one.
 */
export const NOTE_LEVELS = ['standard', 'quick', 'deep', 'simple'] as const
export type NoteLevel = (typeof NOTE_LEVELS)[number]
/** label: on buttons and switches. inline: inside a sentence ("the quick revision notes"). */
export const NOTE_LEVEL_INFO: Record<NoteLevel, { label: string; short: string; inline: string; about: string }> = {
  standard: { label: 'Standard', short: 'Standard', inline: 'standard', about: 'The usual notes: every examinable point, explained simply.' },
  quick: { label: 'Quick revision', short: 'Quick', inline: 'quick revision', about: 'Just the main ideas in a few short sections, so you get through a topic in about a third of the time.' },
  deep: { label: 'In-depth', short: 'In-depth', inline: 'in-depth', about: 'A fuller write-up that goes slowly through everything. For topics you struggle with.' },
  simple: { label: 'Explain it like I’m 12', short: 'Like I’m 12', inline: '“explain it like I’m 12”', about: 'Everyday words and simple examples, one small step at a time, so it really clicks. Easy to review.' }
}
export const isNoteLevel = (v: unknown): v is NoteLevel => typeof v === 'string' && (NOTE_LEVELS as readonly string[]).includes(v)

/**
 * How many questions Claude writes when it writes a topic (Settings → General
 * → Courses): the usual amount, more, or lots. Each level of detail scales from
 * its own usual amount.
 */
export const QUESTION_AMOUNTS = ['usual', 'more', 'lots'] as const
export type QuestionAmount = (typeof QUESTION_AMOUNTS)[number]
export const QUESTION_AMOUNT_INFO: Record<QuestionAmount, { label: string; about: string }> = {
  usual: { label: 'Usual', about: '2–4 questions after each section, and 5–8 in the topic test.' },
  more: { label: 'More', about: '4–6 questions after each section, and 8–12 in the topic test.' },
  lots: { label: 'Lots', about: '6–8 questions after each section, and 12–15 in the topic test.' }
}
export const isQuestionAmount = (v: unknown): v is QuestionAmount => typeof v === 'string' && (QUESTION_AMOUNTS as readonly string[]).includes(v)

/** End-of-week tests: multiple choice across the whole week, at a difficulty. */
export const WEEK_TEST_LEVELS = ['easy', 'medium', 'hard'] as const
export type WeekTestLevel = (typeof WEEK_TEST_LEVELS)[number]
export const WEEK_TEST_INFO: Record<WeekTestLevel, { label: string; about: string }> = {
  easy: { label: 'Easy', about: 'Recognising the key terms and main ideas. A warm-up to check nothing big slipped past you.' },
  medium: { label: 'Medium', about: 'A mix of recall and applying ideas to short scenarios, with believable wrong answers.' },
  hard: { label: 'Hard', about: 'Exam-hard: applying, comparing and reasoning in several steps, with near-miss wrong answers.' }
}
export const isWeekTestLevel = (v: unknown): v is WeekTestLevel => typeof v === 'string' && (WEEK_TEST_LEVELS as readonly string[]).includes(v)

export type WeekTestQuestion = Extract<CourseQuestion, { type: 'mcq' }> & { topic?: string }
export interface WeekTestScore {
  score: number
  total: number
  at: string
}
export interface WeekTest {
  difficulty: WeekTestLevel
  questions: WeekTestQuestion[]
  written_at: string
  last: WeekTestScore | null
  best: WeekTestScore | null
}

/**
 * What kind of course it is (ticked when you make it, or later on the course
 * page). Every AI call for the course is told to tailor its content to them.
 */
export const COURSE_FOCUSES = ['theory', 'practical', 'formula'] as const
export type CourseFocus = (typeof COURSE_FOCUSES)[number]
export const COURSE_FOCUS_INFO: Record<CourseFocus, { label: string; about: string; prompt: string }> = {
  theory: {
    label: 'Theory heavy',
    about: 'Concepts, arguments and explanations: notes focus on understanding why, linking ideas and exact definitions.',
    prompt: `THEORY HEAVY: this course is mostly concepts, arguments and explanations. Put the weight on understanding: what each idea means, why it holds or matters, how the ideas connect and differ, and the key definitions in their exact wording. Use concrete examples, "Imagine…" scenarios and A vs B tables to make abstract ideas stick. Questions lean on explaining, comparing and applying concepts to scenarios (more explain and scenario questions), not on calculation or code. Cards focus on definitions, key arguments, contrasts and lists.`
  },
  practical: {
    label: 'Practical / coding heavy',
    about: 'Doing things: every idea is taught through small worked code or hands-on examples, with questions on reading and fixing code.',
    prompt: `PRACTICAL / CODING HEAVY: this course is about doing: writing code, using tools and building things. Teach every idea through a small, working example in the course's language (or a concrete hands-on procedure): show it, explain it line by line or step by step (a Code | Simple meaning table for code), and say what it shows. Include the common bugs and mistakes and how to spot them, and how you'd use it in practice. Questions lean on reading, predicting, ordering and fixing code or procedures (what does this output, which line is wrong, put these steps in order, which snippet does X). Cards cover key syntax, APIs, commands and patterns as well as the concepts behind them.`
  },
  formula: {
    label: 'Formula & method heavy',
    about: 'Formulas, calculations and step-by-step methods: every formula explained symbol by symbol with worked examples.',
    prompt: `FORMULA AND METHOD HEAVY: this course is about formulas, calculations and step-by-step methods. For every formula: state it, say what each symbol means (with units), when it applies and when it doesn't, then walk through a worked example step by step with numbers. For every method: numbered steps, a worked example, then the usual slips. Write maths in LaTeX ($…$ inline, $$…$$ on its own line). Questions lean on applying formulas and methods to short problems: multiple choice whose wrong options come from common slips (wrong units, a missed step, a rearranging error), putting method steps in order, and filling in values. Cards cover each formula, what its symbols mean and when to use it, and the steps of each method.`
  }
}
export const isCourseFocus = (v: unknown): v is CourseFocus => typeof v === 'string' && (COURSE_FOCUSES as readonly string[]).includes(v)

/** The tailoring rule every prompt for a course gets, from the focuses ticked (empty when none). */
export function courseFocusInstructions(focus: readonly string[]): string {
  const picked = COURSE_FOCUSES.filter((f) => focus.includes(f))
  if (!picked.length) return ''
  const mix = picked.length > 1 ? ` It's a mix of ${picked.length === 2 ? 'both' : 'all three'}: balance them, using whichever suits each topic best.` : ''
  return `WHAT KIND OF COURSE THIS IS (tailor the content, examples, questions and cards to it):${mix}\n${picked.map((f) => `- ${COURSE_FOCUS_INFO[f].prompt}`).join('\n')}\nThis only shapes how things are taught and tested: still only use what's in the material.`
}

/** How far "Cut down flashcards" goes: lose the least important quarter, keep about half, or keep only the essentials. */
export const CARD_CUTS = ['light', 'medium', 'heavy'] as const
export type CardCut = (typeof CARD_CUTS)[number]
export const CARD_CUT_INFO: Record<CardCut, { label: string; about: string; keep: number }> = {
  light: { label: 'A little', about: 'Removes the least important cards (minor details, near-repeats). Keeps about three quarters.', keep: 0.75 },
  medium: { label: 'Key content', about: 'Keeps the core definitions, main lists and processes, key contrasts and anything stressed. About half.', keep: 0.5 },
  heavy: { label: 'Essentials only', about: 'Only what you absolutely must know for the exam: the central ideas of each topic. About a quarter.', keep: 0.25 }
}

/** A level that's written but not the one being shown, with your progress on it. */
export interface TopicVersion {
  content: TopicContent
  progress: TopicProgress
}

/** Failures are warned about for a day; after that the warning goes (the topic or week can still be written or planned again). */
export const ERROR_SHOWN_MS = 24 * 60 * 60 * 1000

/** A failure recent enough to warn about. One with no time recorded is old. */
export function showError(x: { error: string | null; error_at?: string | null }, now = Date.now()): boolean {
  if (!x.error) return false
  const at = x.error_at ? Date.parse(x.error_at) : NaN
  return Number.isFinite(at) && now - at < ERROR_SHOWN_MS
}

export interface Topic {
  id: string
  course_id: string
  week_id: string
  key: string
  position: number
  plan: OutlineTopic
  status: TopicStatus
  error: string | null
  /** When it failed (warnings show for a day, see showError). */
  error_at: string | null
  /** The level of detail that failed to write, when known. */
  error_level: NoteLevel | null
  content: TopicContent | null
  progress: TopicProgress
  card_count: number
  /** The topic's notes, saved as a note when it's written. */
  note_id: string | null
  /** The level of detail of `content` (the one being shown). */
  level: NoteLevel
  /** Every level written for this topic, in NOTE_LEVELS order. */
  levels: NoteLevel[]
  updated_at: string
}

export interface CourseFile {
  id: string
  course_id: string
  week_id: string
  name: string
  path: string
  pages: number | null
}

export type WeekStatus = 'empty' | 'planning' | 'ready' | 'error'

export interface Week {
  id: string
  course_id: string
  position: number
  label: string
  status: WeekStatus
  error: string | null
  /** When planning failed (warnings show for a day, see showError). */
  error_at: string | null
  /** This week's recall-card deck, in the course's folder. */
  deck_id: string | null
  /** Recall turned off: its cards stay, but don't come up in recall, course review or due counts. */
  recall_off: boolean
  /** Never published to the marketplace. The week is also kept off it while its course is private. */
  private: boolean
  /** Its end-of-week test (multiple choice), when one has been written. */
  test: WeekTest | null
  /** A priority for review: its due cards come before other weeks' (Tracker, or Choose weeks on Home). */
  priority: boolean
  /** Tracker: you've learnt it, you've revised it, and how confident you are (1-5; null until you say). */
  learnt: boolean
  revised: boolean
  confidence: number | null
  created_at: string
}

/** What you can mark on a week in the tracker. */
export interface WeekTrack {
  priority?: boolean
  learnt?: boolean
  revised?: boolean
  confidence?: number | null
}
export const CONFIDENCE_MAX = 5
export const CONFIDENCE_LABELS = ['Not at all', 'A little', 'Getting there', 'Fairly', 'Very'] as const

/** One week in the tracker and the review picker. */
export interface TrackerWeek {
  id: string
  label: string
  deck_id: string | null
  recall_off: boolean
  priority: boolean
  learnt: boolean
  revised: boolean
  confidence: number | null
  topic_count: number
  done_count: number
  card_count: number
  due_count: number
}

/** A course with its weeks in order, for the tracker and the review picker. */
export interface TrackerCourse {
  id: string
  name: string
  module: string
  exam_date: string | null
  weeks: TrackerWeek[]
}

/** Decks you can review that aren't a course's weeks. */
export interface TrackerDeck {
  id: string
  name: string
  card_count: number
  due_count: number
}

export interface WeekFull extends Week {
  files: CourseFile[]
  topics: Topic[]
  /** Every card in the week's deck: recall cards plus any you imported or added. */
  card_count: number
}

/** The week's number from its label: "Week 3" → 3, "W10 · Graphs" → 10, "Lecture 4" → 4; null when it has none ("Reading week"). */
export function weekNumber(label: string): number | null {
  const m = label.match(/\b(?:week|wk|w)\s*(\d+)/i) ?? label.match(/\d+/)
  return m ? Number(m[1] ?? m[0]) : null
}

/**
 * Reading week: most terms have one, usually week 6, with no lectures. It's a
 * week like any other, marked in its label ("Week 6 · Reading week"), so it
 * keeps its place in the order, syncs, and goes in a shared week as it is.
 */
export const READING_WEEK = 6
export const isReadingWeek = (label: string): boolean => /\breading\s*week\b/i.test(label)
/** "Week 6" → "Week 6 · Reading week" (a label that already says so is left alone). */
export const asReadingWeek = (label: string): string => (isReadingWeek(label) ? label.trim() : `${label.trim() || `Week ${READING_WEEK}`} · Reading week`)
/** "Week 6 · Reading week" → "Week 6": what it's called once it isn't one. */
export const notReadingWeek = (label: string): string => label.replace(/\s*[·:\-–—(]*\s*reading\s*week\s*\)?\s*/i, ' ').trim() || `Week ${READING_WEEK}`

/** The course has weeks after week 6 but no week 6: probably its reading week, never added. */
export function missingReadingWeek(weeks: { label: string }[]): boolean {
  const nums = weeks.map((w) => weekNumber(w.label))
  return !nums.includes(READING_WEEK) && nums.some((n) => n !== null && n > READING_WEEK)
}

/** What to call the next week added: one after the highest week number so far. */
export function nextWeekLabel(weeks: { label: string }[]): string {
  const top = Math.max(0, ...weeks.map((w) => weekNumber(w.label) ?? 0))
  return `Week ${Math.max(top, weeks.length) + 1}`
}

/** Week 1 first, or the latest week first. */
export type WeekOrder = 'asc' | 'desc'

/**
 * Weeks in week-number order (from their labels), whatever order they were
 * added in, so a week downloaded later (week 2 after week 5) sits in its
 * place. A week without a number stays just after the week it was added
 * after; weeks with the same number keep the order they were added in.
 */
export function sortWeeks<T extends { label: string; position: number }>(weeks: T[], order: WeekOrder = 'asc'): T[] {
  let last = 0
  const keyed = [...weeks]
    .sort((a, b) => a.position - b.position)
    .map((w, i) => {
      const n = weekNumber(w.label)
      if (n !== null) last = n
      return { w, i, n: n ?? last, numbered: n !== null }
    })
  keyed.sort((a, b) => a.n - b.n || Number(b.numbered) - Number(a.numbered) || a.i - b.i)
  const sorted = keyed.map((k) => k.w)
  return order === 'desc' ? sorted.reverse() : sorted
}

export interface Course {
  id: string
  name: string
  module: string
  level: string
  /** Old single recall deck. New courses keep their cards in a deck per week instead. */
  deck_id: string | null
  /** The course's folder in Decks, holding one deck per week. */
  deck_folder_id: string | null
  /** YYYY-MM-DD. Recall is steady until EXAM_REVISION_DAYS before it, then ramps up, and every card gets a last look before it. */
  exam_date: string | null
  /** Your note to the AI about this course, added to every prompt for it ("this course is coding heavy…"). */
  note: string
  /** What kind of course it is (theory, practical/coding, formula/method heavy): every prompt tailors to it. */
  focus: CourseFocus[]
  /** None of its weeks are published to the marketplace, whatever each week is set to. */
  private: boolean
  created_at: string
  updated_at: string
}

/** How many days before the exam revision starts. */
export const EXAM_REVISION_DAYS = 42

/**
 * Where a course is relative to its exam: no date; steady (exam more than 6
 * weeks off: reviews keep going, a little more spread out); revision (the last
 * 6 weeks: reviews ramp up as the exam gets closer); over (the course rests).
 */
export type ExamPhase = { phase: 'none' } | { phase: 'steady'; days: number; startsOn: string | null } | { phase: 'revision'; days: number } | { phase: 'over' }

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function examPhase(examDate: string | null | undefined, now = new Date()): ExamPhase {
  if (!examDate || !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) return { phase: 'none' }
  const [y, m, d] = examDate.split('-').map(Number)
  const exam = new Date(y, m - 1, d)
  const days = Math.round((exam.getTime() - dayStart(now).getTime()) / 86_400_000)
  if (days < 0) return { phase: 'over' }
  if (days > EXAM_REVISION_DAYS) {
    const start = new Date(exam)
    start.setDate(start.getDate() - EXAM_REVISION_DAYS)
    return { phase: 'steady', days, startsOn: isoDay(start) }
  }
  return { phase: 'revision', days }
}

/** Reviews never land later than this many days before the exam, so every card gets a last look. */
export const LAST_LOOK_DAYS_BEFORE = 2

/** Far from the exam, reviews are spaced out this much more than usual: fewer a day, but they keep going. */
export const STEADY_STRETCH = 1.5

/**
 * The longest gap between reviews during revision, shrinking as the exam gets
 * closer: 10 days six weeks out, 3 days two weeks out, every day for the last few.
 */
export function revisionMaxGapDays(daysLeft: number): number {
  return Math.max(1, Math.min(10, Math.floor(daysLeft / 4)))
}

/**
 * When a course card's review is really due. During revision it's pulled in so
 * no card goes longer than the current maximum gap (or past its last look before
 * the exam), which ramps reviews up without rescheduling anything. Otherwise
 * it's just the scheduled date.
 */
export function effectiveDue(due: string, lastReviewed: string | null, examDate: string | null | undefined, now = new Date()): string {
  const p = examPhase(examDate, now)
  if (p.phase !== 'revision') return due
  let t = new Date(due).getTime()
  if (lastReviewed) t = Math.min(t, new Date(lastReviewed).getTime() + revisionMaxGapDays(p.days) * 86_400_000)
  const last = lastLookBefore(examDate, now)
  if (last) t = Math.min(t, last.getTime())
  return new Date(t).toISOString()
}

/**
 * Where to schedule a course card's next review, given what the scheduler
 * picked: further out while the exam is far off, closer in during revision,
 * never after the last look before the exam.
 */
export function examAdjustedDue(due: string, reviewedAt: Date, examDate: string | null | undefined): string {
  const p = examPhase(examDate, reviewedAt)
  const at = reviewedAt.getTime()
  let t = new Date(due).getTime()
  if (p.phase === 'steady') t = at + (t - at) * STEADY_STRETCH
  if (p.phase === 'revision') t = Math.min(t, at + revisionMaxGapDays(p.days) * 86_400_000)
  const last = lastLookBefore(examDate, reviewedAt)
  if (last) t = Math.min(t, Math.max(last.getTime(), at + 86_400_000))
  return new Date(t).toISOString()
}

/** The latest a review should be due for a course with this exam date, or null for no limit. */
export function lastLookBefore(examDate: string | null | undefined, now = new Date()): Date | null {
  const p = examPhase(examDate, now)
  if (p.phase === 'none' || p.phase === 'over') return null
  const [y, m, d] = examDate!.split('-').map(Number)
  const last = new Date(y, m - 1, d - LAST_LOOK_DAYS_BEFORE)
  return last.getTime() > dayStart(now).getTime() ? last : null
}

export interface CourseFull extends Course {
  weeks: WeekFull[]
}

export interface CourseSummary extends Course {
  week_count: number
  planning: boolean
  topic_count: number
  ready_count: number
  done_count: number
  due_count: number
  /** Its highest-numbered week (null with no numbered weeks), and how far through its topics you are. */
  latest_week: LatestWeek | null
}

export interface LatestWeek {
  id: string
  label: string
  number: number
  planning: boolean
  topic_count: number
  done_count: number
}

/**
 * The week everyone's on: the highest week number across all courses (week 9
 * once any course has a week 9), or null when no course has a numbered week.
 */
export function currentWeekNumber(courses: { latest_week: LatestWeek | null }[]): number | null {
  const nums = courses.flatMap((c) => (c.latest_week ? [c.latest_week.number] : []))
  return nums.length ? Math.max(...nums) : null
}

/** The course's week for the current week number, while it still has topics left to do. */
export function currentWeekToReview(course: { latest_week: LatestWeek | null }, current: number | null): LatestWeek | null {
  const w = course.latest_week
  if (!w || current === null || w.number !== current || isReadingWeek(w.label)) return null
  return w.topic_count > 0 && w.done_count < w.topic_count ? w : null
}

// ---------------------------------------------------------------------------
// Cleaning up what comes back

const wordRe = (w: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'giu')

/** Returns a usable question, or null when it can't be asked as written. */
export function sanitizeQuestion(q: CourseQuestion): CourseQuestion | null {
  const t = (s: string) => s.trim()
  switch (q.type) {
    case 'mcq': {
      const options = q.options.map(t).filter(Boolean)
      if (!t(q.q) || options.length < 2 || options.length !== q.options.length || q.answer < 0 || q.answer >= options.length) return null
      return { ...q, options }
    }
    case 'true_false':
      return t(q.q) ? q : null
    case 'fill_blank':
      return parseBlanks(q.text).answers.length > 0 ? q : null
    case 'wrong_word': {
      const wrong = t(q.wrong)
      if (!wrong || !t(q.correct) || normalizeAnswer(wrong) === normalizeAnswer(q.correct)) return null
      // The wrong word has to be in the sentence exactly once, or a tap is ambiguous.
      const hits = [...q.text.matchAll(wordRe(wrong))].length
      if (hits !== 1 || wrong.includes(' ')) return null
      return { ...q, wrong }
    }
    case 'order': {
      const items = q.items.map(t).filter(Boolean)
      return items.length >= 3 && new Set(items).size === items.length ? { ...q, items } : null
    }
    case 'match': {
      const pairs = q.pairs.filter((p) => t(p.term) && t(p.meaning))
      return pairs.length >= 2 ? { ...q, pairs } : null
    }
    case 'sort': {
      const buckets = q.buckets.map(t).filter(Boolean)
      const items = q.items.filter((i) => t(i.item) && buckets.some((b) => normalizeAnswer(b) === normalizeAnswer(i.bucket)))
      return buckets.length >= 2 && items.length >= 3 ? { ...q, buckets, items } : null
    }
    case 'explain':
      return t(q.q) && t(q.model) ? { ...q, points: q.points.map(t).filter(Boolean) } : null
  }
}

export function sanitizeQuestions(qs: CourseQuestion[]): CourseQuestion[] {
  return qs.map(sanitizeQuestion).filter((q): q is CourseQuestion => q !== null)
}

/**
 * Options in a random order, with the answer index following its option.
 * Models tend to put the right answer in the same few places; this makes the
 * position meaningless.
 */
export function shuffleOptions(options: string[], answer: number, rand: () => number = Math.random): { options: string[]; answer: number } {
  const order = options.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return { options: order.map((i) => options[i]), answer: order.indexOf(answer) }
}

/** Every multiple-choice question with its options shuffled. */
export function shuffleMcqs(qs: CourseQuestion[]): CourseQuestion[] {
  return qs.map((q) => (q.type === 'mcq' ? { ...q, ...shuffleOptions(q.options, q.answer) } : q))
}

/**
 * Options in a new random order where the right answer never stays where it
 * was (when there's more than one option), so a retried question can't be
 * answered from memory of where the answer sat.
 */
export function moveAnswer(options: string[], answer: number, rand: () => number = Math.random): { options: string[]; answer: number } {
  if (options.length < 2) return { options, answer }
  for (let i = 0; i < 6; i++) {
    const s = shuffleOptions(options, answer, rand)
    if (s.answer !== answer) return s
  }
  // Unlucky: rotate by one, which always moves it.
  return { options: [...options.slice(1), options[0]], answer: (answer - 1 + options.length) % options.length }
}

/** The same course question with its answers in new places, for when it comes back. */
export function reshuffleQuestion(q: CourseQuestion, rand: () => number = Math.random): CourseQuestion {
  return q.type === 'mcq' ? { ...q, ...moveAnswer(q.options, q.answer, rand) } : q
}

// ---------------------------------------------------------------------------
// fill_blank: "Passing tests is [[evidence|support]] of correctness, not [[proof]]."

export function parseBlanks(text: string): { segments: BlankSegment[]; answers: string[]; alternatives: string[][] } {
  const segments: BlankSegment[] = []
  const answers: string[] = []
  const alternatives: string[][] = []
  let last = 0
  for (const m of text.matchAll(/\[\[([^\]]+?)\]\]/g)) {
    const start = m.index ?? 0
    if (start > last) segments.push({ type: 'text', value: text.slice(last, start) })
    const alts = m[1].split('|').map((s) => s.trim()).filter(Boolean)
    if (alts.length) {
      segments.push({ type: 'blank', value: alts[0] })
      answers.push(alts[0])
      alternatives.push(alts)
    }
    last = start + m[0].length
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) })
  return { segments, answers, alternatives }
}

// wrong_word: the sentence split into tappable words (punctuation stays attached).
export function wordTokens(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}
export function tokenIs(token: string, word: string): boolean {
  return normalizeAnswer(token.replace(/[^\p{L}\p{N}'’-]/gu, '')) === normalizeAnswer(word)
}

// ---------------------------------------------------------------------------
// Rendering with the Learn components

export type CourseAnswer = LearnAnswer | { type: 'wrong_word'; index: number } | { type: 'order'; order: number[] }

/** The six types that map straight onto an existing Learn question component. */
export function asLearnQuestion(q: CourseQuestion, id: string): LearnQuestion | null {
  const common = { id, card_id: '', card_ids: [], cached: false }
  switch (q.type) {
    case 'mcq':
      return { ...common, type: 'multiple_choice', payload: { question: q.q, options: q.options, correct_index: q.answer } }
    case 'true_false':
      return { ...common, type: 'true_false', payload: { statement: q.q, is_true: q.answer, correction: '' } }
    case 'fill_blank': {
      const b = parseBlanks(q.text)
      return { ...common, type: 'fill_blank', payload: { prompt: '', segments: b.segments, answers: b.answers } }
    }
    case 'match':
      return { ...common, type: 'match_pairs', payload: { pairs: q.pairs.map((p) => ({ left: p.term, right: p.meaning, card_id: '' })) } }
    case 'sort':
      return {
        ...common,
        type: 'categorize',
        payload: { categories: q.buckets, items: q.items.map((i) => ({ text: i.item, category: q.buckets.find((b) => normalizeAnswer(b) === normalizeAnswer(i.bucket)) ?? i.bucket })) }
      }
    case 'explain':
      return { ...common, type: 'free_answer', payload: { question: q.q, expected_answer: q.model, marks: explainMarks(q) } }
    default:
      return null
  }
}

/** What an explain (essay) question is out of: a mark for each key point in its mark scheme. */
export function explainMarks(q: Extract<CourseQuestion, { type: 'explain' }>): number {
  return Math.max(1, q.points.filter((p) => p.trim()).length)
}

/**
 * The hints a question can give, one at a time and only when you ask: its
 * nudge, then for an essay question each point the mark scheme gives a mark for.
 */
export function questionHints(q: CourseQuestion): string[] {
  const nudge = q.hint.trim() ? [q.hint.trim()] : []
  if (q.type !== 'explain') return nudge
  return [...nudge, ...q.points.filter((p) => p.trim()).map((p) => `A mark for: ${p.trim()}`)]
}

/** Mark everything except explain (which goes to Claude). */
export function markCourseAnswer(q: CourseQuestion, a: CourseAnswer, t?: Thresholds): Mark | null {
  switch (q.type) {
    case 'wrong_word': {
      if (a.type !== 'wrong_word') throw new Error('Answer does not match the question')
      const ok = tokenIs(wordTokens(q.text)[a.index] ?? '', q.wrong)
      return { score: ok ? 10 : 0, verdict: ok ? 'correct' : 'wrong', by: 'code' }
    }
    case 'order': {
      if (a.type !== 'order') throw new Error('Answer does not match the question')
      const wrongItems = a.order.map((orig, pos) => (orig === pos ? -1 : pos)).filter((p) => p >= 0)
      const right = q.items.length - wrongItems.length
      if (right === q.items.length) return { score: 10, verdict: 'correct', detail: { wrongItems }, by: 'code' }
      const score = Math.round((right / q.items.length) * 100) / 10
      const v = verdictFor(score, t)
      return { score, verdict: v === 'correct' ? 'partial' : v, detail: { wrongItems }, by: 'code' }
    }
    case 'fill_blank': {
      if (a.type !== 'fill_blank') throw new Error('Answer does not match the question')
      const { alternatives } = parseBlanks(q.text)
      const blanks = alternatives.map((alts, i) => alts.some((alt) => blankMatches(a.values[i] ?? '', alt)))
      const ok = blanks.every(Boolean)
      return { score: ok ? 10 : 0, verdict: ok ? 'correct' : 'wrong', detail: { blanks }, by: 'code' }
    }
    case 'explain':
      return null
    default: {
      const lq = asLearnQuestion(q, 'q')!
      return markInCode(lq, a as LearnAnswer, t)
    }
  }
}

/** Plain text of a question, for Explain and recall. */
export function questionText(q: CourseQuestion): string {
  switch (q.type) {
    case 'mcq':
      return `${q.q}\n${q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}`
    case 'true_false':
      return `True or false: ${q.q}`
    case 'fill_blank':
      return parseBlanks(q.text).segments.map((s) => (s.type === 'blank' ? '_____' : s.value)).join('')
    case 'wrong_word':
      return `Which word is wrong? ${q.text}`
    case 'order':
      return `${q.q}\n${q.items.map((i) => `- ${i}`).join('\n')}`
    case 'match':
      return `${q.q}\n${q.pairs.map((p) => `- ${p.term}`).join('\n')}`
    case 'sort':
      return `${q.q} (${q.buckets.join(' / ')})\n${q.items.map((i) => `- ${i.item}`).join('\n')}`
    case 'explain':
      return q.q
  }
}

export function expectedText(q: CourseQuestion): string {
  switch (q.type) {
    case 'mcq':
      return q.options[q.answer] ?? ''
    case 'true_false':
      return q.answer ? 'True' : 'False'
    case 'fill_blank':
      return parseBlanks(q.text).answers.join(', ')
    case 'wrong_word':
      return `"${q.wrong}" should be "${q.correct}"`
    case 'order':
      return q.items.map((s, i) => `${i + 1}. ${s}`).join('\n')
    case 'match':
      return q.pairs.map((p) => `${p.term}: ${p.meaning}`).join('\n')
    case 'sort':
      return q.items.map((i) => `${i.item} → ${i.bucket}`).join('\n')
    case 'explain':
      return q.model
  }
}

// ---------------------------------------------------------------------------
// Page ranges from the outline's "where": "slides 4–19", "pp. 3-7", "4, 6, 9–12"

export function pageList(where: string, max: number): number[] {
  if (/\d{1,2}:\d{2}/.test(where)) return [] // timestamps, not pages
  const out = new Set<number>()
  for (const m of where.matchAll(/(\d+)\s*(?:[-–—]|to)\s*(\d+)|(\d+)/g)) {
    const a = Number(m[1] ?? m[3])
    const b = Number(m[2] ?? m[3])
    for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(max, Math.max(a, b)); p++) out.add(p)
  }
  return [...out].sort((x, y) => x - y)
}

/**
 * Merge outlines written file by file: same title → same topic. Ids become t1…tn.
 * `known` are ids from earlier weeks that "needs" may point at.
 */
export function mergeOutlines(parts: CourseOutline[], known: string[] = []): CourseOutline {
  const topics: OutlineTopic[] = []
  for (const part of parts) {
    // Ids are only unique within one part; "needs" can also name a final id from an earlier part.
    const local = new Map<string, string>()
    const touched: { target: OutlineTopic; needs: string[] }[] = []
    for (const t of part.topics) {
      const existing = topics.find((x) => normalizeAnswer(x.title) === normalizeAnswer(t.title))
      if (existing) {
        local.set(t.id, existing.id)
        for (const s of t.sections) if (!existing.sections.some((x) => normalizeAnswer(x) === normalizeAnswer(s))) existing.sections.push(s)
        existing.sources.push(...t.sources)
        existing.stressed.push(...t.stressed.filter((s) => !existing.stressed.includes(s)))
        existing.minutes = Math.min(30, existing.minutes + Math.round(t.minutes / 2))
        touched.push({ target: existing, needs: t.needs })
      } else {
        const id = `t${topics.length + 1}`
        local.set(t.id, id)
        const nt = { ...t, id, sections: [...t.sections], sources: [...t.sources], stressed: [...t.stressed], needs: [] }
        topics.push(nt)
        touched.push({ target: nt, needs: t.needs })
      }
    }
    for (const { target, needs } of touched) {
      const mapped = needs.map((n) => local.get(n) ?? n).filter((n) => n !== target.id && (topics.some((x) => x.id === n) || known.includes(n)))
      target.needs = [...new Set([...target.needs, ...mapped])]
    }
  }
  return { course: parts.find((p) => p.course)?.course ?? '', topics }
}
