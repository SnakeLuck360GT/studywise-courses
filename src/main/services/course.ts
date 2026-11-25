import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { FINGERPRINT_VERSION, signature, type WeekFingerprint } from '@shared/fingerprint'
import { basename, extname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { getDb, uid, now, json } from '../db'
import { withPointCount } from '@shared/ssText'
import * as repo from '../db/repo'
import { placeNote } from './noteOrder'
import { runAI } from '../ai'
import { paths } from '../paths'
import { extractText, pdfPageCount, IMAGE_EXT, isImageFile } from '../files'
import type { JobContext } from '../jobs'
import { thresholdsFor } from './learn'
import { planTracker, topicTracker } from './liveProgress'
import { verdictFor } from '@shared/marking'
import { isDue } from '@shared/sm2'
import type { Mark } from '@shared/questions'
import type { Card, Deck, ModelChoice, ReviewState } from '@shared/types'
import { activeProvider } from '../ai/models'
import {
  CARD_CUT_INFO,
  COURSE_FOCUSES,
  effectiveDue,
  emptyProgress,
  isCourseFocus,
  isQuestionAmount,
  WEEK_TEST_INFO,
  examPhase,
  isNoteLevel,
  mergeOutlines,
  NOTE_LEVELS,
  NOTE_LEVEL_INFO,
  pageList,
  sanitizeQuestions,
  explainMarks,
  shuffleMcqs,
  sortWeeks,
  type AiTopic,
  type AiWeekTest,
  type CardCut,
  type CourseFocus,
  type Course,
  type CourseFile,
  type CourseFull,
  type CourseMarkOut,
  type CourseUpdate,
  type CourseExtendOut,
  type CourseTrimOut,
  type CourseOutline,
  type CourseQuestion,
  type CourseSummary,
  type Figure,
  type OutlineTopic,
  type NoteLevel,
  type Topic,
  type TopicContent,
  type TopicSection,
  type TopicProgress,
  type TopicVersion,
  type QuestionAmount,
  type Week,
  type WeekFull,
  type WeekTest,
  type WeekTestLevel,
  type WeekTestQuestion
} from '@shared/course'
import { cardKey, matchTopics, mergeLevels, mergePlan, remapContent, withQuestionJudge, type MergeTopic, type QuestionJudge } from '@shared/weekMerge'
import { askAboutRepeats, questionCollector } from './questionDedupe'

// A course is a run of weeks. Each week has its own files; its topics are
// planned from those files only, knowing what earlier weeks already cover.

export const COURSE_SOURCE_EXT = ['.pdf', '.docx', '.pptx', '.txt', '.md', '.markdown', '.vtt', '.srt', '.html', '.htm', '.rtf', '.csv', ...IMAGE_EXT]

/** Above this much text, a week is planned one file at a time and merged. */
const ONE_CALL_CHARS = 300_000
/** Attach a whole PDF to a topic call up to this many pages; beyond it we need page ranges. */
const WHOLE_PDF_PAGES = 40

// ---------------------------------------------------------------------------
// Rows

type CourseRow = Course & { note_folder_id?: string | null }
type RawCourseRow = Omit<CourseRow, 'private' | 'focus'> & { private: number; focus?: string | null }
type WeekRow = Omit<Week, 'recall_off' | 'private' | 'test'> & { outline: string | null; recall_off: number; private: number; planned_with?: string | null; test?: string | null }
type TopicRow = {
  id: string
  course_id: string
  week_id: string
  key: string
  position: number
  plan: string
  status: string
  error: string | null
  content: string | null
  progress: string
  updated_at: string
  note_id: string | null
  level: string | null
  versions: string | null
  /** {level: ModelChoice}: the model each level was written with. */
  written_with?: string | null
}
type Versions = Partial<Record<NoteLevel, TopicVersion>>

const rowLevel = (r: TopicRow): NoteLevel => (isNoteLevel(r.level) ? r.level : 'standard')
const rowVersions = (r: TopicRow): Versions => {
  const v = json<Versions>(r.versions, {})
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => isNoteLevel(k) && x?.content)) as Versions
}
/** Every level written for a topic: the one shown, and the ones put aside. */
const writtenLevels = (r: TopicRow): NoteLevel[] => {
  const v = rowVersions(r)
  return NOTE_LEVELS.filter((l) => (r.content && rowLevel(r) === l) || !!v[l])
}

function cardCounts(courseId: string): Map<string, number> {
  const m = new Map<string, number>()
  const ids = courseDeckIds(courseId)
  if (!ids.length) return m
  const rows = getDb()
    .prepare(`SELECT json_extract(source, '$.ref') ref, COUNT(*) n FROM cards WHERE deck_id IN (${ids.map(() => '?').join(',')}) AND json_extract(source, '$.type') = 'topic' GROUP BY ref`)
    .all(...ids) as { ref: string; n: number }[]
  for (const r of rows) m.set(r.ref, r.n)
  return m
}

const toTopic = (r: TopicRow, counts: Map<string, number>): Topic => ({
  id: r.id,
  course_id: r.course_id,
  week_id: r.week_id,
  key: r.key,
  position: r.position,
  plan: json(r.plan, {} as OutlineTopic),
  status: r.status as Topic['status'],
  error: r.error,
  content: json<TopicContent | null>(r.content, null),
  progress: { ...emptyProgress(), ...json<Partial<TopicProgress>>(r.progress, {}) },
  card_count: counts.get(r.id) ?? 0,
  note_id: r.note_id ?? null,
  level: rowLevel(r),
  levels: writtenLevels(r),
  updated_at: r.updated_at
})

const toWeek = ({ outline: _o, recall_off, private: p, planned_with: _p, test, ...w }: WeekRow): Week => ({ ...w, recall_off: !!recall_off, private: !!p, test: json<WeekTest | null>(test ?? null, null) })
const toCourseRow = (r: RawCourseRow): CourseRow => ({ ...r, private: !!r.private, focus: json<string[]>(r.focus ?? null, []).filter(isCourseFocus) })

function courseRow(id: string): CourseRow {
  const r = getDb().prepare('SELECT * FROM courses WHERE id = ?').get(id) as RawCourseRow | undefined
  if (!r) throw new Error('Course not found')
  return toCourseRow(r)
}

function weekRow(id: string): WeekRow {
  const r = getDb().prepare('SELECT * FROM weeks WHERE id = ?').get(id) as WeekRow | undefined
  if (!r) throw new Error('Week not found')
  return r
}

export function getCourse(id: string): CourseFull {
  const { note_folder_id: _f, ...c } = courseRow(id)
  const files = listFiles(id)
  const topics = listTopics(id)
  const counts = new Map(
    (getDb().prepare('SELECT w.id, COUNT(c.id) n FROM weeks w LEFT JOIN cards c ON c.deck_id = w.deck_id WHERE w.course_id = ? GROUP BY w.id').all(id) as { id: string; n: number }[]).map((r) => [r.id, r.n])
  )
  const weeks = (getDb().prepare('SELECT * FROM weeks WHERE course_id = ? ORDER BY position').all(id) as WeekRow[]).map(
    (w): WeekFull => ({ ...toWeek(w), files: files.filter((f) => f.week_id === w.id), topics: topics.filter((t) => t.week_id === w.id), card_count: counts.get(w.id) ?? 0 })
  )
  // In week-number order, so a week added out of order (downloaded later) sits in its place.
  // Positions stay as they are: topic keys and "earlier weeks" when planning use them.
  return { ...c, weeks: sortWeeks(weeks) }
}

/** Where a course file's copy lives, to open it or show it in its folder. */
export function courseFilePath(fileId: string): string {
  const f = getDb().prepare('SELECT path FROM course_files WHERE id = ?').get(fileId) as { path: string } | undefined
  if (!f || !existsSync(f.path)) throw new Error('That file is no longer in the course')
  return f.path
}

export function listCourses(): CourseSummary[] {
  const rows = (getDb().prepare('SELECT * FROM courses ORDER BY updated_at DESC').all() as RawCourseRow[]).map(toCourseRow)
  return rows.map((r) => {
    const topics = getDb().prepare('SELECT status, progress FROM topics WHERE course_id = ?').all(r.id) as { status: string; progress: string }[]
    const weeks = getDb().prepare('SELECT status FROM weeks WHERE course_id = ?').all(r.id) as { status: string }[]
    let due = 0
    for (const d of recallDeckIds(r.id)) {
      try {
        due += repo.dueCards(d).length
      } catch {
        /* deck gone */
      }
    }
    const { note_folder_id: _f, ...course } = r
    return {
      ...course,
      week_count: weeks.length,
      planning: weeks.some((w) => w.status === 'planning'),
      topic_count: topics.length,
      ready_count: topics.filter((t) => t.status === 'ready').length,
      done_count: topics.filter((t) => json<Partial<TopicProgress>>(t.progress, {}).done).length,
      due_count: due
    }
  })
}

export function listFiles(courseId: string): CourseFile[] {
  return getDb()
    .prepare('SELECT f.id, f.course_id, f.week_id, f.name, f.path, f.pages FROM course_files f JOIN weeks w ON w.id = f.week_id WHERE f.course_id = ? ORDER BY w.position, f.position')
    .all(courseId) as CourseFile[]
}

/** All topics of a course, in teaching order (week, then position). */
export function listTopics(courseId: string): Topic[] {
  courseRow(courseId)
  const counts = cardCounts(courseId)
  return (getDb().prepare('SELECT t.* FROM topics t JOIN weeks w ON w.id = t.week_id WHERE t.course_id = ? ORDER BY w.position, t.position').all(courseId) as TopicRow[]).map((t) =>
    toTopic(t, counts)
  )
}

export function getTopic(id: string): Topic {
  const r = getDb().prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined
  if (!r) throw new Error('Topic not found')
  return toTopic(r, cardCounts(r.course_id))
}

function touchCourse(id: string): void {
  getDb().prepare('UPDATE courses SET updated_at = ? WHERE id = ?').run(now(), id)
}

function setWeek(id: string, patch: { status?: string; error?: string | null; outline?: string | null; label?: string; planned_with?: string | null; test?: string | null }): void {
  const sets = Object.keys(patch).map((k) => `${k} = @${k}`)
  if (sets.length) getDb().prepare(`UPDATE weeks SET ${sets.join(', ')} WHERE id = @id`).run({ ...patch, id })
}

function topicRow(id: string): TopicRow {
  const r = getDb().prepare('SELECT * FROM topics WHERE id = ?').get(id) as TopicRow | undefined
  if (!r) throw new Error('Topic not found')
  return r
}

function setTopic(id: string, patch: { status?: string; error?: string | null; content?: string | null; progress?: string; level?: NoteLevel; versions?: string; written_with?: string; plan?: string }): void {
  const sets = Object.keys(patch).map((k) => `${k} = @${k}`)
  getDb().prepare(`UPDATE topics SET ${[...sets, 'updated_at = @updated_at'].join(', ')} WHERE id = @id`).run({ ...patch, updated_at: now(), id })
}

/** After a crash or quit, nothing is still being written. */
export function recoverInterrupted(): void {
  const d = getDb()
  // A topic that already had notes keeps them; the write that was cut short is just reported.
  d.prepare("UPDATE topics SET status = CASE WHEN content IS NULL THEN 'error' ELSE 'ready' END, error = 'Interrupted. Write it again.' WHERE status = 'writing'").run()
  d.prepare("UPDATE weeks SET status = 'error', error = 'Planning was interrupted. Plan it again.' WHERE status = 'planning'").run()
}

// ---------------------------------------------------------------------------
// Creating

function courseDir(courseId: string): string {
  return join(paths.courses, courseId)
}

// Recall cards live in Decks, in a folder named after the course with one
// deck per week ("Physics · Week 1"). Courses made before this kept one deck
// for everything (courses.deck_id); organizeCourseDecks() sorts those out.

const deckExists = (id: string | null | undefined): id is string => {
  if (!id) return false
  try {
    repo.getDeck(id)
    return true
  } catch {
    return false
  }
}

export const weekDeckName = (courseName: string, weekLabel: string) => `${courseName} · ${weekLabel}`

/** The course's folder in Decks (made again if it was deleted). */
export function deckFolder(courseId: string): string {
  const c = courseRow(courseId)
  if (c.deck_folder_id && repo.listFolders('deck').some((f) => f.id === c.deck_folder_id)) return c.deck_folder_id
  const f = repo.createFolder(c.name, 'deck')
  getDb().prepare('UPDATE courses SET deck_folder_id = ? WHERE id = ?').run(f.id, courseId)
  return f.id
}

/** The course's decks with recall on: every week's, except weeks with recall turned off. */
function recallOnDeckIds(courseId: string): string[] {
  const off = new Set((getDb().prepare('SELECT deck_id FROM weeks WHERE course_id = ? AND recall_off = 1').all(courseId) as { deck_id: string | null }[]).map((w) => w.deck_id))
  return courseDeckIds(courseId).filter((d) => !off.has(d))
}

