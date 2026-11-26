// The AI steps of merging weeks (see @shared/weekMerge for the rest):
//
//   notes      for each topic both copies have, at each level of detail, the AI
//              pairs up sections that cover the same material (whatever their
//              headings) and writes their combined notes: everything from both,
//              with only repeated or reworded points taken out. Every answer is
//              checked: combined notes shorter than the fuller copy, or missing
//              any code, maths or image either had, are thrown away, and those
//              sections merge without AI (nothing is lost either way).
//   questions  then, with the sections paired, the AI spots questions that ask
//              the same thing in other words (questionDedupe.ts); every other
//              question is kept.
//
// If the AI can't be reached (offline, not set up, an error), the merge goes
// ahead without it, exactly as before.

import type { CourseCombineOut, TopicContent } from '@shared/course'
import { contentPairKey, type ContentPlan, type ContentPlanner, type QuestionJudge } from '@shared/weekMerge'
import { runAI } from '../ai'
import { askAboutRepeats, questionCollector } from './questionDedupe'

interface Pair {
  key: string
  a: TopicContent
  b: TopicContent
  level: string
}

export interface CombineOptions {
  module: string
  deckId?: string | null
  signal?: AbortSignal
  /** What it's doing, for a job's progress. */
  onProgress?: (stage: string) => void
}

const LEVEL_NAMES: Record<string, string> = { standard: 'standard', quick: 'quick revision', deep: 'in-depth', simple: '“explain it like I’m 12”' }

/** One part of the prompt: a topic at one level, both versions' sections numbered. */
function partText(p: Pair, n: number): string {
  const side = (tag: 'A' | 'B', c: TopicContent) => c.sections.map((s, i) => `#### ${tag}${i + 1}. ${s.heading.replace(/\s+/g, ' ').trim()}\n${s.notes.trim()}`).join('\n\n')
  return [`### Part ${n}`, `Topic: ${p.a.title} (${LEVEL_NAMES[p.level] ?? p.level} notes)`, 'Version A:', side('A', p.a), 'Version B:', side('B', p.b)].join('\n\n')
}

/** Parts per AI call: a few topics' worth, so the answer (the combined notes) isn't too long either. */
const BATCH_CHARS = 30_000

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
/** What has to come through word for word: code blocks, display maths and images. */
const exact = (s: string) => [...s.matchAll(/```[\s\S]*?```|\$\$[\s\S]*?\$\$|!\[[^\]]*\]\([^)]*\)/g)].map((m) => m[0])

/**
 * One combined section from the AI, checked: real section numbers, each B
 * section used once, at least as long as the fuller of the sections it
 * combines, and every code block, display formula and image of theirs in it.
 * Null when it fails (those sections then merge without AI).
 */
export function checked(p: Pair, e: { a: number; b: number[]; notes: string }, usedB: Set<number>): ContentPlan['sections'][number] | null {
  const a = p.a.sections[e.a - 1]
  const bNums = [...new Set(e.b)]
  const bs = bNums.map((n) => p.b.sections[n - 1])
  if (!a || !bs.length || bs.some((s) => !s) || bNums.some((n) => usedB.has(n))) return null
  const notes = String(e.notes ?? '').trim()
  if (wordCount(notes) < 0.95 * Math.max(wordCount(a.notes), ...bs.map((s) => wordCount(s.notes)))) return null
  const have = squash(notes)
  if ([a, ...bs].flatMap((s) => exact(s.notes)).some((x) => !have.includes(squash(x)))) return null
  for (const n of bNums) usedB.add(n)
  return { a: e.a - 1, b: bNums.map((n) => n - 1), notes }
}

/**
 * Asks the AI to combine these pairs of topic copies. Returns its checked plan
 * for each pair (null: merge that pair without AI). Never throws.
 */
export async function combineContents(pairs: Pair[], opts: CombineOptions): Promise<{ plans: Map<string, ContentPlan | null>; combined: number; checked: boolean }> {
  const plans = new Map<string, ContentPlan | null>()
  let combined = 0
  let ok = true
  const batches: Pair[][] = []
  let cur: Pair[] = []
  let size = 0
  for (const p of pairs) {
    const n = partText(p, 1).length
    if (cur.length && size + n > BATCH_CHARS) {
      batches.push(cur)
      cur = []
      size = 0
    }
    cur.push(p)
    size += n
  }
  if (cur.length) batches.push(cur)

  for (const [bi, batch] of batches.entries()) {
    for (const p of batch) plans.set(p.key, null)
    if (opts.signal?.aborted) break
    opts.onProgress?.(batches.length > 1 ? `Combining notes (${bi + 1} of ${batches.length})…` : 'Combining notes…')
    try {
      const r = await runAI<CourseCombineOut>({
        task: 'course_combine',
        vars: { module: opts.module, parts: batch.map((p, i) => partText(p, i + 1)).join('\n\n') },
        deckId: opts.deckId ?? null,
        signal: opts.signal
      })
      for (const part of r.data.parts) {
        const p = batch[part.part - 1]
        if (!p) continue
        const usedB = new Set<number>()
        const sections = part.sections.map((e) => checked(p, e, usedB)).filter((e): e is ContentPlan['sections'][number] => !!e)
        // An A section combined twice keeps the first.
        const seenA = new Set<number>()
        const unique = sections.filter((e) => (seenA.has(e.a) ? false : (seenA.add(e.a), true)))
        plans.set(p.key, { sections: unique })
        combined += unique.length
      }
    } catch (e) {
      ok = false
      console.warn('[merge] combining notes skipped:', e instanceof Error ? e.message : e)
    }
  }
  return { plans, combined, checked: ok }
}

/**
 * Plans a merge with the AI's help. `run` merges (a dry run: nothing saved)
 * with a planner and a question judge; it's run until every pair of topic
 * copies it combines has been combined (with three or more copies, merging the
 * next one depends on the last), then once more to collect the questions, now
 * that sections are paired up. Returns what the real merge uses.
 */
export async function planMerge(
  run: (planner: ContentPlanner, judge: QuestionJudge | null) => unknown,
  opts: CombineOptions
): Promise<{ planner: ContentPlanner; judge: QuestionJudge; combined: number; repeats: number; checked: boolean }> {
  const plans = new Map<string, ContentPlan | null>()
  const planner: ContentPlanner = { plan: (a, b) => plans.get(contentPairKey(a, b)) ?? null }
  let combined = 0
  let ok = true
  for (let round = 0; round < 10 && !opts.signal?.aborted; round++) {
    const pending = new Map<string, Pair>()
    await run(
      {
        ...planner,
        seen: (a, b, level) => {
          const key = contentPairKey(a, b)
          if (!plans.has(key)) pending.set(key, { key, a, b, level })
        }
      },
      null
    )
    if (!pending.size) break
    const r = await combineContents([...pending.values()], opts)
    for (const [k, v] of r.plans) plans.set(k, v)
    combined += r.combined
    if (!r.checked) ok = false
  }
  opts.onProgress?.('Checking for questions that ask the same thing…')
  const collect = questionCollector()
  await run(planner, collect.judge)
  const q = await askAboutRepeats(collect.groups, { module: opts.module, deckId: opts.deckId, signal: opts.signal })
  return { planner, judge: q.judge, combined, repeats: q.pairs, checked: ok && q.checked }
}
