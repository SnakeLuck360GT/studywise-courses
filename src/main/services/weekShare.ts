// Sharing one week of a course: a friend writes the week (and spends the
// tokens), sends the .studyweek file, and you import it into your own course
// (or a new one) without generating anything.
//
// The file is a zip:
//   week.json   the week, its files' details, its topics (notes, questions,
//               flashcards) and its recall cards; no progress or reviews
//   files/...   the week's source files (slides, transcripts), which topics
//               need for their figures and for writing a topic again
//
// Importing gives everything new ids, so importing twice gives two copies. Slide
// figures aren't in the file: they're rendered again from the PDFs when shown.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import JSZip from 'jszip'
import { getDb, now } from '../db'
import { paths } from '../paths'
import { safeFileName } from '../library'
import { addWeek, createCourse, ensureWeekDeck, fixTopicCardCounts, getCourse, refreshDormancy, syncTopicNote, weekFingerprint } from './course'
import type { WeekFingerprint } from '@shared/fingerprint'
import { IMPORTED_WEEKS_SETTING } from '@shared/market'
import { NOTE_LEVELS } from '@shared/course'
import { getSetting, setSetting } from '../db/repo'

export const WEEK_EXT = 'studyweek'
const FORMAT = 1

type Row = Record<string, unknown>

export interface WeekJson {
  app: 'studywise-courses'
  kind: 'week'
  format: number
  exportedAt: string
  course: { name: string; module: string; level: string }
  week: Row
  files: Row[]
  topics: Row[]
  cards: Row[]
  /** The week's material as a signature (no text), for the marketplace's "already made" check. */
  fingerprint?: WeekFingerprint
}

export interface WeekPreview {
  course: string
  week: string
  topics: number
  written: number
  cards: number
  files: string[]
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const zipPath = (p: string) => p.split(sep).join('/')

export const weekFileName = (course: string, week: string) => `${safeFileName(`${course} - ${week}`)}.${WEEK_EXT}`
export const isWeekFile = (f: string) => basename(f).toLowerCase().endsWith(`.${WEEK_EXT}`)

/**
 * Which sections were added later ("Add new notes") is about your own studying,
 * like your progress: someone you share the week with gets them as ordinary
 * sections.
 */
function withoutAdded<T>(content: T): T {
  const c = content as { sections?: Record<string, unknown>[] } | null
  if (!c || !Array.isArray(c.sections)) return content
  return { ...c, sections: c.sections.map(({ added: _a, ...s }) => s) } as T
}
const jsonWithoutAdded = (text: unknown, key?: 'plan') => {
  if (typeof text !== 'string') return text
  try {
    const v = JSON.parse(text) as Record<string, unknown> | null
    if (!v) return text
    if (key === 'plan') {
      const { added: _a, ...plan } = v
      return JSON.stringify(plan)
    }
    return JSON.stringify(withoutAdded(v))
  } catch {
    return text
  }
}

/** A topic's other levels (topics.versions) with the progress taken out. */
function noProgress(versions: unknown): string {
  try {
    const v = JSON.parse(typeof versions === 'string' ? versions : '{}') as Record<string, { content: unknown; progress?: unknown }>
    return JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { content: withoutAdded(x.content), progress: {} }])))
  } catch {
    return '{}'
  }
}

export async function exportWeek(weekId: string, file: string): Promise<WeekPreview> {
  const { bytes, json } = await weekZip(weekId)
  writeFileSync(file, bytes)
  return previewOf(json)
}

/** An end-of-week test without your scores on it (JSON text in, JSON text or null out). */
function testWithoutScores(test: unknown): string | null {
  if (typeof test !== 'string' || !test) return null
  try {
    const t = JSON.parse(test) as { questions?: unknown[] }
    return Array.isArray(t.questions) && t.questions.length ? JSON.stringify({ ...t, last: null, best: null }) : null
  } catch {
    return null
  }
}

