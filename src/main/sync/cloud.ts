// Syncing and backing up through the cloud: the marketplace server
// (studywise-server) keeps a copy of the whole library for your account, and
// every device (this computer, your other computers, your phone) syncs with
// it instead of with each other, so they don't need to be on the same Wi‑Fi
// or switched on at the same time. It uses the marketplace's address and API
// key (Settings → Marketplace).
//
// Rows go through the change log exactly as with a phone or a linked computer
// (./engine, syncWithCloud), and the files they need (course files, pasted
// images) are copied up and down (copyFiles in ./link).

import { hostname } from 'node:os'
import { getDb } from '../db'
import * as repo from '../db/repo'
import { marketAuth } from '../services/market'
import { deliverRequested, missingWeeks } from '../services/marketTasks'
import { SyncClient, SyncError } from './client'
import { CLOUD_PEER, deviceId, ensureBackfill, getPeer, removePeer, syncWithCloud, type SqlDb } from './engine'
import { localizeCoursePaths } from './files'
import { copyFiles, nodeHttp } from './link'
import type { CloudInfo, CloudStatus } from '@shared/types'

/** true / false once decided; unset until then (Studywise offers it once). */
const ON_KEY = 'cloud.on'
/** Which server and account this library syncs with: "<url>|<user>". A different one starts over. */
const ACCOUNT_KEY = 'cloud.account'

const db = () => getDb() as unknown as SqlDb
const isOn = () => repo.getSetting<boolean | null>(ON_KEY, null)
const account = () => repo.getSetting<string | null>(ACCOUNT_KEY, null)

let state: CloudStatus['state'] = 'idle'
let lastError: string | null = null
let filesLeft = 0
let filesDue = true
let running: Promise<CloudStatus> | null = null
let onStatus: (s: CloudStatus) => void = () => {}
let onReceived: (n: number) => void = () => {}

export function configureCloud(opts: { onStatus: (s: CloudStatus) => void; onReceived: (n: number) => void }): void {
  onStatus = opts.onStatus
  onReceived = opts.onReceived
}

