// This computer syncing with another computer (Settings → Devices → Link to
// another computer). The other computer turns on syncing and shows a one-time
// code, exactly as for a phone; this one pairs with it and then syncs both
// ways in the background: the library's rows through the change log (see
// ./engine), and the files they need (course files, pasted images) copied
// across so this computer has its own. No file to export or carry over.

import { hostname } from 'node:os'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getDb } from '../db'
import * as repo from '../db/repo'
import { getSecret, setSecret } from '../secrets'
import { SyncClient, SyncError, baseUrl, type HttpFn } from './client'
import { deviceId, ensureBackfill, getPeer, removePeer, syncWith, type SqlDb } from './engine'
import { attachmentPath, courseFileOnDisk, localizeCoursePaths, referencedAttachments } from './files'
import type { LinkStatus } from '@shared/types'

interface Linked {
  address: string
  peerId: string
  name: string
}

const LINK_KEY = 'link.computer'
const TOKEN_KEY = 'secret.link.token'
/** The server takes bodies up to 64 MB, and files go as base64. */
const MAX_UPLOAD = 45 * 1024 * 1024

const db = () => getDb() as unknown as SqlDb
const linked = () => repo.getSetting<Linked | null>(LINK_KEY, null)

/** fetch in the shape SyncClient wants. */
export const nodeHttp: HttpFn = async (req) => {
  const ctrl = new AbortController()
  const timer = req.timeoutMs ? setTimeout(() => ctrl.abort(), req.timeoutMs) : null
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as string | Uint8Array<ArrayBuffer> | undefined, signal: ctrl.signal })
    const buf = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, json: async () => JSON.parse(new TextDecoder().decode(buf)) as unknown, bytes: async () => buf }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

let state: LinkStatus['state'] = 'idle'
let lastError: string | null = null
let filesLeft = 0
/** Check the files on the first sync after starting (or linking), then whenever rows change. */
let filesDue = true
let running: Promise<LinkStatus> | null = null
let onStatus: (s: LinkStatus) => void = () => {}
let onReceived: (n: number) => void = () => {}

export function configureLink(opts: { onStatus: (s: LinkStatus) => void; onReceived: (n: number) => void }): void {
  onStatus = opts.onStatus
  onReceived = opts.onReceived
}

function client(): SyncClient | null {
  const l = linked()
  const token = getSecret(TOKEN_KEY)
  return l && token ? new SyncClient(baseUrl(l.address), nodeHttp, token) : null
}

export function linkStatus(): LinkStatus {
  const l = linked()
  const peer = l ? getPeer(db(), l.peerId) : undefined
  // Everything in my log the other computer hasn't been sent, except what came from it.
  const pending = l ? (db().prepare('SELECT COUNT(*) AS n FROM sync_log WHERE seq > ? AND origin != ?').get(peer?.sent_seq ?? 0, l.peerId) as { n: number }).n : 0
  return { linked: !!l, name: l?.name ?? null, address: l?.address ?? null, lastSync: peer?.last_sync ?? null, state, error: lastError, pending, filesLeft: l ? filesLeft : 0 }
}

const changed = () => onStatus(linkStatus())

