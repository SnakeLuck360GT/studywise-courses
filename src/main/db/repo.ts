import { getDb, uid, now, json } from './index'
import type { Card, CardInput, Deck, Folder, Note, ReviewState, ModelChoice, LearnSettings, Thresholds, AiCall, HomeStats } from '@shared/types'
import { CardInput as CardInputSchema } from '@shared/types'
import { parseRequiredPoints, countBlanks } from '@shared/ssText'
import { isDue, masteryOf } from '@shared/sm2'
import { courseFocusInstructions, examPhase, effectiveDue, examAdjustedDue } from '@shared/course'
import { schedule, newState, withDefaults, DEFAULT_SCHEDULER, type SchedulerKind } from '@shared/scheduler'
import { SYNCED_SETTINGS } from '@shared/syncTables'

// ---------- settings ----------
export function getSetting<T>(key: string, fallback: T): T {
  if (key in SYNCED_SETTINGS) return getSyncedSetting(key, fallback)
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? json<T>(row.value, fallback) : fallback
}
export function setSetting(key: string, value: unknown): void {
  if (key in SYNCED_SETTINGS) return setSyncedSetting(key, value)
  getDb()
    .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

// Settings that sync (SYNCED_SETTINGS) live in synced_settings, a row per map
// entry or list item, so devices adding different entries never overwrite
// each other. Values saved before that move over the first time they're used.

/** Moves every synced setting saved the old way, so they all sync from the start (run at startup). */
export function moveSyncedSettings(): void {
  for (const key of Object.keys(SYNCED_SETTINGS)) movedSetting(key)
}

function movedSetting(key: string): void {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
  const v = json<unknown>(row.value, null)
  if (v != null) setSyncedSetting(key, v)
}

function getSyncedSetting<T>(key: string, fallback: T): T {
  movedSetting(key)
  const rows = getDb().prepare('SELECT item, value FROM synced_settings WHERE key = ? ORDER BY rowid').all(key) as { item: string; value: string }[]
  if (!rows.length) return fallback
  return (SYNCED_SETTINGS[key] === 'list' ? rows.map((r) => r.item) : Object.fromEntries(rows.map((r) => [r.item, json<unknown>(r.value, null)]))) as T
}

/** Writes only the entries that changed, so each syncs on its own. */
function setSyncedSetting(key: string, value: unknown): void {
  movedSetting(key)
  const next = new Map<string, string>()
  if (SYNCED_SETTINGS[key] === 'list') {
    if (Array.isArray(value)) for (const v of value) next.set(String(v), 'true')
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (v !== undefined) next.set(k, JSON.stringify(v))
  }
  const d = getDb()
  const cur = new Map((d.prepare('SELECT item, value FROM synced_settings WHERE key = ?').all(key) as { item: string; value: string }[]).map((r) => [r.item, r.value]))
  const del = d.prepare('DELETE FROM synced_settings WHERE key = ? AND item = ?')
  const put = d.prepare('INSERT INTO synced_settings (key, item, value) VALUES (?, ?, ?) ON CONFLICT (key, item) DO UPDATE SET value = excluded.value')
  d.transaction(() => {
    for (const item of cur.keys()) if (!next.has(item)) del.run(key, item)
    for (const [item, v] of next) if (cur.get(item) !== v) put.run(key, item, v)
  })()
}
export function allSettings(): Record<string, unknown> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, json(r.value, null)]))
}

// ---------- folders ----------
export function listFolders(kind?: 'deck' | 'note'): Folder[] {
  const rows = kind
    ? getDb().prepare('SELECT * FROM folders WHERE kind = ? ORDER BY name COLLATE NOCASE').all(kind)
    : getDb().prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all()
  return rows as Folder[]
}
export function createFolder(name: string, kind: 'deck' | 'note', parent_id: string | null = null): Folder {
  const f: Folder = { id: uid(), name, kind, parent_id, created_at: now() }
  getDb().prepare('INSERT INTO folders VALUES (@id, @name, @parent_id, @kind, @created_at)').run(f)
  return f
}
export function renameFolder(id: string, name: string): void {
  getDb().prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id)
}
export function deleteFolder(id: string): void {
  getDb().prepare('DELETE FROM folders WHERE id = ?').run(id)
}

