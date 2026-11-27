import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  sanitizeQuestion,
  parseBlanks,
  markCourseAnswer,
  pageList,
  mergeOutlines,
  wordTokens,
  type CourseQuestion,
  type CourseOutline
} from '@shared/course'

const extra = { hint: '', why: '' }

describe('course questions', () => {
  it('parses blanks with alternatives', () => {
    const b = parseBlanks('Passing tests is [[evidence|support]] of correctness, not [[proof]].')
    expect(b.answers).toEqual(['evidence', 'proof'])
    expect(b.alternatives[0]).toEqual(['evidence', 'support'])
    expect(b.segments.filter((s) => s.type === 'blank')).toHaveLength(2)
  })

  it('accepts alternative answers in fill_blank', () => {
    const q: CourseQuestion = { type: 'fill_blank', text: 'Passing tests is [[evidence|support]] of correctness, not [[proof]].', ...extra }
    expect(markCourseAnswer(q, { type: 'fill_blank', values: ['Support', 'proofs'] })?.verdict).toBe('correct')
    expect(markCourseAnswer(q, { type: 'fill_blank', values: ['evidence', 'truth'] })?.verdict).toBe('wrong')
  })

  it('drops wrong_word questions whose word is missing or repeated', () => {
    const base = { type: 'wrong_word' as const, correct: 'lowest', ...extra }
    expect(sanitizeQuestion({ ...base, text: 'The threshold is the highest frequency.', wrong: 'highest' })).not.toBeNull()
    expect(sanitizeQuestion({ ...base, text: 'The highest is the highest frequency.', wrong: 'highest' })).toBeNull()
    expect(sanitizeQuestion({ ...base, text: 'The threshold is the top frequency.', wrong: 'highest' })).toBeNull()
  })

  it('marks wrong_word by the tapped word, ignoring punctuation', () => {
    const q: CourseQuestion = { type: 'wrong_word', text: 'Electrons leave after a delay.', wrong: 'delay', correct: 'instant', ...extra }
    const idx = wordTokens(q.text).findIndex((t) => t.startsWith('delay'))
    expect(markCourseAnswer(q, { type: 'wrong_word', index: idx })?.verdict).toBe('correct')
    expect(markCourseAnswer(q, { type: 'wrong_word', index: 0 })?.verdict).toBe('wrong')
  })

  it('marks order by position, only correct when all are right', () => {
    const q: CourseQuestion = { type: 'order', q: 'Order', items: ['a', 'b', 'c', 'd'], ...extra }
    expect(markCourseAnswer(q, { type: 'order', order: [0, 1, 2, 3] })?.verdict).toBe('correct')
    const m = markCourseAnswer(q, { type: 'order', order: [0, 1, 3, 2] })!
    expect(m.verdict).not.toBe('correct')
    expect(m.detail?.wrongItems).toEqual([2, 3])
  })

  it('marks mcq, true_false, match and sort through the Learn marker', () => {
    expect(markCourseAnswer({ type: 'mcq', q: 'q', options: ['a', 'b', 'c', 'd'], answer: 2, ...extra }, { type: 'multiple_choice', index: 2 })?.verdict).toBe('correct')
    expect(markCourseAnswer({ type: 'true_false', q: 's', answer: false, ...extra }, { type: 'true_false', value: true })?.verdict).toBe('wrong')
    const match: CourseQuestion = { type: 'match', q: 'm', pairs: [{ term: 'a', meaning: '1' }, { term: 'b', meaning: '2' }, { term: 'c', meaning: '3' }], ...extra }
    expect(markCourseAnswer(match, { type: 'match_pairs', mapping: { 0: 0, 1: 1, 2: 2 } })?.verdict).toBe('correct')
    const sort: CourseQuestion = { type: 'sort', q: 's', buckets: ['Wave', 'Particle'], items: [{ item: 'x', bucket: 'wave' }, { item: 'y', bucket: 'Particle' }, { item: 'z', bucket: 'Wave' }], ...extra }
    expect(markCourseAnswer(sanitizeQuestion(sort)!, { type: 'categorize', assignments: { 0: 'Wave', 1: 'Particle', 2: 'Wave' } })?.verdict).toBe('correct')
  })

  it('reads page ranges and ignores timestamps', () => {
    expect(pageList('slides 4–7', 20)).toEqual([4, 5, 6, 7])
    expect(pageList('pp. 3-4, 9', 20)).toEqual([3, 4, 9])
    expect(pageList('pages 18–25', 20)).toEqual([18, 19, 20])
    expect(pageList('12:30–31:00', 20)).toEqual([])
  })

  it('merges per-file outlines by title and renumbers ids', () => {
    const t = (id: string, title: string, needs: string[] = []) => ({ id, title, goal: '', sections: [title], sources: [], needs, stressed: [], minutes: 10 })
    const a: CourseOutline = { course: 'C', topics: [t('t1', 'Intro'), t('t2', 'Testing', ['t1'])] }
    const b: CourseOutline = { course: '', topics: [t('t1', 'testing'), t('t2', 'Refactoring', ['t1'])] }
    const m = mergeOutlines([a, b])
    expect(m.topics.map((x) => [x.id, x.title])).toEqual([
      ['t1', 'Intro'],
      ['t2', 'Testing'],
      ['t3', 'Refactoring']
    ])
    // b's t1 was "testing", which became t2.
    expect(m.topics[2].needs).toEqual(['t2'])
    expect(m.topics[1].needs).toEqual(['t1'])
  })
})

