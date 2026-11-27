// Asking for weeks nobody has made yet, and donating your AI usage to make
// them (the marketplace's requests and tasks, studywise-server lib/requests.js).
//
// - A request is a week of a course that isn't on the marketplace (made from
//   slides someone uploads, or from a week they planned but haven't written),
//   or the unwritten topics of a week that is. People who want the same week
//   vote for it.
// - Each day the marketplace can hand you one request as a task. Doing it
//   makes the week here with your own AI (plan, then write every topic) and
//   publishes it, which finishes the request for everyone.
// - When a week you asked or voted for is done, it's added to your library
//   the next time you sync with the cloud (deliverRequested).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { getDb } from '../db'
import { getSetting, setSetting } from '../db/repo'
import { addFiles, addWeek, createCourse, deleteWeek, getCourse, listCourses, planWeek, updateWeekFrom, writeTopic } from './course'
import { importWeek, weekZip } from './weekShare'
import { MarketError, contributeTo, copies, download, isWeekPrivate, json, linkedCourses, marketAuth, publish, recordAdded, request, send, test, updateFromMarket } from './market'
import type { JobContext } from '../jobs'
import { AUTO_REQUEST_SETTING, IMPORTED_WEEKS_SETTING, READING_WEEK, REQUESTS_DELIVERED_SETTING, TEACHING_WEEKS, WEEKS_PER_MODULE, requestTitle, sameCourse, weekNumber, type MarketTask, type MissingInfo, type MissingWeek, type SlidesWanted, type WeekRequest } from '@shared/market'

/** Which week here each task is being made in, so a task that stopped part way carries on: {taskId: weekId}. */
const TASK_WEEKS_SETTING = 'market.taskWeeks'
/** Your own weeks you asked for help with: {requestId: weekId}. The finished week goes into them. */
const ASKED_WEEKS_SETTING = 'market.askedWeeks'

const post = (body: unknown = {}) => json(body)

// ---------------------------------------------------------------------------
// Requests

export async function listRequests(courseId?: string): Promise<WeekRequest[]> {
  const qs = courseId ? `?courseId=${encodeURIComponent(courseId)}` : ''
  return (await request<{ requests: WeekRequest[] }>(`/api/requests${qs}`)).requests
}

/** Ask for a week of a course (a marketplace course, or one that isn't there yet), or vote for it if someone already has. */
export async function askForWeek(input: { courseId?: string; course?: { name: string; module?: string; level?: string }; number: number }): Promise<WeekRequest> {
  const why = weekNumberProblem(input.number)
  if (why) throw new Error(why)
  return (await request<{ request: WeekRequest }>('/api/requests', post({ kind: 'week', ...input }))).request
}

/** Ask for the rest of a published week to be written. */
export async function askToFinish(remoteWeekId: string): Promise<WeekRequest> {
  return (await request<{ request: WeekRequest }>('/api/requests', post({ kind: 'write', weekId: remoteWeekId }))).request
}

export async function vote(id: string, on: boolean): Promise<WeekRequest> {
  return (await request<{ request: WeekRequest }>(`/api/requests/${id}/vote`, post({ on }))).request
}

export async function removeRequest(id: string): Promise<void> {
  await request(`/api/requests/${id}`, { method: 'DELETE' })
  setSetting(ASKED_WEEKS_SETTING, Object.fromEntries(Object.entries(askedWeeks()).filter(([k]) => k !== id)))
}

