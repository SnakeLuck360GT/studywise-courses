import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let dir: string
let svc: typeof import('../../src/main/services/course')
let repo: typeof import('../../src/main/db/repo')
let share: typeof import('../../src/main/services/weekShare')
let closeDb: () => void

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-weektest-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  repo = await import('../../src/main/db/repo')
  svc = await import('../../src/main/services/course')
  share = await import('../../src/main/services/weekShare')
})
afterAll(() => {
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

const ctx = () => ({ signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })

describe('quick revision and the number of questions', () => {
  it('quick revision sticks to the main ideas in a few short sections', () => {
    const q = svc.levelInstructions('quick')
    expect(q).toMatch(/QUICK REVISION/)
    expect(q).toMatch(/main ideas/)
    expect(q).toMatch(/2–4/)
    expect(q).toMatch(/1–2 questions per section/)
  })
  it('asks for more questions at every level when set, and nothing extra by default', () => {
    expect(svc.levelInstructions('standard')).toBe('')
    expect(svc.levelInstructions('standard', 'more')).toMatch(/4–6 questions per section, and 8–12/)
    expect(svc.levelInstructions('standard', 'lots')).toMatch(/6–8 questions per section, and 12–15/)
    expect(svc.levelInstructions('quick', 'more')).toMatch(/2–3 questions per section/)
    expect(svc.levelInstructions('deep', 'lots')).toMatch(/7–8 questions per section/)
    // Adding sections to a written topic asks for its own few test questions.
    expect(svc.levelInstructions('standard', 'more', false)).not.toMatch(/topic test/)
  })
  it('reads the setting, falling back to the usual amount', () => {
    expect(svc.questionAmount()).toBe('usual')
    repo.setSetting('course.questions', 'lots')
    expect(svc.questionAmount()).toBe('lots')
    repo.setSetting('course.questions', 'nonsense')
    expect(svc.questionAmount()).toBe('usual')
  })
})

describe('end-of-week test (mock AI)', () => {
  it('writes a multiple-choice test at a difficulty, keeps scores, and shares without them', async () => {
    const course = svc.createCourse({ name: 'Optics', level: 'first-year' })
    const w = svc.addWeek(course.id)
    await svc.addFiles(w.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(w.id, ctx())
    expect(svc.getCourse(course.id).weeks[0].test).toBeNull()

    const r = await svc.writeWeekTest(w.id, ctx(), 'hard')
    expect(r.questions).toBe(svc.weekTestCount(3))
    const test = svc.getCourse(course.id).weeks[0].test!
    expect(test.difficulty).toBe('hard')
    expect(test.questions.every((q) => q.type === 'mcq' && q.options.length === 4)).toBe(true)
    expect(test.questions[0].topic).toBe('What the photoelectric effect is')
    expect(test.best).toBeNull()

    svc.saveWeekTestScore(w.id, 6, 9)
    svc.saveWeekTestScore(w.id, 3, 9)
    const scored = svc.getCourse(course.id).weeks[0].test!
    expect(scored.last).toMatchObject({ score: 3, total: 9 })
    expect(scored.best).toMatchObject({ score: 6, total: 9 })

    // Shared or published: the questions go, your scores don't, and taking it again isn't a change.
    const hash = share.weekContentHash(w.id)
    const { json } = await share.weekZip(w.id)
    const sent = JSON.parse(String(json.week.test))
    expect(sent.questions.length).toBe(test.questions.length)
    expect(sent.best).toBeNull()
    svc.saveWeekTestScore(w.id, 9, 9)
    expect(share.weekContentHash(w.id)).toBe(hash)

    expect(svc.deleteWeekTest(w.id).test).toBeNull()
  })
  it('uses the written notes for a week with no files', async () => {
    const course = svc.createCourse({ name: 'Notes only', level: 'first-year' })
    const w = svc.addWeek(course.id)
    await expect(svc.writeWeekTest(w.id, ctx(), 'easy')).rejects.toThrow(/Add files/)
  })
})

describe('cutting flashcards down to key content (mock AI)', () => {
  it('says how many to keep at each level', () => {
    expect(svc.cutInstructions('light', 40)).toMatch(/keep about 30 of the 40/)
    expect(svc.cutInstructions('medium', 40)).toMatch(/keep about 20 of the 40/)
    expect(svc.cutInstructions('heavy', 40)).toMatch(/keep about 10 of the 40/)
    expect(svc.cutInstructions('heavy', 40)).toMatch(/essentials/)
  })
  it('suggests more cards to remove when cutting than when trimming', async () => {
    const course = svc.createCourse({ name: 'Cut', level: 'first-year' })
    const w = svc.addWeek(course.id)
    const deckId = svc.ensureWeekDeck(w.id)
    repo.createCards(Array.from({ length: 8 }, (_, i) => ({ deck_id: deckId, front: `What is term ${i}?`, back: `Meaning ${i}` })) as never)
    const trim = await svc.suggestTrim({ weekId: w.id })
    const cut = await svc.suggestTrim({ weekId: w.id, cut: 'medium' })
    expect(trim.total).toBe(8)
    expect(trim.remove.length).toBe(0)
    expect(cut.remove.length).toBe(4)
  })
})

describe('what kind of course it is (theory, practical, formula heavy)', () => {
  it('tailors every prompt for the course to what is ticked', async () => {
    const ai = await import('../../src/main/ai')
    const course = svc.createCourse({ name: 'Signals', level: 'second-year' })
    const w = svc.addWeek(course.id)
    const deckId = svc.ensureWeekDeck(w.id)
    const prompt = () => ai.renderPrompt({ task: 'course_week_test', vars: { module: 'Signals' }, deckId }).prompt
    expect(prompt()).not.toMatch(/WHAT KIND OF COURSE/)

    const c = svc.setCourseFocus(course.id, ['formula', 'practical', 'formula'])
    expect(c.focus).toEqual(['practical', 'formula'])
    expect(svc.getCourse(course.id).focus).toEqual(['practical', 'formula'])
    const p = prompt()
    expect(p).toMatch(/WHAT KIND OF COURSE THIS IS/)
    expect(p).toMatch(/PRACTICAL \/ CODING HEAVY/)
    expect(p).toMatch(/FORMULA AND METHOD HEAVY/)
    expect(p).not.toMatch(/THEORY HEAVY/)
    expect(p).toMatch(/balance them/)

    svc.setCourseFocus(course.id, [])
    expect(prompt()).not.toMatch(/WHAT KIND OF COURSE/)
  })
})
