// Talking to the course marketplace: a site (studywise-market) where people
// publish weeks they've generated, so others can add them instead of spending
// their own tokens. You give the app the site's address and an API key made
// on the site's account page; the key is kept encrypted, like the Ollama key.

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSetting, setSetting } from '../db/repo'
import { getSecret, setSecret } from '../secrets'
import { getDb } from '../db'
import { setCoursePrivate, setWeekPrivate, weekFingerprint } from './course'
import { weekContentHash, weekZip } from './weekShare'
import { startJob, type JobContext } from '../jobs'
import { AUTO_PUBLISH_SETTING, IMPORTED_WEEKS_SETTING, type MarketCourse, type MarketCourseFull, type MarketMatch, type MarketSort, type MarketStatus, type MarketWeek, type PublishableWeek } from '@shared/market'

const URL_SETTING = 'market.url'
const KEY_SETTING = 'secret.marketKey' as const
/** Which marketplace week each of your weeks was published as: {localWeekId: remoteWeekId}. */
const PUBLISHED_SETTING = 'market.published'
/** What each of your weeks had in it when it was last published (weekContentHash): {localWeekId: hash}. */
const PUBLISHED_HASH_SETTING = 'market.publishedHash'
const TIMEOUT_MS = 30_000
/** The "already made" check runs before planning, so it mustn't hold planning up for long. */
const SIMILAR_TIMEOUT_MS = 8_000

export function marketUrl(): string {
  return getSetting<string>(URL_SETTING, '').trim().replace(/\/+$/, '')
}

export function marketStatus(): MarketStatus {
  return { url: marketUrl(), hasKey: !!getSecret(KEY_SETTING) }
}

const isReady = () => !!marketUrl() && !!getSecret(KEY_SETTING)

