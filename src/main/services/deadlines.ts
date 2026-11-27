// Deadlines from a spreadsheet you upload (.xlsx, or .csv), and your own
// tasks to tick off: Home shows the next deadline and your tasks (Settings →
// Home). Both sync to your other devices (synced settings, a row each).

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import JSZip from 'jszip'
import { getSetting, setSetting } from '../db/repo'
import { DEADLINES_SETTING, TASKS_SETTING, deadlinesFromRows, type Deadline, type StudyTask } from '@shared/deadlines'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&')

/** "AB" → 27 (A is 0). */
const columnIndex = (ref: string) => [...ref].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1

/** The first sheet of a workbook as rows of text (numbers as written, dates as Excel's day numbers). */
export async function xlsxRows(bytes: Buffer): Promise<string[][]> {
  const zip = await JSZip.loadAsync(bytes)
  const strings: string[] = []
  const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
  if (shared) for (const si of shared.match(/<si>[\s\S]*?<\/si>/g) ?? []) strings.push(unescape([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')))
  // The first sheet the workbook lists (usually sheet1.xml).
  const sheetName = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0]
  if (!sheetName) throw new Error('That spreadsheet has no sheets in it.')
  const xml = await zip.file(sheetName)!.async('string')
  const rows: string[][] = []
  for (const row of xml.match(/<row[\s>][\s\S]*?<\/row>/g) ?? []) {
    const r = Number(row.match(/<row[^>]*\br="(\d+)"/)?.[1] ?? rows.length + 1) - 1
    const cells: string[] = []
    for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = c.match(/\br="([A-Z]+)\d+"/)?.[1]
      if (!ref) continue
      const type = c.match(/\bt="(\w+)"/)?.[1]
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      const inline = [...c.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')
      cells[columnIndex(ref)] = type === 's' && v !== undefined ? (strings[Number(v)] ?? '') : type === 'inlineStr' ? unescape(inline) : unescape(v ?? '')
    }
    rows[r] = Array.from(cells, (x) => x ?? '')
  }
  return Array.from(rows, (x) => x ?? [])
}

/** A .csv as rows (quotes understood). */
function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') row.push(cell), (cell = '')
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

const deadlinesMap = () => getSetting<Record<string, Omit<Deadline, 'id'>>>(DEADLINES_SETTING, {})
const tasksMap = () => getSetting<Record<string, Omit<StudyTask, 'id'>>>(TASKS_SETTING, {})

export function listDeadlines(): { deadlines: Deadline[]; tasks: StudyTask[] } {
  const deadlines = Object.entries(deadlinesMap())
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title))
  const tasks = Object.entries(tasksMap())
    .map(([id, t]) => ({ id, ...t }))
    .sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt.localeCompare(b.createdAt))
  return { deadlines, tasks }
}

/**
 * Read deadlines from a spreadsheet; they replace the ones you had (a
 * deadline you'd ticked off stays ticked). Returns how many.
 */
export async function importDeadlines(file: string): Promise<{ count: number; next: Deadline | null }> {
  const ext = extname(file).toLowerCase()
  const bytes = readFileSync(file)
  const rows = ext === '.csv' ? csvRows(bytes.toString('utf8')) : await xlsxRows(bytes)
  const found = deadlinesFromRows(rows, today())
  if (!found.length) throw new Error('No deadlines found in that spreadsheet. It needs a name and a date for each, or a calendar with a mark (like D) on each deadline’s day.')
  const doneBefore = new Set(Object.values(deadlinesMap()).filter((d) => d.done).map((d) => `${d.module}|${d.code}|${d.title}`))
  const next: Record<string, Omit<Deadline, 'id'>> = {}
  for (const d of found) next[randomUUID()] = { ...d, done: doneBefore.has(`${d.module}|${d.code}|${d.title}`) }
  setSetting(DEADLINES_SETTING, next)
  const list = listDeadlines().deadlines
  return { count: list.length, next: list.find((d) => !d.done && d.due >= today()) ?? null }
}

export function setDeadlineDone(id: string, done: boolean): void {
  const all = deadlinesMap()
  if (all[id]) setSetting(DEADLINES_SETTING, { ...all, [id]: { ...all[id], done } })
}

export function clearDeadlines(): void {
  setSetting(DEADLINES_SETTING, {})
}

export function addTask(text: string): StudyTask {
  const id = randomUUID()
  const t: Omit<StudyTask, 'id'> = { text: text.trim(), done: false, createdAt: new Date().toISOString(), doneAt: null }
  setSetting(TASKS_SETTING, { ...tasksMap(), [id]: t })
  return { id, ...t }
}

export function setTaskDone(id: string, done: boolean): void {
  const all = tasksMap()
  if (all[id]) setSetting(TASKS_SETTING, { ...all, [id]: { ...all[id], done, doneAt: done ? new Date().toISOString() : null } })
}

export function removeTask(id: string): void {
  setSetting(TASKS_SETTING, Object.fromEntries(Object.entries(tasksMap()).filter(([k]) => k !== id)))
}

/** Ticked-off tasks go (the list stays short). */
export function clearDoneTasks(): number {
  const all = tasksMap()
  const keep = Object.fromEntries(Object.entries(all).filter(([, t]) => !t.done))
  setSetting(TASKS_SETTING, keep)
  return Object.keys(all).length - Object.keys(keep).length
}
