import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeQuestions, withQuestionJudge, questionId, type QuestionJudge } from '../../src/shared/weekMerge'
import type { CourseQuestion } from '../../src/shared/course'

const mcq = (q: string, explain = ''): CourseQuestion => ({ type: 'mcq', q, options: ['a', 'b', 'c'], answer: 0, hint: '', why: explain }) as unknown as CourseQuestion

describe('merging questions with the repeat check', () => {
  const a = [mcq('What is the work function?'), mcq('What is a photon?')]
  const b = [mcq('Define the work function', 'the minimum energy to free an electron, in eV'), mcq('What is threshold frequency?')]

  it('without a judge, only exact repeats go (as before)', () => {
    expect(mergeQuestions(a, b)).toHaveLength(4)
  })

  it('keeps the fuller of a pair word for word, in the first copy’s place, and never changes a question', () => {
    const judge: QuestionJudge = { same: (x, y) => (questionId(x) === questionId(a[0]) && questionId(y) === questionId(b[0]) ? 'b' : null) }
    const out = withQuestionJudge(judge, () => mergeQuestions(a, b))
    expect(out).toEqual([b[0], a[1], b[1]])
    // Never fewer than either copy.
    expect(out.length).toBeGreaterThanOrEqual(Math.max(a.length, b.length))
  })

  it('pairs one to one: two of one copy are never folded into one of the other', () => {
    const judge: QuestionJudge = { same: () => 'a' }
    const out = withQuestionJudge(judge, () => mergeQuestions([mcq('x')], [mcq('y'), mcq('z')]))
    expect(out.map((q) => (q as { q: string }).q)).toEqual(['x', 'z'])
  })

  it('collects what a merge combines, and leaves no judge behind', () => {
    const seen: number[] = []
    withQuestionJudge({ seen: (x, y) => seen.push(x.length, y.length) }, () => mergeQuestions(a, b))
    expect(seen).toEqual([2, 2])
    expect(mergeQuestions(a, b)).toHaveLength(4)
  })
})

describe('the AI repeat check (mock AI)', () => {
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sw-dedupe-'))
    const { openDb } = await import('../../src/main/db')
    openDb(join(dir, 't.db'))
    const { seedPresets } = await import('../../src/main/ai/presets')
    seedPresets()
  })
  afterAll(async () => {
    const { closeDb } = await import('../../src/main/db')
    closeDb()
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds reworded repeats across copies and keeps the fuller one', async () => {
    const { questionCollector, askAboutRepeats } = await import('../../src/main/services/questionDedupe')
    const a = [mcq('What is the work function?'), mcq('What is a photon?')]
    const b = [mcq('The work function is what?', 'the minimum energy to free an electron'), mcq('What is threshold frequency?')]
    const collect = questionCollector()
    withQuestionJudge(collect.judge, () => mergeQuestions(a, b))
    expect(collect.groups).toHaveLength(1)
    const check = await askAboutRepeats(collect.groups, { module: 'Physics' })
    expect(check.checked).toBe(true)
    expect(check.pairs).toBe(1)
    const out = withQuestionJudge(check.judge, () => mergeQuestions(a, b))
    expect(out).toEqual([b[0], a[1], b[1]])
  })
})