/**
 * The course's decks whose cards come up for review: weeks with recall on,
 * and none once the exam is over.
 */
export function recallDeckIds(courseId: string): string[] {
  return examPhase(courseRow(courseId).exam_date).phase === 'over' ? [] : recallOnDeckIds(courseId)
}

/** Set (YYYY-MM-DD) or clear the course's exam date. */
export function setExamDate(courseId: string, date: string | null): Course {
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick a date for the exam')
  courseRow(courseId)
  getDb().prepare('UPDATE courses SET exam_date = ? WHERE id = ?').run(date, courseId)
  touchCourse(courseId)
  return courseRow(courseId)
}

/** Your note to the AI about the course. It goes into every prompt for the course (see renderPrompt). */
/** What kind of course it is (theory, practical/coding, formula/method heavy): every prompt for it tailors to these. */
export function setCourseFocus(courseId: string, focus: CourseFocus[]): Course {
  const clean = COURSE_FOCUSES.filter((f) => focus.includes(f))
  getDb().prepare('UPDATE courses SET focus = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(clean), now(), courseId)
  return courseRow(courseId)
}

export function setCourseNote(courseId: string, note: string): Course {
  courseRow(courseId)
  getDb().prepare('UPDATE courses SET note = ? WHERE id = ?').run(note.trim(), courseId)
  touchCourse(courseId)
  return courseRow(courseId)
}

/** Instructions you typed for one run, worded so the model puts them ahead of its standing rules. */
export function priorityInstructions(text: string): string {
  const t = text.trim()
  return t ? `My own instructions for this. They take priority over your other rules and anything above whenever they disagree:
${t}` : ''
}

/**
 * Topic cards wait until you've studied them: a card counts towards what's due
 * once you reach its section's flashcards in the topic (or finish the topic, or
 * rate it), not as soon as the topic is written. Cards you've reviewed are never
 * put back to sleep. Runs when a topic is written or its progress changes, and
 * for every topic at startup. Returns how many cards changed.
 */
export function refreshDormancy(topicId?: string): number {
  const d = getDb()
  const ids = topicId ? [topicId] : (d.prepare("SELECT id FROM topics WHERE status = 'ready'").all() as { id: string }[]).map((r) => r.id)
  const cardsOf = d.prepare(
    "SELECT c.id, c.dormant, EXISTS (SELECT 1 FROM review_state r WHERE r.card_id = c.id) AS reviewed FROM cards c WHERE json_extract(c.source, '$.type') = 'topic' AND json_extract(c.source, '$.ref') = ?"
  )
  const set = d.prepare('UPDATE cards SET dormant = ? WHERE id = ?')
  let changed = 0
  d.transaction(() => {
    for (const id of ids) {
      let t: Topic
      try {
        t = getTopic(id)
      } catch {
        continue
      }
      const p = t.progress
      const started = p.done || p.section > 0 || !!p.step
      const known = new Set<string>()
      const reached = new Set<string>()
      ;(t.content?.sections ?? []).forEach((s, i) => {
        // Reached: you're past this section, or at its flashcards or questions.
        const here = p.done || i < p.section || (i === p.section && !!p.step && p.step.section === i && p.step.kind !== 'notes')
        for (const c of s.cards ?? [])
          if (c.id) {
            known.add(c.id)
            if (here) reached.add(c.id)
          }
      })
      for (const c of cardsOf.all(id) as { id: string; dormant: number; reviewed: number }[]) {
        // Cards from older topics without per-section cards wake when you start the topic.
        const want = c.reviewed ? 0 : known.has(c.id) ? (reached.has(c.id) ? 0 : 1) : started ? 0 : 1
        if (want !== c.dormant) {
          set.run(want, c.id)
          changed++
        }
      }
    }
  })()
  return changed
}

/** Turn recall on or off for a week. Its cards and their review history stay either way. */
export function setWeekRecall(weekId: string, on: boolean): Week {
  weekRow(weekId)
  getDb().prepare('UPDATE weeks SET recall_off = ? WHERE id = ?').run(on ? 0 : 1, weekId)
  touchCourse(weekRow(weekId).course_id)
  return toWeek(weekRow(weekId))
}

/** Private: the course's weeks are never published to the marketplace (see market.setCourseVisibility, which also takes them down). */
export function setCoursePrivate(courseId: string, isPrivate: boolean): Course {
  courseRow(courseId)
  getDb().prepare('UPDATE courses SET private = ? WHERE id = ?').run(isPrivate ? 1 : 0, courseId)
  touchCourse(courseId)
  return courseRow(courseId)
}

/** Private: the week is never published to the marketplace (see market.setWeekVisibility, which also takes it down). */
export function setWeekPrivate(weekId: string, isPrivate: boolean): Week {
  weekRow(weekId)
  getDb().prepare('UPDATE weeks SET private = ? WHERE id = ?').run(isPrivate ? 1 : 0, weekId)
  touchCourse(weekRow(weekId).course_id)
  return toWeek(weekRow(weekId))
}

/** Every deck holding this course's cards: the week decks, plus an old course-wide deck. */
export function courseDeckIds(courseId: string): string[] {
  const c = courseRow(courseId)
  const weekDecks = (getDb().prepare('SELECT deck_id FROM weeks WHERE course_id = ? ORDER BY position').all(courseId) as { deck_id: string | null }[]).map((w) => w.deck_id)
  return [...new Set([...weekDecks, c.deck_id].filter(deckExists))]
}

type DeckAiSettings = Pick<Deck, 'extra_instructions' | 'model_overrides' | 'thresholds'>

/** Models & instructions are set for the whole course, so all its decks share them. */
export function courseDeckSettings(courseId: string): DeckAiSettings {
  const id = courseDeckIds(courseId)[0]
  if (!id) return { extra_instructions: '', model_overrides: {}, thresholds: null }
  const d = repo.getDeck(id)
  return { extra_instructions: d.extra_instructions, model_overrides: d.model_overrides, thresholds: d.thresholds }
}

export function setCourseDeckSettings(courseId: string, s: DeckAiSettings): void {
  for (const id of courseDeckIds(courseId)) repo.updateDeck(id, s)
}

/** The deck for a week's recall cards, made (in the course folder) when missing. */
export function ensureWeekDeck(weekId: string): string {
  const w = weekRow(weekId)
  if (deckExists(w.deck_id)) return w.deck_id
  const c = courseRow(w.course_id)
  const settings = courseDeckSettings(c.id)
  const deck = repo.createDeck({ name: weekDeckName(c.name, w.label), folder_id: deckFolder(c.id), description: `Recall cards from ${c.name}, ${w.label}` })
  repo.updateDeck(deck.id, settings)
  getDb().prepare('UPDATE weeks SET deck_id = ? WHERE id = ?').run(deck.id, weekId)
  return deck.id
}

/** A deck to run course-wide AI calls with (they all share the course's settings). */
function courseDeckId(courseId: string): string | null {
  return courseDeckIds(courseId)[0] ?? null
}

/**
 * Gives every course its folder and week decks, and moves cards out of the old
 * one-deck-per-course layout (review history goes with them). Runs at startup;
 * does nothing once a course is organised.
 */
export function organizeCourseDecks(): void {
  const d = getDb()
  for (const c of d.prepare('SELECT * FROM courses').all() as CourseRow[]) {
    deckFolder(c.id)
    const weeks = d.prepare('SELECT id FROM weeks WHERE course_id = ? ORDER BY position').all(c.id) as { id: string }[]
    for (const w of weeks) ensureWeekDeck(w.id)
    if (!deckExists(c.deck_id)) {
      if (c.deck_id) d.prepare('UPDATE courses SET deck_id = NULL WHERE id = ?').run(c.id)
      continue
    }
    const legacy = c.deck_id
    const weekOf = new Map((d.prepare('SELECT t.id, w.deck_id FROM topics t JOIN weeks w ON w.id = t.week_id WHERE t.course_id = ?').all(c.id) as { id: string; deck_id: string }[]).map((r) => [r.id, r.deck_id]))
    const cards = d.prepare("SELECT id, json_extract(source, '$.ref') ref FROM cards WHERE deck_id = ? AND json_extract(source, '$.type') = 'topic'").all(legacy) as { id: string; ref: string | null }[]
    d.transaction(() => {
      for (const card of cards) {
        const target = card.ref ? weekOf.get(card.ref) : undefined
        if (!target) continue
        repo.moveCards([card.id], target)
        d.prepare('UPDATE review_log SET deck_id = ? WHERE card_id = ?').run(target, card.id)
      }
      const left = (d.prepare('SELECT COUNT(*) n FROM cards WHERE deck_id = ?').get(legacy) as { n: number }).n
      if (left === 0) {
        repo.deleteDeck(legacy)
        d.prepare('UPDATE courses SET deck_id = NULL WHERE id = ?').run(c.id)
      } else {
        // Cards you added yourself stay together, inside the course folder.
        repo.updateDeck(legacy, { name: `${c.name} · Other cards`, folder_id: deckFolder(c.id) })
      }
    })()
  }
}

/** New courses are public (their weeks can go on the marketplace) unless made private. */
export function createCourse(input: { name: string; level: string; private?: boolean }): Course {
  const id = uid()
  const t = now()
  getDb()
    .prepare('INSERT INTO courses (id, name, module, level, deck_id, private, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
    .run(id, input.name, input.name, input.level, input.private ? 1 : 0, t, t)
  deckFolder(id)
  return courseRow(id)
}

/** A new week is public or private as you say, or like its course when you don't. */
export function addWeek(courseId: string, label?: string, opts: { private?: boolean } = {}): Week {
  const c = courseRow(courseId)
  const n = (getDb().prepare('SELECT COUNT(*) n, COALESCE(MAX(position), -1) p FROM weeks WHERE course_id = ?').get(courseId) as { n: number; p: number })
  const id = uid()
  getDb()
    .prepare("INSERT INTO weeks (id, course_id, position, label, status, error, outline, private, created_at) VALUES (?, ?, ?, ?, 'empty', NULL, NULL, ?, ?)")
    .run(id, courseId, n.p + 1, label?.trim() || `Week ${n.n + 1}`, (opts.private ?? c.private) ? 1 : 0, now())
  ensureWeekDeck(id)
  touchCourse(courseId)
  return toWeek(weekRow(id))
}

export function getCourseIdForWeek(weekId: string): string {
  return weekRow(weekId).course_id
}

export function renameWeek(weekId: string, label: string): void {
  const before = weekRow(weekId)
  const noteParent = (getDb().prepare('SELECT note_folder_id FROM courses WHERE id = ?').get(before.course_id) as { note_folder_id: string | null }).note_folder_id
  const notesFolder = noteParent ? repo.listFolders('note').find((f) => f.parent_id === noteParent && f.name === before.label) : undefined
  if (notesFolder) repo.renameFolder(notesFolder.id, label)
  setWeek(weekId, { label })
  const w = weekRow(weekId)
  if (deckExists(w.deck_id)) repo.updateDeck(w.deck_id, { name: weekDeckName(courseRow(w.course_id).name, label) })
}

/** Removes the week, its files, its topics and their recall cards. */
export function deleteWeek(weekId: string): void {
  const w = weekRow(weekId)
  const c = courseRow(w.course_id)
  const topicIds = (getDb().prepare('SELECT id FROM topics WHERE week_id = ?').all(weekId) as { id: string }[]).map((r) => r.id)
  for (const t of topicIds) repo.deleteCards(topicCardIds(c.id, t))
  if (deckExists(w.deck_id)) repo.deleteDeck(w.deck_id)
  for (const f of listFiles(w.course_id).filter((f) => f.week_id === weekId)) rmSync(f.path, { force: true })
  getDb().prepare('DELETE FROM weeks WHERE id = ?').run(weekId)
  touchCourse(w.course_id)
}

/**
 * Merges duplicate weeks of a course into `targetId` (the same week added
 * twice, or two people's versions of it), without AI and without dropping
 * anything (see @shared/weekMerge for what counts as the same topic, section,
 * question or card):
 *   files         the same bytes become one file; the rest move over
 *   recall cards  a card whose front is already there is a repeat; the rest
 *                 move over with their reviews
 *   topics        a matching topic merges in at every level (your progress on
 *                 the target is kept; a finished one with new sections opens
 *                 again at the first new one), the rest move over
 * The other weeks are then removed. Returns what changed.
 */
/** The weeks to merge, once it's known they can be (same course, nothing still being planned or written). */
function mergeableWeeks(targetId: string, otherIds: string[]): { target: WeekRow; others: WeekRow[] } {
  const d = getDb()
  const target = weekRow(targetId)
  const others = [...new Set(otherIds)].filter((id) => id !== targetId).map(weekRow)
  if (!others.length) throw new Error('Pick another week to merge into this one.')
  if (others.some((w) => w.course_id !== target.course_id)) throw new Error('Only weeks of the same course can be merged.')
  for (const w of [target, ...others]) {
    if (w.status === 'planning') throw new Error(`${w.label} is still being planned. Merge it when that's done.`)
    if (d.prepare("SELECT 1 FROM topics WHERE week_id = ? AND status = 'writing'").get(w.id)) throw new Error(`A topic in ${w.label} is still being written. Merge it when that's done.`)
  }
  return { target, others }
}

/** A topic's title, plan and every written level, as merging compares them. */
function mergeTopicOf(r: TopicRow): MergeTopic {
  const contents: Record<string, TopicContent> = {}
  const shown = json<TopicContent | null>(r.content, null)
  if (shown) contents[rowLevel(r)] = shown
  for (const [l, v] of Object.entries(rowVersions(r))) if (v?.content && !contents[l]) contents[l] = v.content
  const plan = json<OutlineTopic | null>(r.plan, null)
  return { title: shown?.title ?? plan?.title ?? r.key, plan, contents }
}

/**
 * mergeWeeks, with the AI checking which questions from the different copies
 * ask the same thing in other words (see questionDedupe.ts). A dry run first
 * finds every list of questions the merge combines; nothing changes until the
 * real merge.
 */
export async function mergeWeeksChecked(targetId: string, otherIds: string[], signal?: AbortSignal): Promise<Awaited<ReturnType<typeof mergeWeeks>> & { repeats: number; checked: boolean }> {
  const { target, others } = mergeableWeeks(targetId, otherIds)
  const load = (weekId: string) => (getDb().prepare('SELECT * FROM topics WHERE week_id = ? ORDER BY position').all(weekId) as TopicRow[]).map(mergeTopicOf)
  const collect = questionCollector()
  withQuestionJudge(collect.judge, () => {
    const topics = load(target.id)
    for (const w of others) {
      const theirs = load(w.id)
      const m = matchTopics(topics, theirs)
      theirs.forEach((t, j) => {
        const i = m.get(j)
        if (i === undefined) topics.push(t)
        else topics[i] = { ...topics[i], contents: mergeLevels(topics[i].contents, t.contents) }
      })
    }
  })
  const c = getCourse(target.course_id)
  const check = await askAboutRepeats(collect.groups, { module: c.module || c.name, signal })
  const r = await mergeWeeks(targetId, otherIds, { judge: check.judge })
  return { ...r, repeats: check.pairs, checked: check.checked }
}

export async function mergeWeeks(targetId: string, otherIds: string[], opts: { judge?: QuestionJudge | null } = {}): Promise<{ weekId: string; merged: number; added: number; cards: number; files: number }> {
  const d = getDb()
  const { target, others } = mergeableWeeks(targetId, otherIds)
  const deckId = ensureWeekDeck(targetId)
  const sha = (p: string) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null)
  const allFiles = listFiles(target.course_id)
  const fileByHash = new Map<string, string>()
  for (const f of allFiles.filter((f) => f.week_id === targetId)) {
    const h = sha(f.path)
    if (h) fileByHash.set(h, f.id)
  }
  let filePos = allFiles.filter((f) => f.week_id === targetId).length
  const cardsIn = (deck: string) => d.prepare('SELECT id, front FROM cards WHERE deck_id = ?').all(deck) as { id: string; front: string }[]
  const cardByKey = new Map<string, string[]>()
  for (const c of cardsIn(deckId)) cardByKey.set(cardKey(c.front), [...(cardByKey.get(cardKey(c.front)) ?? []), c.id])
  const touched = new Set<string>()
  let merged = 0
  let added = 0
  let cards = 0
  let files = 0

  const asMerge = (r: TopicRow, fileMap: Map<string, string>, cardMap: Map<string, string>) => {
    const level = rowLevel(r)
    const contents: Record<string, TopicContent> = {}
    const shown = json<TopicContent | null>(r.content, null)
    if (shown) contents[level] = remapContent(shown, fileMap, cardMap)
    for (const [l, v] of Object.entries(rowVersions(r))) if (v?.content && !contents[l]) contents[l] = remapContent(v.content, fileMap, cardMap)
    const plan = json<OutlineTopic | null>(r.plan, null)
    return { row: r, level, topic: { title: shown?.title ?? plan?.title ?? r.key, plan, contents } satisfies MergeTopic }
  }

  // The judge (the AI check in mergeWeeksChecked) says which questions are repeats in other words.
  withQuestionJudge(opts.judge ?? null, () => {
  for (const w of others) {
    // Files: the same bytes as one already in the target week are that file.
    const fileMap = new Map<string, string>()
    for (const f of allFiles.filter((f) => f.week_id === w.id)) {
      const h = sha(f.path)
      const same = h ? fileByHash.get(h) : undefined
      if (same) {
        fileMap.set(f.id, same)
        d.prepare('DELETE FROM course_files WHERE id = ?').run(f.id)
        rmSync(f.path, { force: true })
      } else {
        d.prepare('UPDATE course_files SET week_id = ?, position = ? WHERE id = ?').run(targetId, filePos++, f.id)
        if (h) fileByHash.set(h, f.id)
        files++
      }
    }
    // Recall cards: repeats of one already in the target week go (each of those stands for at most
    // one card here, and two of this week's own are never folded together); the rest move over with their reviews.
    const cardMap = new Map<string, string>()
    if (deckExists(w.deck_id)) {
      const moving: string[] = []
      const repeats: string[] = []
      const before = new Map(cardByKey)
      const used = new Set<string>()
      for (const c of cardsIn(w.deck_id)) {
        const k = cardKey(c.front)
        const same = k ? before.get(k)?.find((id) => !used.has(id)) : undefined
        if (same) {
          used.add(same)
          cardMap.set(c.id, same)
          repeats.push(c.id)
        } else {
          moving.push(c.id)
          if (k) cardByKey.set(k, [...(cardByKey.get(k) ?? []), c.id])
        }
      }
      if (repeats.length) repo.deleteCards(repeats)
      if (moving.length) repo.moveCards(moving, deckId)
      cards += moving.length
    }

    // Topics.
    const mine = (d.prepare('SELECT * FROM topics WHERE week_id = ? ORDER BY position').all(targetId) as TopicRow[]).map((r) => asMerge(r, new Map(), new Map()))
    const theirs = (d.prepare('SELECT * FROM topics WHERE week_id = ? ORDER BY position').all(w.id) as TopicRow[]).map((r) => asMerge(r, fileMap, cardMap))
    const matches = matchTopics(
      mine.map((t) => t.topic),
      theirs.map((t) => t.topic)
    )
    const weekNo = target.position + 1
    let lastT = Math.max(0, ...mine.map((t) => Number(t.row.key.match(/t(\d+)$/)?.[1] ?? 0)))
    let lastPos = Math.max(-1, ...mine.map((t) => t.row.position))
    theirs.forEach((t, j) => {
      const m = matches.get(j)
      if (m === undefined) {
        // Not in the target week: it moves over, renumbered.
        const key = `w${weekNo}t${++lastT}`
        const versions = Object.fromEntries(Object.entries(rowVersions(t.row)).map(([l, v]) => [l, { ...v, content: t.topic.contents[l] ?? v!.content }]))
        d.prepare('UPDATE topics SET week_id = ?, key = ?, position = ?, plan = ?, content = ?, versions = ?, updated_at = ? WHERE id = ?').run(
          targetId,
          key,
          ++lastPos,
          t.topic.plan ? JSON.stringify({ ...t.topic.plan, id: key }) : t.row.plan,
          t.topic.contents[t.level] ? JSON.stringify(t.topic.contents[t.level]) : t.row.content,
          JSON.stringify(versions),
          now(),
          t.row.id
        )
        touched.add(t.row.id)
        added++
        return
      }
      // The same topic: one topic with everything from both.
      const into = mine[m]
      const contents = mergeLevels(into.topic.contents, t.topic.contents)
      const levels = NOTE_LEVELS.filter((l) => contents[l])
      const level = contents[into.level] ? into.level : (levels[0] ?? into.level)
      const oldVersions = rowVersions(into.row)
      const theirVersions = rowVersions(t.row)
      const progressOf = (l: NoteLevel): TopicProgress => {
        if (l === into.level && into.row.content) return { ...emptyProgress(), ...json<Partial<TopicProgress>>(into.row.progress, {}) }
        return oldVersions[l]?.progress ?? (l === t.level ? { ...emptyProgress(), ...json<Partial<TopicProgress>>(t.row.progress, {}) } : theirVersions[l]?.progress) ?? emptyProgress()
      }
      // A finished level that gained sections opens again at the first new one.
      const reopen = (l: NoteLevel, p: TopicProgress): TopicProgress => {
        const before = l === into.level ? json<TopicContent | null>(into.row.content, null)?.sections.length : oldVersions[l]?.content.sections.length
        const after = contents[l]?.sections.length ?? 0
        return p.done && before !== undefined && after > before ? { ...p, done: false, section: before, step: null } : p
      }
      const versions = Object.fromEntries(levels.filter((l) => l !== level).map((l) => [l, { content: contents[l], progress: reopen(l, progressOf(l)) }]))
      const plan = into.topic.plan && t.topic.plan ? mergePlan(into.topic.plan, t.topic.plan) : (into.topic.plan ?? t.topic.plan)
      const writtenWith = { ...json<Record<string, unknown>>(t.row.written_with, {}), ...json<Record<string, unknown>>(into.row.written_with, {}) }
      d.prepare('UPDATE topics SET status = ?, error = ?, plan = ?, content = ?, level = ?, versions = ?, progress = ?, written_with = ?, updated_at = ? WHERE id = ?').run(
        contents[level] ? 'ready' : into.row.status,
        contents[level] ? null : into.row.error,
        plan ? JSON.stringify(plan) : into.row.plan,
        contents[level] ? JSON.stringify(contents[level]) : null,
        level,
        JSON.stringify(versions),
        JSON.stringify(contents[level] ? reopen(level, progressOf(level)) : emptyProgress()),
        JSON.stringify(writtenWith),
        now(),
        into.row.id
      )
      // Its recall cards are the merged topic's now; its saved notes are replaced by the merged topic's.
      d.prepare("UPDATE cards SET source = json_set(source, '$.ref', ?) WHERE json_extract(source, '$.type') = 'topic' AND json_extract(source, '$.ref') = ?").run(into.row.id, t.row.id)
      d.prepare('DELETE FROM topics WHERE id = ?').run(t.row.id)
      if (t.row.note_id) repo.deleteNote(t.row.note_id)
      touched.add(into.row.id)
      merged++
    })

    // An empty target takes the other week's plan.
    if (target.status !== 'ready' && w.status === 'ready') {
      setWeek(targetId, { status: 'ready', error: null, outline: target.outline ?? w.outline ?? null, planned_with: target.planned_with ?? w.planned_with ?? null })
      target.status = 'ready'
    }
    // A target with no end-of-week test takes the other week's.
    if (!target.test && w.test) {
      setWeek(targetId, { test: w.test })
      target.test = w.test
    }
    deleteWeek(w.id)
  }
  })

  for (const id of touched) {
    refreshDormancy(id)
    if (topicRow(id).status === 'ready') await syncTopicNote(id).catch(() => null)
  }
  touchCourse(target.course_id)
  return { weekId: targetId, merged, added, cards, files }
}

export async function addFiles(weekId: string, files: string[]): Promise<CourseFile[]> {
  const w = weekRow(weekId)
  const dir = join(courseDir(w.course_id), 'files')
  mkdirSync(dir, { recursive: true })
  const all = listFiles(w.course_id)
  const taken = new Set(all.map((f) => f.name.toLowerCase()))
  let pos = all.filter((f) => f.week_id === weekId).length
  const ins = getDb().prepare('INSERT INTO course_files (id, course_id, week_id, name, path, pages, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const f of files) {
    if (!COURSE_SOURCE_EXT.includes(extname(f).toLowerCase())) continue
    let name = basename(f)
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${basename(f, extname(f))} (${n})${extname(f)}`
    taken.add(name.toLowerCase())
    const dest = join(dir, name)
    copyFileSync(f, dest)
    const pages = extname(f).toLowerCase() === '.pdf' ? await pdfPageCount(dest).catch(() => null) : null
    ins.run(uid(), w.course_id, weekId, name, dest, pages, pos++)
  }
  touchCourse(w.course_id)
  return listFiles(w.course_id).filter((f) => f.week_id === weekId)
}

export function removeFile(fileId: string): void {
  const f = getDb().prepare('SELECT path FROM course_files WHERE id = ?').get(fileId) as { path: string } | undefined
  if (!f) return
  getDb().prepare('DELETE FROM course_files WHERE id = ?').run(fileId)
  rmSync(f.path, { force: true })
}

export function deleteCourse(id: string, keepDeck: boolean): void {
  const c = courseRow(id)
  const decks = courseDeckIds(id)
  getDb().prepare('DELETE FROM courses WHERE id = ?').run(id)
  if (!keepDeck) {
    for (const d of decks) repo.deleteDeck(d)
    if (c.deck_folder_id) repo.deleteFolder(c.deck_folder_id)
  }
  rmSync(courseDir(id), { recursive: true, force: true })
}

export function renameCourse(id: string, name: string): void {
  getDb().prepare('UPDATE courses SET name = ?, module = ?, updated_at = ? WHERE id = ?').run(name, name, now(), id)
  const c = courseRow(id)
  if (c.note_folder_id) repo.renameFolder(c.note_folder_id, name)
  if (c.deck_folder_id) repo.renameFolder(c.deck_folder_id, name)
  for (const w of getDb().prepare('SELECT deck_id, label FROM weeks WHERE course_id = ?').all(id) as { deck_id: string | null; label: string }[])
    if (deckExists(w.deck_id)) repo.updateDeck(w.deck_id, { name: weekDeckName(name, w.label) })
}

// ---------------------------------------------------------------------------
// Reading sources

async function pdfPagesText(file: string): Promise<{ num: number; text: string }[]> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: readFileSync(file) })
  try {
    return (await parser.getText()).pages.map((p) => ({ num: p.num, text: p.text }))
  } finally {
    await parser.destroy()
  }
}

/** Text of a file for the prompt; PDFs get [page N] markers. Null for a PDF with no text layer. */
async function fileText(f: CourseFile): Promise<string | null> {
  // Pictures have no text: they're sent as files for Claude to look at.
  if (isImageFile(f.name)) return null
  if (extname(f.name).toLowerCase() === '.pdf') {
    const pages = await pdfPagesText(f.path)
    const chars = pages.reduce((n, p) => n + p.text.trim().length, 0)
    if (chars < pages.length * 20) return null // scanned slides: send the file instead
    return pages.map((p) => `[page ${p.num}]\n${p.text.trim()}`).join('\n\n')
  }
  return extractText(f.path)
}

/**
 * A week's material as a signature and file hashes, for spotting the same
 * slides on the marketplace. Nothing from the files themselves is in it.
 */
export async function weekFingerprint(weekId: string): Promise<WeekFingerprint> {
  const week = weekRow(weekId)
  const files = listFiles(week.course_id).filter((f) => f.week_id === weekId)
  const texts: string[] = []
  const hashes: string[] = []
  for (const f of files) {
    if (!existsSync(f.path)) continue
    hashes.push(createHash('sha256').update(readFileSync(f.path)).digest('hex'))
    const t = await fileText(f).catch(() => null)
    if (t) texts.push(t)
  }
  return { v: FINGERPRINT_VERSION, sig: signature(texts), hashes }
}

const fileBlock = (name: string, body: string, where = '') => `<file name="${name}"${where ? ` part="${where.replace(/"/g, "'")}"` : ''}>\n${body}\n</file>`

// ---------------------------------------------------------------------------
// 1. Plan a week's topics

/** The model a call ran on, as recorded with what it made (the provider filled in). */
function usedModel(m: ModelChoice): ModelChoice {
  return { model: m.model, effort: m.effort ?? null, provider: m.provider ?? activeProvider() }
}

const weekNo = (w: Week) => w.position + 1
const keyFor = (w: Week, localId: string) => `w${weekNo(w)}${localId}` // t3 in week 2 → w2t3

export async function planWeek(weekId: string, ctx: JobContext, instructions = ''): Promise<{ topics: number }> {
  const week = toWeek(weekRow(weekId))
  const course = courseRow(week.course_id)
  ctx.meta({ weekId, courseId: course.id })
  if ((getDb().prepare("SELECT 1 FROM topics WHERE week_id = ? AND status = 'writing'").get(weekId))) throw new Error('Wait for this week’s topics to finish writing first.')
  const files = listFiles(course.id).filter((f) => f.week_id === weekId)
  if (!files.length) throw new Error(`Add files to ${week.label} first.`)
  setWeek(weekId, { status: 'planning', error: null })
  const live = ctx.live ?? (() => {})
  try {
    ctx.progress('Reading the files…')
    live({ stage: 'Reading the files…', percent: 0.02 })
    const texts: { file: CourseFile; text: string | null }[] = []
    for (const f of files) texts.push({ file: f, text: await fileText(f).catch(() => null) })
    const describe = (list: typeof texts) => list.map(({ file }) => `${file.name}${file.pages ? ` (${file.pages} pages)` : ''}`).join(', ')
    const baseVars = { module: course.module || course.name, level: course.level, instructions: priorityInstructions(instructions) }
    const total = texts.reduce((n, t) => n + (t.text?.length ?? 0), 0)

    // What earlier weeks already teach, so this week doesn't repeat it.
    const earlier = listTopics(course.id).filter((t) => {
      const w = weekRow(t.week_id)
      return w.position < week.position
    })
    const earlierNote = earlier.length
      ? `This is ${week.label} of the course. Earlier weeks already have these topics:\n${earlier.map((t) => `- ${t.key}: ${t.content?.title ?? t.plan.title}`).join('\n')}\nDon't plan topics for what they already cover, unless this week takes it further. When a topic builds on one of them, put its id (like ${earlier[0].key}) in "needs". Number this week's own topics t1, t2, …`
      : ''

    live({ stage: 'Sending them to Claude…', percent: 0.08, log: files.map((f) => `Read ${f.name}`) })
    let plannedWith: ModelChoice | null = null
    const callFor = async (list: typeof texts, partInfo: string, from = 0.1, to = 0.95): Promise<CourseOutline> => {
      // PDFs without a text layer go in as files so Claude can look at the slides.
      // Scanned PDFs and pictures go in as files so Claude can look at them.
      const attach = list.filter((t) => t.text === null && (t.file.name.toLowerCase().endsWith('.pdf') || isImageFile(t.file.name))).map((t) => t.file.path)
      const source = list.filter((t) => t.text !== null).map((t) => fileBlock(t.file.name, t.text!.slice(0, ONE_CALL_CHARS))).join('\n\n')
      const r = await runAI<CourseOutline>({
        task: 'course_outline',
        vars: { ...baseVars, files: describe(list), source_text: source, part_info: [earlierNote, partInfo].filter(Boolean).join('\n\n') },
        files: attach.length ? attach : undefined,
        deckId: ensureWeekDeck(weekId),
        signal: ctx.signal
      })
      plannedWith = usedModel(r.model)
      return r.data
    }

    const known = earlier.map((t) => t.key)
    let outline: CourseOutline
    if (total <= ONE_CALL_CHARS || texts.length === 1) {
      ctx.progress(`Planning ${week.label} from ${files.length} file${files.length === 1 ? '' : 's'}…`)
      outline = mergeOutlines([await callFor(texts, '')], known)
    } else {
      // Too much for one call: plan file by file, telling each call what's already planned.
      const parts: CourseOutline[] = []
      for (const [i, t] of texts.entries()) {
        ctx.progress(`Planning file ${i + 1} of ${texts.length} (${t.file.name})…`)
        const sofar = parts.length ? mergeOutlines(parts, known) : null
        const note = [
          `This is file ${i + 1} of ${texts.length} for ${week.label} (all files: ${describe(texts)}). Plan only the topics in this file.`,
          sofar
            ? `Topics already planned from this week's earlier files:\n${sofar.topics.map((x) => `- ${x.id}: ${x.title}`).join('\n')}\nIf this file continues one of those, use exactly the same title so they can be merged.`
            : ''
        ]
          .filter(Boolean)
          .join('\n')
        parts.push(await callFor([t], note, 0.1 + (0.85 * i) / texts.length, 0.1 + (0.85 * (i + 1)) / texts.length))
      }
      outline = mergeOutlines(parts, known)
    }
    if (!outline.topics.length) throw new Error('Claude didn’t find any topics in these files.')

    // Week-local ids (t1…) become course-wide keys (w2t1…).
    const rekey = (id: string) => (/^t\d+$/.test(id) ? keyFor(week, id) : id)
    const topics = outline.topics.map((t) => ({ ...t, id: rekey(t.id), needs: t.needs.map(rekey) }))

    const d = getDb()
    d.transaction(() => {
      // Re-planning replaces this week's topics. Their recall cards stay in the deck.
      d.prepare('DELETE FROM topics WHERE week_id = ?').run(weekId)
      const ins = d.prepare("INSERT INTO topics (id, course_id, week_id, key, position, plan, status, error, content, progress, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, '{}', ?)")
      topics.forEach((t, i) => ins.run(uid(), course.id, weekId, t.id, i, JSON.stringify(t), now()))
    })()
    setWeek(weekId, { status: 'ready', error: null, outline: JSON.stringify({ ...outline, topics }), planned_with: plannedWith ? JSON.stringify(plannedWith) : null })
    touchCourse(course.id)
    return { topics: topics.length }
  } catch (e) {
    setWeek(weekId, { status: 'error', error: ctx.signal.aborted ? 'Cancelled' : (e as Error).message })
    throw e
  }
}

