// The one AI step in merging weeks: spotting questions from two copies that ask
// the same thing in different words. The AI only compares; it never writes.
// Each pair it finds keeps one question word for word (the one with everything
// the other has), and everything else about the merge stays as it is (see
// @shared/weekMerge). A pair is only ever one question from each copy, so the
// merged week has at least as many questions as either copy. If the AI can't
// be reached (offline, not set up, an error), the merge goes ahead without it.

import type { CourseDedupeOut, CourseQuestion } from '@shared/course'
import { questionId, type QuestionJudge } from '@shared/weekMerge'
import { friendlyError, runAI } from '../ai'

interface Group {
  a: CourseQuestion[]
  b: CourseQuestion[]
}

/** Each question as one line: what the AI needs to compare (question, options, answer, explanation, marks). */
function line(q: CourseQuestion): string {
  return JSON.stringify(q).replace(/\s+/g, ' ')
}

/** Groups per AI call, so a big week doesn't make one huge prompt. */
const BATCH_CHARS = 60_000

/** A judge that collects every pair of question lists a merge combines. */
export function questionCollector(): { judge: QuestionJudge; groups: Group[] } {
  const groups: Group[] = []
  const seen = new Set<string>()
  return {
    groups,
    judge: {
      seen: (a, b) => {
        const k = `${a.map(questionId).join('\u0001')}\u0002${b.map(questionId).join('\u0001')}`
        if (seen.has(k)) return
        seen.add(k)
        groups.push({ a, b })
      }
    }
  }
}

/**
 * Asks the AI which questions in these groups are repeats, and returns a judge
 * that answers for the real merge. Never throws: no answer means no repeats.
 */
export async function askAboutRepeats(
  groups: Group[],
  opts: {
    module: string
    deckId?: string | null
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
  }
): Promise<{ judge: QuestionJudge; pairs: number; checked: boolean; error?: string | null }> {
  const decisions = new Map<string, 'a' | 'b'>()
  const key = (a: CourseQuestion, b: CourseQuestion) => `${questionId(a)}\u0000${questionId(b)}`
  const judge: QuestionJudge = {
    same: (a, b) => decisions.get(key(a, b)) ?? null
  }
  if (!groups.length) return { judge, pairs: 0, checked: true }

  const batches: Group[][] = []
  let cur: Group[] = []
  let size = 0
  for (const g of groups) {
    const n = [...g.a, ...g.b].reduce((t, q) => t + line(q).length, 0)
    if (cur.length && size + n > BATCH_CHARS) {
      batches.push(cur)
      cur = []
      size = 0
    }
    cur.push(g)
    size += n
  }
  if (cur.length) batches.push(cur)

  let checked = true
  let error: string | null = null
  for (const [bi, batch] of batches.entries()) {
    if (opts.signal?.aborted) break
    opts.onProgress?.(bi, batches.length)
    const text = batch.map((g, i) => [`### Group ${i + 1}`, 'List A:', ...g.a.map((q, j) => `A${j + 1}. ${line(q)}`), 'List B:', ...g.b.map((q, j) => `B${j + 1}. ${line(q)}`)].join('\n')).join('\n\n')
    try {
      const r = await runAI<CourseDedupeOut>({
        task: 'course_dedupe',
        vars: { module: opts.module, groups: text },
        deckId: opts.deckId ?? null,
        signal: opts.signal
      })
      // Only well-formed, one-to-one pairs count.
      const usedA = new Set<string>()
      const usedB = new Set<string>()
      for (const p of r.data.same) {
        const g = batch[p.group - 1]
        const qa = g?.a[p.a - 1]
        const qb = g?.b[p.b - 1]
        if (!qa || !qb || qa.type !== qb.type) continue
        const ka = `${p.group}:${p.a}`
        const kb = `${p.group}:${p.b}`
        if (usedA.has(ka) || usedB.has(kb)) continue
        usedA.add(ka)
        usedB.add(kb)
        decisions.set(key(qa, qb), p.keep)
      }
    } catch (e) {
      // No AI (offline, not set up, failed): says so, and why (merging stops rather than going ahead unchecked).
      checked = false
      error = friendlyError(e)
      console.warn('[merge] repeat check failed:', error)
      break
    }
  }
  opts.onProgress?.(batches.length, batches.length)
  return { judge, pairs: decisions.size, checked, error }
}