/** https only, except a server on this computer while developing. */
export function cleanUrl(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('That isn’t a web address. It looks like https://courses.example.com')
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('The marketplace address has to start with https://')
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/** Save the address and key (a null key keeps the one you have), then check them. */
export async function configure(input: { url: string; key?: string | null }): Promise<{ user: string }> {
  setSetting(URL_SETTING, cleanUrl(input.url))
  if (input.key !== undefined && input.key !== null) setSecret(KEY_SETTING, input.key)
  return test()
}

export function disconnect(): void {
  setSecret(KEY_SETTING, null)
}

/** Who the key belongs to. */
export async function test(): Promise<{ user: string }> {
  const r = await request<{ user: { name: string } }>('/api/app/me')
  return { user: r.user.name }
}

class MarketError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

async function send(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const url = marketUrl()
  const key = getSecret(KEY_SETTING)
  if (!url) throw new MarketError('Add the marketplace’s address in Settings → Marketplace first.', 0)
  if (!key) throw new MarketError(`Make an API key on ${url} (Account → API keys) and paste it in Settings → Marketplace.`, 0)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${url}${path}`, { ...init, signal: ctrl.signal, headers: { ...init.headers, authorization: `Bearer ${key}`, 'user-agent': 'Studywise' } })
  } catch (e) {
    throw new MarketError(ctrl.signal.aborted ? 'The marketplace took too long to answer.' : `Couldn’t reach the marketplace at ${url}. ${(e as Error).message}`, 0)
  } finally {
    clearTimeout(timer)
  }
  if (res.ok) return res
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  if (res.status === 401) throw new MarketError(`The marketplace didn’t accept your API key. Make a new one on ${url} and paste it in Settings → Marketplace.`, 401)
  throw new MarketError(body?.error || `The marketplace answered ${res.status}.`, res.status)
}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  return (await (await send(path, init)).json()) as T
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export async function listCourses(input: { q?: string; sort?: MarketSort } = {}): Promise<MarketCourse[]> {
  const qs = new URLSearchParams()
  if (input.q?.trim()) qs.set('q', input.q.trim())
  if (input.sort) qs.set('sort', input.sort)
  return (await request<{ courses: MarketCourse[] }>(`/api/courses?${qs}`)).courses
}

export async function getCourse(id: string): Promise<MarketCourseFull> {
  return (await request<{ course: MarketCourseFull }>(`/api/courses/${encodeURIComponent(id)}`)).course
}

export async function mine(): Promise<(MarketWeek & { courseName: string })[]> {
  return (await request<{ weeks: (MarketWeek & { courseName: string })[] }>('/api/mine')).weeks
}

const published = () => getSetting<Record<string, string>>(PUBLISHED_SETTING, {})
const publishedHashes = () => getSetting<Record<string, string>>(PUBLISHED_HASH_SETTING, {})
function setPublishedHash(weekId: string, hash: string | null): void {
  const rest = Object.fromEntries(Object.entries(publishedHashes()).filter(([k]) => k !== weekId))
  setSetting(PUBLISHED_HASH_SETTING, hash ? { ...rest, [weekId]: hash } : rest)
}
/** Forget a remote week (taken down, or gone from the site): the local week isn't published any more. */
function forgetRemote(remoteWeekId: string): void {
  const on = published()
  setSetting(PUBLISHED_SETTING, Object.fromEntries(Object.entries(on).filter(([, v]) => v !== remoteWeekId)))
  for (const [local, remote] of Object.entries(on)) if (remote === remoteWeekId) setPublishedHash(local, null)
}

/** A week stays off the marketplace when it, or its course, is private. */
export function isWeekPrivate(weekId: string): boolean {
  const r = getDb().prepare('SELECT w.private wp, c.private cp FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.id = ?').get(weekId) as { wp: number; cp: number } | undefined
  return !!r && (!!r.wp || !!r.cp)
}

/** Why a private week can't be published: which of the two is private. */
function privateWhy(weekId: string): string {
  const r = getDb().prepare('SELECT c.private cp FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.id = ?').get(weekId) as { cp: number } | undefined
  return r?.cp
    ? 'This course is private, so its weeks stay off the marketplace. Make the course public (its ⋯ menu) to publish them.'
    : 'This week is private, so it stays off the marketplace. Make it public (its ⋯ menu) to publish it.'
}

/** Which of your weeks are on the marketplace: {localWeekId: remoteWeekId}. */
export const publishedWeeks = published

/**
 * Publish a week (its topics, cards, slides and transcripts). Publishing the
 * same week again replaces what you published before.
 */
export async function publish(weekId: string): Promise<{ week: MarketWeek; replaced: boolean }> {
  const written = getDb().prepare("SELECT COUNT(*) n FROM topics WHERE week_id = ? AND status = 'ready'").get(weekId) as { n: number }
  if (!written.n) throw new Error('Write at least one of this week’s topics before publishing it.')
  if (isWeekPrivate(weekId)) throw new Error(privateWhy(weekId))
  const hash = weekContentHash(weekId)
  const { bytes } = await weekZip(weekId)
  const before = published()[weekId]
  const post = (replace?: string) =>
    request<{ week: MarketWeek }>(`/api/weeks${replace ? `?replace=${encodeURIComponent(replace)}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: new Uint8Array(bytes),
      timeoutMs: 10 * 60_000
    })
  let r: { week: MarketWeek }
  let replaced = !!before
  try {
    r = await post(before)
  } catch (e) {
    // Deleted on the site since: publish it as new.
    if (!(before && e instanceof MarketError && e.status === 404)) throw e
    r = await post()
    replaced = false
  }
  setSetting(PUBLISHED_SETTING, { ...published(), [weekId]: r.week.id })
  setPublishedHash(weekId, hash)
  return { week: r.week, replaced }
}

/** Public weeks with at least one written topic, in course and week order: everything that can be published (or just one course's). */
export function publishableWeeks(courseId?: string): { weekId: string; course: string; label: string }[] {
  return getDb()
    .prepare(
      `SELECT w.id weekId, c.name course, w.label label FROM weeks w JOIN courses c ON c.id = w.course_id
       WHERE w.private = 0 AND c.private = 0
         AND EXISTS (SELECT 1 FROM topics t WHERE t.week_id = w.id AND t.status = 'ready') ${courseId ? 'AND c.id = ?' : ''}
       ORDER BY c.name COLLATE NOCASE, w.position`
    )
    .all(...(courseId ? [courseId] : [])) as { weekId: string; course: string; label: string }[]
}

/**
 * The server's summary of a week (what /api/mine shows), worked out from your
 * copy and compared: for weeks published before their content hash was kept.
 */
function sameAsPublished(weekId: string, remote: MarketWeek): boolean {
  const d = getDb()
  const label = (d.prepare('SELECT label FROM weeks WHERE id = ?').get(weekId) as { label: string }).label.replace(/\s+/g, ' ').trim()
  const topics = d.prepare("SELECT COUNT(*) n, COALESCE(SUM(status = 'ready'), 0) ready FROM topics WHERE week_id = ?").get(weekId) as { n: number; ready: number }
  const cards = d.prepare('SELECT COUNT(*) n FROM cards c JOIN weeks w ON w.deck_id = c.deck_id WHERE w.id = ?').get(weekId) as { n: number }
  const files = (d.prepare('SELECT name, path FROM course_files WHERE week_id = ? ORDER BY position').all(weekId) as { name: string; path: string }[]).map((f) => {
    let size = -1
    try {
      size = statSync(f.path).size
    } catch {
      /* missing: never the same */
    }
    return `${f.name}|${size}`
  })
  return (
    label === remote.label &&
    topics.n === remote.topicCount &&
    topics.ready === remote.writtenCount &&
    cards.n === remote.cardCount &&
    files.join('\n') === remote.files.map((f) => `${f.name}|${f.size}`).join('\n')
  )
}

/**
 * Every week that can be published (or one course's), and whether it needs
 * uploading: 'new' (not on the marketplace, or taken down there since),
 * 'changed' since you published it, or 'same' (up to date, so it's skipped).
 */
export async function publishPlan(courseId?: string): Promise<PublishableWeek[]> {
  const weeks = publishableWeeks(courseId)
  const on = published()
  if (!weeks.some((w) => on[w.weekId])) return weeks.map((w) => ({ ...w, state: 'new' as const }))
  // What's actually on the site now: a week taken down there needs publishing again.
  const remote = new Map((await mine()).map((w) => [w.id, w]))
  const hashes = publishedHashes()
  return weeks.map((w): PublishableWeek => {
    const r = on[w.weekId] ? remote.get(on[w.weekId]) : undefined
    if (!r) return { ...w, state: 'new' }
    const hash = weekContentHash(w.weekId)
    if (hashes[w.weekId]) return { ...w, state: hashes[w.weekId] === hash ? 'same' : 'changed' }
    // Published before hashes were kept: compare with what the site has, and remember it from now on.
    if (!sameAsPublished(w.weekId, r)) return { ...w, state: 'changed' }
    setPublishedHash(w.weekId, hash)
    return { ...w, state: 'same' }
  })
}

/** Publish several weeks one after another. One failing doesn't stop the rest. */
export async function publishMany(weeks: { weekId: string; course: string; label: string }[], ctx: JobContext): Promise<{ published: number; failed: string[] }> {
  const failed: string[] = []
  let published = 0
  for (const [i, w] of weeks.entries()) {
    if (ctx.signal.aborted) throw new Error('Cancelled')
    const name = `${w.course} · ${w.label}`
    ctx.progress(`Publishing ${i + 1} of ${weeks.length}: ${name}`)
    ctx.live?.({ stage: `Publishing ${name}…`, percent: i / weeks.length })
    try {
      await publish(w.weekId)
      published++
    } catch (e) {
      failed.push(`${name}: ${(e as Error).message}`)
    }
  }
  if (!published && failed.length) throw new Error(failed[0])
  ctx.progress(`Published ${published} week${published === 1 ? '' : 's'}${failed.length ? `; ${failed.length} didn’t go: ${failed.join('; ')}` : ''}`)
  return { published, failed }
}

export async function remove(remoteWeekId: string): Promise<void> {
  await request(`/api/weeks/${encodeURIComponent(remoteWeekId)}`, { method: 'DELETE' })
  forgetRemote(remoteWeekId)
}

/**
 * Take down whichever of these weeks are on the marketplace. Not connected, or
 * nothing published: nothing to do. One failing doesn't stop the rest.
 */
async function takeDown(weekIds: string[]): Promise<{ removed: number; failed: string[] }> {
  const on = published()
  const remote = weekIds.filter((w) => on[w]).map((w) => on[w])
  const failed: string[] = []
  let removed = 0
  if (!remote.length || !isReady()) return { removed, failed: remote.length ? ['Not connected to the marketplace'] : [] }
  for (const id of remote) {
    try {
      await remove(id)
      removed++
    } catch (e) {
      // Already gone from the site: just forget it.
      if (e instanceof MarketError && e.status === 404) {
        forgetRemote(id)
        removed++
      } else failed.push((e as Error).message)
    }
  }
  return { removed, failed }
}

export interface VisibilityResult {
  /** Weeks taken down from the marketplace because they're now private. */
  removed: number
  /** Why some couldn't be taken down (they're still on the marketplace). */
  failed: string[]
}

/** Make a week public or private. Going private takes it down if it's published. */
export async function setWeekVisibility(weekId: string, isPrivate: boolean): Promise<VisibilityResult> {
  setWeekPrivate(weekId, isPrivate)
  if (isPrivate) {
    clearTimeout(pending.get(weekId))
    pending.delete(weekId)
    return takeDown([weekId])
  }
  queueAutoPublish(weekId)
  return { removed: 0, failed: [] }
}

/** Make a course public or private. Going private takes down every week of it that's published. */
export async function setCourseVisibility(courseId: string, isPrivate: boolean): Promise<VisibilityResult> {
  setCoursePrivate(courseId, isPrivate)
  const weekIds = (getDb().prepare('SELECT id FROM weeks WHERE course_id = ?').all(courseId) as { id: string }[]).map((r) => r.id)
  if (isPrivate) {
    for (const w of weekIds) {
      clearTimeout(pending.get(w))
      pending.delete(w)
    }
    return takeDown(weekIds)
  }
  for (const w of weekIds) queueAutoPublish(w)
  return { removed: 0, failed: [] }
}

/**
 * You added one of your own published weeks back to your courses (say you'd
 * deleted it, or you're on another computer). It's your work, not someone
 * else's: it can be published automatically again, and publishing it updates
 * the copy that's already on the marketplace instead of adding a second one.
 * Unless the week it was published from is still here: then this is just a
 * copy, and that week stays the one linked to the marketplace. Returns
 * whether it was linked.
 */
export async function claimOwnWeek(weekId: string, remoteWeekId: string): Promise<boolean> {
  // Only a week that really is yours on the site.
  if (!(await mine()).some((w) => w.id === remoteWeekId)) return false
  const d = getDb()
  const on = published()
  const stillHere = Object.entries(on).some(([local, remote]) => remote === remoteWeekId && local !== weekId && d.prepare('SELECT 1 FROM weeks WHERE id = ?').get(local))
  if (stillHere) return false
  // Links from weeks that are gone go; this week takes over.
  for (const [local, remote] of Object.entries(on)) if (remote === remoteWeekId && local !== weekId) setPublishedHash(local, null)
  setSetting(PUBLISHED_SETTING, { ...Object.fromEntries(Object.entries(on).filter(([, remote]) => remote !== remoteWeekId)), [weekId]: remoteWeekId })
  // Just downloaded, so it's the same as what's on the marketplace.
  setPublishedHash(weekId, weekContentHash(weekId))
  setSetting(IMPORTED_WEEKS_SETTING, getSetting<string[]>(IMPORTED_WEEKS_SETTING, []).filter((w) => w !== weekId))
  return true
}

/** Download a published week to a temporary .studyweek file, to import like a shared week. */
export async function download(remoteWeekId: string): Promise<string> {
  const res = await send(`/api/weeks/${encodeURIComponent(remoteWeekId)}/file`, { timeoutMs: 10 * 60_000 })
  const dir = join(tmpdir(), 'studywise-market')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${remoteWeekId.replace(/[^\w-]/g, '')}.studyweek`)
  writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  return file
}

/**
 * Published weeks someone else already made of this week, before you spend
 * tokens on it: made from (nearly) the same material, or the same week number
 * of what looks like the same course. Never throws: no marketplace, no key,
 * or the site being down all just mean no warning.
 */
export async function similar(weekId: string): Promise<MarketMatch[]> {
  if (!isReady()) return []
  try {
    const fp = await weekFingerprint(weekId)
    const w = getDb().prepare('SELECT w.label, c.name, c.module FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.id = ?').get(weekId) as { label: string; name: string; module: string } | undefined
    if (!w) return []
    const own = published()[weekId]
    const r = await request<{ matches: MarketMatch[] }>('/api/similar', { ...json({ ...fp, course: w.name, module: w.module, week: w.label }), timeoutMs: SIMILAR_TIMEOUT_MS })
    // Only other people's weeks: your own published ones came from your courses already.
    return r.matches.filter((m) => m.week.id !== own && !m.week.mine)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Publishing automatically (Settings → Marketplace)

/** Wait this long after a topic finishes, so writing a whole week publishes it once. */
export const AUTO_PUBLISH_DELAY_MS = 20_000
const pending = new Map<string, ReturnType<typeof setTimeout>>()

export const autoPublishOn = () => getSetting<boolean>(AUTO_PUBLISH_SETTING, false) === true

/** Weeks waiting to be published automatically (for tests). */
export const pendingAutoPublish = () => [...pending.keys()]

/**
 * A topic in this week finished writing (or failed): publish the week once
 * its other topics are done. Weeks with someone else's work in them never go
 * automatically.
 */
export function queueAutoPublish(weekId: string): void {
  if (!autoPublishOn() || !isReady()) return
  if (getSetting<string[]>(IMPORTED_WEEKS_SETTING, []).includes(weekId)) return
  if (isWeekPrivate(weekId)) return
  clearTimeout(pending.get(weekId))
  pending.set(
    weekId,
    setTimeout(() => {
      pending.delete(weekId)
      const d = getDb()
      // Still writing: the last topic to finish queues it again.
      if (d.prepare("SELECT 1 FROM topics WHERE week_id = ? AND status = 'writing'").get(weekId)) return
      if (!d.prepare("SELECT 1 FROM topics WHERE week_id = ? AND status = 'ready'").get(weekId)) return
      const w = d.prepare('SELECT w.label, c.name FROM weeks w JOIN courses c ON c.id = w.course_id WHERE w.id = ?').get(weekId) as { label: string; name: string } | undefined
      if (!w || !autoPublishOn() || !isReady() || isWeekPrivate(weekId)) return
      // Already published as it is now (say a topic failed to write): nothing to upload.
      if (published()[weekId] && publishedHashes()[weekId] === weekContentHash(weekId)) return
      startJob('other', `Publish ${w.name} · ${w.label}`, () => publish(weekId))
    }, AUTO_PUBLISH_DELAY_MS)
  )
}
