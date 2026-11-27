// Running out of limit while writing: the warning shows for a day, the level
// that failed is remembered, and opening the course fills in what's missing
// from someone's published copy of the week (marketFill). The marketplace is
// a small fake.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { showError, ERROR_SHOWN_MS } from '@shared/course'
import type { MarketMatch } from '@shared/market'

let dir: string
let server: Server
let closeDb: () => void
let svc: typeof import('../../src/main/services/course')
let getDb: typeof import('../../src/main/db').getDb
const PDF = resolve('tests/fixtures/photoelectric-lecture.pdf')
const ctx = (signal = new AbortController().signal) => ({ signal, progress: () => {}, delta: () => {}, meta: () => {} })

// The published copy the fake marketplace offers, and its bytes.
const offer = { matches: [] as MarketMatch[], file: null as Buffer | null }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-fill-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  getDb = db.getDb
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  svc = await import('../../src/main/services/course')
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url === '/api/similar') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ matches: offer.matches }))
      }
      if (req.url?.endsWith('/file') && offer.file) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return res.end(offer.file)
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"Not found"}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const repo = await import('../../src/main/db/repo')
  const { setSecret } = await import('../../src/main/secrets')
  repo.setSetting('market.url', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  setSecret('secret.marketKey', 'swm_test')
})
afterAll(() => {
  server?.close()
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('failure warnings', () => {
  it('show for a day after it failed, and not when the time is unknown', () => {
    const now = Date.parse('2026-11-27T12:00:00Z')
    expect(showError({ error: 'Limit reached', error_at: '2026-11-27T01:00:00Z' }, now)).toBe(true)
    expect(showError({ error: 'Limit reached', error_at: new Date(now - ERROR_SHOWN_MS - 1000).toISOString() }, now)).toBe(false)
    expect(showError({ error: 'Limit reached', error_at: null }, now)).toBe(false)
    expect(showError({ error: null, error_at: '2026-11-27T11:00:00Z' }, now)).toBe(false)
  })

  it('remember when writing failed and at which level, and clear when it’s written', async () => {
    const c = svc.createCourse({ name: 'Optics 1', level: '' })
    const w = svc.addWeek(c.id)
    await svc.addFiles(w.id, [PDF])
    await svc.planWeek(w.id, ctx())
    const [t] = svc.listTopics(c.id)
    const stop = new AbortController()
    stop.abort()
    await expect(svc.writeTopic(t.id, ctx(stop.signal), '', ['deep'])).rejects.toThrow()
    const failed = svc.getTopic(t.id)
    expect([failed.status, failed.error_level]).toEqual(['error', 'deep'])
    expect(showError(failed)).toBe(true)
    await svc.writeTopic(t.id, ctx(), '', ['deep'])
    const ok = svc.getTopic(t.id)
    expect([ok.status, ok.error, ok.error_at, ok.error_level]).toEqual(['ready', null, null, null])
  })
})

describe('filling failed topics from the marketplace (mock AI)', () => {
  it('takes only the level that failed, from a published copy of the week, and the warning goes', async () => {
    const share = await import('../../src/main/services/weekShare')
    const fill = await import('../../src/main/services/marketFill')
    const c = svc.createCourse({ name: 'Quantum 2', level: '' })

    // Someone's published copy: every topic written at standard and in-depth.
    const theirs = svc.addWeek(c.id, 'Week 1')
    await svc.addFiles(theirs.id, [PDF])
    await svc.planWeek(theirs.id, ctx())
    const theirTopics = svc.getCourse(c.id).weeks.find((x) => x.id === theirs.id)!.topics
    for (const t of theirTopics) await svc.writeTopic(t.id, ctx(), '', ['standard', 'deep'])
    const file = join(dir, 'theirs.studyweek')
    await share.exportWeek(theirs.id, file)
    offer.file = readFileSync(file)
    const published = svc.getCourse(c.id).weeks.find((x) => x.id === theirs.id)!.topics
    offer.matches = [
      {
        week: { id: 'abcdefabcdefabcd', courseId: 'c0ffeec0ffeec0ff', label: 'Week 1', number: 1, author: 'sam', topics: published.map((t) => ({ title: t.content!.title, goal: '', sections: t.plan.sections, levels: t.levels })), topicCount: published.length, writtenCount: published.length, cardCount: 0, files: [], size: 1, plannedWith: null, writtenWith: [], downloads: 0, createdAt: '', updatedAt: '', mine: false },
        course: { id: 'c0ffeec0ffeec0ff', name: 'Quantum 2' },
        score: 1,
        sameFiles: 1,
        sameWeek: true
      }
    ]
    svc.deleteWeek(theirs.id)

    // Yours ran out of limit: the first topic's in-depth notes, and the second topic altogether.
    const mine = svc.addWeek(c.id, 'Week 1')
    await svc.addFiles(mine.id, [PDF])
    await svc.planWeek(mine.id, ctx())
    const [a, b, ...rest] = svc.getCourse(c.id).weeks.find((x) => x.id === mine.id)!.topics
    expect(b).toBeTruthy()
    await svc.writeTopic(a.id, ctx())
    const limit = 'You’ve hit your limit · resets 3pm'
    getDb().prepare("UPDATE topics SET error = ?, error_level = 'deep', error_at = ? WHERE id = ?").run(limit, new Date().toISOString(), a.id)
    getDb().prepare("UPDATE topics SET status = 'error', error = ?, error_level = 'standard', error_at = ? WHERE id = ?").run(limit, new Date().toISOString(), b.id)
    const aBefore = svc.getTopic(a.id)

    const r = await fill.fillFailed(c.id)
    expect(r).toMatchObject({ weeks: 1, topics: 2 })
    const after = svc.getCourse(c.id)
    // Still one week: the downloaded copy went into yours and is gone.
    expect(after.weeks.map((x) => x.id)).toEqual([mine.id])
    const a2 = svc.getTopic(a.id)
    expect(a2.levels).toEqual(['standard', 'deep'])
    expect([a2.error, a2.status]).toEqual([null, 'ready'])
    // Your own standard notes untouched.
    expect(a2.content).toEqual(aBefore.content)
    const b2 = svc.getTopic(b.id)
    expect([b2.status, b2.error, b2.levels]).toEqual(['ready', null, ['standard']])
    // Topics that didn't fail aren't touched, and no extra topics came in.
    for (const t of rest) expect(svc.getTopic(t.id).status).toBe('planned')
    expect(after.weeks[0].topics.length).toBe(2 + rest.length)

    // Nothing left to fill: nothing happens.
    expect((await fill.fillFailed(c.id)).weeks).toBe(0)
  }, 60_000)

  it('fills a week whose planning failed with the whole published copy', async () => {
    const fill = await import('../../src/main/services/marketFill')
    const c = svc.createCourse({ name: 'Quantum 3', level: '' })
    const w = svc.addWeek(c.id, 'Week 1')
    await svc.addFiles(w.id, [PDF])
    getDb().prepare("UPDATE weeks SET status = 'error', error = 'Limit reached', error_at = ? WHERE id = ?").run(new Date().toISOString(), w.id)
    const r = await fill.fillFailed(c.id)
    expect(r.weeks).toBe(1)
    const week = svc.getCourse(c.id).weeks[0]
    expect([week.id, week.status, week.error]).toEqual([w.id, 'ready', null])
    expect(week.topics.length).toBeGreaterThan(0)
  }, 60_000)
})
