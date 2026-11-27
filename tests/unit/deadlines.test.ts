// Deadlines from a spreadsheet (a term calendar with a mark on each deadline's
// day, or a plain table), and tasks of your own (services/deadlines).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { daysUntil, deadlinesFromRows, splitName, whenText } from '@shared/deadlines'

// A term calendar like a school's: week headers naming months, a row of day numbers (weekdays), a row per assessment with D on its day.
const days = ['21', '22', '23', '24', '25', '28', '29', '30', '01', '02', '05', '06', '07', '08', '09']
const calendar = [
  ['', 'Welcome week Sep', '', '', '', '', 'Week 01 Oct', '', '', '', '', 'Week 02', '', '', '', ''],
  ['', ...days],
  ['Summative Coursework', '', '', '', '', '', '', '', '1', '', '', '', '', '', '', '2'],
  ['COMP23111-CW1-S-Design and Defence', '', '', '', '', '', '', '', '', 'D'],
  ['COMP24011-Lab3-S-SLAM', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'D'],
  ['', '', '', '', '', 'D']
]

describe('reading deadlines', () => {
  it('reads a term calendar: the day each D is in, months rolling over, this academic year', () => {
    const found = deadlinesFromRows(calendar, '2026-11-27')
    expect(found.map((d) => [d.due, d.module, d.code, d.title])).toEqual([
      ['2026-10-01', 'COMP23111', 'CW1', 'Design and Defence'],
      ['2026-10-09', 'COMP24011', 'Lab3', 'SLAM']
    ])
    // In the spring, a calendar that starts in September is last autumn's.
    expect(deadlinesFromRows(calendar, '2027-02-10')[0].due).toBe('2026-10-01')
  })

  it('reads a table of names and dates (dates written out, or as Excel stores them)', () => {
    const rows = [
      ['Assessment', 'Deadline'],
      ['COMP26020-LAB2-S-CPlusPlus', '30/11/2026'],
      ['Essay draft', '46370'],
      ['Group report', '2026-12-04']
    ]
    expect(deadlinesFromRows(rows, '2026-11-27').map((d) => [d.due, d.title])).toEqual([
      ['2026-11-30', 'CPlusPlus'],
      ['2026-12-04', 'Group report'],
      ['2026-12-14', 'Essay draft']
    ])
  })

  it('splits names into module, code and title, as written', () => {
    expect(splitName('COMP22111-Lab1-S-BUGHUNT')).toEqual({ module: 'COMP22111', code: 'Lab1', title: 'BUGHUNT' })
    expect(splitName('COMP23111-CT2-S-Class Test 2 NoSQL')).toEqual({ module: 'COMP23111', code: 'CT2', title: 'Class Test 2 NoSQL' })
    expect(splitName('Dissertation hand-in')).toEqual({ module: '', code: '', title: 'Dissertation hand-in' })
  })

  it('says how long until a deadline', () => {
    expect(daysUntil('2026-11-30', '2026-11-27')).toBe(3)
    expect(['2026-11-27', '2026-11-28', '2026-12-01', '2026-12-25'].map((d) => whenText(d, '2026-11-27'))).toEqual(['Today', 'Tomorrow', 'In 4 days', 'In 4 weeks'])
  })
})

describe('deadlines and tasks in the library', () => {
  let dir: string
  let closeDb: () => void
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sw-deadlines-'))
    process.env.STUDYWISE_DATA_DIR = dir
    const db = await import('../../src/main/db')
    closeDb = db.closeDb
    db.openDb(join(dir, 't.db'))
  })
  afterAll(() => {
    closeDb?.()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A minimal .xlsx with these rows (all text, shared strings). */
  async function xlsx(rows: string[][]): Promise<string> {
    const strings: string[] = []
    const col = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)))
    const sheet = rows
      .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v === '' ? '' : `<c r="${col(ci)}${ri + 1}" t="s"><v>${strings.push(v) - 1}</v></c>`)).join('')}</row>`)
      .join('')
    const zip = new JSZip()
    zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheet}</sheetData></worksheet>`)
    zip.file('xl/sharedStrings.xml', `<sst>${strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`)
    const file = join(dir, 'deadlines.xlsx')
    writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
    return file
  }

  it('imports a spreadsheet, keeps ticks when it is uploaded again, and keeps tasks', async () => {
    const d = await import('../../src/main/services/deadlines')
    const file = await xlsx(calendar)
    const r = await d.importDeadlines(file)
    expect(r.count).toBe(2)
    const first = d.listDeadlines().deadlines[0]
    d.setDeadlineDone(first.id, true)
    await d.importDeadlines(file)
    expect(d.listDeadlines().deadlines.map((x) => [x.title, x.done])).toEqual([
      ['Design and Defence', true],
      ['SLAM', false]
    ])
    const t = d.addTask('Revise SQL joins')
    d.addTask('Lab 3 report')
    d.setTaskDone(t.id, true)
    expect(d.listDeadlines().tasks.map((x) => [x.text, x.done])).toEqual([
      ['Lab 3 report', false],
      ['Revise SQL joins', true]
    ])
    expect(d.clearDoneTasks()).toBe(1)
    expect(d.listDeadlines().tasks.map((x) => x.text)).toEqual(['Lab 3 report'])
    await expect(d.importDeadlines(await xlsx([['Nothing here']]))).rejects.toThrow(/No deadlines/)
  })
})