function client(): SyncClient | null {
  const a = marketAuth()
  if (!a) return null
  const host = a.url.replace(/^https?:\/\//, '')
  return new SyncClient(`${a.url}/api/cloud`, nodeHttp, a.key, {
    device: { id: deviceId(db()), name: hostname().replace(/\.local$/, ''), kind: 'computer' },
    unreachable: `Can’t reach ${host}. Your changes are kept here and go up when it’s back.`,
    who: 'The cloud'
  })
}

export function cloudStatus(): CloudStatus {
  const a = marketAuth()
  const on = isOn()
  const peer = getPeer(db(), CLOUD_PEER)
  const pending = on ? (db().prepare('SELECT COUNT(*) AS n FROM sync_log WHERE seq > ? AND origin != ?').get(peer?.sent_seq ?? 0, CLOUD_PEER) as { n: number }).n : 0
  const acct = account()
  return {
    on,
    ready: !!a,
    server: a?.url ?? null,
    user: acct?.split('|')[1] ?? null,
    lastSync: peer?.last_sync ?? null,
    state,
    error: lastError,
    pending,
    filesLeft: on ? filesLeft : 0
  }
}

const changed = () => onStatus(cloudStatus())

async function whoAmI(): Promise<string> {
  const a = marketAuth()
  if (!a) throw new Error('Connect to the marketplace first (Settings → Marketplace): cloud sync uses the same account.')
  const res = await nodeHttp({ method: 'GET', url: `${a.url}/api/app/me`, headers: { Authorization: `Bearer ${a.key}` }, timeoutMs: 15_000 }).catch(() => null)
  if (!res) throw new Error(`Can’t reach ${a.url}.`)
  if (res.status === 401) throw new Error(`${a.url} didn’t accept your API key. Make a new one there and paste it in Settings → Marketplace.`)
  const data = (await res.json()) as { user?: { name: string } }
  if (!data.user) throw new Error(`${a.url} answered ${res.status}.`)
  return data.user.name
}

/**
 * Turns cloud sync on (the first sync sends the whole library up, and brings
 * down anything already there from your other devices) or off (both keep what
 * they have).
 */
export async function setCloud(on: boolean): Promise<CloudStatus> {
  if (!on) {
    repo.setSetting(ON_KEY, false)
    lastError = null
    state = 'idle'
    changed()
    return cloudStatus()
  }
  const user = await whoAmI()
  const acct = `${marketAuth()!.url}|${user}`
  // A different server or account: start over with it (nothing here is lost).
  if (account() !== acct) removePeer(db(), CLOUD_PEER)
  repo.setSetting(ACCOUNT_KEY, acct)
  repo.setSetting(ON_KEY, true)
  lastError = null
  filesDue = true
  const s = await syncNow()
  if (s.error) throw new Error(s.error)
  return s
}

/** One sync (calls made while one runs share it). */
export function syncNow(): Promise<CloudStatus> {
  running ??= doSync().finally(() => (running = null))
  return running
}

async function doSync(): Promise<CloudStatus> {
  if (!isOn()) return cloudStatus()
  const c = client()
  const a = marketAuth()
  if (!c || !a) {
    lastError = 'Cloud sync uses your marketplace account: connect to it again in Settings → Marketplace.'
    state = 'error'
    changed()
    return cloudStatus()
  }
  // The marketplace was pointed at another server since: don't mix two clouds.
  if (account() && !account()!.startsWith(`${a.url}|`)) {
    lastError = `Cloud sync was set up with ${account()!.split('|')[0]}. Turn it off and on again to sync with ${a.url} instead.`
    state = 'error'
    changed()
    return cloudStatus()
  }
  state = 'syncing'
  changed()
  try {
    ensureBackfill(db())
    const r = await syncWithCloud(db(), c.transport())
    if (r.received) localizeCoursePaths(db())
    lastError = null
    if (r.received) onReceived(r.received)
    if (filesDue || r.sent || r.received) {
      filesLeft = await copyFiles(c)
      filesDue = filesLeft > 0
    }
    // Weeks you asked for on the marketplace that someone has made since: added here (at most every few minutes).
    void deliverRequested()
      .then((n) => n && onReceived(n))
      .catch((e) => console.warn('Adding requested weeks failed:', (e as Error).message))
    // Your courses' missing weeks asked for (at most every half hour).
    void missingWeeks({ background: true }).catch((e) => console.warn('Asking for missing weeks failed:', (e as Error).message))
  } catch (e) {
    lastError =
      e instanceof SyncError && e.status === 401
        ? `${a.url} didn’t accept your API key. Make a new one there and paste it in Settings → Marketplace.`
        : e instanceof SyncError && e.status === 413
          ? e.message
          : (e as Error).message
  } finally {
    state = lastError ? 'error' : 'idle'
    changed()
  }
  return cloudStatus()
}

async function call<T>(method: 'GET' | 'DELETE', path: string): Promise<T> {
  const a = marketAuth()
  if (!a) throw new Error('Connect to the marketplace first (Settings → Marketplace).')
  const res = await nodeHttp({ method, url: `${a.url}/api/cloud${path}`, headers: { Authorization: `Bearer ${a.key}` }, timeoutMs: 20_000 }).catch(() => null)
  if (!res) throw new Error(`Can’t reach ${a.url}.`)
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (res.status >= 400) throw new Error(data.error ?? `${a.url} answered ${res.status}.`)
  return data
}

/** What the cloud keeps for this account: devices, space used, snapshots. */
export function cloudInfo(): Promise<CloudInfo> {
  return call<CloudInfo>('GET', '')
}

/** Deletes the cloud's copy (every device keeps its own) and turns cloud sync off here. */
export async function deleteCloudCopy(): Promise<CloudStatus> {
  await call('DELETE', '')
  removePeer(db(), CLOUD_PEER)
  repo.setSetting(ON_KEY, false)
  lastError = null
  changed()
  return cloudStatus()
}

/** The address and key a paired phone uses to sync through the cloud too. */
export function cloudCredentials(): { url: string; key: string } | null {
  return isOn() ? marketAuth() : null
}

let timer: ReturnType<typeof setInterval> | null = null

/** Syncs when the app starts, a few seconds after a change here, and at least every minute (every two after an error). */
export function startCloudSync(): void {
  if (timer) return
  let last = Date.now()
  timer = setInterval(() => {
    if (!isOn() || running) return
    const gap = Date.now() - last
    const due = state === 'error' ? gap > 120_000 : cloudStatus().pending > 0 || gap > 60_000
    if (!due) return
    last = Date.now()
    void syncNow()
  }, 5_000)
  if (isOn()) void syncNow()
}

export function stopCloudSync(): void {
  if (timer) clearInterval(timer)
  timer = null
}
