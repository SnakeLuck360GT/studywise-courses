// The files synced rows point at, for syncing between two computers: course
// files (the slides, PDFs and transcripts a course was made from) and pasted
// images. Rows travel through the change log; their bytes are copied over
// /course-file and /file so each computer has its own copy. (A phone doesn't
// need them: it asks the computer for figures and images as it shows them.)

import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { paths } from '../paths'
import { SYNC_TABLES } from '@shared/syncTables'
import type { SqlDb } from './engine'

const SAFE_ID = /^[\w-]+$/
const SAFE_NAME = /^[^\\/:*?"<>|\x00-\x1f]+$/

/**
 * Where a course file belongs on this computer: courses/<course>/files/<name>,
 * whatever folder the computer that added it keeps its data in. Null when the
 * row's ids or name aren't safe to make a path from.
 */
export function coursePathFor(courseId: string, storedPath: string): string | null {
  const name = String(storedPath).split(/[\\/]/).pop() ?? ''
  if (!SAFE_ID.test(courseId) || !SAFE_NAME.test(name) || name === '.' || name === '..') return null
  const full = join(paths.courses, courseId, 'files', name)
  return full.startsWith(paths.courses + sep) ? full : null
}

/** A course file's place on this computer (whether or not it's arrived yet). */
export function courseFileOnDisk(db: SqlDb, id: string): string | null {
  const r = db.prepare('SELECT course_id, path FROM course_files WHERE id = ?').get(id) as { course_id: string; path: string } | undefined
  if (!r) return null
  if (r.path.startsWith(paths.courses + sep) && existsSync(r.path)) return r.path
  return coursePathFor(r.course_id, r.path)
}

/**
 * Course file rows hold the full path on the computer that added the file, so
 * rows from another computer point at its folders. Point them at this
 * computer's copy instead. The fix isn't logged as a change (like applying),
 * so each computer keeps its own path and neither sends it back.
 */
export function localizeCoursePaths(db: SqlDb): number {
  const rows = db.prepare('SELECT id, course_id, path FROM course_files').all() as { id: string; course_id: string; path: string }[]
  const fixes: { id: string; path: string }[] = []
  for (const r of rows) {
    // Already in this computer's courses folder (every course file added here is).
    if (r.path.startsWith(paths.courses + sep)) continue
    const p = coursePathFor(r.course_id, r.path)
    if (p && p !== r.path) fixes.push({ id: r.id, path: p })
  }
  if (!fixes.length) return 0
  db.transaction(() => {
    db.prepare("UPDATE sync_meta SET value = '1' WHERE key = 'applying'").run()
    const up = db.prepare('UPDATE course_files SET path = ? WHERE id = ?')
    for (const f of fixes) up.run(f.path, f.id)
    db.prepare("UPDATE sync_meta SET value = '0' WHERE key = 'applying'").run()
  })()
  return fixes.length
}

/** A pasted image's place on this computer, by its file name. */
export function attachmentPath(name: string): string | null {
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..' ? join(paths.attachments, name) : null
}

const ATTACHMENT = /studywise-file:\/\/attachments\/([\w.-]+)/g

/** Pasted images anything in the synced library refers to (cards, notes, topics…). */
export function referencedAttachments(db: SqlDb): string[] {
  const names = new Set<string>()
  for (const t of SYNC_TABLES) {
    const cols = (db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string; type: string }[]).filter((c) => !c.type || /TEXT/i.test(c.type)).map((c) => c.name)
    for (const c of cols) {
      const rows = db.prepare(`SELECT ${c} AS v FROM ${t.name} WHERE ${c} LIKE '%studywise-file://attachments/%'`).all() as { v: string }[]
      for (const r of rows) for (const m of String(r.v).matchAll(ATTACHMENT)) names.add(m[1])
    }
  }
  return [...names]
}
