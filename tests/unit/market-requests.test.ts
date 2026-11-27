// Requests and tasks (services/marketTasks): making a requested week from its
// slides with the (mock) AI and publishing it, adding a done request to the
// library, which weeks you can ask for help with, and learning what writing
// a section takes of the 5-hour limit. The marketplace is a small fake here;
// studywise-server's own tests cover the real one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { MarketTask, WeekRequest } from '@shared/market'

let dir: string
let server: Server
let closeDb: () => void
const PDF = resolve('tests/fixtures/photoelectric-lecture.pdf')

// What the fake marketplace knows, and what it was sent.
const state = {
  me: 'quin',
  task: null as MarketTask | null,
  mine: [] as WeekRequest[],
  published: null as Buffer | null,
  done: [] as { id: string; body: unknown }[]
}

const request = (over: Partial<WeekRequest> = {}): WeekRequest => ({
  id: 'a1b2c3d4e5f60718',
  kind: 'week',
  courseId: null,
  course: 'Thermo 201',
  module: '',
  level: 'second year',
  number: 3,
  label: 'Week 3',
  status: 'open',
  weekId: null,
  doneBy: [],
  weekAuthor: null,
  votes: 4,
  voted: false,
  mine: false,
  createdBy: 'pia',
  createdAt: '2026-11-27T09:00:00.000Z',
  files: [{ id: 'f0f0f0f0f0f0f0f0', name: 'lecture3.pdf', size: 1, by: 'pia', mine: false }],
  plan: null,
  ready: true,
  toWrite: null,
  inProgress: true,
  yours: true,
  canRemove: false,
  ...over
})

