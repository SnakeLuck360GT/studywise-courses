// The desktop end of sync: a small HTTP server on the local network that
// phones, and other computers linked to this one, sync with.
//
//   GET  /hello            who this is (no auth)
//   POST /pair             { code, deviceId, name } → { token, desktopId, desktopName }
//   POST /push             { changes }            → { applied, skipped }
//   POST /pull             { since }              → { changes, next, more }
//   POST /rpc              { channel, input }     → { ok, data | error }   (AI and other desktop-only work)
//   GET  /events?since=n   long poll for app events (streamed AI text, job progress)
//   GET  /file?u=…         an attachment or figure, by its studywise-file:// URL
//   PUT  /file?u=…         an attachment pasted on the phone or the other computer
//   POST /have             { attachments, courseFiles } → the ones this computer is missing
//   GET  /course-file?id=  a course file's bytes (for a linked computer)
//   PUT  /course-file?id=  a course file added on a linked computer
//
// Everything but /hello and /pair needs the token the device got when pairing.
// It's off until turned on in Settings → Devices.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { getDb } from '../db'
import * as repo from '../db/repo'
import { paths } from '../paths'
import { applyChanges, changesSince, deviceId, ensureBackfill, getPeer, listPeers, removePeer, savePeer, type SqlDb } from './engine'
import { attachmentPath, courseFileOnDisk, localizeCoursePaths } from './files'
import * as cloud from './cloud'
import type { SyncDevice, SyncStatus } from '@shared/types'

export const DEFAULT_PORT = 47821
const MAX_BODY = 64 * 1024 * 1024
const PAIR_MINUTES = 10
/** Which paired devices are computers (Settings → Devices shows them with a laptop). */
const KINDS_KEY = 'sync.deviceKinds'

/** Channels the phone may not run here: they open desktop dialogs, touch secrets, or have a phone version. */
const BLOCKED = new Set([
  'app.info',
  'app.showDataFolder',
  'app.openExternal',
  'app.backup',
  'app.restore',
  'app.pickFiles',
  'app.saveAttachment',
  'updates.status',
  'updates.check',
  'updates.apply',
  'settings.all',
  'settings.set',
  'claude.choose',
  'claude.clearOverride',
  'courses.openFile',
  'courses.exportWeek',
  'courses.previewWeek',
  'courses.importWeek',
  'courses.addFiles',
  'presets.exportFile',
  'presets.importFile',
  'ollama.setConfig',
  'io.importCards',
  'io.importDeck',
  'io.exportDeck',
  'io.importNotes',
  'io.exportLibrary',
  'io.importLibrary',
  'io.exportNote',
  // Pairing and linking are only set up on the computer itself.
  'sync.setEnabled',
  'sync.pairCode',
  'sync.unpair',
  'sync.link',
  'sync.unlink',
  'sync.linkNow',
  'sync.cloudSet',
  'sync.cloudDelete'
])

type RpcRunner = (channel: string, input: unknown, stream: (streamId: string, text: string) => void) => Promise<{ ok: boolean; data?: unknown; error?: string }>

let server: Server | null = null
let port = DEFAULT_PORT
// A 6-digit code could be guessed with enough tries, so a few wrong ones cancel it.
let pairing: { code: string; expires: number; misses: number } | null = null
const MAX_MISSES = 5
let runRpc: RpcRunner | null = null
let onSynced: ((received: number) => void) | null = null
let lastError: string | null = null

// Recent app events, for /events.
const events: { n: number; ev: unknown }[] = []
let eventN = 0
const waiting = new Set<() => void>()

const db = () => getDb() as unknown as SqlDb
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function configureSyncServer(opts: { rpc: RpcRunner; onSynced: (received: number) => void }): void {
  runRpc = opts.rpc
  onSynced = opts.onSynced
}

/** Called for every event the desktop window gets, so phones can follow along. */
export function recordEvent(ev: unknown): void {
  const type = (ev as { type?: string })?.type
  if (!type || ['menu', 'open-files', 'fullscreen', 'update', 'link', 'cloud'].includes(type)) return
  events.push({ n: ++eventN, ev })
  if (events.length > 600) events.splice(0, events.length - 600)
  for (const w of waiting) w()
  waiting.clear()
}