export async function link(address: string, code: string): Promise<LinkStatus> {
  if (!address.trim()) throw new Error('Type the other computer’s address, shown in its Settings → Devices.')
  if (!/^\d{6}$/.test(code.trim())) throw new Error('The pairing code is the 6 digits shown on the other computer.')
  const c = new SyncClient(baseUrl(address), nodeHttp)
  const hello = await c.hello()
  if (hello.app !== 'studywise') throw new Error('That address isn’t Studywise.')
  const me = deviceId(db())
  if (hello.id === me) throw new Error('That’s this computer’s own address. Type the other computer’s address, shown in its Settings → Devices.')
  // Each pair of computers links one way only: if it's paired here, it already syncs with this one.
  if (getPeer(db(), hello.id)?.token_hash) throw new Error(`${hello.name} is already linked to this computer, so the two already sync.`)
  const r = await c.pair(code.trim(), me, hostname(), 'computer')
  const prev = linked()
  if (prev && prev.peerId !== r.desktopId) removePeer(db(), prev.peerId)
  setSecret(TOKEN_KEY, r.token)
  repo.setSetting(LINK_KEY, { address: c.base.replace(/^https?:\/\//, ''), peerId: r.desktopId, name: r.desktopName } satisfies Linked)
  lastError = null
  filesDue = true
  const s = await syncNow()
  if (s.error) throw new Error(s.error)
  return s
}

/** Stops syncing. Both computers keep everything they have. */
export function unlink(): LinkStatus {
  const l = linked()
  setSecret(TOKEN_KEY, null)
  repo.setSetting(LINK_KEY, null)
  if (l) removePeer(db(), l.peerId)
  lastError = null
  state = 'idle'
  filesLeft = 0
  changed()
  return linkStatus()
}

/** One sync (calls made while one runs share it). */
export function syncNow(): Promise<LinkStatus> {
  running ??= doSync().finally(() => (running = null))
  return running
}

async function doSync(): Promise<LinkStatus> {
  const l = linked()
  if (!l) return linkStatus()
  const c = client()
  if (!c) {
    lastError = 'This computer can’t read its saved link key (it may have been restored from a backup). Unlink and link again.'
    state = 'error'
    changed()
    return linkStatus()
  }
  state = 'syncing'
  changed()
  try {
    ensureBackfill(db())
    // relay: this computer's own phones' changes go on to the other computer too.
    const r = await syncWith(db(), l.peerId, c.transport(), { relay: true })
    if (r.received) localizeCoursePaths(db())
    lastError = null
    if (r.received) onReceived(r.received)
    if (filesDue || r.sent || r.received) filesDue = !(await syncFiles(c))
  } catch (e) {
    lastError =
      e instanceof SyncError && e.status === 401
        ? `${l.name} doesn’t recognise this computer any more. Unlink and link again.`
        : e instanceof SyncError && e.status === 0
          ? `Can’t reach ${l.name} at ${l.address}. Check it’s on, Studywise is open there with syncing turned on, and both computers are on the same network.`
          : (e as Error).message
  } finally {
    state = lastError ? 'error' : 'idle'
    changed()
  }
  return linkStatus()
}

async function syncFiles(c: SyncClient): Promise<boolean> {
  filesLeft = await copyFiles(c)
  return filesLeft === 0
}

/**
 * Copies the files the synced rows need: what's missing here comes from the
 * other side (another computer, or the cloud), then what it's missing goes to
 * it. Returns how many couldn't be copied this time.
 */
export async function copyFiles(c: SyncClient): Promise<number> {
  const d = db()
  const fileIds = (d.prepare('SELECT id FROM course_files').all() as { id: string }[]).map((r) => r.id)
  const images = referencedAttachments(d)
  let left = 0
  const save = (p: string, data: Uint8Array) => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, data)
  }

  for (const id of fileIds) {
    const p = courseFileOnDisk(d, id)
    if (!p || existsSync(p)) continue
    try {
      const data = await c.getCourseFile(id)
      if (data) save(p, data)
    } catch {
      left++
    }
  }
  for (const name of images) {
    const p = attachmentPath(name)
    if (!p || existsSync(p)) continue
    try {
      const data = await c.getFile(`studywise-file://attachments/${name}`)
      if (data) save(p, data)
    } catch {
      left++
    }
  }

  const here = (p: string | null): p is string => !!p && existsSync(p)
  const missing = await c.have(
    images.filter((n) => here(attachmentPath(n))),
    fileIds.filter((id) => here(courseFileOnDisk(d, id)))
  )
  for (const id of missing.courseFiles) {
    const p = courseFileOnDisk(d, id)
    if (!here(p)) continue
    if (statSync(p).size > MAX_UPLOAD) {
      console.warn(`[link] ${p} is too big to send (over 45 MB)`)
      continue
    }
    if (!(await c.putCourseFile(id, readFileSync(p)).catch(() => false))) left++
  }
  for (const name of missing.attachments) {
    const p = attachmentPath(name)
    if (!here(p)) continue
    if (!(await c.putFile(`studywise-file://attachments/${name}`, readFileSync(p)).catch(() => false))) left++
  }
  return left
}

let timer: ReturnType<typeof setInterval> | null = null

/** Syncs when the app starts, a few seconds after a change here, and at least every minute (every two while the other computer can't be reached). */
export function startLinkSync(): void {
  if (timer) return
  let last = Date.now()
  timer = setInterval(() => {
    if (!linked() || running) return
    const gap = Date.now() - last
    const due = state === 'error' ? gap > 120_000 : linkStatus().pending > 0 || gap > 60_000
    if (!due) return
    last = Date.now()
    void syncNow()
  }, 5_000)
  if (linked()) void syncNow()
}

export function stopLinkSync(): void {
  if (timer) clearInterval(timer)
  timer = null
}