// ---------- decks ----------
type DeckRow = Omit<Deck, 'model_overrides' | 'learn_settings' | 'thresholds'> & {
  model_overrides: string
  learn_settings: string | null
  thresholds: string | null
}
function toDeck(r: DeckRow): Deck {
  return {
    ...r,
    model_overrides: json<Record<string, ModelChoice>>(r.model_overrides, {}),
    learn_settings: json<LearnSettings | null>(r.learn_settings, null),
    thresholds: json<Thresholds | null>(r.thresholds, null)
  }
}
export function listDecks(): (Deck & { card_count: number; due_count: number })[] {
  const decks = (getDb().prepare('SELECT * FROM decks ORDER BY name COLLATE NOCASE').all() as DeckRow[]).map(toDeck)
  const counts = getDb().prepare('SELECT deck_id, COUNT(*) n FROM cards GROUP BY deck_id').all() as { deck_id: string; n: number }[]
  const cm = new Map(counts.map((c) => [c.deck_id, c.n]))
  const due = dueCountsByDeck()
  return decks.map((d) => ({ ...d, card_count: cm.get(d.id) ?? 0, due_count: due.get(d.id) ?? 0 }))
}
export function getDeck(id: string): Deck {
  const r = getDb().prepare('SELECT * FROM decks WHERE id = ?').get(id) as DeckRow | undefined
  if (!r) throw new Error('Deck not found')
  return toDeck(r)
}
export function createDeck(input: { name: string; folder_id?: string | null; description?: string }): Deck {
  const t = now()
  const d = {
    id: uid(),
    folder_id: input.folder_id ?? null,
    name: input.name,
    description: input.description ?? '',
    extra_instructions: '',
    model_overrides: '{}',
    learn_settings: null,
    thresholds: null,
    created_at: t,
    updated_at: t
  }
  getDb()
    .prepare(
      `INSERT INTO decks VALUES (@id, @folder_id, @name, @description, @extra_instructions, @model_overrides, @learn_settings, @thresholds, @created_at, @updated_at)`
    )
    .run(d)
  return getDeck(d.id)
}
export function updateDeck(
  id: string,
  patch: Partial<Pick<Deck, 'name' | 'folder_id' | 'description' | 'extra_instructions' | 'model_overrides' | 'learn_settings' | 'thresholds'>>
): Deck {
  const cur = getDeck(id)
  const next = { ...cur, ...patch }
  getDb()
    .prepare(
      `UPDATE decks SET name=@name, folder_id=@folder_id, description=@description, extra_instructions=@extra_instructions,
       model_overrides=@model_overrides, learn_settings=@learn_settings, thresholds=@thresholds, updated_at=@updated_at WHERE id=@id`
    )
    .run({
      ...next,
      model_overrides: JSON.stringify(next.model_overrides ?? {}),
      learn_settings: next.learn_settings ? JSON.stringify(next.learn_settings) : null,
      thresholds: next.thresholds ? JSON.stringify(next.thresholds) : null,
      updated_at: now()
    })
  return getDeck(id)
}
export function deleteDeck(id: string): void {
  getDb().prepare('DELETE FROM decks WHERE id = ?').run(id)
}

// ---------- cards ----------
type CardRow = Omit<Card, 'options' | 'cloze_answers' | 'tags' | 'hints' | 'source'> & {
  options: string
  cloze_answers: string
  tags: string
  hints: string
  source: string | null
}
export function toCard(r: CardRow): Card {
  return {
    ...r,
    options: json(r.options, []),
    cloze_answers: json(r.cloze_answers, []),
    tags: json(r.tags, []),
    hints: json(r.hints, []),
    source: json(r.source, null)
  }
}

/** Fill derived fields: required_points from a trailing (n), cloze kind from ___ runs. */
export function normalizeCardInput(input: CardInput): ReturnType<typeof CardInputSchema.parse> {
  const c = CardInputSchema.parse(input)
  if (c.kind !== 'multiple_choice' && countBlanks(c.front) > 0) c.kind = 'cloze'
  if (c.kind === 'cloze') c.required_points = null
  else if (c.required_points == null) c.required_points = parseRequiredPoints(c.front)
  return c
}

