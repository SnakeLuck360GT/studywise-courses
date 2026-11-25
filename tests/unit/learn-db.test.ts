import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, closeDb } from '../../src/main/db'
import * as repo from '../../src/main/db/repo'
import { seedPresets } from '../../src/main/ai/presets'
import * as learn from '../../src/main/services/learn'
import { CHANNELS } from '@shared/channels'
import { QUESTION_TYPES } from '@shared/types'

let dir: string
let deckId: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-learn-'))
  openDb(join(dir, 't.db'))
  seedPresets()
  // Checks the difficulty-based scheduler's numbers (lapses); the StudySmarter one is in traffic.test.ts.
  repo.setSetting('review.scheduler', 'adaptive')
  deckId = repo.createDeck({ name: 'Learn' }).id
  repo.createCards([
    { deck_id: deckId, front: 'What is the work function?', back: 'the **minimum energy** to remove an electron' },
    { deck_id: deckId, front: 'Each electron absorbs ______', back: 'one photon', kind: 'cloze', cloze_answers: ['one photon'] },
    { deck_id: deckId, front: 'State 2 facts (2)', back: '- one\n\n- two' },
    { deck_id: deckId, front: 'E = ?', back: 'E = hf' },
    { deck_id: deckId, front: 'Unit of frequency?', back: 'hertz' },
    { deck_id: deckId, front: 'Planck constant symbol?', back: 'h' }
  ])
})
afterAll(() => {
  closeDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('card fields', () => {
  it('derives required_points and cloze kind on save', () => {
    const cards = repo.listCards(deckId)
    expect(cards[2].required_points).toBe(2)
    expect(cards[1].kind).toBe('cloze')
    const c = repo.updateCard(cards[3].id, { front: 'Name 3 things (3)' })
    expect(c.required_points).toBe(3)
  })
})

describe('learn sessions (AI_MOCK)', () => {
  it('plans only types a card can take', () => {
    const cards = repo.listCards(deckId)
    const types = Object.fromEntries(QUESTION_TYPES.map((t) => [t, t === 'fill_blank' || t === 'read_understand']))
    const plan = learn.planSession(cards, { types, sessionLength: 20, shuffle: false })
    expect(plan.every((p) => p.type === 'fill_blank' || p.type === 'read_understand')).toBe(true)
    // Only the bold-answer card and the cloze card have blanks.
    const blankIds = [cards[0].id, cards[1].id]
    const withBlanks = plan.filter((p) => p.type === 'fill_blank').map((p) => p.card_id)
    expect(withBlanks.length).toBeGreaterThan(0)
    expect(withBlanks.every((id) => blankIds.includes(id))).toBe(true)
    expect(() => learn.planSession(cards, { types: Object.fromEntries(QUESTION_TYPES.map((t) => [t, false])), sessionLength: 5, shuffle: false })).toThrow()
  })
  it('builds every question type, caches, marks and overrides', async () => {
    const all = Object.fromEntries(QUESTION_TYPES.map((t) => [t, true]))
    repo.updateDeck(deckId, { learn_settings: { types: all, sessionLength: 20, shuffle: false } })
    const { sessionId, total } = learn.startSession(deckId)
    expect(total).toBeGreaterThanOrEqual(6)
    const batch = await learn.getBatch(sessionId, 0)
    expect(batch.length).toBeGreaterThan(0)
    // Force each type on one card and check it builds.
    const cards = repo.listCards(deckId)
    const qs = await learn.buildQuestions(deckId, [
      { type: 'multiple_choice', card_id: cards[0].id, card_ids: [cards[0].id] },
      { type: 'true_false', card_id: cards[0].id, card_ids: [cards[0].id] },
      { type: 'free_answer', card_id: cards[2].id, card_ids: [cards[2].id] },
      { type: 'read_understand', card_id: cards[3].id, card_ids: [cards[3].id] },
      { type: 'fill_blank', card_id: cards[1].id, card_ids: [cards[1].id] },
      { type: 'choice_blank', card_id: cards[0].id, card_ids: [cards[0].id] },
      { type: 'match_pairs', card_id: cards[0].id, card_ids: cards.slice(0, 4).map((c) => c.id) },
      { type: 'categorize', card_id: cards[0].id, card_ids: cards.map((c) => c.id) }
    ])
    expect(qs.map((q) => q.type)).toEqual(['multiple_choice', 'true_false', 'free_answer', 'read_understand', 'fill_blank', 'choice_blank', 'match_pairs', 'categorize'])
    const again = await learn.buildQuestions(deckId, [{ type: 'multiple_choice', card_id: cards[0].id, card_ids: [cards[0].id] }])
    expect(again[0].cached).toBe(true)

    const mc = qs[0]
    if (mc.type !== 'multiple_choice') throw new Error()
    const wrongIdx = (mc.payload.correct_index + 1) % 4
    const r = await learn.submitAnswer(sessionId, deckId, mc, { type: 'multiple_choice', index: wrongIdx })
    expect(r.mark.verdict).toBe('wrong')
    expect(repo.getReviewState(mc.card_id)?.lapses).toBe(1)
    const fb = await learn.feedbackFor(r.attemptId)
    expect(fb.kind).toBe('wrong')
    const wrongState = repo.getReviewState(mc.card_id)
    const o = learn.overrideAttempt(r.attemptId)
    expect(o.verdict).toBe('correct')
    expect(repo.getReviewState(mc.card_id)?.lapses).toBe(0)
    // "I was right" can be undone: the first mark and its schedule come back.
    const u = learn.undoOverride(r.attemptId)
    expect(u.verdict).toBe(r.mark.verdict)
    expect(repo.getReviewState(mc.card_id)).toEqual(wrongState)
    expect(() => learn.undoOverride(r.attemptId)).toThrow()
    expect(learn.overrideAttempt(r.attemptId).verdict).toBe('correct')

    const free = qs[2]
    const fr = await learn.submitAnswer(sessionId, deckId, free, { type: 'free_answer', text: 'one two' })
    expect(fr.mark.by).toBe('ai')
    const fill = qs[4]
    const fl = await learn.submitAnswer(sessionId, deckId, fill, { type: 'fill_blank', values: ['one photons'] })
    expect(fl.mark).toMatchObject({ verdict: 'correct', by: 'code' })
    const hint = await learn.hintFor(cards[0].id, mc, 0, [])
    expect(hint.source).toBe('ai')
    const stats = learn.endSession(sessionId)
    expect(stats.answered).toBe(3)
  })
  it('deck stats', () => {
    const s = repo.deckStats(deckId)
    expect(s.activity).toHaveLength(7)
    expect(s.total).toBe(6)
  })
})

describe('IPC channel list', () => {
  it('matches the handler names in ipc.ts', () => {
    const src = readFileSync(join(__dirname, '../../src/main/ipc.ts'), 'utf8')
    const body = src.slice(src.indexOf('export const handlers = {'), src.indexOf('} as const'))
    const found: string[] = []
    let dom = ''
    for (const line of body.split(/\r?\n/)) {
      const d = line.match(/^ {2}(\w+): \{$/)
      if (d) dom = d[1]
      const m = line.match(/^ {4}(\w+): h\(/)
      if (m && dom) found.push(`${dom}.${m[1]}`)
    }
    expect([...CHANNELS]).toEqual(found)
  })
})
