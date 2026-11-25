// Row-level sync between two copies of the library (desktop and phone).
//
// Triggers (see @shared/syncTables) record every local write in sync_log with a
// sequence number, a timestamp and the device it came from. Syncing is then:
//   push: send my rows changed since the peer last saw my log (only ones I made)
//   pull: get the peer's rows changed since I last saw its log
// and when both sides changed the same row, the later change wins.
//
// Only plain SQL goes through here, so the same code runs on better-sqlite3
// (desktop) and sql.js (phone).

import { SYNC_TABLES, KEY_SEP, syncTable, type SyncTable } from '@shared/syncTables'

export interface SqlStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
}
export interface SqlDb {
  prepare(sql: string): SqlStatement
  exec(sql: string): unknown
  transaction<F extends (...args: never[]) => unknown>(fn: F): F
}

export interface Change {
  tbl: string
  pk: string
  at: string
  origin: string
  deleted: boolean
  /** The row as it is now (absent when deleted). */
  row?: Record<string, unknown>
}

export interface ChangePage {
  changes: Change[]
  /** Pass back as `since` to get the next page. */
  next: number
  more: boolean
}

const EPOCH = '1970-01-01T00:00:00.000Z'

export function meta(db: SqlDb, key: string): string | undefined {
  return (db.prepare('SELECT value FROM sync_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
}
export function setMeta(db: SqlDb, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)').run(key, value)
}

export const deviceId = (db: SqlDb): string => meta(db, 'device_id')!

export function maxSeq(db: SqlDb): number {
  return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM sync_log').get() as { n: number }).n
}

const columnsCache = new WeakMap<SqlDb, Map<string, string[]>>()
function columns(db: SqlDb, table: string): string[] {
  let m = columnsCache.get(db)
  if (!m) columnsCache.set(db, (m = new Map()))
  let cols = m.get(table)
  if (!cols) {
    cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    m.set(table, cols)
  }
  return cols
}

const where = (t: SyncTable) => t.pk.map((c) => `${c} = ?`).join(' AND ')
const keyParts = (pk: string) => pk.split(KEY_SEP)
const keyOf = (t: SyncTable, row: Record<string, unknown>) => t.pk.map((c) => String(row[c] ?? '')).join(KEY_SEP)

/**
 * Rows that existed before syncing was added have no log entry. Give each one,
 * once, so the first sync sends the whole library. They get an old timestamp:
 * any real change on the other device beats them.
 */
export function ensureBackfill(db: SqlDb): number {
  if (meta(db, 'backfilled') === '1') return 0
  let n = 0
  db.transaction(() => {
    const device = deviceId(db)
    let seq = maxSeq(db)
    const ins = db.prepare('INSERT OR IGNORE INTO sync_log (tbl, pk, seq, at, deleted, origin) VALUES (?, ?, ?, ?, 0, ?)')
    for (const t of SYNC_TABLES) {
      const rows = db.prepare(`SELECT ${t.pk.join(', ')} FROM ${t.name}`).all() as Record<string, unknown>[]
      for (const r of rows) n += ins.run(t.name, keyOf(t, r), ++seq, EPOCH, device).changes
    }
    setMeta(db, 'backfilled', '1')
  })()
  return n
}

/**
 * Changes after `since` in my log, oldest first. `onlyOrigin` keeps just the
 * changes that device made; `skipOrigin` leaves out the ones it made (so a peer
 * isn't sent its own changes back). Rows that are gone are sent as deletions.
 */
export function changesSince(db: SqlDb, since: number, opts: { onlyOrigin?: string; skipOrigin?: string; limit?: number } = {}): ChangePage {
  const limit = opts.limit ?? 400
  const log = db.prepare('SELECT tbl, pk, seq, at, deleted, origin FROM sync_log WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit + 1) as {
    tbl: string
    pk: string
    seq: number
    at: string
    deleted: number
    origin: string
  }[]
  const more = log.length > limit
  const page = log.slice(0, limit)
  const changes: Change[] = []
  for (const l of page) {
    if (opts.onlyOrigin && l.origin !== opts.onlyOrigin) continue
    if (opts.skipOrigin && l.origin === opts.skipOrigin) continue
    const t = syncTable(l.tbl)
    if (!t) continue
    let row: Record<string, unknown> | undefined
    if (!l.deleted) {
      row = db.prepare(`SELECT * FROM ${t.name} WHERE ${where(t)}`).get(...keyParts(l.pk)) as Record<string, unknown> | undefined
      if (row && t.localId) delete row[t.localId]
    }
    changes.push({ tbl: l.tbl, pk: l.pk, at: l.at, origin: l.origin, deleted: !row, ...(row ? { row } : {}) })
  }
  return { changes, next: page.length ? page[page.length - 1].seq : since, more }
}

/** True when the incoming change should replace what this device has. */
/** True when the incoming change should replace what this device has. */
function wins(c: Change, local: { at: string; origin: string; deleted: number } | undefined, missing: () => boolean): boolean {
  if (!local) return true
  if (c.at !== local.at) return c.at > local.at
  if (c.origin !== local.origin) return c.origin > local.origin
  // The version logged here, but the row isn't here: an older sync dropped it
  // (a child applied before its parent arrived), so put it back.
  return !c.deleted && !!c.row && !local.deleted && missing()
}

/**
 * Applies another device's changes. Each is kept only if it's newer than this
 * device's own change to that row.
 *
 * A sync comes in pages, in the order rows last changed, so a topic can arrive
 * pages before its course (studying touches the course). Foreign keys aren't
 * enforced while a page goes in, so a child waits for its parent instead of
 * being dropped. After the last page (`final`, the default) a row whose parent
 * still isn't here is removed (or its link cleared, for ON DELETE SET NULL).
 */
export function applyChanges(db: SqlDb, changes: Change[], opts: { final?: boolean } = {}): { applied: number; skipped: number } {
  const final = opts.final ?? true
  let applied = 0
  let skipped = 0
  if (!changes.length) {
    if (final) finishApply(db)
    return { applied, skipped }
  }
  // Only changeable outside a transaction; nothing else runs in between (this is synchronous).
  const fkOn = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined)?.foreign_keys === 1
  if (fkOn) db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.transaction(() => {
      db.prepare("UPDATE sync_meta SET value = '1' WHERE key = 'applying'").run()
      const getLog = db.prepare('SELECT at, origin, deleted FROM sync_log WHERE tbl = ? AND pk = ?')
      const putLog = db.prepare('INSERT OR REPLACE INTO sync_log (tbl, pk, seq, at, deleted, origin) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_log), ?, ?, ?)')
      for (const c of changes) {
        const t = syncTable(c.tbl)
        const missing = () => !db.prepare(`SELECT 1 FROM ${t!.name} WHERE ${where(t!)}`).get(...keyParts(c.pk))
        if (!t || !wins(c, getLog.get(c.tbl, c.pk) as { at: string; origin: string; deleted: number } | undefined, missing)) {
          skipped++
          continue
        }
        // A deleted parent's children go after the last page (fixForeignKeys), as ON DELETE would have done.
        if (c.deleted || !c.row) db.prepare(`DELETE FROM ${t.name} WHERE ${where(t)}`).run(...keyParts(c.pk))
        else upsert(db, t, c.row)
        putLog.run(c.tbl, c.pk, c.at, c.deleted || !c.row ? 1 : 0, c.origin)
        applied++
      }
      if (final) fixForeignKeys(db)
      db.prepare("UPDATE sync_meta SET value = '0' WHERE key = 'applying'").run()
    })()
  } finally {
    if (fkOn) db.exec('PRAGMA foreign_keys = ON')
  }
  return { applied, skipped }
}