function fakeMarket(): Promise<string> {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const send = (data: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    const p = req.url!.split('?')[0]
    if (p === '/api/app/me') return send({ user: { name: state.me } })
    if (p === '/api/tasks/today') return send({ task: state.task, on: true })
    const t = p.match(/^\/api\/tasks\/(\w+)\/(start|done)$/)
    if (t && state.task) {
      state.task.status = t[2] === 'start' ? 'started' : 'done'
      if (t[2] === 'done') state.done.push({ id: t[1], body: JSON.parse(body.toString() || '{}') })
      return send({ task: state.task })
    }
    if (p.startsWith('/api/requests/a1b2c3d4e5f60718/files/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return res.end(readFileSync(PDF))
    }
    if (p === '/api/requests/mine') return send({ requests: state.mine })
    if (p === '/api/weeks' && req.method === 'POST') {
      state.published = body
      return send({ week: { id: 'feedfacefeedface', courseId: 'c0ffeec0ffeec0ff', label: 'Week 3', topics: [], files: [], writtenWith: [] } })
    }
    if (p === '/api/weeks/feedfacefeedface/file') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return res.end(state.published)
    }
    send({ error: 'Not found' }, 404)
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-requests-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  const repo = await import('../../src/main/db/repo')
  const { setSecret } = await import('../../src/main/secrets')
  repo.setSetting('market.url', await fakeMarket())
  setSecret('secret.marketKey', 'swm_test')
})
afterAll(() => {
  server?.close()
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('doing a task (mock AI)', () => {
  it('makes the requested week from its slides, writes every topic, publishes it and says it’s done', async () => {
    const tasks = await import('../../src/main/services/marketTasks')
    const course = await import('../../src/main/services/course')
    state.task = { id: 'task1', status: 'assigned', day: '2026-11-27', startedAt: null, request: request() }
    const meta: Record<string, unknown> = {}
    const r = await tasks.runTask('task1', { signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: (m) => Object.assign(meta, m) })

    // A new course with the request's name, and its week 3 written from the downloaded slides.
    const c = course.listCourses().find((x) => x.name === 'Thermo 201')!
    expect(c).toBeTruthy()
    const w = course.getCourse(c.id).weeks.find((x) => x.label === 'Week 3')!
    expect(w.files.map((f) => f.name)).toEqual(['lecture3.pdf'])
    expect(w.topics.length).toBeGreaterThan(0)
    expect(w.topics.every((t) => t.status === 'ready')).toBe(true)
    expect(r.topics).toBe(w.topics.length)
    expect(Number(meta.sectionsWritten)).toBeGreaterThan(0)

    // Published, and the marketplace told which week finishes the request.
    expect(state.published).toBeTruthy()
    expect(state.done).toEqual([{ id: 'task1', body: { weekId: 'feedfacefeedface' } }])

    // Not today's task any more: refused.
    state.task = null
    await expect(tasks.runTask('task1', { signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })).rejects.toThrow(/isn’t today’s task/)
  }, 60_000)

  it('adds a week you asked for once it’s done, only once', async () => {
    const tasks = await import('../../src/main/services/marketTasks')
    const course = await import('../../src/main/services/course')
    const repo = await import('../../src/main/db/repo')
    // Someone else's library: it asked, quin made it.
    state.me = 'pia'
    repo.setSetting('market.published', {})
    state.mine = [request({ status: 'done', weekId: 'feedfacefeedface', courseId: 'c0ffeec0ffeec0ff', doneBy: ['quin'], voted: true })]
    const before = course.listCourses().reduce((n, c) => n + c.week_count, 0)
    expect(await tasks.deliverRequested({ force: true })).toBe(1)
    expect(course.listCourses().reduce((n, c) => n + c.week_count, 0)).toBe(before + 1)
    expect(repo.getSetting<Record<string, string>>('market.requestsDelivered', {})).toEqual({ a1b2c3d4e5f60718: 'feedfacefeedface' })
    // Delivered: not again (even if you delete it), and not more often than every few minutes.
    expect(await tasks.deliverRequested({ force: true })).toBe(0)
    expect(await tasks.deliverRequested()).toBe(0)
  })

  it('lists the weeks you could ask for help with: planned, only files, or part written, not reading week', async () => {
    const tasks = await import('../../src/main/services/marketTasks')
    const course = await import('../../src/main/services/course')
    const ctx = () => ({ signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })
    const c = course.createCourse({ name: 'Optics 301', level: '' })
    const files = course.addWeek(c.id, 'Week 1')
    await course.addFiles(files.id, [PDF])
    const planned = course.addWeek(c.id, 'Week 2')
    await course.addFiles(planned.id, [PDF])
    await course.planWeek(planned.id, ctx())
    const reading = course.addWeek(c.id, 'Week 6')
    await course.addFiles(reading.id, [PDF])
    course.addWeek(c.id, 'Week 7')
    const priv = course.addWeek(c.id, 'Week 8', { private: true })
    await course.addFiles(priv.id, [PDF])
    const mine = tasks.askableWeeks().filter((w) => w.courseId === c.id)
    expect(mine.map((w) => [w.label, w.how])).toEqual([
      ['Week 1', 'files'],
      ['Week 2', 'plan']
    ])
    expect(mine[1].sections).toBeGreaterThan(0)
    await expect(tasks.askForMyWeek(priv.id)).rejects.toThrow(/private/)
  })
})

describe('what writing takes of the 5-hour limit', () => {
  it('guesses until a few topics are measured, then goes by their median', async () => {
    const { sectionRate } = await import('../../src/main/services/usageEstimate')
    expect(sectionRate([])).toEqual({ perSection: 0.01, measured: false })
    expect(sectionRate([0.02, 0.03])).toMatchObject({ measured: false })
    expect(sectionRate([0.02, 0.05, 0.03])).toEqual({ perSection: 0.03, measured: true })
  })

  it('learns from writing jobs measured on their own', async () => {
    const jobs = await import('../../src/main/jobs')
    const est = await import('../../src/main/services/usageEstimate')
    const listeners = new Set<(v: number) => void>()
    jobs.setUsageProbe({
      enabled: () => true,
      onReading: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      refresh: async () => 0.5
    })
    est.startUsageLearning()
    const before = est.sectionSamples().length
    try {
      jobs.startJob('course_topic', 'Topic: A', async (ctx) => {
        listeners.forEach((l) => l(0.42))
        ctx.meta({ sectionsWritten: 4 })
      })
      await new Promise((r) => setTimeout(r, 30))
      const s = est.sectionSamples()
      expect(s.length).toBe(before + 1)
      expect(s[s.length - 1]).toBeCloseTo(0.02)
    } finally {
      jobs.setUsageProbe(null)
    }
  })
})
