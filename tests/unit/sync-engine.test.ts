import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { MIGRATIONS, migrate } from '../../src/main/db/migrations'
import { applyChanges, changesSince, deviceId, ensureBackfill, syncWith, type SqlDb } from '../../src/main/sync/engine'

const T = '2026-01-01T00:00:00.000Z'

function open(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}
const sql = (db: Database.Database) => db as unknown as SqlDb

/** A desktop and a phone wired together in memory, the way the HTTP server does it. */
function pair(desktop: Database.Database, phone: Database.Database) {
  const phoneId = deviceId(sql(phone))
  const transport = {
    push: async (changes: Parameters<typeof applyChanges>[1]) => applyChanges(sql(desktop), changes),
    pull: async (since: number) => changesSince(sql(desktop), since, { skipOrigin: phoneId, limit: 3 })
  }
  return () => syncWith(sql(phone), deviceId(sql(desktop)), transport)
}

const addDeck = (db: Database.Database, id: string, name = id) =>
  db.prepare("INSERT INTO decks (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, name, T, T)
const addCard = (db: Database.Database, id: string, deck: string, front = id) =>
  db.prepare("INSERT INTO cards (id, deck_id, front, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, deck, front, T, T)
const fronts = (db: Database.Database) => (db.prepare('SELECT id, front FROM cards ORDER BY id').all() as { id: string; front: string }[]).map((c) => `${c.id}:${c.front}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('sync engine', () => {
  it('records writes through triggers, but not while applying', () => {
    const db = open()
    addDeck(db, 'd1')
    addCard(db, 'c1', 'd1')
    db.prepare("UPDATE cards SET front = 'x' WHERE id = 'c1'").run()
    const log = db.prepare('SELECT tbl, pk, deleted FROM sync_log ORDER BY seq').all()
    expect(log).toEqual([
      { tbl: 'decks', pk: 'd1', deleted: 0 },
      { tbl: 'cards', pk: 'c1', deleted: 0 }
    ])
    db.prepare("DELETE FROM decks WHERE id = 'd1'").run()
    // The cascade to the card is recorded too.
    expect(db.prepare("SELECT tbl, deleted FROM sync_log WHERE deleted = 1 ORDER BY tbl").all()).toEqual([
      { tbl: 'cards', deleted: 1 },
      { tbl: 'decks', deleted: 1 }
    ])
  })

  it('sends a whole existing library on the first sync, then only changes, both ways', async () => {
    const desktop = open()
    const phone = open()
    // A library from before syncing existed: no log entries yet.
    desktop.exec("UPDATE sync_meta SET value = '1' WHERE key = 'applying'")
    addDeck(desktop, 'd1')
    for (let i = 0; i < 7; i++) addCard(desktop, `c${i}`, 'd1')
    desktop.exec("UPDATE sync_meta SET value = '0' WHERE key = 'applying'")
    expect(ensureBackfill(sql(desktop))).toBe(8)

    const sync = pair(desktop, phone)
    expect(await sync()).toEqual({ sent: 0, received: 8 })
    expect(fronts(phone)).toHaveLength(7)

    // Phone studies and edits; desktop adds a card.
    phone.prepare("UPDATE cards SET front = 'phone edit' WHERE id = 'c1'").run()
    phone.prepare("INSERT INTO review_state (card_id, ease, interval, repetitions, lapses, due) VALUES ('c2', 2.5, 1, 1, 0, ?)").run(T)
    phone.prepare("INSERT INTO review_log (card_id, deck_id, rating, source, at) VALUES ('c2', 'd1', 3, 'flashcard', ?)").run(T)
    addCard(desktop, 'c9', 'd1', 'desktop new')

    const r = await sync()
    expect(r.sent).toBe(3)
    expect(r.received).toBe(1)
    expect(fronts(desktop)).toContain('c1:phone edit')
    expect(fronts(phone)).toContain('c9:desktop new')
    expect(desktop.prepare('SELECT COUNT(*) n FROM review_log').get()).toEqual({ n: 1 })
    expect(desktop.prepare("SELECT interval FROM review_state WHERE card_id = 'c2'").get()).toEqual({ interval: 1 })

    // Nothing new: nothing moves, and the phone's own changes don't come back.
    expect(await sync()).toEqual({ sent: 0, received: 0 })
  })

  it('keeps the later edit when both sides change the same row', async () => {
    const desktop = open()
    const phone = open()
    const sync = pair(desktop, phone)
    addDeck(desktop, 'd1')
    addCard(desktop, 'c1', 'd1', 'original')
    await sync()

    desktop.prepare("UPDATE cards SET front = 'desktop' WHERE id = 'c1'").run()
    await sleep(5)
    phone.prepare("UPDATE cards SET front = 'phone' WHERE id = 'c1'").run()
    await sync()
    expect(fronts(desktop)).toEqual(['c1:phone'])
    expect(fronts(phone)).toEqual(['c1:phone'])

    phone.prepare("UPDATE cards SET front = 'phone again' WHERE id = 'c1'").run()
    await sleep(5)
    desktop.prepare("UPDATE cards SET front = 'desktop again' WHERE id = 'c1'").run()
    await sync()
    expect(fronts(desktop)).toEqual(['c1:desktop again'])
    expect(fronts(phone)).toEqual(['c1:desktop again'])
  })

  it('handles deletes, cascades and children whose parent is gone', async () => {
    const desktop = open()
    const phone = open()
    const sync = pair(desktop, phone)
    addDeck(desktop, 'd1')
    addDeck(desktop, 'd2')
    addCard(desktop, 'c1', 'd1')
    desktop.prepare("INSERT INTO folders (id, name, kind, created_at) VALUES ('f1', 'F', 'deck', ?)").run(T)
    desktop.prepare("UPDATE decks SET folder_id = 'f1' WHERE id = 'd2'").run()
    await sync()
    expect(phone.prepare("SELECT folder_id FROM decks WHERE id = 'd2'").get()).toEqual({ folder_id: 'f1' })

    // Desktop deletes deck d1 while the phone adds a card to it.
    desktop.prepare("DELETE FROM decks WHERE id = 'd1'").run()
    addCard(phone, 'c2', 'd1')
    // Phone deletes the folder: the deck stays, out of the folder.
    phone.prepare("DELETE FROM folders WHERE id = 'f1'").run()
    await sync()
    expect(fronts(desktop)).toEqual([])
    expect(fronts(phone)).toEqual([])
    expect(desktop.prepare("SELECT folder_id FROM decks WHERE id = 'd2'").get()).toEqual({ folder_id: null })
    expect(desktop.prepare('SELECT COUNT(*) n FROM folders').get()).toEqual({ n: 0 })
    expect(desktop.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(phone.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('syncs course progress written on the phone', async () => {
    const desktop = open()
    const phone = open()
    const sync = pair(desktop, phone)
    desktop.prepare("INSERT INTO courses (id, name, created_at, updated_at) VALUES ('k1', 'Physics', ?, ?)").run(T, T)
    desktop.prepare("INSERT INTO weeks (id, course_id, position, label, created_at) VALUES ('w1', 'k1', 0, 'Week 1', ?)").run(T)
    desktop.prepare("INSERT INTO topics (id, course_id, week_id, key, position, plan, updated_at) VALUES ('t1', 'k1', 'w1', 'w1t1', 0, '{}', ?)").run(T)
    await sync()
    phone.prepare(`UPDATE topics SET progress = '{"section":2}' WHERE id = 't1'`).run()
    await sync()
    expect(desktop.prepare("SELECT progress FROM topics WHERE id = 't1'").get()).toEqual({ progress: '{"section":2}' })
  })

  it('keeps an edit made after syncing even when that device’s clock is behind', async () => {
    const desktop = open()
    const phone = open()
    const sync = pair(desktop, phone)
    addDeck(desktop, 'd1')
    addCard(desktop, 'c1', 'd1', 'from the computer')
    // The computer's clock is an hour ahead of the phone's.
    const ahead = new Date(Date.now() + 3600_000).toISOString()
    desktop.prepare("UPDATE sync_log SET at = ? WHERE tbl = 'cards' AND pk = 'c1'").run(ahead)
    await sync()
    expect(fronts(phone)).toEqual(['c1:from the computer'])
    // The phone, having seen that version, changes it: its change is the newer one.
    phone.prepare("UPDATE cards SET front = 'from the phone' WHERE id = 'c1'").run()
    const logged = (phone.prepare("SELECT at FROM sync_log WHERE tbl = 'cards' AND pk = 'c1'").get() as { at: string }).at
    expect(logged > ahead).toBe(true)
    await sync()
    expect(fronts(desktop)).toEqual(['c1:from the phone'])
    expect(fronts(phone)).toEqual(['c1:from the phone'])
  })

  it('gives a library from before the fix the new triggers', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // A library as version 1.8.2 left it (migrations up to 10), with the triggers
    // as they were then: a change's time was just "now".
    const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    const old = (m: string) => m.split(`MAX(${NOW}, COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', julianday(at) + 0.0015 / 86400.0), ''))`).join(NOW)
    for (const [i, m] of MIGRATIONS.slice(0, 10).entries()) {
      db.exec(old(m))
      db.pragma(`user_version = ${i + 1}`)
    }
    const triggers = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_%'").all() as { name: string; sql: string }[]
    const before = triggers()
    expect(before.some((t) => t.sql.includes('julianday'))).toBe(false)
    migrate(db)
    const after = triggers()
    // Every old trigger is still there (later migrations add tables of their own).
    expect(after.map((t) => t.name)).toEqual(expect.arrayContaining(before.map((t) => t.name)))
    expect(after.filter((t) => t.name.endsWith('_upd') || t.name.endsWith('_del')).every((t) => t.sql.includes('julianday'))).toBe(true)
    // Still records writes.
    addDeck(db, 'd1')
    expect(db.prepare("SELECT COUNT(*) n FROM sync_log WHERE tbl = 'decks'").get()).toEqual({ n: 1 })
  })

  it('still settles edits made without seeing each other by which came later', async () => {
    const desktop = open()
    const phone = open()
    const sync = pair(desktop, phone)
    addDeck(desktop, 'd1')
    addCard(desktop, 'c1', 'd1')
    await sync()
    phone.prepare("UPDATE cards SET front = 'phone' WHERE id = 'c1'").run()
    await sleep(5)
    desktop.prepare("UPDATE cards SET front = 'computer' WHERE id = 'c1'").run()
    await sync()
    expect(fronts(desktop)).toEqual(['c1:computer'])
    expect(fronts(phone)).toEqual(['c1:computer'])
  })
})
