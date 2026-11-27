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
  onMarket: [] as number[],
  done: [] as { id: string; body: unknown }[],
  // Requests the fake marketplace has, how many times one was asked for, and files sent with them.
  requests: [] as WeekRequest[],
  asks: 0,
  uploads: [] as string[],
  /** Week numbers that are on the marketplace already. */
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
    if (p === '/api/requests' && req.method === 'GET') return send({ requests: state.requests })
    if (p === '/api/requests' && req.method === 'POST') {
      state.asks++
      const b = JSON.parse(body.toString()) as { number: number; course: { name: string } }
      if (state.onMarket.includes(b.number)) return send({ error: 'on the marketplace already', weekId: '1111222233334444', courseId: '5555666677778888' }, 409)
      const r = request({ id: `${'0'.repeat(15)}${state.requests.length + 1}`, course: b.course.name, number: b.number, label: `Week ${b.number}`, files: [], ready: false, votes: 1, voted: true, mine: true, inProgress: false, yours: false })
      state.requests.push(r)
      return send({ request: r })
    }
    const up = p.match(/^\/api\/requests\/(\w+)\/files$/)
    if (up && req.method === 'POST') {
      state.uploads.push(decodeURIComponent(req.url!.split('name=')[1]))
      return send({ request: state.requests.find((r) => r.id === up[1]) ?? request() })
    }
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

describe('publishing', () => {
  it('shows packing and uploading as a progress bar, and goes straight after writing when automatic', async () => {
    const market = await import('../../src/main/services/market')
    const course = await import('../../src/main/services/course')
    const repo = await import('../../src/main/db/repo')
    const jobs = await import('../../src/main/jobs')
    const c = course.listCourses().find((x) => x.name === 'Thermo 201')!
    const weekId = course.getCourse(c.id).weeks.find((w) => w.label === 'Week 3' && w.topics.some((t) => t.status === 'ready'))!.id
    state.published = null
    const stages: string[] = []
    const percents: number[] = []
    const meta: Record<string, unknown> = {}
    await market.publish(weekId, {
      signal: new AbortController().signal,
      progress: () => {},
      delta: () => {},
      meta: (m) => Object.assign(meta, m),
      live: (u) => {
        if (u.stage) stages.push(u.stage)
        if (typeof u.percent === 'number') percents.push(u.percent)
      }
    })
    expect(meta).toMatchObject({ weekId, publishing: true })
    expect(stages[0]).toMatch(/^Packing/)
    expect(stages.some((x) => /^Uploading .* of .*MB/.test(x))).toBe(true)
    expect(stages.at(-1)).toBe('Published')
    expect(percents.at(-1)).toBe(1)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    // The whole week went up, in pieces.
    expect(state.published!.length).toBeGreaterThan(100_000)

    // Automatic: published a moment after the last topic finishes, as a job with its progress.
    state.published = null
    repo.setSetting('market.publishedHash', {})
    repo.setSetting('market.autoPublish', true)
    try {
      market.queueAutoPublish(weekId)
      await new Promise((r) => setTimeout(r, market.AUTO_PUBLISH_DELAY_MS + 1500))
      expect(state.published).toBeTruthy()
      const job = jobs.listJobs().find((j) => j.meta?.publishing && j.meta?.weekId === weekId)!
      expect([job.status, job.percent]).toEqual(['done', 1])
    } finally {
      repo.setSetting('market.autoPublish', false)
    }
  }, 30_000)
})

describe('your missing weeks', () => {
  it('asks for gaps up to your latest week once, offers ones on the marketplace, and shares your slides', async () => {
    const tasks = await import('../../src/main/services/marketTasks')
    const course = await import('../../src/main/services/course')
    const { getDb } = await import('../../src/main/db')
    const written = (weekId: string, courseId: string) =>
      getDb()
        .prepare("INSERT INTO topics (id, course_id, week_id, key, position, plan, status, error, content, progress, updated_at) VALUES (?, ?, ?, 'w1t1', 0, '{}', 'ready', NULL, '{}', '{}', '')")
        .run(`t-${weekId}`, courseId, weekId)
    const c = course.createCourse({ name: 'Gaps 101', level: '' })
    written(course.addWeek(c.id, 'Week 1').id, c.id)
    const blank = course.addWeek(c.id, 'Week 2')
    await course.addFiles(blank.id, [PDF])
    written(course.addWeek(c.id, 'Week 4').id, c.id)
    state.onMarket = [3]
    state.requests = []
    state.asks = 0

    const info = await tasks.missingWeeks()
    const mine = info.missing.filter((m) => m.courseId === c.id)
    // Weeks 2 (blank, with your slides) and 3 (missing); not 5 onwards (you haven't got there), never 6.
    expect(mine.map((m) => [m.number, m.files, !!m.request, m.available?.weekId ?? null])).toEqual([
      [2, 1, true, null],
      [3, 0, false, '1111222233334444']
    ])
    const asks = state.asks
    // Asked once: not again next time.
    await tasks.missingWeeks()
    expect(state.asks).toBe(asks)

    // Your slides go with the request.
    await tasks.shareSlides({ weekId: blank.id, requestId: mine[0].request!.id })
    expect(state.uploads).toEqual(['photoelectric-lecture.pdf'])

    // Turned off: a new gap isn't asked for, just listed.
    tasks.setAutoRequest(false)
    const d = course.createCourse({ name: 'Gaps 202', level: '' })
    written(course.addWeek(d.id, 'Week 2').id, d.id)
    const off = await tasks.missingWeeks()
    expect(off.autoRequest).toBe(false)
    expect(off.missing.filter((m) => m.courseId === d.id).map((m) => [m.number, m.request])).toEqual([[1, null]])
    expect(state.asks).toBe(asks)
    tasks.setAutoRequest(true)
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