/** This computer's IPv4 addresses a phone could reach: home/office networks first, then Tailscale and the rest. Link-local ones are left out. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address)
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 3 : ip.startsWith('100.') ? 2 : 4)
  return out.sort((x, y) => rank(x) - rank(y))
}

export function syncStatus(): SyncStatus {
  const d = db()
  const kinds = repo.getSetting<Record<string, string>>(KINDS_KEY, {})
  return {
    enabled: repo.getSetting<boolean>('sync.enabled', false),
    running: !!server?.listening,
    port,
    addresses: lanAddresses(),
    name: hostname(),
    deviceId: deviceId(d),
    pairCode: pairing && pairing.expires > Date.now() ? pairing.code : null,
    pairExpires: pairing && pairing.expires > Date.now() ? new Date(pairing.expires).toISOString() : null,
    devices: listPeers(d)
      .filter((p) => p.token_hash)
      .map((p): SyncDevice => ({ id: p.id, name: p.name, kind: kinds[p.id] === 'computer' ? 'computer' : 'phone', lastSync: p.last_sync, address: p.address })),
    error: lastError
  }
}

export function newPairCode(): SyncStatus {
  pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expires: Date.now() + PAIR_MINUTES * 60_000, misses: 0 }
  return syncStatus()
}

export function unpair(id: string): SyncStatus {
  removePeer(db(), id)
  return syncStatus()
}

export async function setSyncEnabled(on: boolean): Promise<SyncStatus> {
  repo.setSetting('sync.enabled', on)
  if (on) await startSyncServer()
  else await stopSyncServer()
  return syncStatus()
}

export async function startSyncServer(): Promise<void> {
  if (server) return
  ensureBackfill(db())
  port = repo.getSetting<number>('sync.port', DEFAULT_PORT)
  lastError = null
  const s = createServer((req, res) => void handle(req, res))
  s.requestTimeout = 0
  s.headersTimeout = 30_000
  await new Promise<void>((resolve) => {
    s.once('error', (e: NodeJS.ErrnoException) => {
      lastError = e.code === 'EADDRINUSE' ? `Port ${port} is in use by another program.` : e.message
      server = null
      resolve()
    })
    s.listen(port, '0.0.0.0', () => {
      server = s
      console.log(`[sync] listening on ${lanAddresses().join(', ') || 'localhost'}:${port}`)
      resolve()
    })
  })
}

export async function stopSyncServer(): Promise<void> {
  const s = server
  server = null
  for (const w of waiting) w()
  waiting.clear()
  if (s) await new Promise<void>((r) => s.close(() => r()))
}

// ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, ...CORS })
  res.end(data)
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('Too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
const readJson = async <T>(req: IncomingMessage): Promise<T> => JSON.parse((await readBody(req)).toString('utf8') || '{}') as T

/** The paired phone making this request, by its token. */
function authed(req: IncomingMessage): string | null {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
  if (!m) return null
  const hash = sha(m[1])
  const peer = listPeers(db()).find((p) => p.token_hash === hash)
  if (!peer) return null
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? null
  if (address && address !== peer.address) savePeer(db(), { id: peer.id, address })
  return peer.id
}

