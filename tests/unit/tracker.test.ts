import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let svc: typeof import('../../src/main/services/course')
let repo: typeof import('../../src/main/db/repo')
let closeDb: () => void

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-tracker-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  db.openDb(join(dir, 't.db'))
  repo = await import('../../src/main/db/repo')
  svc = await import('../../src/main/services/course')
})
afterAll(() => {
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('tracker and review priority', () => {
  it('marks weeks, lists them in week order, and reviews priority weeks first', () => {
    const course = svc.createCourse({ name: 'Algorithms', level: 'second-year' })
    const w1 = svc.addWeek(course.id, 'Week 1')
    const w3 = svc.addWeek(course.id, 'Week 3')
    const w2 = svc.addWeek(course.id, 'Week 2')
    const deck = (id: string) => svc.ensureWeekDeck(id)
    repo.createCards([{ deck_id: deck(w1.id), front: 'w1 a', back: 'x' }])
    repo.createCards([{ deck_id: deck(w2.id), front: 'w2 a', back: 'x' }])
    repo.createCards([{ deck_id: deck(w3.id), front: 'w3 a', back: 'x' }, { deck_id: deck(w3.id), front: 'w3 b', back: 'x' }])
    const other = repo.createDeck({ name: 'Spanish' })
    repo.createCards([{ deck_id: other.id, front: 'hola', back: 'hello' }])

    // Nothing marked to start with.
    const fresh = svc.getCourse(course.id).weeks[0]
    expect(fresh).toMatchObject({ priority: false, learnt: false, revised: false, confidence: null })

    // Marking a week only changes what's given.
    svc.setWeekTrack(w2.id, { learnt: true, confidence: 4 })
    svc.setWeekTrack(w2.id, { revised: true })
    expect(svc.getCourse(course.id).weeks.find((w) => w.id === w2.id)).toMatchObject({ learnt: true, revised: true, confidence: 4, priority: false })
    svc.setWeekTrack(w2.id, { confidence: null })
    expect(svc.getCourse(course.id).weeks.find((w) => w.id === w2.id)?.confidence).toBeNull()
    expect(() => svc.setWeekTrack(w2.id, { confidence: 9 })).toThrow()

    // The tracker lists weeks in week-number order with their due counts, and the other decks apart.
    const t = svc.tracker()
    const c = t.courses.find((x) => x.id === course.id)!
    expect(c.weeks.map((w) => w.label)).toEqual(['Week 1', 'Week 2', 'Week 3'])
    expect(c.weeks.map((w) => w.due_count)).toEqual([1, 1, 2])
    expect(t.decks.map((d) => d.name)).toEqual(['Spanish'])

    // A priority week's cards come first: in the course's review and in a picked review.
    svc.setWeekTrack(w3.id, { priority: true })
    expect(svc.dueCards(course.id).slice(0, 2).map((x) => x.front).sort()).toEqual(['w3 a', 'w3 b'])
    const picked = svc.reviewCards([other.id, deck(w1.id), deck(w3.id)])
    expect(picked.map((x) => x.front)).toEqual(['w3 a', 'w3 b', 'hola', 'w1 a'])

    // A week with recall off has nothing to review, even when picked.
    svc.setWeekRecall(w1.id, false)
    expect(svc.reviewCards([deck(w1.id)])).toEqual([])
  })

  it('keeps tracker marks out of a shared week', async () => {
    const share = await import('../../src/main/services/weekShare')
    const course = svc.createCourse({ name: 'Databases', level: 'second-year' })
    const w = svc.addWeek(course.id, 'Week 1')
    const before = share.weekContentHash(w.id)
    svc.setWeekTrack(w.id, { priority: true, learnt: true, revised: true, confidence: 2 })
    // Marking a week isn't new content to publish.
    expect(share.weekContentHash(w.id)).toBe(before)
    const { json } = await share.weekZip(w.id)
    const sent = json.week as Record<string, unknown>
    for (const k of ['priority', 'learnt', 'revised', 'confidence']) expect(sent[k]).toBeUndefined()
  })
})