// ---------------------------------------------------------------------------
// 1b. An end-of-week test (multiple choice only)

/** About three questions per topic, between 10 and 25. */
export const weekTestCount = (topics: number) => Math.max(10, Math.min(25, topics * 3 || 15))

/**
 * Write a week's end-of-week test from its files (or, for a week with no files
 * here, its written notes) at a difficulty. Replaces any test it had.
 */
export async function writeWeekTest(weekId: string, ctx: JobContext, difficulty: WeekTestLevel, instructions = ''): Promise<{ questions: number }> {
  const week = toWeek(weekRow(weekId))
  const course = courseRow(week.course_id)
  ctx.meta({ weekId, courseId: course.id })
  const files = listFiles(course.id).filter((f) => f.week_id === weekId && existsSync(f.path))
  const topics = listTopics(course.id).filter((t) => t.week_id === weekId)
  const written = topics.filter((t) => t.content)
  if (!files.length && !written.length) throw new Error(`Add files to ${week.label}, or write its topics, first.`)
  const live = ctx.live ?? (() => {})
  ctx.progress(`Writing the ${WEEK_TEST_INFO[difficulty].label.toLowerCase()} end-of-week test for ${week.label}…`)
  live({ stage: 'Reading the week…', percent: 0.02 })

  const texts: { file: CourseFile; text: string | null }[] = []
  for (const f of files) texts.push({ file: f, text: await fileText(f).catch(() => null) })
  const attach = texts.filter((t) => t.text === null && (t.file.name.toLowerCase().endsWith('.pdf') || isImageFile(t.file.name))).map((t) => t.file.path)
  // The files share one call's worth of text between them.
  const withText = texts.filter((t) => t.text !== null)
  const share = withText.length ? Math.floor(ONE_CALL_CHARS / withText.length) : 0
  let source = withText.map((t) => fileBlock(t.file.name, t.text!.slice(0, share))).join('\n\n')
  // Nothing to read (a week added from someone else with no files here): the written notes stand in.
  if (!source && !attach.length)
    source = written
      .map((t) => fileBlock(`${t.content!.title} (notes)`, t.content!.sections.map((s) => `## ${s.heading}\n${s.notes}`).join('\n\n')))
      .join('\n\n')
      .slice(0, ONE_CALL_CHARS)
  const topicList = topics.length
    ? topics.map((t) => `- ${t.content?.title ?? t.plan.title}${t.plan.goal ? `: ${t.plan.goal}` : ''}${t.plan.stressed?.length ? ` (stressed: ${t.plan.stressed.join('; ')})` : ''}`).join('\n')
    : '(Not planned yet: work out the topics from the files.)'
  const count = weekTestCount(topics.length)

  live({ stage: 'Sending it to Claude…', percent: 0.08, log: files.length ? files.map((f) => `Read ${f.name}`) : ['Using the written notes'] })
  const r = await runAI<AiWeekTest>({
    task: 'course_week_test',
    vars: {
      module: course.module || course.name,
      level: course.level,
      week: week.label,
      topics: topicList,
      files: files.length ? files.map((f) => f.name).join(', ') : 'none (the notes are included below)',
      difficulty: `${WEEK_TEST_INFO[difficulty].label}. ${WEEK_TEST_INFO[difficulty].about}`,
      count: String(count),
      source_text: source,
      instructions: priorityInstructions(instructions)
    },
    files: attach.length ? attach : undefined,
    deckId: ensureWeekDeck(weekId),
    signal: ctx.signal
  })
  live({ stage: 'Checking the questions…', percent: 0.97 })
  const titles = new Map(topics.map((t) => [(t.content?.title ?? t.plan.title).toLowerCase(), t.content?.title ?? t.plan.title]))
  const questions: WeekTestQuestion[] = []
  for (const q of r.data.questions) {
    const [ok] = sanitizeQuestions([{ type: 'mcq', q: q.q, options: q.options, answer: q.answer, hint: q.hint, why: q.why }])
    if (ok?.type !== 'mcq') continue
    const topic = titles.get(q.topic.trim().toLowerCase()) ?? q.topic.trim()
    questions.push(topic ? { ...ok, topic } : ok)
  }
  if (!questions.length) throw new Error('Claude didn’t write any usable questions. Try again.')
  const test: WeekTest = { difficulty, questions, written_at: now(), last: null, best: null }
  setWeek(weekId, { test: JSON.stringify(test) })
  touchCourse(course.id)
  return { questions: questions.length }
}