/** The .studyweek file's bytes (and what's in it). */
/** What goes in a shared or published week: its rows without your progress, and where its files are. */
function weekRows(weekId: string) {
  const d = getDb()
  const row = d.prepare('SELECT * FROM weeks WHERE id = ?').get(weekId) as Row | undefined
  if (!row) throw new Error('Week not found')
  // Its end-of-week test goes, without your scores (so taking it doesn't count as a change to publish).
  const week: Row = { ...row, test: testWithoutScores(row.test) }
  const course = d.prepare('SELECT * FROM courses WHERE id = ?').get(week.course_id) as Row
  const courseDir = join(paths.courses, String(course.id))
  const files = (d.prepare('SELECT * FROM course_files WHERE week_id = ? ORDER BY position').all(weekId) as Row[]).map((f): Row & { path: string } => ({ ...f, path: zipPath(relative(courseDir, String(f.path))) }))
  // Your progress and the link to your own copy of the notes stay with you.
  // Every level of detail a topic is written at goes, without your progress on it.
  const topics = (d.prepare('SELECT * FROM topics WHERE week_id = ? ORDER BY position').all(weekId) as Row[]).map((t) => ({ ...t, progress: '{}', note_id: null, versions: noProgress(t.versions), content: jsonWithoutAdded(t.content), plan: jsonWithoutAdded(t.plan, 'plan') }))
  const cards = week.deck_id ? (d.prepare('SELECT * FROM cards WHERE deck_id = ? ORDER BY id').all(week.deck_id) as Row[]) : []
  return { week, course, courseDir, files, topics, cards }
}

/** onProgress: how far packing has got, 0–1. */
export async function weekZip(weekId: string, onProgress?: (fraction: number) => void): Promise<{ bytes: Buffer; json: WeekJson }> {
  const { week, course, courseDir, files, topics, cards } = weekRows(weekId)
  const json: WeekJson = {
    app: 'studywise-courses',
    kind: 'week',
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    course: { name: String(course.name), module: String(course.module ?? ''), level: String(course.level ?? '') },
    // Whether it's private on your computer is yours, like the deck it's in.
    week: { ...week, deck_id: null, private: undefined },
    files,
    topics,
    cards,
    fingerprint: await weekFingerprint(weekId)
  }
  const zip = new JSZip()
  zip.file('week.json', JSON.stringify(json), { compression: 'DEFLATE' })
  for (const f of files) {
    const full = join(courseDir, String(f.path))
    if (existsSync(full)) zip.file(`files/${f.path}`, readFileSync(full))
  }
  return { bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }, onProgress && ((m) => onProgress(m.percent / 100))), json }
}

/**
 * A hash of what publishing the week would send: same hash, nothing new to
 * upload. Leaves out what changes just by studying or by settings that aren't
 * shared (which cards are still waiting, timestamps, recall on or off,
 * private), and hashes each file's bytes.
 */
export function weekContentHash(weekId: string): string {
  const { week, course, courseDir, files, topics, cards } = weekRows(weekId)
  const drop = (r: Row, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)))
  const content = {
    course: { name: String(course.name), module: String(course.module ?? ''), level: String(course.level ?? '') },
    week: drop(week, ['id', 'course_id', 'deck_id', 'private', 'recall_off', 'created_at']),
    topics: topics.map((t) => drop(t, ['course_id', 'week_id', 'updated_at'])),
    cards: cards.map((c) => drop(c, ['deck_id', 'dormant', 'created_at', 'updated_at'])),
    files: files.map((f) => {
      const full = join(courseDir, String(f.path))
      return { name: f.name, path: f.path, pages: f.pages, position: f.position, sha256: existsSync(full) ? createHash('sha256').update(readFileSync(full)).digest('hex') : null }
    })
  }
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

function previewOf(j: WeekJson): WeekPreview {
  return {
    course: j.course.name,
    week: String(j.week.label),
    topics: j.topics.length,
    written: j.topics.filter((t) => t.status === 'ready').length,
    cards: j.cards.length,
    files: j.files.map((f) => String(f.name))
  }
}

