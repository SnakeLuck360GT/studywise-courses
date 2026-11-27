// Deadlines (from a spreadsheet you upload) and your own tasks to tick off,
// shown on Home instead of time studied when you choose (Settings → Home).

export interface Deadline {
  id: string
  /** "Design and Defence". */
  title: string
  /** "COMP23111", or "" when the name has no module code. */
  module: string
  /** The assessment's short code ("CW1", "Lab3"), or "". */
  code: string
  /** YYYY-MM-DD. */
  due: string
  /** Ticked off. */
  done: boolean
}

export interface StudyTask {
  id: string
  text: string
  done: boolean
  createdAt: string
  /** When it was ticked off. */
  doneAt: string | null
}

/** Settings (synced to your other devices): deadlines and tasks, a row per entry. */
export const DEADLINES_SETTING = 'home.deadlines'
export const TASKS_SETTING = 'home.tasks'
/** Settings: what the panel beside the cards-due count on Home shows. */
export const HOME_PANEL_SETTING = 'home.panel'
export type HomePanel = 'time' | 'deadlines'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`

/** "COMP23111-CW1-S-Design and Defence" → module COMP23111, code CW1, title "Design and Defence". */
export function splitName(name: string): { module: string; code: string; title: string } {
  const clean = name.replace(/\s+/g, ' ').trim()
  const m = clean.match(/^([A-Z]{2,6}\s?\d{3,6}[A-Z]?)\s*[-–:]\s*(.*)$/i)
  if (!m) return { module: '', code: '', title: clean }
  const module = m[1].replace(/\s/g, '').toUpperCase()
  // "CW1-S-Design and Defence": the code, a one-letter type (S summative, F formative), then the title.
  const rest = m[2].match(/^([A-Za-z]+\d+[A-Za-z]?)\s*-\s*(?:[A-Z]\s*-\s*)?(.+)$/)
  if (!rest) return { module, code: '', title: m[2] || clean }
  // As written: "BUGHUNT", "SLAM", "Lab1".
  return { module, code: rest[1], title: rest[2].trim() }
}

const dayNumber = (v: string) => (/^\d{1,2}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 31 ? Number(v) : null)

/** The month a header like "Welcome week Sep" or "Week 06 Nov" names, if any. */
const monthIn = (s: string) => {
  const m = s.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/)
  return m ? MONTHS.indexOf(m[1]) : null
}

/** Excel's day number for a date (1900 system): 45000 is 2023-03-15. */
function excelDate(n: number): string | null {
  if (!(n > 20000 && n < 80000)) return null
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000)
  return d.toISOString().slice(0, 10)
}

/** "2026-12-04", "04/12/2026", "4 Dec 2026", "Dec 4, 2026" → YYYY-MM-DD (days first, as written in the UK). */
function parseDate(v: string): string | null {
  const s = v.trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return excelDate(Number(s))
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return iso(+m[1], +m[2] - 1, +m[3])
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1])
  m = s.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i)
  if (m && monthIn(m[2]) !== null) return iso(+m[3], monthIn(m[2])!, +m[1])
  m = s.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i)
  if (m && monthIn(m[1]) !== null) return iso(+m[3], monthIn(m[1])!, +m[2])
  return null
}

/**
 * Deadlines from a sheet's cells (rows of text, as read). Two layouts:
 *
 * - A term calendar: a row of day numbers (one column per day, with week
 *   headers above naming the months), and a row per assessment with a mark
 *   (like "D") in the column of its deadline. The year comes from `today`:
 *   a calendar starting in the autumn is this academic year's.
 * - A table: a column of names and a column of dates.
 */
export function deadlinesFromRows(rows: string[][], today: string): Omit<Deadline, 'id' | 'done'>[] {
  const out: Omit<Deadline, 'id' | 'done'>[] = []
  const add = (name: string, due: string) => {
    const n = splitName(name)
    if (n.title) out.push({ ...n, due })
  }

  // The calendar: the row with the most day numbers.
  let dayRow = -1
  let best = 0
  rows.forEach((r, i) => {
    const n = r.filter((v) => dayNumber(v) !== null).length
    if (n > best) {
      best = n
      dayRow = i
    }
  })
  if (best >= 10) {
    const days = rows[dayRow]
    const headers = rows.slice(0, dayRow)
    const first = days.findIndex((v) => dayNumber(v) !== null)
    // The first month named in a header at or before the first day, else the month of that day this year.
    let month: number | null = null
    for (const h of headers) for (let c = 0; c <= first && month === null; c++) month = h[c] ? monthIn(h[c]) : null
    if (month === null) for (const h of headers) for (const v of h) if (month === null && v) month = monthIn(v)
    const [ty, tm] = today.split('-').map(Number)
    const startMonth = month ?? tm - 1
    // An autumn start before today's month (or in it): this academic year; otherwise last year's.
    let year = startMonth >= 7 && tm - 1 < 7 ? ty - 1 : ty
    let m = startMonth
    let last = 0
    const dateOf: (string | null)[] = days.map(() => null)
    for (let c = first; c < days.length; c++) {
      const d = dayNumber(days[c] ?? '')
      if (d === null) continue
      if (d < last) {
        m++
        if (m > 11) {
          m = 0
          year++
        }
      }
      last = d
      dateOf[c] = iso(year, m, d)
    }
    for (const r of rows.slice(dayRow + 1)) {
      const name = (r[0] ?? '').trim()
      if (!name) continue
      for (let c = first; c < r.length; c++) {
        const v = (r[c] ?? '').trim()
        // A mark (D, X, ✓…), not a count.
        if (v && !/^\d+$/.test(v) && dateOf[c]) add(name, dateOf[c]!)
      }
    }
    if (out.length) return dedupe(out)
  }

  // A table: the column with the most dates, and the text column beside it with the most names.
  const width = Math.max(0, ...rows.map((r) => r.length))
  let dateCol = -1
  best = 0
  for (let c = 0; c < width; c++) {
    const n = rows.filter((r) => parseDate(r[c] ?? '')).length
    if (n > best) {
      best = n
      dateCol = c
    }
  }
  if (dateCol < 0) return []
  let nameCol = -1
  best = 0
  for (let c = 0; c < width; c++) {
    if (c === dateCol) continue
    const n = rows.filter((r) => (r[c] ?? '').trim() && !parseDate(r[c] ?? '') && /[a-z]/i.test(r[c] ?? '')).length
    if (n > best) {
      best = n
      nameCol = c
    }
  }
  if (nameCol < 0) return []
  for (const r of rows) {
    const due = parseDate(r[dateCol] ?? '')
    if (due && (r[nameCol] ?? '').trim()) add(r[nameCol], due)
  }
  return dedupe(out)
}

const dedupe = (list: Omit<Deadline, 'id' | 'done'>[]) => {
  const seen = new Set<string>()
  return list.filter((d) => !seen.has(`${d.module}|${d.code}|${d.title}|${d.due}`) && seen.add(`${d.module}|${d.code}|${d.title}|${d.due}`)).sort((a, b) => a.due.localeCompare(b.due))
}

/** Whole days from `today` to `due` (both YYYY-MM-DD): 0 today, 1 tomorrow, negative past. */
export function daysUntil(due: string, today: string): number {
  return Math.round((Date.parse(`${due}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000)
}

/** "Today", "Tomorrow", "In 3 days", "In 2 weeks", "2 days ago". */
export function whenText(due: string, today: string): string {
  const n = daysUntil(due, today)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n === -1) return 'Yesterday'
  if (n < 0) return `${-n} days ago`
  if (n < 14) return `In ${n} days`
  return `In ${Math.round(n / 7)} weeks`
}