export function listCards(deckId: string): Card[] {
  return (getDb().prepare('SELECT * FROM cards WHERE deck_id = ? ORDER BY position, created_at').all(deckId) as CardRow[]).map(toCard)
}
export function getCard(id: string): Card {
  const r = getDb().prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
  if (!r) throw new Error('Card not found')
  return toCard(r)
}
export function getCards(ids: string[]): Card[] {
  if (ids.length === 0) return []
  const rows = getDb()
    .prepare(`SELECT * FROM cards WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as CardRow[]
  const map = new Map(rows.map((r) => [r.id, toCard(r)]))
  return ids.map((id) => map.get(id)).filter((c): c is Card => !!c)
}

export function createCards(inputs: CardInput[]): Card[] {
  const d = getDb()
  const ins = d.prepare(
    `INSERT INTO cards (id, deck_id, position, format, kind, front, back, language, options, cloze_answers, tags, hints, explanation, source, required_points, created_at, updated_at)
     VALUES (@id, @deck_id, @position, @format, @kind, @front, @back, @language, @options, @cloze_answers, @tags, @hints, @explanation, @source, @required_points, @created_at, @updated_at)`
  )
  const ids: string[] = []
  d.transaction(() => {
    const posByDeck = new Map<string, number>()
    for (const raw of inputs) {
      const c = normalizeCardInput(raw)
      let pos = posByDeck.get(c.deck_id)
      if (pos === undefined) {
        const r = d.prepare('SELECT COALESCE(MAX(position), 0) p FROM cards WHERE deck_id = ?').get(c.deck_id) as { p: number }
        pos = r.p
      }
      pos += 1
      posByDeck.set(c.deck_id, pos)
      const t = now()
      const id = uid()
      ids.push(id)
      ins.run({
        ...c,
        id,
        position: pos,
        options: JSON.stringify(c.options),
        cloze_answers: JSON.stringify(c.cloze_answers),
        tags: JSON.stringify(c.tags),
        hints: JSON.stringify(c.hints),
        source: c.source ? JSON.stringify(c.source) : null,
        created_at: t,
        updated_at: t
      })
    }
  })()
  return getCards(ids)
}

export function updateCard(id: string, patch: Partial<CardInput>): Card {
  const cur = getCard(id)
  const merged = normalizeCardInput({ ...cur, ...patch, required_points: patch.front !== undefined && patch.required_points === undefined ? null : (patch.required_points ?? cur.required_points) })
  getDb()
    .prepare(
      `UPDATE cards SET deck_id=@deck_id, format=@format, kind=@kind, front=@front, back=@back, language=@language, options=@options,
       cloze_answers=@cloze_answers, tags=@tags, hints=@hints, explanation=@explanation, source=@source, required_points=@required_points, updated_at=@updated_at WHERE id=@id`
    )
    .run({
      ...merged,
      id,
      options: JSON.stringify(merged.options),
      cloze_answers: JSON.stringify(merged.cloze_answers),
      tags: JSON.stringify(merged.tags),
      hints: JSON.stringify(merged.hints),
      source: merged.source ? JSON.stringify(merged.source) : null,
      updated_at: now()
    })
  // Card content changed: cached questions are stale.
  if (patch.front !== undefined || patch.back !== undefined || patch.cloze_answers !== undefined || patch.options !== undefined) {
    getDb().prepare('DELETE FROM question_cache WHERE card_id = ?').run(id)
  }
  return getCard(id)
}

export function deleteCards(ids: string[]): void {
  const d = getDb()
  const del = d.prepare('DELETE FROM cards WHERE id = ?')
  d.transaction(() => ids.forEach((id) => del.run(id)))()
}
export function moveCards(ids: string[], deckId: string): void {
  const d = getDb()
  const up = d.prepare('UPDATE cards SET deck_id = ?, updated_at = ? WHERE id = ?')
  d.transaction(() => ids.forEach((id) => up.run(deckId, now(), id)))()
}

export function searchCards(q: string, deckId?: string): (Card & { deck_name: string })[] {
  const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`
  const rows = getDb()
    .prepare(
      `SELECT c.*, d.name AS deck_name FROM cards c JOIN decks d ON d.id = c.deck_id
       WHERE (c.front LIKE @like ESCAPE '\\' OR c.back LIKE @like ESCAPE '\\' OR c.tags LIKE @like ESCAPE '\\')
       ${deckId ? 'AND c.deck_id = @deckId' : ''} ORDER BY c.updated_at DESC LIMIT 200`
    )
    .all({ like, deckId }) as (CardRow & { deck_name: string })[]
  return rows.map((r) => ({ ...toCard(r), deck_name: r.deck_name }))
}

// ---------- notes ----------
type NoteRow = Omit<Note, 'deck_ids'>
function withDecks(n: NoteRow): Note {
  const decks = getDb().prepare('SELECT deck_id FROM note_decks WHERE note_id = ?').all(n.id) as { deck_id: string }[]
  return { ...n, deck_ids: decks.map((d) => d.deck_id) }
}
export function listNotes(): Omit<Note, 'content'>[] {
  const rows = getDb()
    // Revision order within a folder; notes made before ordering come after, newest first.
    .prepare('SELECT id, folder_id, title, module, type, week, created_at, updated_at, position FROM notes ORDER BY position IS NULL, position, updated_at DESC')
    .all() as Omit<NoteRow, 'content'>[]
  const links = getDb().prepare('SELECT note_id, deck_id FROM note_decks').all() as { note_id: string; deck_id: string }[]
  return rows.map((r) => ({ ...r, deck_ids: links.filter((l) => l.note_id === r.id).map((l) => l.deck_id) }))
}
export function getNote(id: string): Note {
  const r = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
  if (!r) throw new Error('Note not found')
  return withDecks(r)
}
export function createNote(input: Partial<Pick<Note, 'title' | 'module' | 'type' | 'week' | 'content' | 'folder_id'>>): Note {
  const t = now()
  const n = {
    id: uid(),
    folder_id: input.folder_id ?? null,
    title: input.title || 'Untitled',
    module: input.module ?? '',
    type: input.type ?? '',
    week: input.week ?? '',
    content: input.content ?? '',
    created_at: t,
    updated_at: t
  }
  getDb()
    .prepare('INSERT INTO notes (id, folder_id, title, module, type, week, content, created_at, updated_at) VALUES (@id, @folder_id, @title, @module, @type, @week, @content, @created_at, @updated_at)')
    .run(n)
  return getNote(n.id)
}
export function updateNote(id: string, patch: Partial<Pick<Note, 'title' | 'module' | 'type' | 'week' | 'content' | 'folder_id'>>): Note {
  const cur = getNote(id)
  const next = { ...cur, ...patch, updated_at: now() }
  getDb()
    .prepare('UPDATE notes SET folder_id=@folder_id, title=@title, module=@module, type=@type, week=@week, content=@content, updated_at=@updated_at WHERE id=@id')
    .run(next)
  return getNote(id)
}
export function deleteNote(id: string): void {
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id)
}
export function linkNoteDeck(noteId: string, deckId: string, linked: boolean): void {
  if (linked) getDb().prepare('INSERT OR IGNORE INTO note_decks VALUES (?, ?)').run(noteId, deckId)
  else getDb().prepare('DELETE FROM note_decks WHERE note_id = ? AND deck_id = ?').run(noteId, deckId)
}
export function notesForDeck(deckId: string): Note[] {
  const rows = getDb()
    .prepare('SELECT n.* FROM notes n JOIN note_decks l ON l.note_id = n.id WHERE l.deck_id = ?')
    .all(deckId) as NoteRow[]
  return rows.map(withDecks)
}

