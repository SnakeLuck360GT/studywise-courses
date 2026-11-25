import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { retryPosition, insertRetry } from '@shared/retry'

let dir: string
let db: typeof import('../../src/main/db')
let repo: typeof import('../../src/main/db/repo')
let svc: typeof import('../../src/main/services/course')
let learn: typeof import('../../src/main/services/learn')
let library: typeof import('../../src/main/library')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-decks-'))
  process.env.STUDYWISE_DATA_DIR = dir
  db = await import('../../src/main/db')
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  repo = await import('../../src/main/db/repo')
  // These tests check the difficulty-based scheduler's numbers (lapses, repetitions); the StudySmarter one is in traffic.test.ts.
  repo.setSetting('review.scheduler', 'adaptive')
  svc = await import('../../src/main/services/course')
  learn = await import('../../src/main/services/learn')
  library = await import('../../src/main/library')
})
afterAll(() => {
  db.closeDb()
  rmSync(dir, { recursive: true, force: true })
})

const ctx = () => ({ signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })

describe('retry positions', () => {
  it('comes back a few items later, never past the end', () => {
    expect(retryPosition(0, 10)).toBe(4)
    expect(retryPosition(8, 10)).toBe(10)
    expect(retryPosition(9, 10)).toBe(10)
    // Topics keep retries before the summary.
    expect(retryPosition(5, 10, 7)).toBe(7)
  })
  it('keeps coming back until it is right', () => {
    let q = ['a', 'b', 'c']
    q = insertRetry(q, 0, 'a').list // missed a
    expect(q).toEqual(['a', 'b', 'c', 'a'])
    q = insertRetry(q, 3, 'a').list // missed a again
    expect(q).toEqual(['a', 'b', 'c', 'a', 'a'])
  })
})

describe('learn retries', () => {
  it('are marked but leave the schedule and session stats alone', async () => {
    const deck = repo.createDeck({ name: 'Retry' })
    const [card] = repo.createCards([{ deck_id: deck.id, front: 'Unit of frequency?', back: 'hertz' }])
    const { sessionId } = learn.startSession(deck.id)
    const [mc] = await learn.buildQuestions(deck.id, [{ type: 'multiple_choice', card_id: card.id, card_ids: [card.id] }])
    if (mc.type !== 'multiple_choice') throw new Error()
    const wrong = (mc.payload.correct_index + 1) % mc.payload.options.length
    await learn.submitAnswer(sessionId, deck.id, mc, { type: 'multiple_choice', index: wrong })
    const after = repo.getReviewState(card.id)
    expect(after?.lapses).toBe(1)
    // Asked again later in the session and got right: marked, but the first answer is what counts.
    const r = await learn.submitAnswer(sessionId, deck.id, mc, { type: 'multiple_choice', index: mc.payload.correct_index }, true)
    expect(r.mark.verdict).toBe('correct')
    expect(repo.getReviewState(card.id)).toEqual(after)
    expect(learn.endSession(sessionId)).toMatchObject({ answered: 1, wrong: 1, correct: 0 })
  })
})