// ---------------------------------------------------------------------------
// The whole flow with mock AI: plan, write, figures, recall, marking.

let dir: string
let svc: typeof import('../../src/main/services/course')
let closeDb: () => void

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-course-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  svc = await import('../../src/main/services/course')
})
afterAll(() => {
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})

const ctx = () => ({ signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} })
type LivePatch = { stage?: string; percent?: number | null }
const recording = (seen: LivePatch[]) => ({ ...ctx(), live: (p: LivePatch) => void seen.push(p) })

describe('course service (mock AI)', () => {
  it('plans, writes a topic, renders its figure and serves recall cards', async () => {
    expect(process.env.AI_MOCK).toBe('1')
    const transcript = join(dir, 'transcript.txt')
    writeFileSync(transcript, 'So, the photoelectric effect. This is important, it will come up. Electrons come out instantly.')
    const course = svc.createCourse({ name: 'Quantum 101', level: 'first-year physics' })
    const w1 = svc.addWeek(course.id)
    expect(w1.label).toBe('Week 1')
    await expect(svc.planWeek(w1.id, ctx())).rejects.toThrow(/Add files/)
    await svc.addFiles(w1.id, [resolve('tests/fixtures/photoelectric-lecture.pdf'), transcript])
    expect(svc.listFiles(course.id).map((f) => [f.name, f.pages])).toEqual([
      ['photoelectric-lecture.pdf', 12],
      ['transcript.txt', null]
    ])

    expect(await svc.planWeek(w1.id, ctx())).toEqual({ topics: 3 })
    const topics = svc.listTopics(course.id)
    expect(topics.map((t) => [t.key, t.status])).toEqual([
      ['w1t1', 'planned'],
      ['w1t2', 'planned'],
      ['w1t3', 'planned']
    ])
    expect(topics[1].plan.needs).toEqual(['w1t1'])

    // Week 2 has its own files; its keys don't clash and it lists after week 1.
    const w2 = svc.addWeek(course.id, 'Week 2: more')
    await svc.addFiles(w2.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    expect(svc.listFiles(course.id).map((f) => f.name)).toEqual(['photoelectric-lecture.pdf', 'transcript.txt', 'photoelectric-lecture (2).pdf'])
    await svc.planWeek(w2.id, ctx())
    const all = svc.listTopics(course.id)
    expect(all.map((t) => t.key)).toEqual(['w1t1', 'w1t2', 'w1t3', 'w2t1', 'w2t2', 'w2t3'])
    expect(svc.getCourse(course.id).weeks.map((w) => [w.label, w.topics.length, w.files.length])).toEqual([
      ['Week 1', 3, 2],
      ['Week 2: more', 3, 1]
    ])

    // Topic 2 uses pages 5–8, so page 2 of the excerpt is page 6 of the PDF.
    const seen: LivePatch[] = []
    const r = await svc.writeTopic(topics[1].id, recording(seen))
    const stages = seen.map((p) => p.stage).filter(Boolean)
    expect(stages.some((x) => /^Reading /.test(x!))).toBe(true)
    expect(stages.some((x) => /^Writing section 3 of 3/.test(x!))).toBe(true)
    expect(stages.some((x) => /topic check/.test(x!))).toBe(true)
    expect(stages.some((x) => /recall cards/.test(x!))).toBe(true)
    const pcts = seen.map((p) => p.percent).filter((x): x is number => typeof x === 'number')
    expect(Math.max(...pcts)).toBeGreaterThan(0.9)
    expect(r.cards).toBe(4)
    const t2 = svc.getTopic(topics[1].id)
    expect(t2.status).toBe('ready')
    expect(t2.card_count).toBe(4)
    const fig = t2.content!.sections.find((s) => s.figure)!.figure!
    expect(fig.page).toBe(6)
    const url = await svc.figureUrl(fig.fileId, fig.page)
    expect(url).toMatch(/^studywise-file:\/\/courses\/.+\.png$/)
    expect(existsSync(join(dir, 'courses', course.id, 'figures', `${fig.fileId}-p6.png`))).toBe(true)

    // Every question survived sanitising, all eight types.
    const types = new Set(t2.content!.sections.flatMap((s) => s.questions.map((q) => q.type)))
    expect(types.size).toBe(8)

    // Each section keeps the flashcards Claude tied to it, shown before its questions.
    expect(t2.content!.sections.map((s) => (s.cards ?? []).map((c) => c.front))).toEqual([
      ['What is a photoelectron?'],
      ['What is the work function?', 'What is the threshold frequency?'],
      // Its answer is two bullets, so the question says (2).
      ['Does brighter light give faster photoelectrons? (2)']
    ])
    // They point at their deck cards, and rating one schedules it (by id, or by front for older topics).
    const sc = t2.content!.sections[1].cards![0]
    expect(sc.id).toBeTruthy()
    expect(svc.rateTopicCard(t2.id, sc.front, 1, sc.id).cardId).toBe(sc.id)
    expect(svc.rateTopicCard(t2.id, `  ${sc.front} `, 3).cardId).toBe(sc.id)
    expect((await import('../../src/main/db/repo')).getReviewState(sc.id!)).toBeTruthy()

    // No recall until another topic has been started.
    await svc.writeTopic(topics[0].id, ctx())
    expect(svc.recallCard(course.id, topics[0].id)).toBeNull()
    svc.saveProgress(topics[1].id, { ...t2.progress, section: 1 })
    const rc = svc.recallCard(course.id, topics[0].id)
    expect(rc?.topicTitle).toBe(t2.content!.title)
    svc.recallReview(rc!.card.id, true)

    // Rewriting replaces the topic's cards rather than adding more.
    await svc.writeTopic(topics[1].id, ctx())
    expect(svc.getTopic(topics[1].id).card_count).toBe(4)

    const explainQ = t2.content!.sections[2].questions.find((q) => q.type === 'explain')!
    if (explainQ.type !== 'explain') throw new Error('expected explain')
    const good = await svc.markExplain(course.id, explainQ, 'Each photon has too little energy and one photon frees one electron, more photons does not help')
    expect(good.mark.verdict).toBe('correct')
    const empty = await svc.markExplain(course.id, explainQ, '  ')
    expect(empty.mark.score).toBe(0)

    // Writing a topic makes its note (in the course's folder, with the figure); rewriting updates the same one.
    const noteId = svc.getTopic(topics[1].id).note_id!
    expect(noteId).toBeTruthy()
    const repoMod = await import('../../src/main/db/repo')
    const note = repoMod.getNote(noteId)
    expect(note.title).toBe(t2.content!.title)
    expect(note.week).toBe('1')
    expect(note.content).toContain('## Key terms:')
    expect(note.content).toMatch(/!\[.*\]\(studywise-file:\/\/courses\/.+\.png\)/)
    // Notes are filed by week: Quantum 101 › Week 1.
    const noteFolders = repoMod.listFolders('note')
    const weekFolder = noteFolders.find((f) => f.id === note.folder_id)
    expect(weekFolder?.name).toBe('Week 1')
    expect(noteFolders.find((f) => f.id === weekFolder?.parent_id)?.name).toBe('Quantum 101')
    expect(await svc.syncTopicNote(topics[1].id)).toBe(noteId)

    // Recall reaches back into earlier weeks.
    const w2t1 = all[3]
    await svc.writeTopic(w2t1.id, ctx())
    svc.saveProgress(topics[0].id, { ...svc.getTopic(topics[0].id).progress, section: 2 })
    expect(svc.recallCard(course.id, w2t1.id)?.topicTitle).toBe(svc.getTopic(topics[0].id).content!.title)

    // Recall cards go in a deck per week, inside a Decks folder named after the course.
    const full = svc.getCourse(course.id)
    expect(full.deck_id).toBeNull()
    const folder = repoMod.listFolders('deck').find((f) => f.id === full.deck_folder_id)
    expect(folder?.name).toBe('Quantum 101')
    const [wk1, wk2] = full.weeks
    expect(repoMod.getDeck(wk1.deck_id!)).toMatchObject({ name: 'Quantum 101 · Week 1', folder_id: folder!.id })
    expect(repoMod.getDeck(wk2.deck_id!)).toMatchObject({ name: 'Quantum 101 · Week 2: more', folder_id: folder!.id })
    expect(repoMod.listCards(wk1.deck_id!)).toHaveLength(8) // two week-1 topics × 4
    expect(repoMod.listCards(wk2.deck_id!)).toHaveLength(4)
    expect(repoMod.getNote(noteId).deck_ids).toContain(wk1.deck_id)
    expect(svc.dueCards(course.id).length).toBeGreaterThan(0)

    // Renaming keeps the folder and decks in step.
    svc.renameWeek(wk2.id, 'Week 2')
    expect(repoMod.getDeck(wk2.deck_id!).name).toBe('Quantum 101 · Week 2')
    svc.renameCourse(course.id, 'Quantum')
    expect(repoMod.listFolders('deck').find((f) => f.id === folder!.id)?.name).toBe('Quantum')
    expect(repoMod.getDeck(wk1.deck_id!).name).toBe('Quantum · Week 1')

    // Models & instructions apply to every week deck, and new weeks pick them up.
    svc.setCourseDeckSettings(course.id, { extra_instructions: 'Use SI units', model_overrides: { course_topic: { model: 'opus', effort: null } }, thresholds: null })
    expect(repoMod.getDeck(wk2.deck_id!).extra_instructions).toBe('Use SI units')
    const w3 = svc.addWeek(course.id)
    expect(repoMod.getDeck(w3.deck_id!).model_overrides.course_topic?.model).toBe('opus')
    svc.deleteWeek(w3.id)

    // Deleting a week takes its deck, topics and their cards with it.
    svc.deleteWeek(w2.id)
    expect(() => repoMod.getDeck(wk2.deck_id!)).toThrow()
    expect(svc.listTopics(course.id)).toHaveLength(3)
    expect(svc.listFiles(course.id)).toHaveLength(2)

    // Deleting the course takes the folder and its decks.
    svc.deleteCourse(course.id, false)
    expect(svc.listCourses()).toHaveLength(0)
    expect(repoMod.listFolders('deck').some((f) => f.id === folder!.id)).toBe(false)
    expect(() => repoMod.getDeck(wk1.deck_id!)).toThrow()
  }, 60_000)
})

describe('live progress parsing', () => {
  it('reads finished and half-written strings out of partial JSON', async () => {
    const { stringValues } = await import('../../src/main/services/liveProgress')
    const json = '{"sections":[{"heading":"What is IFT?","notes":"This is \\"the\\" idea.\\nMore"},{"heading":"Rename vs Mo'
    expect(stringValues(json, 'heading')).toEqual({ done: ['What is IFT?'], open: 'Rename vs Mo' })
    expect(stringValues(json, 'notes').done).toEqual(['This is "the" idea.\nMore'])
  })
})

describe('multiple-choice shuffling', () => {
  it('moves the answer index with its option, and keeps every option', async () => {
    const { shuffleOptions } = await import('@shared/course')
    const opts = ['right', 'wrong a', 'wrong b', 'wrong c']
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) {
      const s = shuffleOptions(opts, 0)
      expect(s.options[s.answer]).toBe('right')
      expect([...s.options].sort()).toEqual([...opts].sort())
      seen.add(s.answer)
    }
    // Over many shuffles the right answer lands in every position.
    expect(seen.size).toBe(4)
  })
})