/** Find the markdown section (by heading) of a note. */
export function noteSection(noteId: string, section?: string): string {
  let note: Note
  try {
    note = getNote(noteId)
  } catch {
    return ''
  }
  if (!section) return note.content.slice(0, 6000)
  const lines = note.content.split('\n')
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim() === section.trim())
  if (start === -1) return note.content.slice(0, 6000)
  const level = (lines[start].match(/^#+/) ?? ['#'])[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/)
    if (m && m[1].length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// ---------- review / spaced repetition ----------
export function writeReviewState(r: ReviewState): void {
  const full = { ...r, difficulty: r.difficulty ?? 0.6, sr_state: r.sr_state ?? 0, good_count: r.good_count ?? 0 }
  getDb()
    .prepare(
      `INSERT INTO review_state (card_id, ease, interval, repetitions, lapses, due, last_reviewed, difficulty, sr_state, good_count)
       VALUES (@card_id, @ease, @interval, @repetitions, @lapses, @due, @last_reviewed, @difficulty, @sr_state, @good_count)
       ON CONFLICT(card_id) DO UPDATE SET ease=@ease, interval=@interval, repetitions=@repetitions, lapses=@lapses, due=@due,
       last_reviewed=@last_reviewed, difficulty=@difficulty, sr_state=@sr_state, good_count=@good_count`
    )
    .run(full)
}
export function getReviewState(cardId: string): ReviewState | null {
  return (getDb().prepare('SELECT * FROM review_state WHERE card_id = ?').get(cardId) as ReviewState | undefined) ?? null
}
export function applyReview(cardId: string, rating: 1 | 2 | 3 | 4, source: 'flashcard' | 'learn', at = new Date()): ReviewState {
  const card = getCard(cardId)
  const existing = getReviewState(cardId)
  const cur = existing ? withDefaults(existing) : newState(at)
  const kind = getSetting<SchedulerKind>('review.scheduler', DEFAULT_SCHEDULER)
  const s = schedule(kind, cur, rating, at)
  // A course card's next review follows its exam: further out while it's far off,
  // closer in during revision, never after the last look before it.
  s.due = examAdjustedDue(s.due, at, examDateOfDeck(card.deck_id))
  const next = {
    card_id: cardId,
    ease: s.ease,
    interval: s.interval,
    repetitions: s.repetitions,
    lapses: s.lapses,
    due: s.due,
    last_reviewed: s.last_reviewed,
    difficulty: s.difficulty,
    sr_state: s.sr_state,
    good_count: s.good_count
  }
  const d = getDb()
  d.transaction(() => {
    writeReviewState(next)
    d.prepare('INSERT INTO review_log (card_id, deck_id, rating, source, at) VALUES (?, ?, ?, ?, ?)').run(cardId, card.deck_id, rating, source, at.toISOString())
    // Rating a card means you've met it: it's in spaced review from now on.
    d.prepare('UPDATE cards SET dormant = 0 WHERE id = ? AND dormant = 1').run(cardId)
  })()
  return next
}
/** Cards still waiting for you to study their topic (see course.refreshDormancy). */
function dormantIds(deckId?: string): Set<string> {
  const rows = (deckId ? getDb().prepare('SELECT id FROM cards WHERE dormant = 1 AND deck_id = ?').all(deckId) : getDb().prepare('SELECT id FROM cards WHERE dormant = 1').all()) as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

/** The exam date of the course a deck belongs to (its week deck), if any. */
function examDateOfDeck(deckId: string): string | null {
  const r = getDb().prepare('SELECT c.exam_date FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.deck_id = ?').get(deckId) as { exam_date: string | null } | undefined
  return r?.exam_date ?? null
}

/** Your note to the AI for the course a deck belongs to (a week deck, or an old course-wide deck), or ''. */
/** The tailoring rule for the kinds of course (theory, practical, formula heavy) ticked for a deck's course. */
export function courseFocusForDeck(deckId: string): string {
  try {
    const r = getDb()
      .prepare('SELECT c.focus FROM courses c WHERE c.deck_id = ? OR c.id IN (SELECT course_id FROM weeks WHERE deck_id = ?) LIMIT 1')
      .get(deckId, deckId) as { focus: string | null } | undefined
    return courseFocusInstructions(json<string[]>(r?.focus, []))
  } catch {
    return '' // a database from before course focuses
  }
}

export function courseNoteForDeck(deckId: string): string {
  try {
    const r = getDb()
      .prepare('SELECT c.note FROM courses c WHERE c.deck_id = ? OR c.id IN (SELECT course_id FROM weeks WHERE deck_id = ?) LIMIT 1')
      .get(deckId, deckId) as { note: string | null } | undefined
    return r?.note?.trim() ?? ''
  } catch {
    return '' // a database from before course notes
  }
}

/** Exam dates of every course week deck that has one. */
function examDatesByDeck(): Map<string, string> {
  const rows = getDb().prepare('SELECT w.deck_id, c.exam_date FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.deck_id IS NOT NULL AND c.exam_date IS NOT NULL').all() as { deck_id: string; exam_date: string }[]
  return new Map(rows.map((r) => [r.deck_id, r.exam_date]))
}

/** Due, counting a course's revision ramp (see effectiveDue). */
function dueWithExam(state: Pick<ReviewState, 'due' | 'last_reviewed'> | null | undefined, examDate: string | null | undefined, now: Date): boolean {
  if (!state) return isDue(state, now)
  return isDue({ due: effectiveDue(state.due, state.last_reviewed ?? null, examDate, now) }, now)
}

/**
 * Course week decks that don't count towards what's due right now: weeks with
 * recall turned off, and courses whose exam is over.
 */
export function restingDeckIds(now = new Date()): Set<string> {
  const rows = getDb().prepare('SELECT w.deck_id, w.recall_off, c.exam_date FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.deck_id IS NOT NULL').all() as { deck_id: string; recall_off: number; exam_date: string | null }[]
  const out = new Set<string>()
  for (const r of rows) if (r.recall_off || examPhase(r.exam_date, now).phase === 'over') out.add(r.deck_id)
  return out
}

export function dueCards(deckId: string, now = new Date()): Card[] {
  const sleeping = dormantIds(deckId)
  const cards = listCards(deckId).filter((c) => !sleeping.has(c.id))
  const states = new Map(
    (getDb().prepare('SELECT r.* FROM review_state r JOIN cards c ON c.id = r.card_id WHERE c.deck_id = ?').all(deckId) as ReviewState[]).map((s) => [
      s.card_id,
      s
    ])
  )
  const exam = examDateOfDeck(deckId)
  return cards
    .filter((c) => dueWithExam(states.get(c.id), exam, now))
    .sort((a, b) => (states.get(a.id)?.due ?? '').localeCompare(states.get(b.id)?.due ?? ''))
}
/**
 * Due cards per deck. Resting course weeks (recall off, or the exam far off or
 * over) count none, and neither do cards from topics you haven't studied yet.
 */
export function dueCountsByDeck(now = new Date()): Map<string, number> {
  const resting = restingDeckIds(now)
  const exams = examDatesByDeck()
  const rows = getDb()
    .prepare('SELECT c.deck_id, c.dormant, r.due, r.last_reviewed FROM cards c LEFT JOIN review_state r ON r.card_id = c.id')
    .all() as { deck_id: string; dormant: number; due: string | null; last_reviewed: string | null }[]
  const m = new Map<string, number>()
  for (const r of rows) {
    if (resting.has(r.deck_id) || r.dormant) continue
    if (dueWithExam(r.due ? { due: r.due, last_reviewed: r.last_reviewed } : null, exams.get(r.deck_id), now)) m.set(r.deck_id, (m.get(r.deck_id) ?? 0) + 1)
  }
  return m
}
export function totalDueToday(): number {
  let n = 0
  for (const v of dueCountsByDeck().values()) n += v
  return n
}

export function deckStats(deckId: string) {
  const cards = listCards(deckId)
  const states = new Map(
    (getDb().prepare('SELECT r.* FROM review_state r JOIN cards c ON c.id = r.card_id WHERE c.deck_id = ?').all(deckId) as ReviewState[]).map((s) => [
      s.card_id,
      s
    ])
  )
  const sleeping = dormantIds(deckId)
  const exam = examDateOfDeck(deckId)
  const due = cards.filter((c) => !sleeping.has(c.id) && dueWithExam(states.get(c.id), exam, new Date())).length
  const mastery = cards.length ? cards.reduce((a, c) => a + masteryOf(states.get(c.id)), 0) / cards.length : 0
  const days: { date: string; count: number }[] = []
  const today = new Date()
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    days.push({ date: key, count: 0 })
  }
  const since = days[0].date
  const logs = getDb().prepare('SELECT at FROM review_log WHERE deck_id = ? AND at >= ?').all(deckId, since) as { at: string }[]
  for (const l of logs) {
    const local = new Date(l.at)
    const key = new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    const day = days.find((d) => d.date === key)
    if (day) day.count++
  }
  // Weakest: most lapses, then lowest ease, then most recent wrong attempts.
  const wrongCounts = getDb()
    .prepare(
      `SELECT card_id, SUM(CASE WHEN verdict != 'correct' AND overridden = 0 THEN 1 ELSE 0 END) wrong, COUNT(*) total
       FROM answer_attempts WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ?) GROUP BY card_id`
    )
    .all(deckId) as { card_id: string; wrong: number; total: number }[]
  const wm = new Map(wrongCounts.map((w) => [w.card_id, w]))
  const weakest = cards
    .map((c) => {
      const s = states.get(c.id)
      const w = wm.get(c.id)
      const score = (s?.lapses ?? 0) * 2 + (s ? Math.max(0, (s.difficulty ?? 0.6) - 0.45) * 6 + Math.max(0, 2.5 - s.ease) * 2 : 0) + (w ? (w.wrong / Math.max(1, w.total)) * 3 : 0)
      return { card: c, score, lapses: s?.lapses ?? 0, ease: s?.ease ?? null, difficulty: s?.difficulty ?? null }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
  return { total: cards.length, due, mastery, activity: days, weakest, reviewed: states.size }
}

// ---------- ai_calls ----------
export function logAiCall(c: Omit<AiCall, 'id' | 'created_at'> & { preset_id?: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO ai_calls (task, preset_id, preset_name, preset_version, model, duration_ms, input_tokens, output_tokens, cost_usd, ok, error, created_at)
       VALUES (@task, @preset_id, @preset_name, @preset_version, @model, @duration_ms, @input_tokens, @output_tokens, @cost_usd, @ok, @error, @created_at)`
    )
    .run({ preset_id: null, ...c, ok: c.ok ? 1 : 0, created_at: now() })
}
export function listAiCalls(limit = 200): AiCall[] {
  const rows = getDb().prepare('SELECT * FROM ai_calls ORDER BY id DESC LIMIT ?').all(limit) as (Omit<AiCall, 'ok'> & { ok: number })[]
  return rows.map((r) => ({ ...r, ok: !!r.ok }))
}
export function aiUsageSummary() {
  return getDb()
    .prepare(
      `SELECT task, model, COUNT(*) calls, SUM(ok) ok, AVG(duration_ms) avg_ms, SUM(COALESCE(input_tokens,0)) input_tokens, SUM(COALESCE(output_tokens,0)) output_tokens
       FROM ai_calls GROUP BY task, model ORDER BY calls DESC`
    )
    .all()
}

// ---------- home overview ----------
const localDay = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

/** Reviews per day for the last `days` days (local dates), the current streak and the next due card. */
export function overview(days = 84) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const rows = getDb().prepare('SELECT at FROM review_log WHERE at >= ?').all(start.toISOString()) as { at: string }[]
  const counts = new Map<string, number>()
  for (const r of rows) {
    const k = localDay(new Date(r.at))
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const activity: { date: string; count: number }[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const k = localDay(d)
    activity.push({ date: k, count: counts.get(k) ?? 0 })
  }
  // Streak: consecutive days with reviews, counting back from today (or yesterday if nothing yet today).
  let streak = 0
  let i = activity.length - 1
  if (activity[i]?.count === 0) i--
  while (i >= 0 && activity[i].count > 0) {
    streak++
    i--
  }
  const today = activity[activity.length - 1]?.count ?? 0
  const week = activity.slice(-7).reduce((n, a) => n + a.count, 0)
  let next: (Card & { deck_name: string }) | null = null
  for (const d of listDecks().filter((x) => x.due_count > 0).sort((a, b) => b.due_count - a.due_count)) {
    const c = dueCards(d.id)[0]
    if (c) {
      next = { ...c, deck_name: d.name }
      break
    }
  }
  return { activity, streak, today, week, next }
}

// ---------- time studied ----------

/** Add time spent studying (on a topic, flashcards, Learn or notes) to today, on this device. */
export function addStudyTime(seconds: number, at = new Date()): void {
  const s = Math.round(Math.max(0, Math.min(seconds, 600)))
  if (!s) return
  const device = (getDb().prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get() as { value: string } | undefined)?.value ?? 'local'
  getDb()
    .prepare('INSERT INTO study_time (day, device, seconds) VALUES (?, ?, ?) ON CONFLICT (day, device) DO UPDATE SET seconds = seconds + excluded.seconds')
    .run(localDay(at), device, s)
}

/** Everything the home page shows about your studying. */
export function homeStats(now = new Date()): HomeStats {
  const d = getDb()
  const today = localDay(now)
  const dayOffset = (n: number) => {
    const x = new Date(now)
    x.setHours(12, 0, 0, 0)
    x.setDate(x.getDate() - n)
    return localDay(x)
  }
  const perDay = new Map((d.prepare('SELECT day, SUM(seconds) s FROM study_time GROUP BY day').all() as { day: string; s: number }[]).map((r) => [r.day, r.s]))
  const sumSince = (from: string) => [...perDay].reduce((n, [day, s]) => (day >= from && day <= today ? n + s : n), 0)
  const total = [...perDay.values()].reduce((n, s) => n + s, 0)
  const studiedDays = [...perDay.values()].filter((s) => s > 0).length
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = dayOffset(6 - i)
    return { date, seconds: perDay.get(date) ?? 0 }
  })
  let bestDay: HomeStats['bestDay'] = null
  for (const [date, seconds] of perDay) if (seconds > 0 && (!bestDay || seconds > bestDay.seconds)) bestDay = { date, seconds }

  // Reviews by local day, for the streak and today's/this week's counts.
  const reviewDays = new Map<string, number>()
  for (const r of d.prepare('SELECT at FROM review_log WHERE at >= ?').all(new Date(now.getTime() - 400 * 86_400_000).toISOString()) as { at: string }[]) {
    const k = localDay(new Date(r.at))
    reviewDays.set(k, (reviewDays.get(k) ?? 0) + 1)
  }
  const active = (day: string) => (perDay.get(day) ?? 0) >= 60 || (reviewDays.get(day) ?? 0) > 0
  let streak = 0
  let back = active(today) ? 0 : 1
  while (active(dayOffset(back))) {
    streak++
    back++
  }
  const weekStart = dayOffset(6)
  const reviewedWeek = [...reviewDays].reduce((n, [day, c]) => (day >= weekStart ? n + c : n), 0)
  const totalReviews = (d.prepare('SELECT COUNT(*) n FROM review_log').get() as { n: number }).n
  // Retention: share of the last 30 days' reviews you didn't rate "again".
  const recent = d.prepare('SELECT COUNT(*) n, SUM(CASE WHEN rating > 1 THEN 1 ELSE 0 END) ok FROM review_log WHERE at >= ?').get(new Date(now.getTime() - 30 * 86_400_000).toISOString()) as { n: number; ok: number | null }
  const known = (d.prepare('SELECT COUNT(*) n FROM review_state WHERE interval >= 21').get() as { n: number }).n

  const topicRows = d.prepare('SELECT status, progress FROM topics').all() as { status: string; progress: string }[]
  const topics = { done: 0, total: topicRows.length, written: 0, answered: 0, correct: 0, tests: 0, testAverage: null as number | null }
  let testSum = 0
  for (const t of topicRows) {
    let p: { done?: boolean; answered?: number; correct?: number; checkScore?: number | null; checkTotal?: number | null } = {}
    try {
      p = JSON.parse(t.progress || '{}')
    } catch {
      /* ignore */
    }
    if (t.status === 'ready') topics.written++
    if (p.done) topics.done++
    topics.answered += p.answered ?? 0
    topics.correct += p.correct ?? 0
    if (p.checkTotal) {
      topics.tests++
      testSum += (p.checkScore ?? 0) / p.checkTotal
    }
  }
  if (topics.tests) topics.testAverage = testSum / topics.tests
  topics.correct = Math.round(topics.correct * 10) / 10

  return {
    time: { today: perDay.get(today) ?? 0, week: sumSince(weekStart), month: sumSince(dayOffset(29)), total, dailyAverage: studiedDays ? Math.round(total / studiedDays) : 0 },
    days,
    streak,
    bestDay,
    cards: { reviewedToday: reviewDays.get(today) ?? 0, reviewedWeek, total: totalReviews, known, retention: recent.n ? (recent.ok ?? 0) / recent.n : null },
    topics,
    courses: (d.prepare('SELECT COUNT(*) n FROM courses').get() as { n: number }).n
  }
}