/** Save a go at a week's test: the last score, and the best if it beats it. */
export function saveWeekTestScore(weekId: string, score: number, total: number): Week {
  const week = toWeek(weekRow(weekId))
  if (!week.test) throw new Error('This week has no end-of-week test.')
  const s = { score, total, at: now() }
  const ratio = (x: { score: number; total: number } | null) => (x && x.total ? x.score / x.total : -1)
  const test: WeekTest = { ...week.test, last: s, best: ratio(s) >= ratio(week.test.best) ? s : week.test.best }
  setWeek(weekId, { test: JSON.stringify(test) })
  return toWeek(weekRow(weekId))
}

export function deleteWeekTest(weekId: string): Week {
  setWeek(weekId, { test: null })
  return toWeek(weekRow(weekId))
}

// ---------------------------------------------------------------------------
// 2. Write a topic

interface Attached {
  name: string
  fileId: string
  /** Original page number for each page of the attached PDF. */
  pages: number[]
}

function findFile(files: CourseFile[], name: string): CourseFile | undefined {
  const n = name.trim().toLowerCase()
  const stem = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '')
  return files.find((f) => f.name.toLowerCase() === n) ?? files.find((f) => stem(f.name) === stem(n)) ?? files.find((f) => stem(f.name).includes(stem(n)) || stem(n).includes(stem(f.name)))
}