/** After the last page: rows whose parent never came are removed (or their link cleared). */
export function finishApply(db: SqlDb): void {
  db.transaction(() => {
    db.prepare("UPDATE sync_meta SET value = '1' WHERE key = 'applying'").run()
    fixForeignKeys(db)
    db.prepare("UPDATE sync_meta SET value = '0' WHERE key = 'applying'").run()
  })()
}

function upsert(db: SqlDb, t: SyncTable, row: Record<string, unknown>): void {
  const local = columns(db, t.name)
  const cols = local.filter((c) => c !== t.localId && c in row)
  const vals = cols.map((c) => toSql(row[c]))
  if (t.localId) {
    // No unique constraint to upsert on: update in place or insert.
    const exists = db.prepare(`SELECT 1 FROM ${t.name} WHERE ${where(t)}`).get(...t.pk.map((c) => row[c]))
    if (exists) {
      const set = cols.filter((c) => !t.pk.includes(c))
      if (set.length) db.prepare(`UPDATE ${t.name} SET ${set.map((c) => `${c} = ?`).join(', ')} WHERE ${where(t)}`).run(...set.map((c) => toSql(row[c])), ...t.pk.map((c) => row[c]))
    } else db.prepare(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals)
    return
  }
  const set = cols.filter((c) => !t.pk.includes(c))
  // ON CONFLICT DO UPDATE, never REPLACE: replacing deletes the row first, which would cascade to its children.
  const sql =
    `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${t.pk.join(', ')}) DO ${set.length ? `UPDATE SET ${set.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING'}`
  db.prepare(sql).run(...vals)
}

const toSql = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)

