// Syncing through the cloud: several devices, each syncing only with a stand-in
// for studywise-server's cloud store (lib/cloud.js there), which keeps the
// latest version of each row with a sequence number and the same "later change
// wins" rule as the devices.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../../src/main/db/migrations'
import { CLOUD_PEER, deviceId, ensureBackfill, syncWithCloud, type Change, type SqlDb } from '../../src/main/sync/engine'

const T = '2026-01-01T00:00:00.000Z'

function open(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
const sql = (db: Database.Database) => db as unknown as SqlDb

/** The server's store, in memory: latest row per key, a sequence number, own changes not sent back. */
function fakeCloud(page = 3) {
  const rows = new Map<string, Change & { seq: number }>()
  let seq = 0
  let pushed = 0
  const wins = (c: Change, cur?: Change) => !cur || (c.at !== cur.at ? c.at > cur.at : c.origin > cur.origin)
  return {
    rows,
    get pushed() {
      return pushed
    },
    transport(device: string) {
      return {
        push: async (changes: Change[]) => {
          pushed += changes.length
          for (const c of changes) {
            const k = `${c.tbl}\u0000${c.pk}`
            if (wins(c, rows.get(k))) rows.set(k, { ...c, seq: ++seq })
          }
        },
        pull: async (since: number) => {
          const all = [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq)
          const slice = all.slice(0, page)
          return {
            changes: slice.filter((r) => r.origin !== device).map(({ seq: _s, ...c }) => c),
            next: slice.length ? slice[slice.length - 1].seq : since,
            more: all.length > page
          }
        }
      }
    }
  }
}

const sync = (db: Database.Database, cloud: ReturnType<typeof fakeCloud>) => syncWithCloud(sql(db), cloud.transport(deviceId(sql(db))))
const addDeck = (db: Database.Database, id: string) => db.prepare('INSERT INTO decks (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, id, T, T)
const addCard = (db: Database.Database, id: string, deck: string, front = id) => db.prepare('INSERT INTO cards (id, deck_id, front, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, deck, front, T, T)
const fronts = (db: Database.Database) => (db.prepare('SELECT id, front FROM cards ORDER BY id').all() as { id: string; front: string }[]).map((c) => `${c.id}:${c.front}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('cloud sync', () => {
  it('gets every device the same library without them ever talking to each other', async () => {
    const cloud = fakeCloud()
    const mac = open()
    const pc = open()
    const phone = open()
    addDeck(mac, 'd1')
    for (let i = 0; i < 5; i++) addCard(mac, `m${i}`, 'd1')
    await sync(mac, cloud)
    await sync(pc, cloud)
    await sync(phone, cloud)
    expect(fronts(phone)).toEqual(fronts(mac))

    // An edit on the phone and a new card on the PC reach everyone.
    await sleep(5)
    phone.prepare("UPDATE cards SET front = 'from phone' WHERE id = 'm1'").run()
    addCard(pc, 'p1', 'd1', 'from pc')
    await sync(phone, cloud)
    await sync(pc, cloud)
    await sync(mac, cloud)
    await sync(phone, cloud)
    for (const db of [mac, pc, phone]) expect(fronts(db)).toEqual(['m0:m0', 'm1:from phone', 'm2:m2', 'm3:m3', 'm4:m4', 'p1:from pc'])

    // A deletion travels too.
    mac.prepare("DELETE FROM cards WHERE id = 'm4'").run()
    await sync(mac, cloud)
    await sync(phone, cloud)
    expect(fronts(phone)).not.toContain('m4:m4')
  })

  it('doesn’t send rows it got from the cloud back up', async () => {
    const cloud = fakeCloud()
    const mac = open()
    const pc = open()
    addDeck(mac, 'd1')
    for (let i = 0; i < 9; i++) addCard(mac, `m${i}`, 'd1')
    await sync(mac, cloud)
    const before = cloud.pushed
    await sync(pc, cloud)
    await sync(pc, cloud)
    expect(cloud.pushed).toBe(before)
    // But its own change still goes up.
    addCard(pc, 'p1', 'd1')
    await sync(pc, cloud)
    expect(cloud.pushed).toBe(before + 1)
  })

  it('sends a library from before syncing on the first cloud sync, and the later change wins', async () => {
    const cloud = fakeCloud()
    const mac = open()
    mac.exec("UPDATE sync_meta SET value = '1' WHERE key = 'applying'")
    addDeck(mac, 'd1')
    addCard(mac, 'old', 'd1', 'from before')
    mac.exec("UPDATE sync_meta SET value = '0' WHERE key = 'applying'")
    ensureBackfill(sql(mac))
    const pc = open()
    await sync(mac, cloud)
    await sync(pc, cloud)
    expect(fronts(pc)).toEqual(['old:from before'])

    // Both change the same card while apart: the later edit wins everywhere.
    mac.prepare("UPDATE cards SET front = 'mac, earlier' WHERE id = 'old'").run()
    await sleep(5)
    pc.prepare("UPDATE cards SET front = 'pc, later' WHERE id = 'old'").run()
    await sync(pc, cloud)
    await sync(mac, cloud)
    await sync(pc, cloud)
    expect(fronts(mac)).toEqual(['old:pc, later'])
    expect(fronts(pc)).toEqual(['old:pc, later'])
  })

  it('takes rows a restore puts back (origin cloud) and doesn’t echo them', async () => {
    const cloud = fakeCloud()
    const mac = open()
    addDeck(mac, 'd1')
    addCard(mac, 'c1', 'd1', 'now')
    await sync(mac, cloud)
    const k = 'cards\u0000c1'
    const cur = cloud.rows.get(k)!
    cloud.rows.set(k, { ...cur, at: new Date(Date.now() + 1000).toISOString(), origin: CLOUD_PEER, row: { ...cur.row, front: 'restored' }, seq: 999 })
    const pushed = cloud.pushed
    await sync(mac, cloud)
    await sync(mac, cloud)
    expect(fronts(mac)).toEqual(['c1:restored'])
    expect(cloud.pushed).toBe(pushed)
  })
})