async function pdfExcerpt(f: CourseFile, pages: number[], dir: string): Promise<string> {
  const src = await PDFDocument.load(readFileSync(f.path), { ignoreEncryption: true, updateMetadata: false })
  const doc = await PDFDocument.create()
  const copied = await doc.copyPages(src, pages.map((p) => p - 1))
  copied.forEach((p) => doc.addPage(p))
  const contiguous = pages.every((p, i) => i === 0 || p === pages[i - 1] + 1)
  const stem = basename(f.name, extname(f.name)).replace(/[^\w.-]+/g, '_')
  const out = join(dir, `${stem}_pages_${contiguous ? `${pages[0]}-${pages[pages.length - 1]}` : 'selected'}.pdf`)
  writeFileSync(out, await doc.save())
  return out
}

/** What to send for one topic: only its own week's sources, cut to the pages it uses. */
async function topicSources(files: CourseFile[], plan: OutlineTopic, work: string): Promise<{ attach: string[]; attached: Attached[]; text: string; notes: string[] }> {
  const byFile = new Map<string, { file: CourseFile; where: string[] }>()
  for (const s of plan.sources ?? []) {
    const f = findFile(files, s.file)
    if (!f) continue
    const cur = byFile.get(f.id) ?? { file: f, where: [] }
    if (s.where) cur.where.push(s.where)
    byFile.set(f.id, cur)
  }
  // The outline named nothing we recognise: fall back to the whole week.
  if (byFile.size === 0) for (const f of files) byFile.set(f.id, { file: f, where: [] })

  const attach: string[] = []
  const attached: Attached[] = []
  const blocks: string[] = []
  const notes: string[] = []
  for (const { file, where } of byFile.values()) {
    const isPdf = extname(file.name).toLowerCase() === '.pdf'
    if (isPdf && file.pages) {
      const pages = [...new Set(where.flatMap((w) => pageList(w, file.pages!)))].sort((a, b) => a - b)
      if (!pages.length && file.pages <= WHOLE_PDF_PAGES) {
        attach.push(file.path)
        attached.push({ name: file.name, fileId: file.id, pages: Array.from({ length: file.pages }, (_, i) => i + 1) })
        continue
      }
      if (pages.length) {
        const out = await pdfExcerpt(file, pages, work)
        attach.push(out)
        attached.push({ name: basename(out), fileId: file.id, pages })
        const gaps = pages.length !== pages[pages.length - 1] - pages[0] + 1
        notes.push(`${basename(out)} is pages ${pages[0]}–${pages[pages.length - 1]} of ${file.name}${gaps ? ` (pages ${pages.join(', ')})` : ''}.`)
        continue
      }
      // Long PDF with no usable page range: send the text instead.
    }
    // A picture (a photo of a slide or the whiteboard) goes in for Claude to look at.
    if (isImageFile(file.name)) {
      attach.push(file.path)
      continue
    }
    const text = await fileText(file).catch(() => null)
    if (text) blocks.push(fileBlock(file.name, text, where.join('; ')))
    if (where.length && !isPdf) notes.push(`From ${file.name}, focus on: ${where.join('; ')}.`)
  }
  return { attach, attached, text: blocks.join('\n\n'), notes }
}

/** The whole course's plan, short, with this topic in full. */
function courseOutline(course: CourseRow, topic: Topic): string {
  const all = listTopics(course.id)
  const weeks = new Map((getDb().prepare('SELECT id, label FROM weeks WHERE course_id = ?').all(course.id) as { id: string; label: string }[]).map((w) => [w.id, w.label]))
  return JSON.stringify(
    {
      course: course.name,
      topics: all.map((t) => (t.id === topic.id ? { ...t.plan, week: weeks.get(t.week_id) } : { id: t.key, week: weeks.get(t.week_id), title: t.content?.title ?? t.plan.title, goal: t.plan.goal, sections: t.plan.sections }))
    },
    null,
    1
  )
}

function mapFigure(fig: AiTopic['sections'][number]['figure'], attached: Attached[]): Figure | null {
  if (!fig) return null
  const a = attached.find((x) => x.name.toLowerCase() === fig.file.trim().toLowerCase()) ?? (attached.length === 1 ? attached[0] : undefined)
  if (!a) return null
  const page = a.pages[fig.page - 1]
  return page ? { fileId: a.fileId, page, caption: fig.caption } : null
}

/** A topic's recall cards, in whichever of the course's decks they are. */
/**
 * Rate one of a topic's section flashcards (1 again … 4 easy), as in flashcard
 * review. Topics written before section cards carried ids are matched by front.
 */
export function rateTopicCard(topicId: string, front: string, rating: 1 | 2 | 3 | 4, cardId?: string): { cardId: string | null; learnt: boolean } {
  let id = cardId ?? null
  if (!id) {
    const ids = topicCardIds(getTopic(topicId).course_id, topicId)
    const row = ids.length
      ? (getDb().prepare(`SELECT id FROM cards WHERE id IN (${ids.map(() => '?').join(',')}) AND trim(front) = ?`).get(...ids, front.trim()) as { id: string } | undefined)
      : undefined
    id = row?.id ?? null
  }
  // learnt: spaced repetition counts the card as learnt (or reviewed) now, so more greens this session are practice.
  const s = id ? repo.applyReview(id, rating, 'learn') : null
  return { cardId: id, learnt: !!s && rating >= 3 && s.sr_state >= 1 }
}

/**
 * Topic cards with a list answer say how many points it wants, "(2)" for two
 * bullets (see withPointCount). Fixes cards written before that was enforced,
 * and the same card inside its topic, so rating by front still finds it. Runs
 * at startup and after importing a week; does nothing once they're right.
 */
export function fixTopicCardCounts(): number {
  const d = getDb()
  const rows = d.prepare("SELECT id, front, back, source FROM cards WHERE json_extract(source, '$.type') = 'topic'").all() as { id: string; front: string; back: string; source: string }[]
  const changed = new Map<string, { from: string; to: string }>()
  const byTopic = new Map<string, string[]>()
  d.transaction(() => {
    for (const r of rows) {
      const to = withPointCount(r.front, r.back)
      if (to === r.front) continue
      repo.updateCard(r.id, { front: to })
      changed.set(r.id, { from: r.front, to })
      const topicId = json<{ ref?: string }>(r.source, {}).ref
      if (topicId) byTopic.set(topicId, [...(byTopic.get(topicId) ?? []), r.id])
    }
    for (const [topicId, ids] of byTopic) {
      const fixes = ids.map((id) => ({ id, ...changed.get(id)! }))
      editAllLevels(topicId, (content) => {
        for (const s of content.sections)
          for (const c of s.cards ?? []) {
            const f = fixes.find((x) => x.id === c.id) ?? (!c.id ? fixes.find((x) => x.from.trim() === c.front.trim()) : undefined)
            if (f) c.front = f.to
          }
      })
    }
  })()
  return changed.size
}

export interface TrimSuggestion {
  cardId: string
  topicId: string | null
  topicTitle: string
  front: string
  back: string
  reason: string
}

/** At most this many cards go in one call; a bigger course is checked a few weeks at a time. */
const TRIM_BATCH = 600

/** What "Cut down flashcards" asks for on top of the usual trim, at each level. */
export function cutInstructions(cut: CardCut, total: number): string {
  const keep = Math.max(1, Math.round(total * CARD_CUT_INFO[cut].keep))
  const head = `CUT DOWN TO KEY CONTENT. I have too many cards for this week and want fewer, so as well as the cards above, remove cards that are real content but not important enough to keep. Aim to keep about ${keep} of the ${total} cards (that's a target, not exact). This replaces "when a card is genuinely unsure, keep it": here, unsure cards go first.`
  const how: Record<CardCut, string> = {
    light: `Cut a little: remove only the least important cards, such as minor details, narrow facts unlikely to be asked, and cards that mostly repeat another one. Keep every key definition, list, process, contrast and formula, and anything the lecturer stressed.`,
    medium: `Cut to the key content: keep the core definitions, the main lists and processes, the important contrasts and formulas, and anything the lecturer stressed. Remove secondary details, smaller facts, and cards that only add a little to another card.`,
    heavy: `Cut to the essentials only: keep just what I absolutely must know for the exam, the central definitions and the most important ideas of each topic. Remove everything else, even if it's examinable. Keep at least one card for each topic that has cards.`
  }
  return `${head}\n${how[cut]}\nFor these, "reason" says why it's less important in a few words (e.g. "minor detail", "covered by 12").`
}

/**
 * Asks which recall cards aren't pure course content: one week's (or just one
 * topic's), or a whole course's at once so duplicates across weeks are caught.
 * With `cut`, it also cuts the cards down to the key content, by how much you
 * picked. Only the cards' text is sent, so it's cheap. Nothing is removed
 * here: the student picks from the suggestions.
 */
export async function suggestTrim(scope: ({ weekId: string; topicId?: string } | { courseId: string }) & { cut?: CardCut }): Promise<{ total: number; remove: TrimSuggestion[] }> {
  const courseId = 'courseId' in scope ? scope.courseId : weekRow(scope.weekId).course_id
  const c = courseRow(courseId)
  const weeks = (getDb().prepare('SELECT * FROM weeks WHERE course_id = ? ORDER BY position').all(courseId) as WeekRow[]).filter((w) => !('weekId' in scope) || w.id === scope.weekId)
  const titles = new Map(listTopics(c.id).map((t) => [t.id, t.content?.title ?? t.plan.title]))
  const entries = weeks.flatMap((w) =>
    deckExists(w.deck_id)
      ? repo
          .listCards(w.deck_id)
          .map((card) => ({ card, week: w.label, topicId: card.source?.type === 'topic' ? (card.source.ref ?? null) : null }))
          .filter((x) => !('topicId' in scope) || !scope.topicId || x.topicId === scope.topicId)
      : []
  )
  if (!entries.length) return { total: 0, remove: [] }
  const oneLine = (s: string) => s.replace(/\s*\n\s*-\s*/g, '; ').replace(/^-\s*/, '').replace(/\s+/g, ' ').trim()
  const whole = 'courseId' in scope
  const remove: TrimSuggestion[] = []
  for (let start = 0; start < entries.length; start += TRIM_BATCH) {
    const batch = entries.slice(start, start + TRIM_BATCH)
    const list = batch
      .map((x, i) => `${i + 1}. [${whole ? `${x.week} · ` : ''}${x.topicId ? titles.get(x.topicId) ?? 'Topic' : 'Added by hand'}] Q: ${oneLine(x.card.front)} | A: ${oneLine(x.card.back)}`)
      .join('\n')
    const instructions = scope.cut ? cutInstructions(scope.cut, batch.length) : ''
    const r = await runAI<CourseTrimOut>({ task: 'course_trim', vars: { module: c.module || c.name, level: c.level, cards: list, instructions }, deckId: courseDeckId(courseId) })
    const seen = new Set<number>()
    for (const x of r.data.remove) {
      if (x.n < 1 || x.n > batch.length || seen.has(x.n)) continue
      seen.add(x.n)
      const { card, topicId: tid, week } = batch[x.n - 1]
      const topic = tid ? titles.get(tid) ?? '' : 'Added by hand'
      remove.push({ cardId: card.id, topicId: tid, topicTitle: whole ? `${week} · ${topic}` : topic, front: card.front, back: card.back, reason: x.reason })
    }
  }
  return { total: entries.length, remove }
}