/** A studywise-file:// URL → the file under the data folder, if it's one the phone may read. */
function fileFor(url: string, write: boolean): string | null {
  const m = /^studywise-file:\/\/(.+)$/.exec(url)
  if (!m) return null
  const rel = normalize(decodeURIComponent(m[1].replace(/^\/+/, '')))
  const full = join(paths.userData, rel)
  if (full.startsWith(paths.attachments + sep)) return /^[\w.-]+$/.test(full.slice(paths.attachments.length + 1)) ? full : null
  if (!write && full.startsWith(paths.courses + sep) && full.endsWith('.png')) return full
  return null
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      return void res.end()
    }
    const url = new URL(req.url ?? '/', 'http://x')
    const route = `${req.method} ${url.pathname}`

    if (route === 'GET /hello') return send(res, 200, { app: 'studywise', name: hostname(), id: deviceId(db()), pairing: !!(pairing && pairing.expires > Date.now()) })

    if (route === 'POST /pair') {
      const b = await readJson<{ code?: string; deviceId?: string; name?: string; kind?: string }>(req)
      if (!pairing || pairing.expires < Date.now()) return send(res, 403, { error: 'Pairing isn’t open. On that computer, open Settings → Devices and press Pair a device.' })
      if (String(b.code ?? '').trim() !== pairing.code || !b.deviceId) {
        if (++pairing.misses >= MAX_MISSES) {
          pairing = null
          return send(res, 403, { error: 'Too many wrong codes. On that computer, press Pair a device again for a new one.' })
        }
        return send(res, 403, { error: 'That code doesn’t match. Check the code on the computer you’re pairing with.' })
      }
      const token = randomBytes(32).toString('base64url')
      savePeer(db(), { id: b.deviceId, name: String(b.name || 'Phone').slice(0, 80), token_hash: sha(token), address: req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? null })
      // Remembered so Synced devices shows a computer as one (older phones don't say).
      const kinds = repo.getSetting<Record<string, string>>(KINDS_KEY, {})
      repo.setSetting(KINDS_KEY, { ...kinds, [b.deviceId]: b.kind === 'computer' ? 'computer' : 'phone' })
      pairing = null
      onSynced?.(0)
      return send(res, 200, { token, desktopId: deviceId(db()), desktopName: hostname() })
    }

    const peer = authed(req)
    if (!peer) return send(res, 401, { error: 'This device isn’t paired with this computer any more. Pair it again.' })

    if (route === 'POST /push') {
      const b = await readJson<{ changes: Parameters<typeof applyChanges>[1]; done?: boolean }>(req)
      // Rows waiting for a parent from a later page are tidied up after the last one (older phones send every page as the last).
      const r = applyChanges(db(), b.changes ?? [], { final: b.done !== false })
      if (r.applied) {
        // Course files added on a linked computer arrive with its folders in their paths.
        localizeCoursePaths(db())
        onSynced?.(r.applied)
      }
      return send(res, 200, r)
    }
    if (route === 'POST /have') {
      const b = await readJson<{ attachments?: unknown[]; courseFiles?: unknown[] }>(req)
      const attachments = (b.attachments ?? []).map(String).filter((n) => {
        const p = attachmentPath(n)
        return !!p && !existsSync(p)
      })
      const courseFiles = (b.courseFiles ?? []).map(String).filter((id) => {
        const p = courseFileOnDisk(db(), id)
        return !!p && !existsSync(p)
      })
      return send(res, 200, { attachments, courseFiles })
    }
    if (url.pathname === '/course-file') {
      const file = courseFileOnDisk(db(), url.searchParams.get('id') ?? '')
      if (!file) return send(res, 404, { error: 'Not found' })
      if (req.method === 'GET') {
        if (!existsSync(file)) return send(res, 404, { error: 'Not found' })
        const data = readFileSync(file)
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, ...CORS })
        return void res.end(data)
      }
      if (req.method === 'PUT') {
        const raw = await readBody(req)
        const data = /json/.test(req.headers['content-type'] ?? '') ? Buffer.from(String((JSON.parse(raw.toString('utf8')) as { data?: string }).data ?? ''), 'base64') : raw
        if (!existsSync(file)) {
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, data)
        }
        return send(res, 200, { ok: true })
      }
    }
    if (route === 'POST /pull') {
      const b = await readJson<{ since?: number }>(req)
      const page = changesSince(db(), Number(b.since) || 0, { skipOrigin: peer })
      if (!page.more) {
        savePeer(db(), { id: peer, last_sync: new Date().toISOString() })
        onSynced?.(0)
      }
      return send(res, 200, page)
    }
    if (route === 'POST /rpc') {
      const b = await readJson<{ channel?: string; input?: unknown }>(req)
      const channel = String(b.channel ?? '')
      if (!runRpc || BLOCKED.has(channel)) return send(res, 200, { ok: false, error: 'That isn’t available from the phone.' })
      // A phone syncing through the cloud: get its latest changes first, and put what this makes up there after.
      const viaCloud = cloud.cloudStatus().on === true && !channel.startsWith('sync.')
      if (viaCloud) await cloud.syncNow()
      const out = await runRpc(channel, b.input, (streamId, text) => recordEvent({ type: 'ai:delta', streamId, text }))
      if (viaCloud) await cloud.syncNow()
      return send(res, 200, out)
    }
    if (route === 'GET /events') {
      const since = Number(url.searchParams.get('since') ?? -1)
      if (since < 0 || since > eventN) return send(res, 200, { events: [], next: eventN })
      if (eventN === since) {
        await new Promise<void>((resolve) => {
          const done = () => (clearTimeout(t), resolve())
          const t = setTimeout(() => (waiting.delete(done), resolve()), 20_000)
          waiting.add(done)
          req.on('close', done)
        })
      }
      const list = events.filter((e) => e.n > since)
      return send(res, 200, { events: list, next: eventN })
    }
    if (url.pathname === '/file') {
      const file = fileFor(url.searchParams.get('u') ?? '', req.method === 'PUT')
      if (!file) return send(res, 403, { error: 'Not allowed' })
      if (req.method === 'GET') {
        if (!existsSync(file)) return send(res, 404, { error: 'Not found' })
        const data = readFileSync(file)
        res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': data.length, ...CORS })
        return void res.end(data)
      }
      if (req.method === 'PUT') {
        const raw = await readBody(req)
        const data = /json/.test(req.headers['content-type'] ?? '') ? Buffer.from(String((JSON.parse(raw.toString('utf8')) as { data?: string }).data ?? ''), 'base64') : raw
        mkdirSync(paths.attachments, { recursive: true })
        if (!existsSync(file)) writeFileSync(file, data)
        return send(res, 200, { ok: true })
      }
    }
    send(res, 404, { error: 'Not found' })
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: (e as Error).message })
  }
}

/** For tests: the peer record for a device. */
export const _peer = (id: string) => getPeer(db(), id)