async function readWeek(file: string): Promise<{ zip: JSZip; json: WeekJson }> {
  const zip = await JSZip.loadAsync(readFileSync(file))
  const entry = zip.file('week.json')
  if (!entry) throw new Error('This isn’t a shared Studywise week.')
  const json = JSON.parse(await entry.async('string')) as WeekJson
  if (json.app !== 'studywise-courses' || json.kind !== 'week' || !json.week) throw new Error('This isn’t a shared Studywise week.')
  if (json.format > FORMAT) throw new Error('This week was shared from a newer version of Studywise. Update the app, then import it again.')
  return { zip, json }
}

/**
 * A topic row with only the levels of detail you chose to download. One that
 * has none of them keeps the level it has (better than an empty topic); `fell`
 * says so.
 */
function keepLevels(t: Row, chosen: string[]): { row: Row; fell: boolean } {
  const parse = <T>(s: unknown, fb: T): T => {
    try {
      return typeof s === 'string' ? ((JSON.parse(s) as T) ?? fb) : fb
    } catch {
      return fb
    }
  }
  const level = String(t.level || 'standard')
  const versions = parse<Record<string, { content?: unknown; progress?: unknown }>>(t.versions, {})
  const contents: Record<string, unknown> = {}
  if (typeof t.content === 'string' && t.content) contents[level] = parse(t.content, null)
  for (const [l, v] of Object.entries(versions)) if (v?.content && !contents[l]) contents[l] = v.content
  const have = Object.keys(contents).filter((l) => contents[l])
  if (!have.length) return { row: t, fell: false }
  let keep = have.filter((l) => chosen.includes(l))
  const fell = !keep.length
  if (fell) keep = [have.includes(level) ? level : have[0]]
  const shown = keep.includes(level) ? level : (NOTE_LEVELS.find((l) => keep.includes(l)) ?? keep[0])
  const written = parse<Record<string, unknown>>(t.written_with, {})
  return {
    fell,
    row: {
      ...t,
      level: shown,
      content: JSON.stringify(contents[shown]),
      versions: JSON.stringify(Object.fromEntries(keep.filter((l) => l !== shown).map((l) => [l, { content: contents[l], progress: {} }]))),
      written_with: JSON.stringify(Object.fromEntries(Object.entries(written).filter(([l]) => keep.includes(l))))
    }
  }
}

/** What's in a shared week, for the import dialog. */
export async function previewWeek(file: string): Promise<WeekPreview> {
  return previewOf((await readWeek(file)).json)
}

/**
 * Adds a shared week to one of your courses (as its next week), or to a new
 * course named like the sender's. Returns where it went.
 */