function fixForeignKeys(db: SqlDb): void {
  for (let round = 0; round < 8; round++) {
    const bad = db.prepare('PRAGMA foreign_key_check').all() as { table: string; rowid: number; parent: string; fkid: number }[]
    if (!bad.length) return
    for (const b of bad) {
      const fk = (db.prepare(`PRAGMA foreign_key_list(${b.table})`).all() as { id: number; from: string; on_delete: string }[]).filter((f) => f.id === b.fkid)
      if (fk.length === 1 && fk[0].on_delete === 'SET NULL') db.prepare(`UPDATE ${b.table} SET ${fk[0].from} = NULL WHERE rowid = ?`).run(b.rowid)
      else db.prepare(`DELETE FROM ${b.table} WHERE rowid = ?`).run(b.rowid)
    }
  }
}

// ---------------------------------------------------------------------------
// One sync, from the side that starts it (the phone)

export interface SyncTransport {
  /** done: the last page of this push, so the peer can tidy up rows whose parent never came. */
  push(changes: Change[], done?: boolean): Promise<unknown>
  pull(since: number): Promise<ChangePage>
}

/**
 * Bumped when older versions could have lost rows, so each device sends and
 * fetches everything once more (rows already there are skipped, missing ones
 * come back). 1: children applied a page before their parent were dropped.
 */
const RESYNC = 1

export interface SyncResult {
  sent: number
  received: number
}

/**
 * Sends my changes the peer hasn't seen, then applies the peer's changes I haven't seen.
 * relay: also send changes that came here from other devices (a computer linked
 * to another computer passes on its own phones' changes); anything that came
 * from the peer itself is still left out, and an echo of the peer's own row is
 * ignored there because it isn't newer.
 */
export async function syncWith(db: SqlDb, peerId: string, transport: SyncTransport, opts: { relay?: boolean } = {}): Promise<SyncResult> {
  const me = deviceId(db)
  let peer = getPeer(db, peerId) ?? savePeer(db, { id: peerId })
  const resyncKey = `resync:${peerId}`
  if (Number(meta(db, resyncKey) ?? 0) < RESYNC) peer = savePeer(db, { id: peerId, sent_seq: 0, got_seq: 0 })
  let sent = 0
  let received = 0
  for (;;) {
    const page = changesSince(db, peer.sent_seq, opts.relay ? { skipOrigin: peerId } : { onlyOrigin: me })
    // The last page always goes (even empty, after others), so the peer knows the push is complete.
    if (page.changes.length || (!page.more && sent)) await transport.push(page.changes, !page.more)
    sent += page.changes.length
    peer = savePeer(db, { id: peerId, sent_seq: page.next })
    if (!page.more) break
  }
  for (;;) {
    const page = await transport.pull(peer.got_seq)
    received += applyChanges(db, page.changes, { final: !page.more }).applied
    peer = savePeer(db, { id: peerId, got_seq: page.next })
    if (!page.more) break
  }
  setMeta(db, resyncKey, String(RESYNC))
  savePeer(db, { id: peerId, last_sync: new Date().toISOString() })
  return { sent, received }
}

// ---------------------------------------------------------------------------
// Peers

export interface Peer {
  id: string
  name: string
  token_hash: string | null
  address: string | null
  /** My log position the peer has been sent. */
  sent_seq: number
  /** The peer's log position I've received. */
  got_seq: number
  last_sync: string | null
  created_at: string
}

export function listPeers(db: SqlDb): Peer[] {
  return db.prepare('SELECT * FROM sync_peers ORDER BY created_at').all() as Peer[]
}
export function getPeer(db: SqlDb, id: string): Peer | undefined {
  return db.prepare('SELECT * FROM sync_peers WHERE id = ?').get(id) as Peer | undefined
}
export function savePeer(db: SqlDb, p: Partial<Peer> & { id: string }): Peer {
  const cur = getPeer(db, p.id)
  const next: Peer = { name: 'Device', token_hash: null, address: null, sent_seq: 0, got_seq: 0, last_sync: null, created_at: new Date().toISOString(), ...cur, ...p }
  db.prepare(
    'INSERT OR REPLACE INTO sync_peers (id, name, token_hash, address, sent_seq, got_seq, last_sync, created_at) VALUES (@id, @name, @token_hash, @address, @sent_seq, @got_seq, @last_sync, @created_at)'
  ).run(next)
  return next
}
export function removePeer(db: SqlDb, id: string): void {
  db.prepare('DELETE FROM sync_peers WHERE id = ?').run(id)
}