/** Removes recall cards, and the same cards from their topics' section flashcards. */
export function removeTopicCards(cardIds: string[]): number {
  if (!cardIds.length) return 0
  const d = getDb()
  const ids = new Set(cardIds)
  const topics = new Set<string>()
  for (const id of cardIds) {
    const row = d.prepare('SELECT source FROM cards WHERE id = ?').get(id) as { source: string } | undefined
    const ref = row ? json<{ type?: string; ref?: string }>(row.source, {}) : {}
    if (ref.type === 'topic' && ref.ref) topics.add(ref.ref)
  }
  d.transaction(() => {
    repo.deleteCards(cardIds)
    for (const topicId of topics)
      editAllLevels(topicId, (content) => {
        for (const s of content.sections) if (s.cards) s.cards = s.cards.filter((c) => !c.id || !ids.has(c.id))
      })
  })()
  return cardIds.length
}

function topicCardIds(courseId: string, topicId: string): string[] {
  const ids = courseDeckIds(courseId)
  if (!ids.length) return []
  return (
    getDb()
      .prepare(`SELECT id FROM cards WHERE deck_id IN (${ids.map(() => '?').join(',')}) AND json_extract(source, '$.type') = 'topic' AND json_extract(source, '$.ref') = ?`)
      .all(...ids, topicId) as { id: string }[]
  ).map((r) => r.id)
}

/** The cards Claude tied to a section (1-based), trimmed and non-empty. */
export function sectionCards(cards: AiTopic['cards'], section: number): { front: string; back: string }[] {
  return cards.filter((c) => c.section === section && c.front.trim() && c.back.trim()).map((c) => ({ front: withPointCount(c.front.trim(), c.back.trim()), back: c.back.trim() }))
}

/** Questions per section and in the topic test, for each level of detail at each amount (Settings → Courses). */
const QUESTION_COUNTS: Record<NoteLevel, Record<QuestionAmount, { section: string; check: string }>> = {
  standard: { usual: { section: '2–4', check: '5–8' }, more: { section: '4–6', check: '8–12' }, lots: { section: '6–8', check: '12–15' } },
  quick: { usual: { section: '1–2', check: '3–5' }, more: { section: '2–3', check: '5–8' }, lots: { section: '3–4', check: '8–10' } },
  deep: { usual: { section: '3–4', check: '5–8' }, more: { section: '5–6', check: '8–12' }, lots: { section: '7–8', check: '12–15' } },
  simple: { usual: { section: '2–3', check: '5–8' }, more: { section: '4–5', check: '8–12' }, lots: { section: '6–7', check: '12–15' } }
}

/** How many questions to write per topic, from Settings → Courses. */
export function questionAmount(): QuestionAmount {
  const v = repo.getSetting<string>('course.questions', 'usual')
  return isQuestionAmount(v) ? v : 'usual'
}

/** The question counts for a level, as a rule for the prompt. Standard at the usual amount is the usual rules, so it adds nothing. */
function questionRule(level: NoteLevel, amount: QuestionAmount, check: boolean): string {
  const n = QUESTION_COUNTS[level][amount]
  if (amount === 'usual') return level === 'standard' ? '' : `- ${n.section} questions per section.${check ? ` "check" (the topic test): ${n.check} questions.` : ''}`
  return `- More practice: ${n.section} questions per section${check ? `, and ${n.check} questions in "check" (the topic test)` : ''}, instead of the usual amount. Every question still only tests what's been taught so far. Use the extra questions to come at the ideas from different angles (scenarios, applying it, contrasts, spotting mistakes), never to ask the same thing twice.`
}

/**
 * What each level of detail asks for on top of the usual rules, with the
 * number of questions from Settings → Courses. Standard at the usual amount is
 * the usual write-up, so it adds nothing. `check`: false when adding sections
 * to a written topic, which asks for its own few extra test questions.
 */
export function levelInstructions(level: NoteLevel, amount: QuestionAmount = 'usual', check = true): string {
  const questions = questionRule(level, amount, check)
  if (level === 'quick')
    return `LEVEL OF DETAIL: QUICK REVISION. I'm revising and short on time. I want the fastest way through this topic: just the main ideas, the things most likely to come up in the exam, in a fraction of the time the full notes take (aim for about a third: roughly 5 minutes for a typical topic).
- Focus on the core only: the key definitions, the main ideas and how they fit together, the key lists and steps, the important contrasts and formulas, and anything the lecturer stressed. Leave out minor details, side points, background, history, extra examples and edge cases. If something wouldn't be worth a mark in the exam, cut it.
- Few, short sections: about 2–4 for the whole topic (never more than 5), merging the outline's sections freely. Each section about 30–80 words of notes. Ignore the usual one-screen-per-idea rule.
- Tight bullets, short definitions and compact tables only. No "Imagine…" stories, analogies, scene-setting or worked examples, unless one line is essential to get the idea. No figures or diagrams unless one shows the main idea at a glance.
- The last section still ends with "**Quick exam summary:**" and 3–5 bullets.
- Questions are quick to answer: mostly mcq, true_false, match and fill_blank. No explain questions in the sections.
${questions}
- The recall cards follow the usual rules.`
  if (level === 'deep')
    return `LEVEL OF DETAIL: IN-DEPTH. I struggle with this topic, so I want a fuller write-up that makes sure I really understand it, even though it takes longer.
- Go slowly and build everything up from the basics. Sections can run to about two screens (up to roughly 350 words), and you can split the outline's sections into more sections where that helps.
- For each idea: what it means in everyday words, the proper term or definition, why it works or happens (not just what), and how it connects to the ideas around it.
- More worked examples, each walked through step by step with every step explained. More "Common mistake:" callouts, and "Check yourself:" lines that ask me something to think about before moving on.
- Where the material is technical, show the reasoning or derivation rather than just the result.
${questions}
- The recall cards follow the usual rules.
- Still only teach what's in the material.`
  if (level === 'simple')
    return `LEVEL OF DETAIL: EXPLAIN IT LIKE I'M 12. Explain this topic so a bright 12-year-old would really understand it, while still covering what I need for the exam. Simple, easy to review, and it has to click.
- Everyday words and short sentences (mostly under 15 words). No jargon until it's needed; when a technical term comes up, first say what it means in plain words with something from everyday life, then give the proper term in bold.
- Every idea gets a simple, concrete example from ordinary life (school, games, cooking, sport, phones, shops), and an analogy where it helps ("It's like…"). Then link the example back to the real thing in one line ("So in a computer, …").
- One small step at a time. Each section teaches one idea in about 60–140 words, then ends with "**In one line:**" and the whole idea in a single simple sentence.
- Where something has steps, number them, one short line each. Where two things get mixed up, a tiny "A vs B" table with plain words.
- After the tricky ideas, add a "**Quick check:**" line asking me something simple to think about, with the answer straight after in brackets.
- Still cover every examinable point, definition and formula from the sources: say it simply, don't drop it. Keep the exact wording of any formal definition the exam might test, after the simple version, with "Remember:" before it.
${questions}
- Questions, the topic check and the recall cards are written in the same simple language; the cards otherwise follow the usual rules.`
  return questions ? `NUMBER OF QUESTIONS:
${questions}` : ''
}

const sameFront = (a: string, b: string) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Write a topic at one or more levels of detail (one AI call each). Each level
 * is kept, so you can switch between them; the first level written (in
 * NOTE_LEVELS order) is the one shown afterwards. Writing a level the topic
 * already has replaces just that level. With no levels given, the level shown
 * is written again. With `keepShown`, a topic that's already written keeps
 * showing what it shows now and the new levels are saved alongside it (a quick
 * review next to your notes, say).
 */
export async function writeTopic(topicId: string, ctx: JobContext, instructions = '', levels: NoteLevel[] = [], keepShown = false): Promise<{ topicId: string; sections: number; cards: number }> {
  const first = getTopic(topicId)
  const pick = levels.length ? levels : [first.content ? first.level : ('standard' as NoteLevel)]
  const want = NOTE_LEVELS.filter((l) => pick.includes(l))
  const live = ctx.live
  let out = { topicId, sections: 0, cards: 0 }
  for (const [i, level] of want.entries()) {
    // Each level gets its share of the progress bar.
    const scaled: typeof live = live && ((u) => live(u.percent == null ? u : { ...u, percent: (i + u.percent) / want.length }))
    const show = i === 0 && !(keepShown && first.content && level !== first.level)
    const r = await writeTopicLevel(topicId, { ...ctx, live: scaled }, instructions, level, show, want.length > 1)
    if (i === 0) out = r
  }
  return out
}

