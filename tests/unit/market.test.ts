import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { signature, similarity, words, SIGNATURE_SIZE } from '@shared/fingerprint'
import { authorsText, modelLabel, planAdd, sameCourse, weekNumber, weeksByWeek, type MarketWeek } from '@shared/market'

const lecture = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `In ${topic} the ${i}th idea builds on the one before it, and the lecture works an example through step by step.`).join(' ')

describe('week fingerprints', () => {
  it('is too unsure to say anything about very little text', () => {
    expect(signature(['Week 1 slides'])).toBeNull()
  })

  it('matches the same material, even reworded a little, and not a different lecture', () => {
    const a = signature([lecture('thermodynamics', 60)])!
    expect(a).toHaveLength(SIGNATURE_SIZE)
    // The same text read again, with page markers and different case: identical.
    expect(similarity(a, signature([`[page 1]\n${lecture('thermodynamics', 60).toUpperCase()}`])!)).toBe(1)
    // Split across two files.
    const half = lecture('thermodynamics', 60).split('. ')
    expect(similarity(a, signature([half.slice(0, 30).join('. '), half.slice(30).join('. ')])!)).toBeGreaterThan(0.85)
    // A few lines changed.
    expect(similarity(a, signature([lecture('thermodynamics', 60) + ' ' + lecture('entropy', 6)])!)).toBeGreaterThan(0.6)
    // A different lecture.
    expect(similarity(a, signature([lecture('electromagnetism', 60).replace(/idea/g, 'law')])!)).toBeLessThan(0.2)
  })

  it('ignores accents and punctuation', () => {
    expect(words('Café, naïve—résumé! [page 3] x')).toEqual(['cafe', 'naive', 'resume'])
  })

  it('names who published a course', () => {
    expect(authorsText(['alex'])).toBe('alex')
    expect(authorsText(['alex', 'sam'])).toBe('alex and sam')
    expect(authorsText(['alex', 'sam', 'kim'])).toBe('alex, sam and kim')
    expect(authorsText(['alex', 'sam', 'kim', 'lee', 'pat'])).toBe('alex, sam and 3 others')
  })

  it('groups everyone’s version of the same week by the number in its label', () => {
    const w = (id: string, label: string, number: number, author: string, downloads = 0, updatedAt = '2026-01-01') => ({ id, label, number, author, downloads, updatedAt })
    const groups = weeksByWeek([
      w('a', 'Week 3', 3, 'alex', 1),
      w('b', 'Week 1', 1, 'alex'),
      // Sam skipped week 2, so their Week 3 is second in their course: still week 3.
      w('c', 'Week 3: Testing', 2, 'sam', 5),
      w('d', 'W3', 7, 'kim', 1, '2026-02-01'),
      w('e', 'Week 2', 2, 'kim'),
      w('f', 'Revision', 9, 'alex'),
      w('g', 'revision ', 4, 'sam')
    ])
    expect(groups.map((g) => g.title)).toEqual(['Week 1', 'Week 2', 'Week 3', 'Revision'])
    expect(groups.map((g) => g.versions.map((v) => v.id))).toEqual([['b'], ['e'], ['c', 'd', 'a'], ['f', 'g']])
    expect(groups.map((g) => g.people)).toEqual([1, 1, 3, 2])
    expect(weeksByWeek([])).toEqual([])
  })

  it('counts people, not versions', () => {
    const w = (id: string, author: string) => ({ id, label: 'Week 1', number: 1, author, downloads: 0, updatedAt: '2026-01-01' })
    expect(weeksByWeek([w('a', 'alex'), w('b', 'alex'), w('c', 'sam')])[0].people).toBe(2)
  })

  it('reads week numbers from labels', () => {
    expect(weekNumber('Week 9: Testing')).toBe(9)
    expect(weekNumber('W12')).toBe(12)
    expect(weekNumber('Intro')).toBeNull()
  })

  it('labels models', () => {
    expect(modelLabel({ model: 'opus', effort: 'high' })).toBe('opus · high')
    expect(modelLabel({ model: 'gpt-oss:120b', effort: null, provider: 'ollama' })).toBe('gpt-oss:120b (Ollama)')
  })
})