describe('sharing a week', () => {
  it('exports a written week and imports it into a new course and into an existing one', async () => {
    const share = await import('../../src/main/services/weekShare')
    const { existsSync: exists } = await import('node:fs')
    const src = svc.createCourse({ name: 'Friend’s Quantum', level: 'first-year physics' })
    svc.addWeek(src.id, 'Week 1')
    const w2 = svc.addWeek(src.id, 'Week 2')
    await svc.addFiles(w2.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(w2.id, ctx())
    const planned = svc.listTopics(src.id)
    await svc.writeTopic(planned[0].id, ctx())
    // Their progress shouldn't travel.
    svc.saveProgress(planned[0].id, { section: 2, done: false, answered: 3, correct: 2, checkScore: null, checkTotal: null, lastStudied: null })

    const file = join(dir, 'week.studyweek')
    const out = await share.exportWeek(w2.id, file)
    expect(out).toMatchObject({ course: 'Friend’s Quantum', week: 'Week 2', topics: 3, written: 1, files: ['photoelectric-lecture.pdf'] })
    expect(out.cards).toBeGreaterThan(0)
    expect(await share.previewWeek(file)).toEqual(out)

    // Into a brand-new course: same name, the week is its first.
    const a = await share.importWeek(file, { newCourse: true })
    const ca = svc.getCourse(a.courseId)
    expect(ca.name).toBe('Friend’s Quantum')
    expect(ca.weeks.map((w) => w.label)).toEqual(['Week 2'])
    const ta = svc.listTopics(a.courseId)
    expect(ta.map((t) => t.key)).toEqual(['w1t1', 'w1t2', 'w1t3'])
    expect(ta[0].status).toBe('ready')
    expect(ta[0].progress.section).toBe(0)
    expect(ta[0].card_count).toBeGreaterThan(0)
    const fa = svc.listFiles(a.courseId)
    expect(fa.map((f) => f.name)).toEqual(['photoelectric-lecture.pdf'])
    expect(exists(fa[0].path)).toBe(true)
    // Section flashcards point at the imported deck cards, so rating them works.
    const sc = ta[0].content!.sections.flatMap((s) => s.cards ?? [])[0]
    expect(svc.rateTopicCard(ta[0].id, sc.front, 3, sc.id).cardId).toBe(sc.id)

    // Into a course that already has a "Week 2" with the same file: both get numbered, topics follow.
    const b = await share.importWeek(file, { courseId: src.id })
    const cb = svc.getCourse(b.courseId)
    expect(cb.weeks.map((w) => w.label)).toEqual(['Week 1', 'Week 2', 'Week 2 (2)'])
    const tb = svc.listTopics(src.id).filter((t) => t.week_id === b.weekId)
    expect(tb.map((t) => t.key)).toEqual(['w3t1', 'w3t2', 'w3t3'])
    expect(svc.listFiles(src.id).filter((f) => f.week_id === b.weekId).map((f) => f.name)).toEqual(['photoelectric-lecture (2).pdf'])
    expect(tb[0].plan.sources?.[0]?.file).toBe('photoelectric-lecture (2).pdf')
    // The original week is untouched.
    expect(svc.listTopics(src.id).filter((t) => t.week_id === w2.id)[0].progress.section).toBe(2)
  })
})

describe('point counts on topic cards', () => {
  it('adds a missing (n), fixes a wrong one, and leaves one-line answers and blanks alone', async () => {
    const { withPointCount } = await import('@shared/ssText')
    expect(withPointCount('What are the three places an operand can be?', '- Main memory\n- Registers\n- The instruction')).toBe('What are the three places an operand can be? (3)')
    expect(withPointCount('Name two hazards (3)', '- Data\n\n- Control')).toBe('Name two hazards (2)')
    expect(withPointCount('What is the work function?', 'The minimum energy to free an electron')).toBe('What is the work function?')
    expect(withPointCount('Each electron absorbs ___', '- one photon\n- of energy')).toBe('Each electron absorbs ___')
  })
  it('fixes existing topic cards and the same cards inside their topic', async () => {
    const repo = await import('../../src/main/db/repo')
    const { getDb } = await import('../../src/main/db')
    const t = svc.listTopics(svc.listCourses()[0].id).find((x) => x.status === 'ready')!
    const card = t.content!.sections.flatMap((s) => s.cards ?? []).find((c) => c.id)!
    // An old card: a list answer with no count, both in the deck and in the topic.
    repo.updateCard(card.id!, { front: 'List the two parts', back: '- one\n- two' })
    const content = { ...t.content!, sections: t.content!.sections.map((s) => ({ ...s, cards: (s.cards ?? []).map((c) => (c.id === card.id ? { ...c, front: 'List the two parts', back: '- one\n- two' } : c)) })) }
    getDb().prepare('UPDATE topics SET content = ? WHERE id = ?').run(JSON.stringify(content), t.id)
    expect(svc.fixTopicCardCounts()).toBeGreaterThanOrEqual(1)
    const fixed = repo.getCard(card.id!)
    expect(fixed.front).toBe('List the two parts (2)')
    expect(fixed.required_points).toBe(2)
    expect(svc.getTopic(t.id).content!.sections.flatMap((s) => s.cards ?? []).find((c) => c.id === card.id)!.front).toBe('List the two parts (2)')
    // Running again changes nothing.
    expect(svc.fixTopicCardCounts()).toBe(0)
  })
})

describe('trimming recall cards', () => {
  it('suggests cards that are only illustrations, and removing one takes it out of its topic too', async () => {
    const repo = await import('../../src/main/db/repo')
    const { getDb } = await import('../../src/main/db')
    const t = svc.listTopics(svc.listCourses()[0].id).find((x) => x.status === 'ready')!
    const week = svc.getCourse(t.course_id).weeks.find((w) => w.id === t.week_id)!
    // A trivia card, in the deck and in the topic's first section.
    const [trivia] = repo.createCards([{ deck_id: week.deck_id!, front: 'Which companies are given as examples?', back: 'Google, Amazon', source: { type: 'topic', ref: t.id, section: 'x' } }])
    const topic = svc.getTopic(t.id)
    const content = { ...topic.content!, sections: topic.content!.sections.map((s, i) => (i ? s : { ...s, cards: [...(s.cards ?? []), { front: trivia.front, back: trivia.back, id: trivia.id }] })) }
    getDb().prepare('UPDATE topics SET content = ? WHERE id = ?').run(JSON.stringify(content), t.id)

    const r = await svc.suggestTrim({ weekId: week.id })
    expect(r.total).toBeGreaterThan(1)
    expect(r.remove.map((s) => s.cardId)).toEqual([trivia.id])
    expect(r.remove[0]).toMatchObject({ topicId: t.id, reason: 'an example, not examinable' })
    // Only one topic's cards when asked.
    expect((await svc.suggestTrim({ weekId: week.id, topicId: 'some-other-topic' })).total).toBe(0)
    // The whole course at once finds it too, labelled with its week.
    const all = await svc.suggestTrim({ courseId: t.course_id })
    expect(all.remove.map((s) => s.cardId)).toEqual([trivia.id])
    expect(all.remove[0].topicTitle.startsWith(week.label + ' · ')).toBe(true)

    expect(svc.removeTopicCards([trivia.id])).toBe(1)
    expect(repo.listCards(week.deck_id!).some((c) => c.id === trivia.id)).toBe(false)
    expect(svc.getTopic(t.id).content!.sections.flatMap((s) => s.cards ?? []).some((c) => c.id === trivia.id)).toBe(false)
  })
})

describe('turning recall off for a week', () => {
  it('keeps the cards but leaves them out of recall, course review and due counts until it is back on', async () => {
    const repo = await import('../../src/main/db/repo')
    // A course with one written week, so every recall card comes from it.
    const c = svc.createCourse({ name: 'Recall toggle', level: 'first-year' })
    const w = svc.addWeek(c.id, 'Week 1')
    await svc.addFiles(w.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(w.id, ctx())
    const [t1, t2] = svc.listTopics(c.id)
    await svc.writeTopic(t1.id, ctx())
    // Finished, so all its cards are in review (cards wait until you've studied them).
    svc.saveProgress(t1.id, { section: 3, done: true, answered: 0, correct: 0, checkScore: null, checkTotal: null, lastStudied: null })
    const deck = svc.getCourse(c.id).weeks[0].deck_id!
    const cards = repo.listCards(deck).length
    expect(cards).toBeGreaterThan(0)
    expect(svc.recallCard(c.id, t2.id)).not.toBeNull()
    expect(svc.dueCards(c.id).length).toBe(cards)
    expect(repo.dueCountsByDeck().get(deck)).toBe(cards)

    expect(svc.setWeekRecall(w.id, false).recall_off).toBe(true)
    expect(svc.recallCard(c.id, t2.id)).toBeNull()
    expect(svc.dueCards(c.id)).toEqual([])
    expect(repo.dueCountsByDeck().get(deck)).toBeUndefined()
    expect(svc.listCourses().find((x) => x.id === c.id)!.due_count).toBe(0)
    // Nothing deleted, and the deck can still be reviewed by hand.
    expect(repo.listCards(deck).length).toBe(cards)
    expect(repo.dueCards(deck).length).toBe(cards)

    expect(svc.setWeekRecall(w.id, true).recall_off).toBe(false)
    expect(svc.dueCards(c.id).length).toBe(cards)
    expect(repo.dueCountsByDeck().get(deck)).toBe(cards)
  })
})

describe('cards wait until you study them', () => {
  it('a written topic adds nothing to review until you reach each section; reviewed cards stay', async () => {
    const repo = await import('../../src/main/db/repo')
    const c = svc.createCourse({ name: 'Dormancy', level: 'first-year' })
    const w = svc.addWeek(c.id, 'Week 1')
    await svc.addFiles(w.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(w.id, ctx())
    const t = svc.listTopics(c.id)[1]
    await svc.writeTopic(t.id, ctx())
    const deck = svc.getCourse(c.id).weeks[0].deck_id!
    const bySection = svc.getTopic(t.id).content!.sections.map((s) => (s.cards ?? []).map((x) => x.id!))
    const total = repo.listCards(deck).length
    // Just written: nothing due anywhere.
    expect(svc.dueCards(c.id)).toEqual([])
    expect(repo.dueCountsByDeck().get(deck)).toBeUndefined()
    expect(repo.dueCards(deck)).toEqual([])

    // At section 2's flashcards: sections 1 and 2 are in review, 3 isn't.
    const base = { done: false, answered: 0, correct: 0, checkScore: null, checkTotal: null, lastStudied: null }
    svc.saveProgress(t.id, { ...base, section: 1, step: { kind: 'cards', section: 1 } })
    expect(new Set(svc.dueCards(c.id).map((x) => x.id))).toEqual(new Set([...bySection[0], ...bySection[1]]))

    // Learn a section-2 card (two greens), then reset the topic: it stays in review, the rest wait again.
    repo.applyReview(bySection[1][0], 3, 'learn')
    repo.applyReview(bySection[1][0], 3, 'learn')
    svc.resetTopicProgress(t.id)
    const sleeping = repo.listCards(deck).filter((x) => !svc.dueCards(c.id).some((d) => d.id === x.id) && x.id !== bySection[1][0])
    expect(sleeping.length).toBe(total - 1)

    // Finished: everything's in review.
    svc.saveProgress(t.id, { ...base, section: 3, done: true })
    expect(repo.dueCountsByDeck().get(deck)).toBe(total - 1) // the learnt one isn't due again yet
  })
})

describe('exam dates', () => {
  const day = (offset: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offset)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const DAY = 86_400_000
  it('phases: steady while far off, revision for the last 6 weeks, resting after', async () => {
    const { examPhase, revisionMaxGapDays } = await import('@shared/course')
    expect(examPhase(null).phase).toBe('none')
    expect(examPhase(day(100))).toMatchObject({ phase: 'steady', days: 100, startsOn: day(58) })
    expect(examPhase(day(42))).toMatchObject({ phase: 'revision', days: 42 })
    expect(examPhase(day(-1)).phase).toBe('over')
    // The longest gap between reviews shrinks as the exam gets closer.
    expect([42, 28, 12, 6, 2, 0].map(revisionMaxGapDays)).toEqual([10, 7, 3, 1, 1, 1])
  })
  it('spaces reviews out while far off, pulls them in during revision, never past the last look', async () => {
    const { examAdjustedDue } = await import('@shared/course')
    const now = new Date()
    const in20 = new Date(now.getTime() + 20 * DAY).toISOString()
    const gap = (iso: string) => Math.round((new Date(iso).getTime() - now.getTime()) / DAY)
    expect(gap(examAdjustedDue(in20, now, null))).toBe(20)
    expect(gap(examAdjustedDue(in20, now, day(200)))).toBe(30) // steady: 1.5x further out
    expect(gap(examAdjustedDue(in20, now, day(30)))).toBe(7) // revision, 30 days left: at most 7
    expect(gap(examAdjustedDue(in20, now, day(5)))).toBeLessThanOrEqual(3) // and the last look comes before the exam
  })
  it('keeps reviewing a course far from its exam, ramps it up in revision, rests it after', async () => {
    const repo = await import('../../src/main/db/repo')
    const { getDb } = await import('../../src/main/db')
    const c = svc.createCourse({ name: 'Exam course', level: 'first-year' })
    const w = svc.addWeek(c.id, 'Week 1')
    await svc.addFiles(w.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(w.id, ctx())
    const t = svc.listTopics(c.id)[0]
    await svc.writeTopic(t.id, ctx())
    svc.saveProgress(t.id, { section: 3, done: true, answered: 0, correct: 0, checkScore: null, checkTotal: null, lastStudied: null })
    const deck = svc.getCourse(c.id).weeks[0].deck_id!
    const n = repo.listCards(deck).length

    // Far off: not quiet, everything new is still due.
    svc.setExamDate(c.id, day(90))
    expect(svc.dueCards(c.id).length).toBe(n)
    expect(repo.dueCountsByDeck().get(deck)).toBe(n)

    // A card you knew 5 days ago, next due in 60 days: not due while far off...
    const card = repo.listCards(deck)[0]
    repo.applyReview(card.id, 3, 'flashcard')
    getDb().prepare('UPDATE review_state SET last_reviewed = ?, due = ? WHERE card_id = ?').run(new Date(Date.now() - 5 * DAY).toISOString(), new Date(Date.now() + 60 * DAY).toISOString(), card.id)
    expect(svc.dueCards(c.id).some((x) => x.id === card.id)).toBe(false)
    // ...but in revision 20 days out (at most 5 days between reviews) it's due again today.
    svc.setExamDate(c.id, day(20))
    expect(svc.dueCards(c.id).some((x) => x.id === card.id)).toBe(true)
    expect(repo.dueCountsByDeck().get(deck)).toBe(n)

    // After the exam the course rests.
    svc.setExamDate(c.id, day(-1))
    expect(svc.dueCards(c.id)).toEqual([])
    expect(repo.dueCountsByDeck().get(deck)).toBeUndefined()
    expect(svc.setExamDate(c.id, null).exam_date).toBeNull()
  })
})

describe('more kinds of week files', () => {
  it('reads web pages and RTF as text, and takes pictures as files for Claude to look at', async () => {
    const files = await import('../../src/main/files')
    expect(files.htmlToText('<html><style>p{}</style><h1>Pipelines</h1><p>Fetch &amp; decode</p><ul><li>one</li><li>two</li></ul><script>x()</script></html>')).toBe('Pipelines\n\nFetch & decode\n\n- one\n\n- two')
    expect(files.rtfToText('{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs24 Hazards\\par Data and control\\par}')).toBe('Hazards\nData and control')
    const c = svc.createCourse({ name: 'File types', level: '' })
    const w = svc.addWeek(c.id, 'Week 1')
    const png = join(dir, 'whiteboard.png')
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'))
    const page = join(dir, 'reading.html')
    writeFileSync(page, '<p>Forwarding</p>')
    const added = await svc.addFiles(w.id, [png, page, join(dir, 'notes.key')])
    expect(added.map((f) => f.name)).toEqual(['whiteboard.png', 'reading.html'])
  })
})

describe('dropping a shared week into an existing week', () => {
  it('adds its topics after the week’s own, numbered on, with their cards', async () => {
    const share = await import('../../src/main/services/weekShare')
    const repo = await import('../../src/main/db/repo')
    // A friend's written week.
    const src = svc.createCourse({ name: 'Friend', level: '' })
    const fw = svc.addWeek(src.id, 'Week 1')
    await svc.addFiles(fw.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(fw.id, ctx())
    await svc.writeTopic(svc.listTopics(src.id)[0].id, ctx())
    const file = join(dir, 'merge.studyweek')
    await share.exportWeek(fw.id, file)
    // My week 2 already has its own three planned topics.
    const mine = svc.createCourse({ name: 'Mine', level: '' })
    svc.addWeek(mine.id, 'Week 1')
    const w2 = svc.addWeek(mine.id, 'Week 2')
    await svc.addFiles(w2.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(w2.id, ctx())
    const r = await share.importWeek(file, { weekId: w2.id })
    expect(r.weekId).toBe(w2.id)
    const topics = svc.listTopics(mine.id).filter((t) => t.week_id === w2.id)
    expect(topics.map((t) => t.key)).toEqual(['w2t1', 'w2t2', 'w2t3', 'w2t4', 'w2t5', 'w2t6'])
    expect(topics.filter((t) => t.status === 'ready').map((t) => t.key)).toEqual(['w2t4'])
    // The friend's topic that built on their t1 now points at its new number here.
    expect(topics[4].plan.needs).toEqual(['w2t4'])
    expect(repo.listCards(svc.getCourse(mine.id).weeks[1].deck_id!).length).toBe(r.cards)
    // The same slides the week already has: its own copy is used, not added twice.
    const w2Files = svc.listFiles(mine.id).filter((f) => f.week_id === w2.id)
    expect(w2Files.map((f) => f.name)).toEqual(['photoelectric-lecture.pdf'])
    for (const t of topics.filter((x) => x.status === 'ready')) for (const s of t.content!.sections) if (s.figure) expect(s.figure.fileId).toBe(w2Files[0].id)
  })

  it('numbers a different file that has the same name, rather than overwriting it', async () => {
    const share = await import('../../src/main/services/weekShare')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(join(a, 'notes.txt'), 'Their notes on entropy.')
    writeFileSync(join(b, 'notes.txt'), 'My own notes on enthalpy.')
    const src = svc.createCourse({ name: 'Friend 2', level: '' })
    const fw = svc.addWeek(src.id, 'Week 1')
    await svc.addFiles(fw.id, [join(a, 'notes.txt')])
    const file = join(dir, 'names.studyweek')
    await share.exportWeek(fw.id, file)
    const mine = svc.createCourse({ name: 'Mine 2', level: '' })
    const w = svc.addWeek(mine.id, 'Week 1')
    await svc.addFiles(w.id, [join(b, 'notes.txt')])
    await share.importWeek(file, { weekId: w.id })
    expect(svc.listFiles(mine.id).map((f) => f.name)).toEqual(['notes.txt', 'notes (2).txt'])
  })
})

describe('the current week on the Courses page', () => {
  it('reports each course’s latest week and picks the highest week number across courses', async () => {
    const { currentWeekNumber, currentWeekToReview } = await import('../../src/shared/course')
    const a = svc.createCourse({ name: 'Latest A', level: 'first-year' })
    svc.addWeek(a.id, 'Week 8')
    const a9 = svc.addWeek(a.id, 'Week 9')
    svc.addWeek(a.id, 'Revision') // no number: not the latest week
    await svc.addFiles(a9.id, [resolve('tests/fixtures/photoelectric-lecture.pdf')])
    await svc.planWeek(a9.id, ctx())
    const b = svc.createCourse({ name: 'Latest B', level: 'first-year' })
    svc.addWeek(b.id, 'Week 8')

    const latest = (id: string) => svc.listCourses().find((x) => x.id === id)!
    const topics = svc.listTopics(a.id)
    expect(latest(a.id).latest_week).toMatchObject({ id: a9.id, number: 9, topic_count: topics.length, done_count: 0 })
    expect(latest(b.id).latest_week).toMatchObject({ number: 8, topic_count: 0 })

    const current = currentWeekNumber([latest(a.id), latest(b.id)])
    expect(current).toBe(9)
    expect(currentWeekToReview(latest(a.id), current)?.id).toBe(a9.id)
    expect(currentWeekToReview(latest(b.id), current)).toBeNull() // no week 9 yet

    // Every topic done: reviewed, so it stops showing.
    for (const t of topics) svc.saveProgress(t.id, { section: 0, done: true, answered: 0, correct: 0, checkScore: null, checkTotal: null, lastStudied: null })
    expect(latest(a.id).latest_week!.done_count).toBe(topics.length)
    expect(currentWeekToReview(latest(a.id), current)).toBeNull()
    expect(currentWeekNumber([])).toBeNull()
  })
})
