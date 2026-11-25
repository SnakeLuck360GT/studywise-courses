import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let dir: string
let svc: typeof import('../../src/main/services/course')
let repo: typeof import('../../src/main/db/repo')
let order: typeof import('../../src/main/services/noteOrder')
let getDb: typeof import('../../src/main/db').getDb
let closeDb: () => void

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-noteorder-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  getDb = db.getDb
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  repo = await import('../../src/main/db/repo')
  svc = await import('../../src/main/services/course')
  order = await import('../../src/main/services/noteOrder')
})
afterAll(() => {
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

const ctx = () => ({ signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })
const titlesIn = (folderId: string | null) => repo.listNotes().filter((n) => n.folder_id === folderId).map((n) => n.title)

describe('notes in revision order', () => {
  it('reads week and lecture numbers', () => {
    expect(order.weekOf('3', 'anything')).toBe(3)
    expect(order.weekOf('Week 10', '')).toBe(10)
    expect(order.weekOf('', 'W4: Sorting')).toBe(4)
    expect(order.weekOf('', 'Sorting')).toBe(Number.POSITIVE_INFINITY)
    expect(order.lectureOf('Lecture 12 – Graphs')).toBe(12)
    expect(order.lectureOf('L3 recap')).toBe(3)
    expect(order.lectureOf('Graphs')).toBe(Number.POSITIVE_INFINITY)
  })

  it('puts a course’s topic notes in topic order as they’re written, whatever order you write them in (mock AI)', async () => {
    const course = svc.createCourse({ name: 'Ordered optics', level: 'first-year' })
    const w = svc.addWeek(course.id)
    await svc.addFiles(w.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(w.id, ctx())
    const [t1, t2, t3] = svc.listTopics(course.id)
    // Written last first.
    await svc.writeTopic(t3.id, ctx())
    await svc.writeTopic(t1.id, ctx())
    await svc.writeTopic(t2.id, ctx())
    const folder = repo.getNote(svc.getTopic(t1.id).note_id!).folder_id
    expect(titlesIn(folder)).toEqual([t1, t2, t3].map((t) => svc.getTopic(t.id).content!.title))
  }, 60_000)

  it('puts generated notes by week then lecture, keeps older notes after them until asked, then orders everything', () => {
    const folderId = repo.createFolder('Algorithms', 'note').id
    const make = (title: string, week = '', position: 'place' | 'old' = 'place') => {
      const n = repo.createNote({ title, week, folder_id: folderId })
      if (position === 'place') order.placeNote(n.id)
      return n
    }
    // Notes from before ordering existed: no position.
    make('Old: Week 2 recap', '2', 'old')
    make('Old: Lecture 1', '1', 'old')
    // New generations, made out of order.
    make('Lecture 3 – Heaps', '2')
    make('Lecture 1 – Big O', '1')
    make('Lecture 4 – Graphs', '2')
    make('Lecture 2 – Sorting', '1')
    make('Exam tips')
    expect(titlesIn(folderId).slice(0, 5)).toEqual(['Lecture 1 – Big O', 'Lecture 2 – Sorting', 'Lecture 3 – Heaps', 'Lecture 4 – Graphs', 'Exam tips'])
    // The older ones are still after the ordered ones.
    expect(titlesIn(folderId).slice(5).sort()).toEqual(['Old: Lecture 1', 'Old: Week 2 recap'])

    // Putting the folder in revision order includes them.
    expect(order.putInRevisionOrder(folderId)).toBe(7)
    expect(titlesIn(folderId)).toEqual(['Old: Lecture 1', 'Lecture 1 – Big O', 'Lecture 2 – Sorting', 'Lecture 3 – Heaps', 'Lecture 4 – Graphs', 'Old: Week 2 recap', 'Exam tips'])
    expect(repo.listNotes().filter((n) => n.folder_id === folderId).every((n) => n.position !== null)).toBe(true)
  })

  it('orders every folder at once, and a note made by hand keeps working', () => {
    const loose = repo.createNote({ title: 'Week 9 scribbles', week: '9' })
    expect(loose.position).toBeNull()
    order.putInRevisionOrder(null)
    expect((getDb().prepare('SELECT COUNT(*) n FROM notes WHERE position IS NULL').get() as { n: number }).n).toBe(0)
  })
})