export async function importWeek(
  file: string,
  target: { courseId: string } | { newCourse: true } | { weekId: string },
  opts: { levels?: string[] } = {}
): Promise<{ courseId: string; weekId: string; topics: number; cards: number; fellBack: number }> {
  const { zip, json } = await readWeek(file)
  const d = getDb()
  // Only the levels of detail you chose (quick revision, standard, in-depth…).
  let fellBack = 0
  if (opts.levels?.length) {
    json.topics = json.topics.map((t) => {
      const k = keepLevels(t, opts.levels!)
      if (k.fell) fellBack++
      return k.row
    })
  }

  // Into an existing week: its topics, files and cards join that week's.
  const into = 'weekId' in target ? (d.prepare('SELECT * FROM weeks WHERE id = ?').get(target.weekId) as Row | undefined) : undefined
  if ('weekId' in target && !into) throw new Error('Week not found')
  const courseId = into
    ? String(into.course_id)
    : 'courseId' in target
      ? target.courseId
      : (() => {
          const c = createCourse({ name: json.course.name || 'Shared course', level: json.course.level })
          if (json.course.module) d.prepare('UPDATE courses SET module = ? WHERE id = ?').run(json.course.module, c.id)
          return c.id
        })()
  const course = getCourse(courseId)

  let week: { id: string; position: number }
  if (into) {
    week = { id: String(into.id), position: Number(into.position) }
    // An empty week (or one whose planning failed, so it has no topics) takes the shared week's state; one with its own topics keeps its own.
    const blank = into.status === 'empty' || (into.status === 'error' && !d.prepare('SELECT 1 FROM topics WHERE week_id = ?').get(week.id))
    if (blank && json.week.status === 'ready') d.prepare("UPDATE weeks SET status = 'ready', error = NULL, error_at = NULL, outline = COALESCE(outline, ?) WHERE id = ?").run(json.week.outline ?? null, week.id)
    // Its end-of-week test comes too, unless the week has its own.
    const test = testWithoutScores(json.week.test)
    if (test) d.prepare('UPDATE weeks SET test = COALESCE(test, ?) WHERE id = ?').run(test, week.id)
  } else {
    // The week lands at the end of your course, under its own label (numbered if you already have one by that name).
    const labels = new Set(course.weeks.map((w) => w.label.toLowerCase()))
    let label = String(json.week.label || 'Shared week')
    for (let n = 2; labels.has(label.toLowerCase()); n++) label = `${json.week.label} (${n})`
    week = addWeek(courseId, label)
    const status = json.week.status === 'planning' ? 'error' : String(json.week.status ?? 'empty')
    d.prepare('UPDATE weeks SET status = ?, error = ?, outline = ?, planned_with = ? WHERE id = ?').run(
      status,
      status === 'error' ? 'Planning was interrupted. Plan it again.' : (json.week.error ?? null),
      json.week.outline ?? null,
      typeof json.week.planned_with === 'string' ? json.week.planned_with : null,
      week.id
    )
    const test = testWithoutScores(json.week.test)
    if (test) d.prepare('UPDATE weeks SET test = ? WHERE id = ?').run(test, week.id)
  }

  // It holds someone else's work now, so it's never published for you automatically.
  setSetting(IMPORTED_WEEKS_SETTING, [...new Set([...getSetting<string[]>(IMPORTED_WEEKS_SETTING, []), week.id])])

  // Merging into a week that already has the same file (your own copy of the
  // slides): their topics use yours, and the file isn't added a second time.
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const sameAs = new Map<string, { id: string; name: string }>() // their file id → yours
  if (into) {
    const mine = (d.prepare('SELECT id, name, path FROM course_files WHERE week_id = ?').all(week.id) as { id: string; name: string; path: string }[]).filter((f) => existsSync(f.path))
    const byHash = new Map(mine.map((f) => [sha(readFileSync(f.path)), f]))
    for (const f of json.files) {
      const entry = zip.file(`files/${String(f.path)}`)
      const m = entry && byHash.get(sha(await entry.async('nodebuffer')))
      if (m) sameAs.set(String(f.id).toLowerCase(), { id: m.id, name: m.name })
    }
  }

  // New ids for everything in the file, and the sender's course and week become yours.
  const remap = new Map<string, string>([
    [String(json.week.course_id).toLowerCase(), courseId],
    [String(json.week.id).toLowerCase(), week.id]
  ])
  for (const r of [...json.files, ...json.topics, ...json.cards]) if (typeof r.id === 'string') remap.set(r.id.toLowerCase(), sameAs.get(r.id.toLowerCase())?.id ?? randomUUID())
  const swap = (s: string) => s.replace(UUID, (m) => remap.get(m.toLowerCase()) ?? m)

  // Topic keys follow the week's position here (w3t1 becomes w5t1 as your week 5), and
  // carry on after the week's own topics when it already has some (t5, t6, …).
  const newNo = week.position + 1
  const existing = d.prepare('SELECT key, position FROM topics WHERE week_id = ?').all(week.id) as { key: string; position: number }[]
  const lastT = Math.max(0, ...existing.map((t) => Number(t.key.match(/t(\d+)$/)?.[1] ?? 0)))
  const lastPos = Math.max(-1, ...existing.map((t) => t.position))
  const keyMap = new Map<string, string>()
  ;[...json.topics]
    .sort((a, b) => Number(a.position) - Number(b.position))
    .forEach((t, i) => {
      const own = String(t.key).match(/t(\d+)$/)?.[1]
      keyMap.set(String(t.key), `w${newNo}t${existing.length ? lastT + i + 1 : (own ?? i + 1)}`)
    })
  // Keys appear as "w3t1" in rows, and as \"w3t1\" inside each topic's plan (JSON stored as text).
  const rekey = (s: string) => s.replace(/(\\?")(w\d+t\d+)(\\?")/g, (m, q1: string, k: string, q2: string) => (keyMap.has(k) ? `${q1}${keyMap.get(k)}${q2}` : m))

  const files = JSON.parse(swap(JSON.stringify(json.files))) as Row[]
  const topics = JSON.parse(rekey(swap(JSON.stringify(json.topics)))) as Row[]
  const cards = JSON.parse(swap(JSON.stringify(json.cards))) as Row[]
  for (const t of topics) {
    // rekey already renamed the key field itself; a merged week's topics go after its own.
    if (existing.length) t.position = lastPos + 1 + Number(t.position)
  }

  // Files go in your course's folder; a name you already have gets a number, and topics follow the rename.
  const taken = new Set(course.weeks.flatMap((w) => w.files.map((f) => f.name.toLowerCase())))
  const renamed = new Map<string, string>()
  const dir = join(paths.courses, courseId, 'files')
  mkdirSync(dir, { recursive: true })
  const fileRows: { row: Row; from: string; to: string }[] = []
  for (const [i, f] of files.entries()) {
    const yours = sameAs.get(String(json.files[i].id).toLowerCase())
    if (yours) {
      if (yours.name !== f.name) renamed.set(String(f.name), yours.name)
      continue
    }
    const orig = safeFileName(String(f.name))
    let name = orig
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${basename(orig, extname(orig))} (${n})${extname(orig)}`
    taken.add(name.toLowerCase())
    if (name !== f.name) renamed.set(String(f.name), name)
    const from = `files/${String(f.path)}`
    fileRows.push({ row: { ...f, name, course_id: courseId, week_id: week.id, path: join(dir, name) }, from, to: join(dir, name) })
  }
  for (const t of topics) {
    if (!renamed.size || typeof t.plan !== 'string') continue
    const plan = JSON.parse(t.plan) as { sources?: { file: string }[] }
    for (const s of plan.sources ?? []) if (renamed.has(s.file)) s.file = renamed.get(s.file)!
    t.plan = JSON.stringify(plan)
  }

  const columns = (t: string) => new Set((d.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name))
  const insert = (t: string, rows: Row[]) => {
    const have = columns(t)
    for (const r of rows) {
      const keys = Object.keys(r).filter((k) => have.has(k))
      d.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`).run(Object.fromEntries(keys.map((k) => [k, r[k]])))
    }
  }
  const deckId = ensureWeekDeck(week.id)
  const t = now()
  d.transaction(() => {
    insert('course_files', fileRows.map((f) => f.row))
    insert(
      'topics',
      topics.map((tp) => ({
        ...tp,
        course_id: courseId,
        week_id: week.id,
        // Anything mid-write when it was shared isn't being written here.
        ...(tp.status === 'writing' ? { status: 'error', error: 'Interrupted. Write it again.' } : {}),
        progress: '{}',
        ...(tp.versions !== undefined ? { versions: noProgress(tp.versions) } : {}),
        note_id: null,
        updated_at: t
      }))
    )
    insert('cards', cards.map((c) => ({ ...c, deck_id: deckId })))
  })()

  for (const f of fileRows) {
    const entry = zip.file(f.from)
    if (entry) writeFileSync(f.to, await entry.async('nodebuffer'))
  }
  // Cards shared from an older version may lack their (n) point counts.
  fixTopicCardCounts()
  // Nothing in a shared week has been studied here yet, so its cards wait until you do.
  for (const tp of topics) refreshDormancy(String(tp.id))
  // Each written topic gets its notes in your notes, like one you wrote yourself.
  for (const tp of topics) if (tp.status === 'ready') await syncTopicNote(String(tp.id)).catch(() => null)
  d.prepare('UPDATE courses SET updated_at = ? WHERE id = ?').run(t, courseId)
  return { courseId, weekId: week.id, topics: topics.length, cards: cards.length, fellBack }
}
