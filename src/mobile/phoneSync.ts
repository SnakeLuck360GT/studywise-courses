// The phone's side of syncing: pairing, syncing in the background, following
// the computer's events (streamed AI text, job progress), forwarding requests
// that need the computer, and keeping a copy of images for offline use.

import type { PhoneSyncStatus } from '@shared/mobile'
import * as repo from '../main/db/repo'
import { getDb } from '../main/db'
import { onWrite, saveNow } from './db'
import { SyncClient, SyncError, baseUrl } from '../main/sync/client'
import { CLOUD_PEER, deviceId, ensureBackfill, getPeer, removePeer, syncWith, syncWithCloud, type SqlDb } from '../main/sync/engine'
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
/** The cloud's address and key ({url, key}) when this phone syncs through it. */
const CLOUD_KEY = 'secret.phone.cloud'

let client: SyncClient | null = null
let state: PhoneSyncStatus['state'] = 'idle'
let online = false
let lastError: string | null = null
let running: Promise<PhoneSyncStatus> | null = null
const statusListeners = new Set<(s: PhoneSyncStatus) => void>()
let emitEvent: (ev: unknown) => void = () => {}

const desktop = () => repo.getSetting<Desktop | null>(DESKTOP_KEY, null)
const cloudAuth = () => repo.getSetting<{ url: string; key: string } | null>(CLOUD_KEY, null)

let cloud: SyncClient | null = null
function cloudClient(): SyncClient | null {
  const a = cloudAuth()
  if (!a) return null
  if (!cloud || cloud.base !== `${a.url}/api/cloud`)
    cloud = new SyncClient(`${a.url}/api/cloud`, http, a.key, {
      device: { id: deviceId(db()), name: deviceName(), kind: 'phone' },
      unreachable: `Can’t reach ${a.url.replace(/^https?:\/\//, '')}. Your changes are kept on the phone and go up when you’re online.`,
      who: 'The cloud'
    })
  return cloud
}
/** Something to sync with: the cloud, or the paired computer. */
const canSync = () => !!cloudClient() || !!makeClient()

function makeClient(): SyncClient | null {
  const d = desktop()
  const token = repo.getSetting<string | null>(TOKEN_KEY, null)
  if (!d || !token) return null
  if (!client || client.base !== baseUrl(d.address)) client = new SyncClient(baseUrl(d.address), http, token)
  return client
}

export function status(): PhoneSyncStatus {
  const d = desktop()
  const c = cloudAuth()
  let pending = 0
  if (c) {
    const peer = getPeer(db(), CLOUD_PEER)
    pending = (db().prepare('SELECT COUNT(*) AS n FROM sync_log WHERE seq > ? AND origin != ?').get(peer?.sent_seq ?? 0, CLOUD_PEER) as { n: number }).n
  } else if (d) {
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
    pending,
    cloud: { on: !!c, server: c?.url ?? null, lastSync: c ? (getPeer(db(), CLOUD_PEER)?.last_sync ?? null) : null }
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

/**
 * Sync through the cloud from now on: with the address and key given, or the
 * ones the paired computer uses (it has to have cloud sync on). The computer
 * stays paired for AI.
 */
export async function useCloud(input?: { url: string; key: string }): Promise<PhoneSyncStatus> {
  let auth = input ? { url: input.url.trim().replace(/\/+$/, ''), key: input.key.trim() } : null
  if (auth && !/^https?:\/\//i.test(auth.url)) auth.url = `https://${auth.url}`
  if (!auth) {
    const c = makeClient()
    if (!c) throw new Error('Pair with your computer first, or type the cloud’s address and an API key.')
    const r = await c.rpc('sync.cloudCredentials', null)
    if (!r.ok) throw new Error(r.error ?? 'Your computer couldn’t say.')
    if (!r.data) throw new Error('Turn on cloud sync on your computer first (Settings → Devices).')
    auth = r.data as { url: string; key: string }
  }
  if (!auth.url || !auth.key) throw new Error('Type the cloud’s address and an API key.')
  repo.setSetting(CLOUD_KEY, auth)
  cloud = null
  lastError = null
  await saveNow()
  const s = await syncNow()
  if (s.error) {
    repo.setSetting(CLOUD_KEY, null)
    cloud = null
    await saveNow()
    throw new Error(s.error)
  }
  return s
}

/** Stop syncing through the cloud: back to syncing with the paired computer over Wi‑Fi. */
export async function stopCloud(): Promise<PhoneSyncStatus> {
  repo.setSetting(CLOUD_KEY, null)
  removePeer(db(), CLOUD_PEER)
  cloud = null
  lastError = null
  await saveNow()
  changed()
  return status()
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
  const cc = cloudClient()
  const c = makeClient()
  const d = desktop()
  if (!cc && (!c || !d)) return status()
  state = 'syncing'
  changed()
  try {
    ensureBackfill(db())
    // Through the cloud when it's on (the computer is then only for AI), else with the computer.
    const r = cc ? await syncWithCloud(db(), cc.transport()) : await syncWith(db(), d!.desktopId, c!.transport())
    await uploadAttachments(cc ?? c!)
    if (!cc) online = true
    lastError = null
    if (r.received) emitEvent({ type: 'sync', received: r.received })
    void prefetchFigures()
  } catch (e) {
    if (!cc) online = false
    lastError =
      e instanceof SyncError && e.status === 401
        ? cc
          ? 'The cloud didn’t accept this phone’s key any more. Turn cloud sync off and on again.'
          : 'Your computer doesn’t recognise this phone any more. Unpair and pair again.'
        : (e as Error).message
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
  // (Through the cloud, the computer fetches it before it starts: whether it's reachable shows in the call.)
  if (!cloudAuth() && !online) throw new Error(lastError ?? 'Can’t reach your computer.')
  const r = await c.rpc(channel, input).catch((e: unknown) => {
    online = false
    changed()
    throw e
  })
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
      if (canSync()) void syncNow()
    }, 4000)
  })
  setInterval(() => !document.hidden && canSync() && void syncNow(), 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void saveNow()
    else if (canSync()) void syncNow()
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
  // From the computer, or failing that the cloud (pasted images are kept there too).
  for (const c of [makeClient(), url.startsWith('studywise-file://attachments/') ? cloudClient() : null]) {
    if (!c) continue
    try {
      const data = await c.getFile(url)
      if (!data) continue
      await idb.set('files', url, data)
      return blobUrl(url, data)
    } catch {
      /* try the next */
    }
  }
  return null
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
