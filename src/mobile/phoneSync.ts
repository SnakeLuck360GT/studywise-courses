// The phone's side of syncing: pairing, syncing in the background, following
// the computer's events (streamed AI text, job progress), forwarding requests
// that need the computer, and keeping a copy of images for offline use.

import type { PhoneSyncStatus } from '@shared/mobile'
import * as repo from '../main/db/repo'
import { getDb } from '../main/db'
import { onWrite, saveNow } from './db'
import { SyncClient, SyncError, baseUrl } from '../main/sync/client'
import { deviceId, ensureBackfill, getPeer, removePeer, syncWith, type SqlDb } from '../main/sync/engine'
import { http } from './http'
import { idb } from './idb'

interface Desktop {
  address: string
  desktopId: string
  desktopName: string
}

const db = () => getDb() as unknown as SqlDb
const TOKEN_KEY = 'secret.phone.token'
const DESKTOP_KEY = 'phone.desktop'
const UPLOADS_KEY = 'uploads'

let client: SyncClient | null = null
let state: PhoneSyncStatus['state'] = 'idle'
let online = false
let lastError: string | null = null
let running: Promise<PhoneSyncStatus> | null = null
const statusListeners = new Set<(s: PhoneSyncStatus) => void>()
let emitEvent: (ev: unknown) => void = () => {}

const desktop = () => repo.getSetting<Desktop | null>(DESKTOP_KEY, null)

function makeClient(): SyncClient | null {
  const d = desktop()
  const token = repo.getSetting<string | null>(TOKEN_KEY, null)
  if (!d || !token) return null
  if (!client || client.base !== baseUrl(d.address)) client = new SyncClient(baseUrl(d.address), http, token)
  return client
}

export function status(): PhoneSyncStatus {
  const d = desktop()
  let pending = 0
  if (d) {
    const peer = getPeer(db(), d.desktopId)
    pending = (db().prepare('SELECT COUNT(*) AS n FROM sync_log WHERE seq > ? AND origin = ?').get(peer?.sent_seq ?? 0, deviceId(db())) as { n: number }).n
  }
  return {
    paired: !!d && !!repo.getSetting<string | null>(TOKEN_KEY, null),
    desktopName: d?.desktopName ?? null,
    address: d?.address ?? null,
    lastSync: d ? (getPeer(db(), d.desktopId)?.last_sync ?? null) : null,
    state,
    online,
    error: lastError,
    pending
  }
}

function changed(): void {
  const s = status()
  for (const l of statusListeners) l(s)
}

export function onStatus(fn: (s: PhoneSyncStatus) => void): () => void {
  statusListeners.add(fn)
  return () => statusListeners.delete(fn)
}

function deviceName(): string {
  const ua = navigator.userAgent
  if (/iPad/.test(ua)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua)
  return m ? m[1].trim() : /Android/.test(ua) ? 'Android phone' : 'Phone'
}