/** Upload slides, transcripts or readings for a requested week. */
export async function addRequestFiles(id: string, files: string[]): Promise<WeekRequest> {
  let last: WeekRequest | null = null
  for (const f of files) {
    const r = await request<{ request: WeekRequest }>(`/api/requests/${id}/files?name=${encodeURIComponent(basename(f))}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(readFileSync(f)),
      timeoutMs: 10 * 60_000
    })
    last = r.request
  }
  if (!last) throw new Error('Pick some files first.')
  return last
}

export async function removeRequestFile(id: string, fileId: string): Promise<void> {
  await request(`/api/requests/${id}/files/${fileId}`, { method: 'DELETE' })
}

const weekNumberProblem = (n: number | null): string | null =>
  n === null || !Number.isInteger(n) || n < 1 || n > WEEKS_PER_MODULE
    ? `Modules have weeks 1 to ${WEEKS_PER_MODULE}, so the week needs a number in its name (like “Week 4”).`
    : n === READING_WEEK
      ? `Week ${READING_WEEK} is reading week, so there’s nothing to make.`
      : null

const askedWeeks = () => getSetting<Record<string, string>>(ASKED_WEEKS_SETTING, {})

/** One of your weeks someone else could make or finish for you. */
export interface AskableWeek {
  weekId: string
  courseId: string
  course: string
  label: string
  /** finish: some topics written (it's published, others write the rest). plan: planned, nothing written (the plan goes with the request). files: only files so far. */
  how: 'finish' | 'plan' | 'files'
  /** Topics and sections still to write (for a week with only files: none known yet). */
  topics: number
  sections: number
}

/** Your public weeks with something still to write, and a week number a module has. */
export function askableWeeks(): AskableWeek[] {
  const d = getDb()
  const weeks = d
    .prepare('SELECT w.id, w.label, c.id course_id, c.name FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.private = 0 AND c.private = 0 ORDER BY c.name COLLATE NOCASE, w.position')
    .all() as { id: string; label: string; course_id: string; name: string }[]
  const topicsOf = d.prepare('SELECT status, plan FROM topics WHERE week_id = ?')
  const filesOf = d.prepare('SELECT COUNT(*) n FROM course_files WHERE week_id = ?')
  const out: AskableWeek[] = []
  for (const w of weeks) {
    if (weekNumberProblem(weekNumber(w.label))) continue
    const topics = topicsOf.all(w.id) as { status: string; plan: string }[]
    const left = topics.filter((t) => t.status !== 'ready')
    const sections = left.reduce((n, t) => {
      try {
        return n + Math.max(1, (JSON.parse(t.plan) as { sections?: unknown[] }).sections?.length ?? 1)
      } catch {
        return n + 1
      }
    }, 0)
    const files = (filesOf.get(w.id) as { n: number }).n
    if (!topics.length && !files) continue
    if (topics.length && !left.length) continue
    const how = !topics.length ? 'files' : left.length < topics.length ? 'finish' : 'plan'
    out.push({ weekId: w.id, courseId: w.course_id, course: w.name, label: w.label, how, topics: left.length, sections })
  }
  return out
}

/**
 * Ask for help with one of your own weeks. Some topics written: it's published
 * and the rest is asked for. Planned with nothing written: the plan goes with
 * the request, so whoever makes it writes from your plan. Only files: they
 * go up with the request. When it's done, it comes back into this week.
 */
export async function askForMyWeek(weekId: string): Promise<WeekRequest> {
  if (isWeekPrivate(weekId)) throw new Error('This week is private, so nothing of it goes on the marketplace. Make it public first.')
  const w = askableWeeks().find((x) => x.weekId === weekId)
  if (!w) throw new Error('That week has nothing left to write, or no number a module has (weeks 1 to 12, not reading week).')
  if (w.how === 'finish') {
    const { week } = await publish(weekId)
    return askToFinish(week.id)
  }
  const c = getCourse(w.courseId)
  const r = await askForWeek({ course: { name: c.name, module: c.module, level: c.level }, number: weekNumber(w.label)! })
  if (w.how === 'plan') {
    const { bytes } = await weekZip(weekId)
    await request(`/api/requests/${r.id}/plan`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: new Uint8Array(bytes), timeoutMs: 10 * 60_000 })
  } else {
    const files = getDb().prepare('SELECT path FROM course_files WHERE week_id = ? ORDER BY position').all(weekId) as { path: string }[]
    await addRequestFiles(r.id, files.map((f) => f.path))
  }
  setSetting(ASKED_WEEKS_SETTING, { ...askedWeeks(), [r.id]: weekId })
  return (await listRequests()).find((x) => x.id === r.id) ?? r
}

// ---------------------------------------------------------------------------
// Tasks

/** Today's task (the marketplace hands one out if there's a week waiting), and whether you get tasks at all. */
export async function todayTask(): Promise<{ task: MarketTask | null; on: boolean }> {
  return request<{ task: MarketTask | null; on: boolean }>('/api/tasks/today')
}

export async function skipTask(id: string): Promise<MarketTask> {
  return (await request<{ task: MarketTask }>(`/api/tasks/${id}/skip`, post())).task
}

export async function setTasksOn(on: boolean): Promise<{ on: boolean }> {
  return request<{ on: boolean }>('/api/tasks/settings', post({ on }))
}

const taskWeeks = () => getSetting<Record<string, string>>(TASK_WEEKS_SETTING, {})
const weekExists = (id: string | undefined) => !!id && !!getDb().prepare('SELECT 1 FROM weeks WHERE id = ?').get(id)

/** The course of yours a request's week goes in: the one its marketplace course goes into, else one with the same name. */
async function courseFor(r: WeekRequest, { publicOnly }: { publicOnly: boolean }): Promise<string | null> {
  const ok = (id: string) => {
    const c = getDb().prepare('SELECT private FROM courses WHERE id = ?').get(id) as { private: number } | undefined
    return !!c && !(publicOnly && c.private)
  }
  if (r.courseId) {
    const linked = (await linkedCourses([r.courseId]).catch(() => ({}) as Record<string, string>))[r.courseId]
    if (linked && ok(linked)) return linked
  }
  const same = listCourses().find((c) => ok(c.id) && sameCourse({ name: c.name, module: c.module }, { name: r.course, module: r.module }))
  return same?.id ?? null
}

/** A week of that course with this number: [one with topics, a blank one]. */
function weekNumbered(courseId: string, n: number | null): { full: string | null; blank: string | null } {
  if (n === null) return { full: null, blank: null }
  const ws = getCourse(courseId).weeks.filter((w) => weekNumber(w.label) === n)
  return { full: ws.find((w) => w.topics.length)?.id ?? null, blank: ws.find((w) => !w.topics.length)?.id ?? null }
}

/** A progress bar for one part of a longer job. */
function part(ctx: JobContext, from: number, to: number): JobContext {
  const live = ctx.live
  return { ...ctx, live: live && ((u) => live(u.percent == null ? u : { ...u, percent: from + (to - from) * u.percent })) }
}

/** Bring the request's material here: the week to make it in. */
async function prepareWeek(r: WeekRequest, ctx: JobContext): Promise<string> {
  if (r.kind === 'write') {
    // You have that week already: write the rest in your copy.
    const have = copies()[r.weekId!]
    if (have) return have.weekId
    ctx.progress(`Downloading ${r.label} of ${r.course}`)
    const file = await download(r.weekId!)
    try {
      const courseId = await courseFor(r, { publicOnly: false })
      const imp = await importWeek(file, courseId ? { courseId } : { newCourse: true })
      recordAdded(r.weekId!, imp.weekId, false, r.courseId ?? undefined)
      return imp.weekId
    } finally {
      rmSync(file, { force: true })
    }
  }
  // A week: in a course of yours that can go on the marketplace (or a new one).
  const courseId = (await courseFor(r, { publicOnly: true })) ?? createCourse({ name: r.course, level: r.level }).id
  const at = weekNumbered(courseId, r.number)
  // Made here already, just never published.
  if (at.full) return at.full
  const dir = mkdtempSync(join(tmpdir(), 'studywise-request-'))
  try {
    if (r.plan) {
      ctx.progress('Downloading the plan for it')
      const res = await send(`/api/requests/${r.id}/plan`, { timeoutMs: 10 * 60_000 })
      const file = join(dir, 'plan.studyweek')
      writeFileSync(file, Buffer.from(await res.arrayBuffer()))
      const imp = await importWeek(file, at.blank ? { weekId: at.blank } : { courseId })
      // Your writing, from their plan: it's yours to publish.
      setSetting(IMPORTED_WEEKS_SETTING, getSetting<string[]>(IMPORTED_WEEKS_SETTING, []).filter((id) => id !== imp.weekId))
      return imp.weekId
    }
    const weekId = at.blank ?? addWeek(courseId, r.label).id
    const paths: string[] = []
    for (const [i, f] of r.files.entries()) {
      ctx.progress(`Downloading ${f.name} (${i + 1} of ${r.files.length})`)
      ctx.live?.({ stage: `Downloading ${f.name}…`, percent: (0.04 * i) / r.files.length })
      const res = await send(`/api/requests/${r.id}/files/${f.id}`, { timeoutMs: 10 * 60_000 })
      const p = join(dir, f.name.replace(/[\\/]/g, '_'))
      writeFileSync(p, Buffer.from(await res.arrayBuffer()))
      paths.push(p)
    }
    if (!paths.length) throw new Error('Nobody has uploaded anything for this week yet.')
    await addFiles(weekId, paths)
    return weekId
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Do today's task (a job): bring the material here, plan the week if it isn't
 * planned, write every topic not written yet, and publish it. Running it again
 * after it stopped (a limit, the app closing) carries on where it got to.
 */
export async function runTask(taskId: string, ctx: JobContext): Promise<{ week: string; topics: number }> {
  const { task } = await todayTask()
  if (!task || task.id !== taskId) throw new Error('That isn’t today’s task any more.')
  if (task.status !== 'assigned' && task.status !== 'started')
    throw new Error(task.status === 'done' ? 'You’ve done this one. Thanks!' : task.status === 'beaten' ? 'Someone else made this week first.' : 'This task has finished.')
  const r = task.request
  if (!r) throw new Error('That request isn’t there any more.')
  await request(`/api/tasks/${taskId}/start`, post())
  ctx.meta({ marketTask: taskId })

  let weekId = taskWeeks()[taskId]
  if (!weekExists(weekId)) {
    weekId = await prepareWeek(r, ctx)
    setSetting(TASK_WEEKS_SETTING, { ...taskWeeks(), [taskId]: weekId })
  }
  const courseId = (getDb().prepare('SELECT course_id FROM weeks WHERE id = ?').get(weekId) as { course_id: string }).course_id
  ctx.meta({ weekId, courseId })
  const topics = () => getCourse(courseId).weeks.find((w) => w.id === weekId)!.topics

  if (!topics().length) {
    ctx.progress(`Planning ${r.label}`)
    await planWeek(weekId, part(ctx, 0.05, 0.2))
  }
  const left = topics().filter((t) => t.status !== 'ready')
  let sections = 0
  for (const [i, t] of left.entries()) {
    if (ctx.signal.aborted) throw new Error('Cancelled')
    ctx.progress(`Writing topic ${i + 1} of ${left.length}: ${t.plan.title}`)
    const r2 = await writeTopic(t.id, part(ctx, 0.2 + (0.7 * i) / left.length, 0.2 + (0.7 * (i + 1)) / left.length))
    sections += r2.sections
  }
  // What the writing used, per section (planning's share included), for the next estimate.
  ctx.meta({ sectionsWritten: sections })

  ctx.progress('Publishing it')
  ctx.live?.({ stage: 'Publishing it to the marketplace…', percent: 0.92 })
  if (r.kind === 'write') {
    await contributeTo(r.weekId!, weekId, part(ctx, 0.92, 0.99))
    await request(`/api/tasks/${taskId}/done`, post())
  } else {
    const { week } = await publish(weekId, part(ctx, 0.92, 0.99))
    await request(`/api/tasks/${taskId}/done`, post({ weekId: week.id }))
  }
  setSetting(TASK_WEEKS_SETTING, Object.fromEntries(Object.entries(taskWeeks()).filter(([k]) => k !== taskId)))
  ctx.progress(`Made ${requestTitle(r)} for ${r.votes === 1 ? 'the person' : `the ${r.votes} people`} who asked. Thanks!`)
  return { week: `${r.course} · ${r.label}`, topics: left.length }
}

// ---------------------------------------------------------------------------
// Weeks you asked for, added when they're done

/** Not more often than this (it runs after cloud syncs, which happen every minute). */
const DELIVERY_GAP_MS = 5 * 60_000
let lastDelivery = 0
let me: string | null = null

/**
 * Weeks you asked or voted for that are done now go into your library: into
 * the week of yours you asked for help with, your copy of a week that was
 * finished, a blank week with that number, or the course they go in. Each
 * only once (a week you delete isn't added again). Returns how many came in.
 */
export async function deliverRequested({ force = false } = {}): Promise<number> {
  if (!marketAuth()) return 0
  if (!force && Date.now() - lastDelivery < DELIVERY_GAP_MS) return 0
  lastDelivery = Date.now()
  me ??= (await test()).user
  const mine = (await request<{ requests: WeekRequest[] }>('/api/requests/mine')).requests
  let added = 0
  for (const r of mine) {
    if (r.status !== 'done' || !r.weekId) continue
    const delivered = getSetting<Record<string, string>>(REQUESTS_DELIVERED_SETTING, {})
    if (delivered[r.id] === r.weekId) continue
    const mark = () => setSetting(REQUESTS_DELIVERED_SETTING, { ...getSetting<Record<string, string>>(REQUESTS_DELIVERED_SETTING, {}), [r.id]: r.weekId! })
    try {
      // You made it: you have it.
      if (r.doneBy.includes(me) && r.kind === 'week') {
        mark()
        continue
      }
      const have = copies()[r.weekId]
      if (have) {
        // A week that was finished for you: your copy gets the new topics, your progress kept.
        if (r.kind === 'write') {
          await updateFromMarket(r.weekId, { mine: r.weekAuthor === me, marketCourseId: r.courseId ?? undefined })
          added++
        }
        mark()
        continue
      }
      if (await addRequested(r)) added++
      mark()
    } catch (e) {
      // Tried again at the next sync.
      console.warn(`Couldn’t add ${requestTitle(r)}: ${(e as Error).message}`)
    }
  }
  return added
}

async function addRequested(r: WeekRequest): Promise<boolean> {
  const file = await download(r.weekId!)
  try {
    // Your own week you asked for help with: the finished one goes into it, your progress kept.
    const asked = askedWeeks()[r.id]
    if (asked && weekExists(asked)) {
      const courseId = (getDb().prepare('SELECT course_id FROM weeks WHERE id = ?').get(asked) as { course_id: string }).course_id
      const fresh = await importWeek(file, { courseId })
      try {
        await updateWeekFrom(asked, fresh.weekId)
        recordAdded(r.weekId!, asked, false, r.courseId ?? undefined)
      } catch {
        // Too different to bring in: it stays as a week of its own.
        recordAdded(r.weekId!, fresh.weekId, false, r.courseId ?? undefined)
        return true
      } finally {
        setSetting(IMPORTED_WEEKS_SETTING, getSetting<string[]>(IMPORTED_WEEKS_SETTING, []).filter((id) => id !== fresh.weekId))
      }
      if (weekExists(fresh.weekId)) deleteWeek(fresh.weekId)
      return true
    }
    const courseId = await courseFor(r, { publicOnly: false })
    const blank = courseId ? weekNumbered(courseId, r.number).blank : null
    const imp = await importWeek(file, blank ? { weekId: blank } : courseId ? { courseId } : { newCourse: true })
    recordAdded(r.weekId!, imp.weekId, false, r.courseId ?? undefined)
    return true
  } finally {
    rmSync(file, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Your missing weeks: asked for automatically, and a prompt to add their slides

/** Weeks already asked for automatically (or found on the marketplace), so the server isn't asked again: {"courseId:number": requestId | "available:weekId:courseId"}. */
const AUTO_ASKED_SETTING = 'market.autoAsked'
const autoAsked = () => getSetting<Record<string, string>>(AUTO_ASKED_SETTING, {})
export const autoRequestOn = () => getSetting<boolean>(AUTO_REQUEST_SETTING, true) !== false

/** Not more often than this in the background (opening the marketplace always checks). */
const AUTO_GAP_MS = 30 * 60_000
let lastAuto = 0

/**
 * Teaching weeks of your public courses up to the latest one you have (a gap
 * like week 3 when you have 1, 2 and 4, or a week of yours with nothing
 * written), and which are asked for or on the marketplace already. With
 * automatic requests on, any not asked for yet are asked for now (your vote).
 */
export async function missingWeeks({ background = false } = {}): Promise<MissingInfo> {
  const auto = autoRequestOn()
  const empty: MissingInfo = { missing: [], slidesWanted: [], autoRequest: auto }
  if (!marketAuth()) return empty
  if (background && (!auto || Date.now() - lastAuto < AUTO_GAP_MS)) return empty
  lastAuto = Date.now()
  const d = getDb()
  const courses = (d.prepare('SELECT id, name, module, level FROM courses WHERE private = 0 ORDER BY name COLLATE NOCASE').all() as { id: string; name: string; module: string; level: string }[])
  const weeksOf = d.prepare('SELECT id, label FROM weeks WHERE course_id = ? AND private = 0')
  const writtenIn = d.prepare("SELECT COUNT(*) n FROM topics WHERE week_id = ? AND status = 'ready'")
  const filesIn = d.prepare('SELECT COUNT(*) n FROM course_files WHERE week_id = ?')
  const requests = await listRequests()
  const sameAs = (c: { name: string; module: string }, r: WeekRequest) => sameCourse({ name: c.name, module: c.module }, { name: r.course, module: r.module })
  const asked = autoAsked()
  const missing: MissingWeek[] = []
  const slidesWanted: SlidesWanted[] = []

  for (const c of courses) {
    const byNumber = new Map<number, { id: string; written: number; files: number }>()
    for (const w of weeksOf.all(c.id) as { id: string; label: string }[]) {
      const n = weekNumber(w.label)
      if (n === null || n < 1 || n > WEEKS_PER_MODULE) continue
      const info = { id: w.id, written: (writtenIn.get(w.id) as { n: number }).n, files: (filesIn.get(w.id) as { n: number }).n }
      const had = byNumber.get(n)
      // Two weeks with one number: the one with more written counts.
      if (!had || info.written > had.written) byNumber.set(n, info)
    }
    const latest = Math.max(0, ...byNumber.keys())
    for (const n of TEACHING_WEEKS.filter((x) => x <= latest)) {
      const mine = byNumber.get(n)
      if (mine?.written) continue
      const key = `${c.id}:${n}`
      let request = requests.find((r) => r.kind === 'week' && r.number === n && sameAs(c, r)) ?? null
      let available: MissingWeek['available'] = null
      const remembered = asked[key]
      if (remembered?.startsWith('available:')) {
        const [, weekId, courseId] = remembered.split(':')
        available = { weekId, courseId }
      }
      if (request?.status === 'done' && request.weekId && request.courseId) available = { weekId: request.weekId, courseId: request.courseId }
      if (!request && !available && auto && !remembered) {
        try {
          request = await askForWeek({ course: { name: c.name, module: c.module, level: c.level }, number: n })
          setSetting(AUTO_ASKED_SETTING, { ...autoAsked(), [key]: request.id })
        } catch (e) {
          // On the marketplace already: offered to add instead.
          const data = e instanceof MarketError && e.status === 409 ? e.data : null
          if (data && typeof data.weekId === 'string' && typeof data.courseId === 'string') {
            available = { weekId: data.weekId, courseId: data.courseId }
            setSetting(AUTO_ASKED_SETTING, { ...autoAsked(), [key]: `available:${data.weekId}:${data.courseId}` })
          } else console.warn(`Couldn’t ask for ${c.name} · Week ${n}: ${(e as Error).message}`)
        }
      }
      if (request?.status === 'done') request = null
      missing.push({ courseId: c.id, course: c.name, number: n, weekId: mine?.id ?? null, files: mine?.files ?? 0, request, available })
    }
    // Someone else's requests for this course that need slides: you may have them.
    for (const r of requests) {
      if (r.kind !== 'week' || r.status !== 'open' || r.ready || r.number === null || !sameAs(c, r)) continue
      if (missing.some((m) => m.request?.id === r.id)) continue
      const mine = byNumber.get(r.number)
      slidesWanted.push({ request: r, weekId: mine?.id ?? null, files: mine?.files ?? 0 })
    }
  }
  return { missing, slidesWanted, autoRequest: auto }
}

export function setAutoRequest(on: boolean): void {
  setSetting(AUTO_REQUEST_SETTING, on)
  lastAuto = 0
}

/**
 * Send the slides in one of your weeks with a request (yours or someone
 * else's), so someone can make it. Without a request yet, the week is asked
 * for first.
 */
export async function shareSlides(input: { weekId: string; requestId?: string }): Promise<WeekRequest> {
  if (isWeekPrivate(input.weekId)) throw new Error('This week is private, so its files stay here. Make it public first.')
  const files = getDb().prepare('SELECT path FROM course_files WHERE week_id = ? ORDER BY position').all(input.weekId) as { path: string }[]
  if (!files.length) throw new Error('That week has no slides or transcripts in it yet.')
  let id = input.requestId
  if (!id) {
    const w = getDb().prepare('SELECT w.label, c.name, c.module, c.level FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.id = ?').get(input.weekId) as { label: string; name: string; module: string; level: string }
    id = (await askForWeek({ course: { name: w.name, module: w.module, level: w.level }, number: weekNumber(w.label)! })).id
  }
  return addRequestFiles(id, files.map((f) => f.path))
}

/** Ask for one of your missing weeks (when automatic requests are off) and send slides you picked with it. */
export async function askWithFiles(input: { courseId: string; number: number; files: string[] }): Promise<WeekRequest> {
  const c = getCourse(input.courseId)
  const r = await askForWeek({ course: { name: c.name, module: c.module, level: c.level }, number: input.number })
  return input.files.length ? addRequestFiles(r.id, input.files) : r
}