async function writeTopicLevel(topicId: string, ctx: JobContext, instructions: string, level: NoteLevel, show: boolean, several: boolean): Promise<{ topicId: string; sections: number; cards: number }> {
  const topic = getTopic(topicId)
  const course = courseRow(topic.course_id)
  ctx.meta({ topicId, courseId: course.id, level })
  setTopic(topicId, { status: 'writing', error: null })
  const work = mkdtempSync(join(tmpdir(), 'studywise-topic-'))
  const live = ctx.live ?? (() => {})
  const levelName = NOTE_LEVEL_INFO[level].inline
  try {
    ctx.progress('Gathering this topic’s sources…')
    live({ stage: 'Picking out this topic’s pages…', percent: 0.02 })
    const weekFiles = listFiles(course.id).filter((f) => f.week_id === topic.week_id)
    const src = await topicSources(weekFiles, topic.plan, work)
    ctx.progress(several || level !== 'standard' ? `Writing ${topic.plan.title} (${levelName})…` : `Writing ${topic.plan.title}…`)
    live({ stage: several ? `Sending them to Claude for the ${levelName} notes…` : 'Sending them to Claude…', percent: 0.06, log: src.notes.length ? src.notes : ['Sending the week’s files'] })

    // Written at another level already: its recall cards (and their review history)
    // stay, and this level reuses them rather than adding near-duplicates.
    const otherLevels = topic.levels.filter((l) => l !== level)
    const deckCards = topicCardIds(course.id, topicId).map((id) => repo.getCard(id))
    const keepCards = otherLevels.length > 0 && deckCards.length > 0
    const reuse = keepCards
      ? `This topic is already written at another level of detail, and its recall cards are already in my spaced repetition. For "cards", reuse exactly these cards word for word (same front and back), each with the number of the section that teaches it. Leave out any this version doesn't teach, and don't add new ones:\n${deckCards.map((c) => `- front: ${JSON.stringify(c.front)} back: ${JSON.stringify(c.back)}`).join('\n')}`
      : ''

    const r = await runAI<AiTopic>({
      task: 'course_topic',
      vars: {
        module: course.module || course.name,
        level: course.level,
        outline: courseOutline(course, topic),
        topic_id: topic.key,
        topic_title: topic.plan.title,
        source_text: src.text,
        part_info: src.notes.join('\n'),
        instructions: [levelInstructions(level, questionAmount()), reuse, priorityInstructions(instructions)].filter(Boolean).join('\n\n')
      },
      files: src.attach.length ? src.attach : undefined,
      deckId: ensureWeekDeck(topic.week_id),
      onEvent: topicTracker(live, topic.plan.sections.length, 0.08, 0.9),
      signal: ctx.signal
    })
    const ai = r.data
    live({ stage: 'Saving…', percent: 0.9, preview: null })
    const content: TopicContent = {
      title: ai.title || topic.plan.title,
      goal: ai.goal || topic.plan.goal,
      sections: ai.sections
        .map((s, i) => ({ s, cards: sectionCards(ai.cards, i + 1) }))
        .filter(({ s }) => s.heading.trim() || s.notes.trim())
        .map(({ s, cards }) => ({ heading: s.heading.trim(), notes: s.notes.trim(), figure: mapFigure(s.figure, src.attached), cards, questions: shuffleMcqs(sanitizeQuestions(s.questions)) })),
      check: shuffleMcqs(sanitizeQuestions(ai.check))
    }
    if (!content.sections.length) throw new Error('Claude returned a topic with no sections.')

    let cardCount = deckCards.length
    if (keepCards) {
      // Section flashcards point at the recall cards they match; any others are just for practice here.
      for (const s of content.sections) for (const c of s.cards ?? []) c.id = deckCards.find((d) => sameFront(d.front, c.front))?.id
    } else {
      // Recall cards replace this topic's old ones.
      const deckId = ensureWeekDeck(topic.week_id)
      if (deckCards.length) repo.deleteCards(deckCards.map((c) => c.id))
      const cards = repo.createCards(
        ai.cards
          .filter((c) => c.front.trim() && c.back.trim())
          .map((c) => ({ deck_id: deckId, format: 'question_answer' as const, front: withPointCount(c.front.trim(), c.back.trim()), back: c.back.trim(), tags: [content.title], source: { type: 'topic' as const, ref: topicId, section: content.title } }))
      )
      // Section flashcards point at their deck cards, so rating one feeds spaced repetition.
      const idByFront = new Map(cards.map((c) => [c.front, c.id]))
      for (const s of content.sections) for (const c of s.cards ?? []) c.id = idByFront.get(c.front)
      cardCount = cards.length
    }
    storeLevel(topicId, level, content, show)
    setTopic(topicId, { written_with: JSON.stringify({ ...json<Record<string, ModelChoice>>(topicRow(topicId).written_with, {}), [level]: usedModel(r.model) }) })
    // Its cards wait until you study it.
    refreshDormancy(topicId)
    touchCourse(course.id)

    const figs = content.sections.map((s) => s.figure).filter((f): f is Figure => !!f)
    if (figs.length) {
      ctx.progress('Rendering figures…')
      live({ stage: 'Rendering figures…', percent: 0.93 })
      for (const f of figs) await figureUrl(f.fileId, f.page).catch(() => null)
    }
    live({ stage: 'Saving the notes…', percent: 0.97 })
    const noteId = await syncTopicNote(topicId).catch(() => null)
    ctx.meta({ noteId })
    return { topicId, sections: content.sections.length, cards: cardCount }
  } catch (e) {
    // A topic with notes already keeps them (and stays usable); the error is still shown.
    const has = !!topicRow(topicId).content
    setTopic(topicId, { status: has ? 'ready' : 'error', error: ctx.signal.aborted ? 'Cancelled' : (e as Error).message })
    throw e
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Save a newly written level. Shown: it becomes the topic's content (the level
 * shown before is put aside with your progress on it). Otherwise it's put aside
 * for later. Rewriting the level being shown always replaces it in place.
 */
function storeLevel(topicId: string, level: NoteLevel, content: TopicContent, show: boolean): void {
  const row = topicRow(topicId)
  const versions = rowVersions(row)
  const cur = rowLevel(row)
  const fresh = JSON.stringify(emptyProgress())
  if (show || !row.content || cur === level) {
    if (row.content && cur !== level) versions[cur] = { content: json<TopicContent>(row.content, null as unknown as TopicContent), progress: { ...emptyProgress(), ...json<Partial<TopicProgress>>(row.progress, {}) } }
    delete versions[level]
    setTopic(topicId, { status: 'ready', error: null, content: JSON.stringify(content), progress: fresh, level, versions: JSON.stringify(versions) })
  } else {
    versions[level] = { content, progress: emptyProgress() }
    setTopic(topicId, { status: 'ready', error: null, versions: JSON.stringify(versions) })
  }
}

/** Show a topic at another level of detail it's been written at. Your progress on each level is kept separately. */
export async function setTopicLevel(topicId: string, level: NoteLevel): Promise<Topic> {
  const row = topicRow(topicId)
  const cur = rowLevel(row)
  if (cur === level && row.content) return getTopic(topicId)
  const versions = rowVersions(row)
  const v = versions[level]
  if (!v) throw new Error(`This topic hasn’t been written as ${NOTE_LEVEL_INFO[level].inline} yet.`)
  if (row.content) versions[cur] = { content: json<TopicContent>(row.content, null as unknown as TopicContent), progress: { ...emptyProgress(), ...json<Partial<TopicProgress>>(row.progress, {}) } }
  delete versions[level]
  setTopic(topicId, { content: JSON.stringify(v.content), progress: JSON.stringify({ ...emptyProgress(), ...v.progress }), level, versions: JSON.stringify(versions) })
  refreshDormancy(topicId)
  touchCourse(row.course_id)
  // The topic's note follows the level shown.
  await syncTopicNote(topicId).catch(() => null)
  return getTopic(topicId)
}

/** Change a topic's content at every level it's written at (the one shown and the ones put aside). */
function editAllLevels(topicId: string, fn: (c: TopicContent) => void): void {
  const row = getDb().prepare('SELECT * FROM topics WHERE id = ?').get(topicId) as TopicRow | undefined
  if (!row) return
  const content = row.content ? json<TopicContent | null>(row.content, null) : null
  if (content) fn(content)
  const versions = rowVersions(row)
  for (const v of Object.values(versions)) if (v) fn(v.content)
  getDb().prepare('UPDATE topics SET content = ?, versions = ?, updated_at = ? WHERE id = ?').run(content ? JSON.stringify(content) : row.content, JSON.stringify(versions), now(), topicId)
}

// ---------------------------------------------------------------------------
// 3. Add new notes to a week that's already planned
//
// New material (files, or notes you paste) is compared with what the week
// already teaches. Whatever's new goes where it belongs: new sections at the
// end of an existing topic, or a new topic. Sections you may already have
// studied are never touched: a written topic gets only the new sections,
// written to fit after its own (at every level it's written at), marked with
// when they were added. A finished topic is opened up again at the first new
// section, so you can tell what you've reviewed from what's new.

const EXISTING_NOTES_CHARS = 30_000

export async function addNotesToWeek(weekId: string, newFileIds: string[], ctx: JobContext, instructions = ''): Promise<{ sections: number; updated: number; topics: number; summary: string }> {
  const week = toWeek(weekRow(weekId))
  const course = courseRow(week.course_id)
  ctx.meta({ weekId, courseId: course.id })
  const d = getDb()
  if (d.prepare("SELECT 1 FROM topics WHERE week_id = ? AND status = 'writing'").get(weekId)) throw new Error('Wait for this week’s topics to finish writing first.')
  const fresh = listFiles(course.id).filter((f) => f.week_id === weekId && newFileIds.includes(f.id))
  if (!fresh.length) throw new Error('None of those can be added to a week.')
  const topics = listTopics(course.id).filter((t) => t.week_id === weekId)
  if (!topics.length) throw new Error(`Plan ${week.label} first: there are no topics to add to yet.`)
  const live = ctx.live ?? (() => {})

  ctx.progress('Reading the new notes…')
  live({ stage: 'Reading the new notes…', percent: 0.02 })
  const texts: { file: CourseFile; text: string | null }[] = []
  for (const f of fresh) texts.push({ file: f, text: await fileText(f).catch(() => null) })
  const attach = texts.filter((t) => t.text === null && (t.file.name.toLowerCase().endsWith('.pdf') || isImageFile(t.file.name))).map((t) => t.file.path)
  const perFile = Math.floor(ONE_CALL_CHARS / Math.max(1, texts.filter((t) => t.text).length))
  const source = texts.filter((t) => t.text !== null).map((t) => fileBlock(t.file.name, t.text!.slice(0, perFile))).join('\n\n')
  const current = topics.map((t) => ({
    id: t.key,
    title: t.content?.title ?? t.plan.title,
    goal: t.content?.goal ?? t.plan.goal,
    written: t.status === 'ready',
    sections: t.content ? t.content.sections.map((s) => s.heading) : t.plan.sections
  }))

  ctx.progress(`Comparing the new notes with ${week.label}…`)
  live({ stage: `Comparing the new notes with ${week.label}…`, percent: 0.08, log: fresh.map((f) => `Read ${f.name}`) })
  const r = await runAI<CourseUpdate>({
    task: 'course_update',
    vars: {
      module: course.module || course.name,
      level: course.level,
      week: week.label,
      topics: JSON.stringify(current, null, 1),
      files: fresh.map((f) => `${f.name}${f.pages ? ` (${f.pages} pages)` : ''}`).join(', '),
      source_text: source,
      instructions: priorityInstructions(instructions)
    },
    files: attach.length ? attach : undefined,
    deckId: ensureWeekDeck(weekId),
    signal: ctx.signal
  })

  const stamp = now()
  const byKey = new Map(topics.map((t) => [t.key, t]))
  // One entry per topic, only real topics, only new headings.
  const merged = new Map<string, CourseUpdate['updates'][number]>()
  for (const u of r.data.updates) {
    const t = byKey.get(u.topic)
    if (!t) continue
    const have = new Set((t.content ? t.content.sections.map((s) => s.heading) : t.plan.sections).map((h) => h.trim().toLowerCase()))
    const sections = u.sections.map((h) => h.trim()).filter((h) => h && !have.has(h.toLowerCase()))
    if (!sections.length) continue
    const cur = merged.get(u.topic)
    merged.set(u.topic, cur ? { ...cur, sections: [...cur.sections, ...sections], sources: [...cur.sources, ...u.sources], stressed: [...cur.stressed, ...u.stressed] } : { ...u, sections })
  }
  const updates = [...merged.values()]

  // New topics: planned, at the end of the week, numbered on from its own.
  const numbers = topics.map((t) => Number(t.key.match(/t(\d+)$/)?.[1] ?? 0))
  let n = Math.max(0, ...numbers)
  let pos = Math.max(0, ...topics.map((t) => t.position)) + 1
  const localIds = new Map<string, string>()
  const newTopics = r.data.topics.filter((t) => t.title.trim() && t.sections.length)
  for (const t of newTopics) localIds.set(t.id, keyFor(week, `t${++n}`))
  const rekey = (id: string) => localIds.get(id) ?? (/^t\d+$/.test(id) ? keyFor(week, id) : id)
  const ins = d.prepare("INSERT INTO topics (id, course_id, week_id, key, position, plan, status, error, content, progress, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'planned', NULL, NULL, '{}', ?)")
  for (const t of newTopics) ins.run(uid(), course.id, weekId, localIds.get(t.id)!, pos++, JSON.stringify({ ...t, id: localIds.get(t.id)!, needs: t.needs.map(rekey), added: stamp }), now())

  // Topics not written yet just plan the new sections: they'll be in it when it's written.
  for (const u of updates.filter((x) => byKey.get(x.topic)!.status !== 'ready')) {
    const t = byKey.get(u.topic)!
    setTopic(t.id, { plan: JSON.stringify({ ...t.plan, sections: [...t.plan.sections, ...u.sections], sources: [...t.plan.sources, ...u.sources], stressed: [...t.plan.stressed, ...u.stressed] }) })
  }

  // Written topics get just the new sections.
  const written = updates.filter((x) => byKey.get(x.topic)!.status === 'ready')
  let sections = 0
  for (const [i, u] of written.entries()) {
    const t = byKey.get(u.topic)!
    const scaled = (x: Parameters<typeof live>[0]) => live(x.percent == null ? x : { ...x, percent: 0.15 + (0.8 * (i + x.percent)) / written.length })
    sections += await extendTopic(t.id, u, fresh, { ...ctx, live: scaled }, instructions, stamp)
  }
  touchCourse(course.id)
  const planned = updates.length - written.length
  const summary =
    r.data.summary.trim() ||
    (sections || newTopics.length || planned
      ? `Added ${[sections && `${sections} new section${sections === 1 ? '' : 's'}`, planned && `${planned} planned section${planned === 1 ? '' : 's'}`, newTopics.length && `${newTopics.length} new topic${newTopics.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}.`
      : `${week.label} already covers everything in the new notes.`)
  ctx.progress(summary)
  return { sections, updated: updates.length, topics: newTopics.length, summary }
}

/** Write a written topic's new sections (at every level it's written at) and put them after its own. Returns how many were added to the level shown. */
async function extendTopic(topicId: string, u: CourseUpdate['updates'][number], files: CourseFile[], ctx: JobContext, instructions: string, stamp: string): Promise<number> {
  const t0 = getTopic(topicId)
  const course = courseRow(t0.course_id)
  const live = ctx.live ?? (() => {})
  // The plan gets them too, so writing the topic again later includes them.
  const plan = { ...t0.plan, sections: [...t0.plan.sections, ...u.sections], sources: [...t0.plan.sources, ...u.sources], stressed: [...t0.plan.stressed, ...u.stressed] }
  setTopic(topicId, { plan: JSON.stringify(plan), status: 'writing', error: null })
  const work = mkdtempSync(join(tmpdir(), 'studywise-topic-'))
  try {
    ctx.progress(`Adding to ${t0.content?.title ?? t0.plan.title}…`)
    live({ stage: `Writing the new sections for ${t0.content?.title ?? t0.plan.title}…`, percent: 0.05 })
    // Only the new material: the topic's own sources are already in its notes.
    const src = await topicSources(files, { ...plan, sources: u.sources }, work)
    const deckId = ensureWeekDeck(t0.week_id)
    const shown = rowLevel(topicRow(topicId))
    const levels = [shown, ...writtenLevels(topicRow(topicId)).filter((l) => l !== shown)]
    let newCards: Card[] = []
    let added = 0
    for (const [i, level] of levels.entries()) {
      const row = topicRow(topicId)
      const versions = rowVersions(row)
      const isShown = rowLevel(row) === level
      const content = isShown ? json<TopicContent>(row.content, null as unknown as TopicContent) : versions[level]?.content
      if (!content) continue
      const existing = content.sections
        .map((s, j) => `## ${j + 1}. ${s.heading}\n${s.notes}`)
        .join('\n\n')
        .slice(0, EXISTING_NOTES_CHARS)
      const reuse = newCards.length
        ? `The new material's recall cards are already made. For "cards", reuse exactly these, word for word (same front and back), each with the number of the new section that teaches it, and don't add others:\n${newCards.map((c) => `- front: ${JSON.stringify(c.front)} back: ${JSON.stringify(c.back)}`).join('\n')}`
        : ''
      live({ stage: levels.length > 1 ? `Writing the new sections (${NOTE_LEVEL_INFO[level].inline})…` : 'Writing the new sections…', percent: 0.1 + (0.8 * i) / levels.length })
      const r = await runAI<CourseExtendOut>({
        task: 'course_extend',
        vars: {
          module: course.module || course.name,
          level: course.level,
          topic_title: content.title,
          existing,
          new_sections: u.sections.map((h) => `- ${h}`).join('\n'),
          source_text: src.text,
          part_info: [src.notes.join('\n'), u.stressed.length ? `Stressed in the new material: ${u.stressed.join('; ')}` : ''].filter(Boolean).join('\n'),
          instructions: [levelInstructions(level, questionAmount(), false), reuse, priorityInstructions(instructions)].filter(Boolean).join('\n\n')
        },
        files: src.attach.length ? src.attach : undefined,
        deckId,
        signal: ctx.signal
      })
      const fresh: TopicSection[] = r.data.sections
        .map((s, k) => ({ s, cards: sectionCards(r.data.cards, k + 1) }))
        .filter(({ s }) => s.heading.trim() || s.notes.trim())
        .map(({ s, cards }) => ({ heading: s.heading.trim(), notes: s.notes.trim(), figure: mapFigure(s.figure, src.attached), cards, questions: shuffleMcqs(sanitizeQuestions(s.questions)), added: stamp }))
      if (!fresh.length) continue
      // The first level makes the new recall cards; the others point at the same ones.
      if (!newCards.length) {
        newCards = repo.createCards(
          r.data.cards
            .filter((c) => c.front.trim() && c.back.trim())
            .map((c) => ({ deck_id: deckId, format: 'question_answer' as const, front: withPointCount(c.front.trim(), c.back.trim()), back: c.back.trim(), tags: [content.title], source: { type: 'topic' as const, ref: topicId, section: content.title } }))
        )
      }
      for (const s of fresh) for (const c of s.cards ?? []) c.id = newCards.find((x) => sameFront(x.front, c.front))?.id
      const start = content.sections.length
      const next: TopicContent = { ...content, sections: [...content.sections, ...fresh], check: [...content.check, ...shuffleMcqs(sanitizeQuestions(r.data.check))] }
      // Finished it before: it opens again at the first new section, with your scores kept.
      const reopen = (p: TopicProgress): TopicProgress => (p.done ? { ...p, done: false, section: start, step: null } : p)
      if (isShown) {
        const p = { ...emptyProgress(), ...json<Partial<TopicProgress>>(row.progress, {}) }
        setTopic(topicId, { content: JSON.stringify(next), progress: JSON.stringify(reopen(p)) })
        added = fresh.length
      } else {
        versions[level] = { content: next, progress: reopen({ ...emptyProgress(), ...versions[level]!.progress }) }
        setTopic(topicId, { versions: JSON.stringify(versions) })
      }
    }
    setTopic(topicId, { status: 'ready', error: null })
    refreshDormancy(topicId)
    const figs = (getTopic(topicId).content?.sections ?? []).filter((s) => s.added === stamp && s.figure).map((s) => s.figure!)
    for (const f of figs) await figureUrl(f.fileId, f.page).catch(() => null)
    await syncTopicNote(topicId).catch(() => null)
    return added
  } catch (e) {
    // Its notes are still there: it stays usable, with the error shown.
    setTopic(topicId, { status: 'ready', error: ctx.signal.aborted ? 'Cancelled' : `Adding the new notes didn’t finish: ${(e as Error).message}` })
    throw e
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Figures: the slide rendered from the PDF, cached as a PNG.

export async function figureUrl(fileId: string, page: number): Promise<string> {
  const f = getDb().prepare('SELECT id, course_id, week_id, name, path, pages FROM course_files WHERE id = ?').get(fileId) as CourseFile | undefined
  if (!f) throw new Error('That file is no longer in the course')
  if (!Number.isInteger(page) || page < 1 || (f.pages && page > f.pages)) throw new Error('No such page')
  const dir = join(courseDir(f.course_id), 'figures')
  const name = `${f.id}-p${page}.png`
  const out = join(dir, name)
  if (!existsSync(out)) {
    mkdirSync(dir, { recursive: true })
    const { PDFParse } = await import('pdf-parse')
    const parser = new PDFParse({ data: readFileSync(f.path) })
    try {
      const shot = await parser.getScreenshot({ partial: [page], desiredWidth: 1600, imageBuffer: true, imageDataUrl: false })
      const data = shot.pages[0]?.data
      if (!data) throw new Error('Could not render that page')
      writeFileSync(out, data)
    } finally {
      await parser.destroy()
    }
  }
  return `studywise-file://courses/${f.course_id}/figures/${name}`
}

// ---------------------------------------------------------------------------
// Learning

export function saveProgress(topicId: string, progress: TopicProgress): Topic {
  setTopic(topicId, { progress: JSON.stringify({ ...progress, lastStudied: now() }) })
  refreshDormancy(topicId)
  touchCourse(getTopic(topicId).course_id)
  return getTopic(topicId)
}

export function resetTopicProgress(topicId: string): Topic {
  setTopic(topicId, { progress: JSON.stringify(emptyProgress()) })
  refreshDormancy(topicId)
  return getTopic(topicId)
}

export async function markExplain(courseId: string, q: Extract<CourseQuestion, { type: 'explain' }>, answer: string, topicId?: string): Promise<{ mark: Mark; wrong: string }> {
  const c = courseRow(courseId)
  const deckId = topicId ? ensureWeekDeck(getTopic(topicId).week_id) : courseDeckId(courseId)
  const total = explainMarks(q)
  if (!answer.trim()) return { mark: { score: 0, verdict: 'wrong', detail: { points_found: [], points_missing: q.points, short_feedback: 'Have a go first, even a rough answer gets marks.', marks: { got: 0, total } }, by: 'code' }, wrong: '' }
  const r = await runAI<CourseMarkOut>({
    task: 'course_mark',
    vars: { module: c.module || c.name, level: c.level, question: q.q, marks: String(total), model: q.model, points: q.points.map((p) => `- ${p}`).join('\n'), answer },
    deckId
  })
  const m = r.data
  // Marks awarded decide the score; an edited prompt that only gives a score out of 10 still works.
  const got = m.marks != null ? Math.max(0, Math.min(total, Math.round(m.marks))) : Math.round((Math.max(0, Math.min(10, m.score)) / 10) * total)
  const score = m.marks != null ? Math.round((got / total) * 100) / 10 : Math.max(0, Math.min(10, m.score))
  return {
    mark: { score, verdict: verdictFor(score, thresholdsFor(deckId)), detail: { points_found: m.got, points_missing: m.missed, short_feedback: m.feedback, marks: { got, total } }, by: 'ai' },
    wrong: m.wrong
  }
}

/**
 * A surprise recall card from a different topic you've already started
 * (any week). Due or never-reviewed cards first.
 */
export function recallCard(courseId: string, excludeTopicId: string, exclude: string[] = []): { card: Card; topicTitle: string } | null {
  const decks = recallDeckIds(courseId)
  if (!decks.length) return null
  const started = listTopics(courseId).filter((t) => t.id !== excludeTopicId && t.status === 'ready' && (t.progress.section > 0 || t.progress.done))
  if (!started.length) return null
  const titles = new Map(started.map((t) => [t.id, t.content?.title ?? t.plan.title]))
  const sleeping = new Set((getDb().prepare('SELECT id FROM cards WHERE dormant = 1').all() as { id: string }[]).map((r) => r.id))
  const cards = decks.flatMap((d) => repo.listCards(d)).filter((card) => card.source?.type === 'topic' && card.source.ref && titles.has(card.source.ref) && !exclude.includes(card.id) && !sleeping.has(card.id))
  if (!cards.length) return null
  const states = new Map(
    (getDb().prepare(`SELECT r.* FROM review_state r JOIN cards c ON c.id = r.card_id WHERE c.deck_id IN (${decks.map(() => '?').join(',')})`).all(...decks) as ReviewState[]).map((s) => [s.card_id, s])
  )
  const exam = courseRow(courseId).exam_date
  const due = cards.filter((card) => {
    const s = states.get(card.id)
    return s ? isDue({ due: effectiveDue(s.due, s.last_reviewed ?? null, exam) }) : true
  })
  const pool = due.length ? due : cards
  const card = pool[Math.floor(Math.random() * pool.length)]
  return { card, topicTitle: titles.get(card.source!.ref!) ?? '' }
}

export function recallReview(cardId: string, knew: boolean): void {
  repo.applyReview(cardId, knew ? 3 : 1, 'learn')
}

/** Due recall cards from every week of the course with recall on, in week order. */
export function dueCards(courseId: string): Card[] {
  return recallDeckIds(courseId).flatMap((d) => repo.dueCards(d))
}

function noteFolder(courseId: string): string {
  const c = courseRow(courseId)
  if (c.note_folder_id && repo.listFolders('note').some((f) => f.id === c.note_folder_id)) return c.note_folder_id
  const f = repo.createFolder(c.name, 'note')
  getDb().prepare('UPDATE courses SET note_folder_id = ? WHERE id = ?').run(f.id, courseId)
  return f.id
}

/** The week's folder inside the course's notes folder ("Physics › Week 3"), made when missing. */
function weekNoteFolder(weekId: string): string {
  const w = weekRow(weekId)
  const parent = noteFolder(w.course_id)
  const found = repo.listFolders('note').find((f) => f.parent_id === parent && f.name === w.label)
  return found ? found.id : repo.createFolder(w.label, 'note', parent).id
}

/**
 * Course notes are filed by week. Notes written before that sit loose in the
 * course folder; move them into their week's folder. Notes you've moved
 * somewhere else are left alone. Runs at startup.
 */
export function organizeCourseNotes(): void {
  const rows = getDb()
    .prepare('SELECT t.note_id, t.week_id FROM topics t JOIN courses c ON c.id = t.course_id JOIN notes n ON n.id = t.note_id WHERE n.folder_id = c.note_folder_id')
    .all() as { note_id: string; week_id: string }[]
  for (const r of rows) repo.updateNote(r.note_id, { folder_id: weekNoteFolder(r.week_id) })
}

/**
 * The topic's notes as one note, in its week's notes folder, with its figures.
 * Made when the topic is written and updated when it's written again.
 */
export async function syncTopicNote(topicId: string): Promise<string> {
  const t = getTopic(topicId)
  if (!t.content) throw new Error('Write the topic first')
  const course = courseRow(t.course_id)
  const week = weekRow(t.week_id)
  const parts: string[] = []
  if (t.content.goal) parts.push(`_${t.content.goal}_`)
  for (const s of t.content.sections) {
    parts.push(`## ${s.heading}\n\n${s.notes}`)
    if (s.figure) {
      const url = await figureUrl(s.figure.fileId, s.figure.page).catch(() => null)
      if (url) parts.push(`![${s.figure.caption.replace(/[[\]]/g, '')}](${url})${s.figure.caption ? `\n_${s.figure.caption}_` : ''}`)
    }
  }
  // The notes list shows "Week <week>", so "Week 3" is stored as "3".
  const fields = { title: t.content.title, module: course.module || course.name, type: 'Lecture', week: week.label.replace(/^week\s+/i, ''), content: `${parts.join('\n\n')}\n` }
  let noteId = t.note_id
  if (noteId) {
    try {
      repo.updateNote(noteId, fields)
    } catch {
      noteId = null // deleted: make a new one
    }
  }
  if (!noteId) {
    noteId = repo.createNote({ ...fields, folder_id: weekNoteFolder(week.id) }).id
    getDb().prepare('UPDATE topics SET note_id = ? WHERE id = ?').run(noteId, topicId)
    // In course order in its folder (by week, then topic), not newest first.
    placeNote(noteId)
  }
  repo.linkNoteDeck(noteId, ensureWeekDeck(t.week_id), true)
  return noteId
}

/** Topics written before notes were automatic get theirs now. */
export async function backfillNotes(): Promise<void> {
  const ids = (getDb().prepare("SELECT id FROM topics WHERE status = 'ready' AND (note_id IS NULL OR note_id NOT IN (SELECT id FROM notes))").all() as { id: string }[]).map((r) => r.id)
  for (const id of ids) await syncTopicNote(id).catch(() => null)
}