export async function pair(address: string, code: string): Promise<PhoneSyncStatus> {
  if (!address) throw new Error('Type your computer’s address, shown in Studywise → Settings → Devices.')
  const c = new SyncClient(baseUrl(address), http)
  const hello = await c.hello()
  if (hello.app !== 'studywise') throw new Error('That address isn’t Studywise.')
  const r = await c.pair(code, deviceId(db()), deviceName())
  const prev = desktop()
  if (prev && prev.desktopId !== r.desktopId) removePeer(db(), prev.desktopId)
  repo.setSetting(TOKEN_KEY, r.token)
  repo.setSetting(DESKTOP_KEY, { address: c.base.replace(/^https?:\/\//, ''), desktopId: r.desktopId, desktopName: r.desktopName } satisfies Desktop)
  client = null
  await saveNow()
  startEventLoop()
  const s = await syncNow()
  if (s.error) throw new Error(s.error)
  return s
}

export async function unpair(): Promise<PhoneSyncStatus> {
  const d = desktop()
  repo.setSetting(TOKEN_KEY, null)
  repo.setSetting(DESKTOP_KEY, null)
  if (d) removePeer(db(), d.desktopId)
  client = null
  online = false
  lastError = null
  changed()
  return status()
}

/** One sync (calls made while one runs share it). */
export function syncNow(): Promise<PhoneSyncStatus> {
  running ??= doSync().finally(() => (running = null))
  return running
}

async function doSync(): Promise<PhoneSyncStatus> {
  const c = makeClient()
  const d = desktop()
  if (!c || !d) return status()
  state = 'syncing'
  changed()
  try {
    ensureBackfill(db())
    const r = await syncWith(db(), d.desktopId, c.transport())
    await uploadAttachments(c)
    online = true
    lastError = null
    if (r.received) emitEvent({ type: 'sync', received: r.received })
    void prefetchFigures()
  } catch (e) {
    online = false
    lastError = e instanceof SyncError && e.status === 401 ? 'Your computer doesn’t recognise this phone any more. Unpair and pair again.' : (e as Error).message
  } finally {
    state = lastError ? 'error' : 'idle'
    await saveNow()
    changed()
  }
  return status()
}

// ---------------------------------------------------------------------------
// Requests that need the computer

export async function remote<T>(channel: string, input: unknown): Promise<T> {
  const c = makeClient()
  if (!c) throw new Error('That needs your computer. Pair with it in Settings → Sync.')
  // Send what's changed here first, so the computer works on the same data…
  await syncNow()
  if (!online) throw new Error(lastError ?? 'Can’t reach your computer.')
  const r = await c.rpc(channel, input)
  if (!r.ok) throw new Error(r.error ?? 'Something went wrong on your computer')
  // …and bring back whatever it changed.
  await syncNow()
  return r.data as T
}

export const isOnline = () => online && !!makeClient()

// ---------------------------------------------------------------------------
// Events from the computer (long poll)

let loopOn = false
export function setEventSink(fn: (ev: unknown) => void): void {
  emitEvent = fn
}

export function startEventLoop(): void {
  if (loopOn) return
  loopOn = true
  void (async () => {
    let since = -1
    while (loopOn) {
      const c = makeClient()
      if (!c || document.hidden) {
        await sleep(3000)
        continue
      }
      try {
        const r = await c.events(since)
        if (since >= 0)
          for (const e of r.events) {
            emitEvent(e.ev)
            const ev = e.ev as { type: string; job?: { status: string } }
            // A job finished on the computer: fetch what it made.
            if (ev.type === 'job' && ev.job?.status !== 'running') void syncNow()
          }
        since = r.next
        if (!online) {
          online = true
          changed()
        }
      } catch {
        since = -1
        await sleep(8000)
      }
    }
  })()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Sync when the app opens, comes back to the front, every minute, and a few seconds after a change. */
export function startAutoSync(): void {
  startEventLoop()
  void syncNow()
  let timer: ReturnType<typeof setTimeout> | null = null
  onWrite(() => {
    if (state === 'syncing') return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      changed()
      if (makeClient()) void syncNow()
    }, 4000)
  })
  setInterval(() => !document.hidden && makeClient() && void syncNow(), 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void saveNow()
    else if (makeClient()) void syncNow()
  })
}

// ---------------------------------------------------------------------------
// Images: attachments and course figures, cached for offline use

const blobUrls = new Map<string, string>()

function blobUrl(url: string, data: Uint8Array): string {
  const ext = url.split('.').pop()?.toLowerCase()
  const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
  const u = URL.createObjectURL(new Blob([data as BlobPart], { type }))
  blobUrls.set(url, u)
  return u
}

/** A studywise-file:// URL → something an <img> can show, from the cache or the computer. */
export async function fileUrl(url: string): Promise<string | null> {
  const known = blobUrls.get(url)
  if (known) return known
  const cached = await idb.get<Uint8Array>('files', url)
  if (cached) return blobUrl(url, cached)
  const c = makeClient()
  if (!c) return null
  try {
    const data = await c.getFile(url)
    if (!data) return null
    await idb.set('files', url, data)
    return blobUrl(url, data)
  } catch {
    return null
  }
}

/** An image pasted or added on the phone: kept here and sent to the computer on the next sync. */
export async function saveAttachment(name: string, data: Uint8Array): Promise<string> {
  const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? '.png').toLowerCase()
  const url = `studywise-file://attachments/${crypto.randomUUID()}${ext}`
  await idb.set('files', url, data)
  const list = (await idb.get<string[]>('kv', UPLOADS_KEY)) ?? []
  await idb.set('kv', UPLOADS_KEY, [...list, url])
  return url
}

async function uploadAttachments(c: SyncClient): Promise<void> {
  const list = (await idb.get<string[]>('kv', UPLOADS_KEY)) ?? []
  const left: string[] = []
  for (const url of list) {
    const data = await idb.get<Uint8Array>('files', url)
    if (!data) continue
    if (!(await c.putFile(url, data).catch(() => false))) left.push(url)
  }
  await idb.set('kv', UPLOADS_KEY, left)
}

/** A course figure (a PDF page the computer renders), cached so topics show it offline. */
export async function figureUrl(fileId: string, page: number): Promise<string> {
  const key = `fig:${fileId}:${page}`
  let url = await idb.get<string>('kv', key)
  if (!url) {
    url = await remote<string>('courses.figure', { fileId, page })
    await idb.set('kv', key, url)
  }
  const shown = await fileUrl(url)
  if (!shown) throw new Error('The figure isn’t on this phone yet.')
  return shown
}

let prefetching = false
/** After a sync, fetch figures for written topics so they're there offline. */
async function prefetchFigures(): Promise<void> {
  if (prefetching || !isOnline()) return
  prefetching = true
  try {
    const rows = db().prepare("SELECT content FROM topics WHERE status = 'ready' AND content IS NOT NULL").all() as { content: string }[]
    for (const r of rows) {
      let sections: { figure?: { fileId: string; page: number } | null }[] = []
      try {
        sections = (JSON.parse(r.content) as { sections?: typeof sections }).sections ?? []
      } catch {
        continue
      }
      for (const s of sections) {
        if (!s.figure || !isOnline()) continue
        if (await idb.get<string>('kv', `fig:${s.figure.fileId}:${s.figure.page}`)) continue
        const c = makeClient()
        if (!c) return
        const r2 = await c.rpc('courses.figure', s.figure).catch(() => null)
        if (!r2?.ok || typeof r2.data !== 'string') continue
        await idb.set('kv', `fig:${s.figure.fileId}:${s.figure.page}`, r2.data)
        await fileUrl(r2.data)
      }
    }
  } finally {
    prefetching = false
  }
}
