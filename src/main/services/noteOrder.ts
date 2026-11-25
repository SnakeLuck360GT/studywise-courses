// Notes in revision order: the order you'd go through them to revise.
//
// Each note has a position in its folder (notes.position; null for notes made
// before positions existed, which are listed after the ordered ones). A
// course topic's notes go in course order: by week, then the topic's place in
// the week. Other notes go by the week they're for (the note's Week, or
// "Week 3" / "W3" in the title), then the lecture number in the title
// ("Lecture 5"), then when they were made.
//
// New notes (written topics, generated notes) are put in place as they're
// made. "Put in revision order" orders everything already there, including
// notes made before this.

import { getDb } from '../db'

interface NoteRow {
  id: string
  folder_id: string | null
  title: string
  week: string
  created_at: string
  position: number | null
}

const NONE = Number.POSITIVE_INFINITY

/** 3 from "3", "Week 3", "W3: Testing"; none when there's no number. */
export function weekOf(week: string, title: string): number {
  const w = String(week ?? '').match(/\d+/)
  if (w) return Number(w[0])
  const t = String(title ?? '').match(/\b(?:week|wk|w)\s*(\d+)/i)
  return t ? Number(t[1]) : NONE
}

/** 5 from "Lecture 5", "Lec 5", "L5 – Sorting"; none otherwise. */
export function lectureOf(title: string): number {
  const m = String(title ?? '').match(/\b(?:lecture|lec|l)\s*(\d+)/i)
  return m ? Number(m[1]) : NONE
}

/** Where each course topic's note sits in its course: [week, topic]. */
function courseOrder(noteIds: string[]): Map<string, [number, number]> {
  if (!noteIds.length) return new Map()
  const rows = getDb()
    .prepare(`SELECT t.note_id, w.position wp, t.position tp FROM topics t JOIN weeks w ON w.id = t.week_id WHERE t.note_id IN (${noteIds.map(() => '?').join(',')})`)
    .all(...noteIds) as { note_id: string; wp: number; tp: number }[]
  return new Map(rows.map((r) => [r.note_id, [r.wp + 1, r.tp]]))
}

type Key = [number, number, string]

function keys(notes: NoteRow[]): Map<string, Key> {
  const course = courseOrder(notes.map((n) => n.id))
  return new Map(
    notes.map((n) => {
      const c = course.get(n.id)
      return [n.id, c ? [c[0], c[1], n.created_at] : [weekOf(n.week, n.title), lectureOf(n.title), n.created_at]]
    })
  )
}

/** Week, then lecture or topic, then when it was made. No number sorts after every number. */
const cmp = (a: Key, b: Key) => {
  for (let i = 0; i < 2; i++) {
    const x = a[i] as number
    const y = b[i] as number
    if (x === y) continue
    if (x === NONE) return 1
    if (y === NONE) return -1
    return x - y
  }
  return a[2].localeCompare(b[2])
}

function notesIn(folderId: string | null): NoteRow[] {
  return getDb()
    .prepare(`SELECT id, folder_id, title, week, created_at, position FROM notes WHERE ${folderId ? 'folder_id = ?' : 'folder_id IS NULL'}`)
    .all(...(folderId ? [folderId] : [])) as NoteRow[]
}

function save(ordered: NoteRow[]): void {
  const d = getDb()
  const up = d.prepare('UPDATE notes SET position = ? WHERE id = ?')
  d.transaction(() => ordered.forEach((n, i) => n.position !== i && up.run(i, n.id)))()
}

/**
 * Put a newly made note in its place among its folder's ordered notes. Notes
 * made before positions existed stay where they are (after the ordered ones)
 * until the folder is put in revision order.
 */
export function placeNote(noteId: string): void {
  const n = getDb().prepare('SELECT id, folder_id FROM notes WHERE id = ?').get(noteId) as { id: string; folder_id: string | null } | undefined
  if (!n) return
  const all = notesIn(n.folder_id)
  const peers = all.filter((x) => x.position !== null || x.id === noteId)
  const k = keys(peers)
  save(peers.sort((a, b) => cmp(k.get(a.id)!, k.get(b.id)!)))
}

/** Folders whose notes to order: one folder and the folders inside it, or every notes folder (and notes in no folder). */
function scope(folderId: string | null): (string | null)[] {
  const folders = getDb().prepare("SELECT id, parent_id FROM folders WHERE kind = 'note'").all() as { id: string; parent_id: string | null }[]
  if (!folderId) return [null, ...folders.map((f) => f.id)]
  const out = new Set([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders)
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id)
        grew = true
      }
  }
  return [...out]
}

/** Put every note in a folder (and the folders inside it), or every note, in revision order. Returns how many notes it ordered. */
export function putInRevisionOrder(folderId: string | null): number {
  let n = 0
  for (const f of scope(folderId)) {
    const notes = notesIn(f)
    const k = keys(notes)
    save(notes.sort((a, b) => cmp(k.get(a.id)!, k.get(b.id)!)))
    n += notes.length
  }
  return n
}