describe('course decks', () => {
  it('sorts old one-deck courses into a folder with a deck per week', () => {
    const d = db.getDb()
    const now = new Date().toISOString()
    // A course made before week decks: one deck for everything, weeks without decks.
    const legacy = repo.createDeck({ name: 'Old course' })
    const courseId = db.uid()
    d.prepare('INSERT INTO courses (id, name, module, level, deck_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(courseId, 'Old course', 'Old course', '', legacy.id, now, now)
    const weekIds = [db.uid(), db.uid()]
    weekIds.forEach((id, i) => d.prepare("INSERT INTO weeks (id, course_id, position, label, status, created_at) VALUES (?, ?, ?, ?, 'ready', ?)").run(id, courseId, i, `Week ${i + 1}`, now))
    const topicIds = weekIds.map((w, i) => {
      const id = db.uid()
      d.prepare("INSERT INTO topics (id, course_id, week_id, key, position, plan, status, updated_at) VALUES (?, ?, ?, ?, 0, '{}', 'ready', ?)").run(id, courseId, w, `w${i + 1}t1`, now)
      return id
    })
    const cards = repo.createCards([
      { deck_id: legacy.id, front: 'w1 card', back: 'a', source: { type: 'topic', ref: topicIds[0] } },
      { deck_id: legacy.id, front: 'w2 card', back: 'b', source: { type: 'topic', ref: topicIds[1] } },
      { deck_id: legacy.id, front: 'my own card', back: 'c' }
    ])
    repo.applyReview(cards[0].id, 3, 'flashcard')

    svc.organizeCourseDecks()
    const c = svc.getCourse(courseId)
    const folder = repo.listFolders('deck').find((f) => f.id === c.deck_folder_id)!
    expect(folder.name).toBe('Old course')
    const [w1, w2] = c.weeks
    expect(repo.listCards(w1.deck_id!).map((x) => x.front)).toEqual(['w1 card'])
    expect(repo.listCards(w2.deck_id!).map((x) => x.front)).toEqual(['w2 card'])
    // Review history moves with the card.
    expect(repo.getReviewState(cards[0].id)?.repetitions).toBe(1)
    expect((d.prepare('SELECT deck_id FROM review_log WHERE card_id = ?').get(cards[0].id) as { deck_id: string }).deck_id).toBe(w1.deck_id)
    // Your own cards stay together, in the folder.
    expect(repo.getDeck(legacy.id)).toMatchObject({ name: 'Old course · Other cards', folder_id: folder.id })
    expect(c.deck_id).toBe(legacy.id)
    expect(svc.getTopic(topicIds[1]).card_count).toBe(1)

    // Running it again changes nothing.
    const decksBefore = repo.listDecks().length
    svc.organizeCourseDecks()
    expect(repo.listDecks().length).toBe(decksBefore)
  })
})

describe('library export and import', () => {
  it('moves everything, with progress only when asked, and never clashes', async () => {
    // A course written with mock AI (cards, figure, note), a plain deck with an image, and some progress.
    const course = svc.createCourse({ name: 'Optics', level: '' })
    const w = svc.addWeek(course.id)
    const transcript = join(dir, 'talk.txt')
    writeFileSync(transcript, 'Light is a wave and a particle.')
    await svc.addFiles(w.id, [resolve('tests/fixtures/photoelectric-lecture.pdf'), transcript])
    await svc.planWeek(w.id, ctx())
    const [topic] = svc.listTopics(course.id)
    await svc.writeTopic(topic.id, ctx())
    svc.saveProgress(topic.id, { ...svc.getTopic(topic.id).progress, section: 2 })
    const img = `${db.uid()}.png`
    mkdirSync(join(dir, 'attachments'), { recursive: true })
    writeFileSync(join(dir, 'attachments', img), Buffer.from([1, 2, 3]))
    const deck = repo.createDeck({ name: 'Loose deck' })
    const [card] = repo.createCards([{ deck_id: deck.id, front: 'Picture', back: `![](studywise-file://attachments/${img})` }])
    repo.applyReview(card.id, 3, 'flashcard')

    const before = { decks: repo.listDecks().length, notes: repo.listNotes().length, courses: svc.listCourses().length }

    // Without progress.
    const plain = join(dir, 'plain.studywise')
    const counts = await library.exportLibrary(plain, { includeProgress: false })
    expect(counts.courses).toBeGreaterThanOrEqual(1)
    const lib = JSON.parse(await (await JSZip.loadAsync(readFileSync(plain))).file('library.json')!.async('string'))
    expect(lib.includesProgress).toBe(false)
    expect(lib.tables.review_state).toBeUndefined()
    // Paths are relative with forward slashes, so they work on Mac and Windows.
    for (const f of lib.tables.course_files) expect(f.path).toMatch(/^files\/[^\\]+$/)

    const r = await library.importLibrary(plain)
    expect(r.includesProgress).toBe(false)
    expect(repo.listDecks().length).toBe(before.decks * 2)
    expect(repo.listNotes().length).toBe(before.notes * 2)
    expect(svc.listCourses().length).toBe(before.courses * 2)

    // The copy is its own: new ids, its own folder and week deck, files on disk, nothing started.
    const copy = svc.listCourses().find((c) => c.name === 'Optics' && c.id !== course.id)!
    const full = svc.getCourse(copy.id)
    expect(full.deck_folder_id).not.toBe(svc.getCourse(course.id).deck_folder_id)
    const copyWeek = full.weeks[0]
    expect(repo.getDeck(copyWeek.deck_id!).folder_id).toBe(full.deck_folder_id)
    for (const f of copyWeek.files) expect(existsSync(f.path)).toBe(true)
    const copyTopic = copyWeek.topics[0]
    expect(copyTopic.progress.section).toBe(0)
    expect(copyTopic.card_count).toBe(svc.getTopic(topic.id).card_count)
    const copyCards = repo.listCards(copyWeek.deck_id!)
    expect(copyCards.every((c) => c.source?.ref === copyTopic.id)).toBe(true)
    expect(copyCards.every((c) => repo.getReviewState(c.id) === null)).toBe(true)
    // The topic's note points at the copy's own figure, which was copied too.
    const note = repo.getNote(copyTopic.note_id!)
    const fig = note.content.match(/studywise-file:\/\/courses\/([^/]+)\/figures\/([^)]+\.png)/)!
    expect(fig[1]).toBe(copy.id)
    expect(existsSync(join(dir, 'courses', copy.id, 'figures', fig[2]))).toBe(true)
    expect(repo.notesForDeck(copyWeek.deck_id!).map((n) => n.id)).toContain(note.id)

    // With progress.
    const withProgress = join(dir, 'progress.studywise')
    await library.exportLibrary(withProgress, { includeProgress: true })
    const r2 = await library.importLibrary(withProgress)
    expect(r2.includesProgress).toBe(true)
    expect(r2.reviews).toBeGreaterThan(0)
    const loose = repo.listDecks().filter((d) => d.name === 'Loose deck')
    expect(loose.length).toBe(4) // the original, the first copy, and copies of both
    const newest = loose.find((d) => d.id !== deck.id && repo.listCards(d.id).some((c) => repo.getReviewState(c.id)))!
    const movedCard = repo.listCards(newest.id)[0]
    expect(repo.getReviewState(movedCard.id)?.repetitions).toBe(1)
    expect(movedCard.back).toBe(`![](studywise-file://attachments/${img})`)
  }, 60_000)

  it('rejects other files and makes names safe on every system', async () => {
    const bogus = join(dir, 'bogus.studywise')
    const zip = new JSZip()
    zip.file('hello.txt', 'hi')
    writeFileSync(bogus, await zip.generateAsync({ type: 'nodebuffer' }))
    await expect(library.importLibrary(bogus)).rejects.toThrow(/isn’t a Studywise library/)
    expect(library.safeFileName('Week 1: intro?.pdf')).toBe('Week 1- intro-.pdf')
    expect(library.safeFileName('CON.txt')).toBe('_CON.txt')
  })
})