let dir: string
let svc: typeof import('../../src/main/services/course')
let share: typeof import('../../src/main/services/weekShare')
let getDb: typeof import('../../src/main/db').getDb
let closeDb: () => void

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-market-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  getDb = db.getDb
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  svc = await import('../../src/main/services/course')
  share = await import('../../src/main/services/weekShare')
})
afterAll(() => {
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

const ctx = () => ({ signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })
const PDF = resolve('tests/fixtures/photoelectric-lecture.pdf')

describe('publishing a week (mock AI)', () => {
  it('records the model and effort, puts them and a fingerprint in the shared week, and reuses identical slides when merging', async () => {
    const course = svc.createCourse({ name: 'Quantum 101', level: 'first-year physics' })
    const w1 = svc.addWeek(course.id)
    await svc.addFiles(w1.id, [PDF])
    await svc.planWeek(w1.id, ctx())
    const [t1] = svc.listTopics(course.id)
    await svc.writeTopic(t1.id, ctx())

    const week = getDb().prepare('SELECT planned_with FROM weeks WHERE id = ?').get(w1.id) as { planned_with: string }
    const planned = JSON.parse(week.planned_with)
    expect(planned.model).toBeTruthy()
    expect(planned.provider).toBe('claude')
    expect('effort' in planned).toBe(true)
    const topic = getDb().prepare('SELECT written_with FROM topics WHERE id = ?').get(t1.id) as { written_with: string }
    expect(JSON.parse(topic.written_with).standard.model).toBeTruthy()

    // The same fingerprint every time, and it matches the file's own.
    const fp = await svc.weekFingerprint(w1.id)
    expect(fp.hashes).toHaveLength(1)
    expect(fp.sig).toHaveLength(SIGNATURE_SIZE)

    const file = join(dir, 'w1.studyweek')
    await share.exportWeek(w1.id, file)
    const json = JSON.parse(await (await JSZip.loadAsync(readFileSync(file))).file('week.json')!.async('string'))
    expect(json.fingerprint).toEqual(fp)
    expect(json.week.planned_with).toBe(week.planned_with)
    expect(json.topics.find((t: { id: string }) => t.id === t1.id).written_with).toBe(topic.written_with)

    // Into a new course: who made it comes along.
    const r = await share.importWeek(file, { newCourse: true })
    const imported = getDb().prepare('SELECT planned_with FROM weeks WHERE id = ?').get(r.weekId) as { planned_with: string }
    expect(imported.planned_with).toBe(week.planned_with)

    // Into a week of yours that already has the same PDF: yours is used, not a copy.
    const mine = svc.createCourse({ name: 'My physics', level: '' })
    const w = svc.addWeek(mine.id)
    await svc.addFiles(w.id, [PDF])
    await share.importWeek(file, { weekId: w.id })
    const files = svc.getCourse(mine.id).weeks[0].files
    expect(files).toHaveLength(1)
    const merged = svc.listTopics(mine.id).filter((t) => t.status === 'ready')
    const figures = merged.flatMap((t) => t.content!.sections.map((s) => s.figure).filter(Boolean))
    for (const f of figures) expect(f!.fileId).toBe(files[0].id)
  })
})

describe('publishing automatically', () => {
  it('waits for the week’s topics, publishes once, and never touches weeks with someone else’s work', async () => {
    const market = await import('../../src/main/services/market')
    const repo = await import('../../src/main/db/repo')
    const { setSecret } = await import('../../src/main/secrets')
    const jobs = await import('../../src/main/jobs')
    const course = svc.createCourse({ name: 'Auto 101', level: '' })
    const w = svc.addWeek(course.id)
    await svc.addFiles(w.id, [PDF])
    await svc.planWeek(w.id, ctx())
    const [t1] = svc.listTopics(course.id)
    await svc.writeTopic(t1.id, ctx())

    // Off by default.
    market.queueAutoPublish(w.id)
    expect(market.pendingAutoPublish()).toEqual([])
    // On, but no marketplace connected: nothing.
    repo.setSetting('market.autoPublish', true)
    market.queueAutoPublish(w.id)
    expect(market.pendingAutoPublish()).toEqual([])

    // (Zipping needs real timers, so the shared week goes in first.)
    const file = join(dir, 'auto.studyweek')
    await share.exportWeek(w.id, file)
    const into = svc.addWeek(course.id, 'Week 2')
    await share.importWeek(file, { weekId: into.id })

    repo.setSetting('market.url', 'http://localhost:1')
    setSecret('secret.marketKey', 'swm_test')
    vi.useFakeTimers()
    try {
      // Several topics finishing: one publish, after the last.
      market.queueAutoPublish(w.id)
      market.queueAutoPublish(w.id)
      expect(market.pendingAutoPublish()).toEqual([w.id])
      // Another topic still writing when the wait is over: not yet.
      getDb().prepare("UPDATE topics SET status = 'writing' WHERE id != ? AND week_id = ?").run(t1.id, w.id)
      const before = jobs.listJobs().length
      vi.advanceTimersByTime(market.AUTO_PUBLISH_DELAY_MS)
      expect(market.pendingAutoPublish()).toEqual([])
      expect(jobs.listJobs().length).toBe(before)
      getDb().prepare("UPDATE topics SET status = 'planned' WHERE status = 'writing' AND week_id = ?").run(w.id)

      // A shared week merged in: it's someone else's work now, so never automatic.
      market.queueAutoPublish(into.id)
      expect(market.pendingAutoPublish()).toEqual([])
    } finally {
      vi.useRealTimers()
      repo.setSetting('market.autoPublish', false)
      setSecret('secret.marketKey', null)
    }
  })
})

describe('public and private', () => {
  it('makes courses and weeks public unless you say otherwise, and a new week follows its course', () => {
    const pub = svc.createCourse({ name: 'Visible 101', level: '' })
    expect(pub.private).toBe(false)
    expect(svc.addWeek(pub.id).private).toBe(false)
    expect(svc.addWeek(pub.id, 'Mine only', { private: true }).private).toBe(true)

    const priv = svc.createCourse({ name: 'Hidden 101', level: '', private: true })
    expect(priv.private).toBe(true)
    expect(svc.addWeek(priv.id).private).toBe(true)
    expect(svc.getCourse(priv.id).private).toBe(true)
    expect(svc.listCourses().find((c) => c.id === priv.id)?.private).toBe(true)
  })

  it('never publishes a private week, or any week of a private course, by hand, in bulk or automatically', async () => {
    const market = await import('../../src/main/services/market')
    const repo = await import('../../src/main/db/repo')
    const { setSecret } = await import('../../src/main/secrets')
    const course = svc.createCourse({ name: 'Private 101', level: '' })
    const w = svc.addWeek(course.id)
    await svc.addFiles(w.id, [PDF])
    await svc.planWeek(w.id, ctx())
    const [t1] = svc.listTopics(course.id)
    await svc.writeTopic(t1.id, ctx())
    const listed = () => market.publishableWeeks(course.id).map((x) => x.weekId)
    expect(listed()).toEqual([w.id])

    repo.setSetting('market.autoPublish', true)
    repo.setSetting('market.url', 'http://localhost:1')
    setSecret('secret.marketKey', 'swm_test')
    vi.useFakeTimers()
    try {
      // The week private.
      await market.setWeekVisibility(w.id, true)
      expect(market.isWeekPrivate(w.id)).toBe(true)
      expect(listed()).toEqual([])
      market.queueAutoPublish(w.id)
      expect(market.pendingAutoPublish()).toEqual([])
      await expect(market.publish(w.id)).rejects.toThrow(/week is private/)

      // Public again: with automatic publishing on, it's queued.
      await market.setWeekVisibility(w.id, false)
      expect(market.pendingAutoPublish()).toEqual([w.id])

      // The course private: the week is too, whatever it's set to, and the queued publish is dropped.
      await market.setCourseVisibility(course.id, true)
      expect(market.pendingAutoPublish()).toEqual([])
      expect(svc.getCourse(course.id).weeks[0].private).toBe(false)
      expect(market.isWeekPrivate(w.id)).toBe(true)
      expect(listed()).toEqual([])
      await expect(market.publish(w.id)).rejects.toThrow(/course is private/)

      await market.setCourseVisibility(course.id, false)
      expect(listed()).toEqual([w.id])
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      repo.setSetting('market.autoPublish', false)
      setSecret('secret.marketKey', null)
    }
  })

  it('takes a published week down when it goes private', async () => {
    const market = await import('../../src/main/services/market')
    const repo = await import('../../src/main/db/repo')
    const { setSecret } = await import('../../src/main/secrets')
    const course = svc.createCourse({ name: 'Takedown 101', level: '' })
    const w = svc.addWeek(course.id)
    repo.setSetting('market.published', { [w.id]: 'remote-1' })
    repo.setSetting('market.url', 'https://market.test')
    setSecret('secret.marketKey', 'swm_test')
    const calls: string[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    try {
      const r = await market.setCourseVisibility(course.id, true)
      expect(r).toEqual({ removed: 1, failed: [] })
      expect(calls).toEqual(['DELETE https://market.test/api/weeks/remote-1'])
      expect(market.publishedWeeks()[w.id]).toBeUndefined()
      // Nothing published any more: nothing to take down.
      expect(await market.setWeekVisibility(w.id, true)).toEqual({ removed: 0, failed: [] })
      expect(calls).toHaveLength(1)
    } finally {
      fetchMock.mockRestore()
      setSecret('secret.marketKey', null)
    }
  })

  it('publishing everything skips weeks already up to date, and only uploads new or changed ones', async () => {
    const market = await import('../../src/main/services/market')
    const repo = await import('../../src/main/db/repo')
    const { setSecret } = await import('../../src/main/secrets')
    const course = svc.createCourse({ name: 'Skip 101', level: '' })
    const w = svc.addWeek(course.id, 'Week 1')
    const now = new Date().toISOString()
    getDb()
      .prepare("INSERT INTO topics (id, course_id, week_id, key, position, plan, status, content, updated_at) VALUES (?, ?, ?, 't1', 0, '{}', 'ready', 'First version', ?)")
      .run(`topic-${w.id}`, course.id, w.id, now)
    repo.setSetting('market.url', 'https://market.test')
    setSecret('secret.marketKey', 'swm_test')
    // The site: what's published, as /api/mine shows it.
    let onSite: Record<string, unknown>[] = []
    const uploads: string[] = []
    const remoteWeek = (id: string) => ({ id, courseId: 'c', label: 'Week 1', number: 1, author: 'me', topics: [], topicCount: 1, writtenCount: 1, cardCount: 0, files: [], size: 1, plannedWith: null, writtenWith: [], downloads: 0, createdAt: now, updatedAt: now, mine: true, courseName: 'Skip 101' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url)
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (u.endsWith('/api/mine')) return ok({ weeks: onSite })
      if (u.includes('/api/weeks') && init?.method === 'POST') {
        uploads.push(u)
        onSite = [remoteWeek('remote-skip')]
        return ok({ week: remoteWeek('remote-skip') })
      }
      throw new Error(`unexpected ${u}`)
    })
    const state = async () => (await market.publishPlan(course.id)).map((x) => x.state)
    try {
      expect(await state()).toEqual(['new'])
      await market.publish(w.id)
      expect(uploads).toHaveLength(1)
      // Nothing changed: skipped.
      expect(await state()).toEqual(['same'])

      // Studying (progress, cards waking up, timestamps) isn't a change.
      getDb().prepare("UPDATE topics SET progress = '{\"read\":true}', updated_at = ? WHERE week_id = ?").run(new Date(Date.now() + 5000).toISOString(), w.id)
      expect(await state()).toEqual(['same'])

      // Editing the content is.
      getDb().prepare("UPDATE topics SET content = 'Second version' WHERE week_id = ?").run(w.id)
      expect(await state()).toEqual(['changed'])
      await market.publish(w.id)
      expect(await state()).toEqual(['same'])

      // Taken down on the site: publish it again.
      onSite = []
      expect(await state()).toEqual(['new'])
      onSite = [remoteWeek('remote-skip')]

      // Published before hashes were kept: compared with the site's summary, then remembered.
      repo.setSetting('market.publishedHash', {})
      expect(await state()).toEqual(['same'])
      expect(repo.getSetting<Record<string, string>>('market.publishedHash', {})[w.id]).toBeTruthy()
      repo.setSetting('market.publishedHash', {})
      onSite = [{ ...remoteWeek('remote-skip'), writtenCount: 0 }]
      expect(await state()).toEqual(['changed'])
      expect(uploads).toHaveLength(2)
    } finally {
      fetchMock.mockRestore()
      setSecret('secret.marketKey', null)
    }
  })

  it('leaves whether a week is private out of the shared file', async () => {
    const course = svc.createCourse({ name: 'Share 101', level: '' })
    const w = svc.addWeek(course.id, 'Week 1', { private: true })
    const { json } = await share.weekZip(w.id)
    expect('private' in JSON.parse(JSON.stringify(json.week))).toBe(false)
  })
})

describe('weeks added from the marketplace', () => {
  it('lists a course’s weeks by week number, whatever order they were added in', async () => {
    const { sortWeeks, weekNumber } = await import('@shared/course')
    expect(weekNumber('Week 3')).toBe(3)
    expect(weekNumber('W10 · Graphs')).toBe(10)
    expect(weekNumber('Lecture 4')).toBe(4)
    expect(weekNumber('Week 2 (2)')).toBe(2)
    expect(weekNumber('Reading week')).toBeNull()
    const ws = ['Week 1', 'Week 5', 'Reading week', 'Week 2', 'Week 10', 'Week 2 (2)'].map((label, position) => ({ label, position }))
    expect(sortWeeks(ws).map((w) => w.label)).toEqual(['Week 1', 'Week 2', 'Week 2 (2)', 'Week 5', 'Reading week', 'Week 10'])
    expect(sortWeeks(ws, 'desc').map((w) => w.label)).toEqual(['Week 10', 'Reading week', 'Week 5', 'Week 2 (2)', 'Week 2', 'Week 1'])

    // A course where week 5 was downloaded before week 2: shown in order, positions untouched.
    const src = svc.createCourse({ name: 'Order 101', level: '' })
    const w5 = svc.addWeek(src.id, 'Week 5')
    const w2 = svc.addWeek(src.id, 'Week 2')
    const f5 = join(dir, 'w5.studyweek')
    const f2 = join(dir, 'w2.studyweek')
    await share.exportWeek(w5.id, f5)
    await share.exportWeek(w2.id, f2)
    const mineCourse = svc.createCourse({ name: 'Order 101 (mine)', level: '' })
    svc.addWeek(mineCourse.id, 'Week 1')
    await share.importWeek(f5, { courseId: mineCourse.id })
    await share.importWeek(f2, { courseId: mineCourse.id })
    const c = svc.getCourse(mineCourse.id)
    expect(c.weeks.map((w) => w.label)).toEqual(['Week 1', 'Week 2', 'Week 5'])
    expect(c.weeks.map((w) => w.position)).toEqual([0, 2, 1])
  })

  it('remembers what you added, so adding it again can ask; your own is linked to what you published', async () => {
    const market = await import('../../src/main/services/market')
    const repo = await import('../../src/main/db/repo')
    const course = svc.createCourse({ name: 'Copies 101', level: '' })
    const src = svc.addWeek(course.id, 'Week 1')
    const file = join(dir, 'copies.studyweek')
    await share.exportWeek(src.id, file)
    expect(market.copies()['remote-1']).toBeUndefined()

    // Someone else's week: remembered, still never published automatically.
    const a = await share.importWeek(file, { courseId: course.id })
    market.recordAdded('remote-1', a.weekId, false)
    expect(market.copies()['remote-1']).toMatchObject({ weekId: a.weekId, courseId: course.id, course: 'Copies 101', week: 'Week 1 (2)', how: 'added' })
    expect(repo.getSetting<string[]>('market.importedWeeks', [])).toContain(a.weekId)
    expect(market.publishedWeeks()[a.weekId]).toBeUndefined()

    // Your own week, published from another device: linked, so publishing from here replaces it.
    const b = await share.importWeek(file, { courseId: course.id })
    market.recordAdded('remote-2', b.weekId, true)
    expect(market.publishedWeeks()[b.weekId]).toBe('remote-2')
    expect(repo.getSetting<string[]>('market.importedWeeks', [])).not.toContain(b.weekId)
    expect(market.copies()['remote-2']).toMatchObject({ weekId: b.weekId, how: 'added' })

    // Published from here: counts as having it.
    repo.setSetting('market.published', { ...market.publishedWeeks(), [src.id]: 'remote-3' })
    expect(market.copies()['remote-3']).toMatchObject({ weekId: src.id, how: 'published', at: null })

    // Deleted since: you don't have it any more.
    svc.deleteWeek(a.weekId)
    expect(market.copies()['remote-1']).toBeUndefined()
  })
})

describe('downloading a whole course', () => {
  const week = (id: string, label: string, more: Partial<MarketWeek> = {}): MarketWeek => ({
    id,
    courseId: 'mc',
    label,
    number: 1,
    author: 'alex',
    topics: [],
    topicCount: 3,
    writtenCount: 3,
    cardCount: 10,
    files: [],
    size: 1,
    plannedWith: null,
    writtenWith: [],
    downloads: 0,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    mine: false,
    ...more
  })
  const remote = [
    week('a1', 'Week 1'),
    week('b1', 'Week 1', { writtenCount: 5 }),
    week('m2', 'Week 2', { mine: true, writtenCount: 1 }),
    week('o2', 'Week 2', { writtenCount: 6 }),
    week('a3', 'Week 3'),
    week('a4', 'Week 4')
  ]
  const local = [
    { id: 'L1', label: 'Week 1', topics: 4 },
    { id: 'L3', label: 'Week 3', topics: 0 }
  ]

  it('adds one version of each week: yours, else the most written', () => {
    const p = planAdd(remote, [], {}, null, 'all')
    expect(p.items.map((i) => i.week.id)).toEqual(['b1', 'm2', 'a3', 'a4'])
    expect(p.items.every((i) => i.into === null)).toBe(true)
    expect(p.skipped).toBe(0)
  })

  it('with "missing", leaves out weeks your course has and fills its blank ones', () => {
    const p = planAdd(remote, local, {}, 'C', 'missing')
    expect(p.items.map((i) => [i.week.id, i.into?.id ?? null])).toEqual([
      ['m2', null],
      ['a3', 'L3'],
      ['a4', null]
    ])
    expect(p.skipped).toBe(1)
  })

  it('with "all", adds weeks your course has its own of, but never one already added to it', () => {
    const p = planAdd(remote, local, { a1: { courseId: 'C' }, a4: { courseId: 'other' } }, 'C', 'all')
    // Week 1: you added a1 to this course, so that's the one you have.
    expect(p.items.map((i) => i.week.id)).toEqual(['m2', 'a3', 'a4'])
    expect(p.skipped).toBe(1)
  })

  it('knows your course under a different name', () => {
    expect(sameCourse({ name: 'Software Engineering 1 (COMP23311)' }, { name: 'SE1', module: 'COMP23311' })).toBe(true)
    expect(sameCourse({ name: 'Databases (COMP23111)' }, { name: 'Algorithms (COMP26120)' })).toBe(false)
    expect(sameCourse({ name: 'Physics 101' }, { name: 'physics 101!' })).toBe(true)
    expect(sameCourse({ name: 'Software Engineering 1' }, { name: 'Software Engineering 2' })).toBe(false)
  })
})

describe('remembering where a marketplace course goes', () => {
  it('links the course to where you added its weeks, and forgets it when that course is deleted', async () => {
    const market = await import('../../src/main/services/market')
    const src = svc.createCourse({ name: 'Links 101', level: '' })
    const w = svc.addWeek(src.id, 'Week 1')
    const file = join(dir, 'links.studyweek')
    await share.exportWeek(w.id, file)
    const into = svc.createCourse({ name: 'My Links', level: '' })
    const a = await share.importWeek(file, { courseId: into.id })
    market.recordAdded('remote-link-1', a.weekId, false, 'market-course-1')
    expect(await market.linkedCourses(['market-course-1'])).toEqual({ 'market-course-1': into.id })
    // Added somewhere else later: that's where it goes now.
    const b = await share.importWeek(file, { newCourse: true })
    market.recordAdded('remote-link-2', b.weekId, false, 'market-course-1')
    expect(await market.linkedCourses(['market-course-1'])).toEqual({ 'market-course-1': b.courseId })
    svc.deleteCourse(b.courseId, false)
    expect((await market.linkedCourses(['market-course-1']))['market-course-1']).toBeUndefined()
  })
})

describe('downloading a course from a marketplace (fake server)', () => {
  it('plans, downloads and adds the missing weeks, fills a blank one, remembers them, and then has nothing missing', async () => {
    const http = await import('node:http')
    const market = await import('../../src/main/services/market')
    const repo = await import('../../src/main/db/repo')
    const { setSecret } = await import('../../src/main/secrets')

    // Their course: Week 1 (planned, with topics), Week 2 (yours, from another device), Week 3.
    const theirs = svc.createCourse({ name: 'Fake Server 101', level: '' })
    const t1 = svc.addWeek(theirs.id, 'Week 1')
    await svc.addFiles(t1.id, [PDF])
    await svc.planWeek(t1.id, ctx())
    const t2 = svc.addWeek(theirs.id, 'Week 2')
    const t3 = svc.addWeek(theirs.id, 'Week 3')
    const files: Record<string, Buffer> = {}
    for (const [rid, w] of [['r1', t1], ['r2', t2], ['r3', t3]] as const) {
      const f = join(dir, `${rid}.studyweek`)
      await share.exportWeek(w.id, f)
      files[rid] = readFileSync(f)
    }
    const mk = (id: string, label: string, mine = false) => ({
      id, courseId: 'mc-fake', label, number: 1, author: mine ? 'me' : 'alex', topics: [], topicCount: 3, writtenCount: 0, cardCount: 0,
      files: [], size: 1, plannedWith: null, writtenWith: [], downloads: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01', mine
    })
    const course = {
      id: 'mc-fake', name: 'Fake Server 101', module: '', level: '', authors: ['alex'], weekCount: 3, topicCount: 3, cardCount: 0, models: [],
      downloads: 0, updatedAt: '2026-01-01', mine: true,
      weeks: [mk('r1', 'Week 1'), mk('r2', 'Week 2', true), mk('r3', 'Week 3')]
    }
    const seen: string[] = []
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`)
      const file = req.url?.match(/^\/api\/weeks\/(\w+)\/file$/)?.[1]
      if (req.url === '/api/courses/mc-fake') return res.end(JSON.stringify({ course }))
      if (file && files[file]) return res.end(files[file])
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    repo.setSetting('market.url', `http://127.0.0.1:${port}`)
    setSecret('secret.marketKey', 'swm_fake')
    try {
      // Your course already has a blank Week 3.
      const mine = svc.createCourse({ name: 'Fake Server 101', level: '' })
      const blank3 = svc.addWeek(mine.id, 'Week 3')

      const [plan] = await market.planAdds([{ marketCourseId: 'mc-fake', courseId: mine.id }], 'missing')
      expect(plan.target).toBe('Fake Server 101')
      expect(plan.items.map((i) => [i.id, i.into?.id ?? null])).toEqual([
        ['r1', null],
        ['r2', null],
        ['r3', blank3.id]
      ])

      const progress: string[] = []
      const meta: Record<string, unknown>[] = []
      const r = await market.addPlanned([plan], { signal: new AbortController().signal, progress: (m) => progress.push(m), delta: () => {}, meta: (m) => meta.push(m) })
      expect(r).toEqual({ added: 3, failed: [] })
      expect(meta.at(-1)).toMatchObject({ marketAdded: 3, courseId: mine.id })
      expect(seen.every((s) => s.endsWith('Bearer swm_fake'))).toBe(true)

      // In week order, Week 3 filled rather than added again, Week 1's topics came through.
      const c = svc.getCourse(mine.id)
      expect(c.weeks.map((w) => w.label)).toEqual(['Week 1', 'Week 2', 'Week 3'])
      expect(c.weeks.find((w) => w.label === 'Week 3')!.id).toBe(blank3.id)
      expect(c.weeks.find((w) => w.label === 'Week 1')!.topics.length).toBeGreaterThan(0)

      // Remembered: what you have, where the course goes, and your own week linked to what you published.
      const have = market.copies()
      expect(['r1', 'r2', 'r3'].map((id) => have[id]?.courseId)).toEqual([mine.id, mine.id, mine.id])
      expect(await market.linkedCourses(['mc-fake'])).toEqual({ 'mc-fake': mine.id })
      expect(Object.values(market.publishedWeeks())).toContain('r2')

      // Nothing missing now, and "all" doesn't add copies of what you added either.
      for (const mode of ['missing', 'all'] as const) {
        const [again] = await market.planAdds([{ marketCourseId: 'mc-fake', courseId: mine.id }], mode)
        expect(again.items).toEqual([])
        expect(again.skipped).toBe(3)
      }

      // A week that won't download doesn't stop the rest.
      const other = svc.createCourse({ name: 'Elsewhere', level: '' })
      const broken = { ...plan, courseId: other.id, items: [{ ...plan.items[0], id: 'gone', into: null }, { ...plan.items[1], into: null }] }
      const r2 = await market.addPlanned([broken], { signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })
      expect(r2.added).toBe(1)
      expect(r2.failed[0]).toMatch(/Week 1: not found/)
    } finally {
      server.close()
      setSecret('secret.marketKey', null)
      repo.setSetting('market.url', '')
    }
  })
})
