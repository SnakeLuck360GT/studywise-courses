// How much of the Claude plan's 5-hour limit writing a section takes, so a
// planned week can say roughly what writing it will use, and a task or
// request can say what donating it costs.
//
// Jobs already measure their share of the limit (jobs.ts, planUsage). Each
// topic-writing job that ran on its own (nothing else sharing the reading)
// gives a sample: what it used divided by the sections it wrote. The estimate
// is the median of your recent samples, so it fits your plan and the model
// you write with. Until there are a few, it's a rough starting guess.

import { getDb } from '../db'
import { getSetting, setSetting } from '../db/repo'
import { activeProvider } from '../ai/models'
import { isMock } from '../ai'
import { onJobMeasured } from '../jobs'
import type { UsageRate } from '@shared/market'

/** Recent samples: share of the 5-hour limit per section written (0.01 = 1%). */
const SAMPLES_SETTING = 'usage.sectionSamples'
const KEEP = 30
/** Enough samples to trust over the guess. */
const ENOUGH = 3
/**
 * Before anything is measured: about 1% of a 5-hour limit per section. A guess
 * (it depends on the plan and the model); measured samples replace it.
 */
const GUESS_PER_SECTION = 0.01
/** A week nobody has planned yet, when the library has no planned weeks to go by. */
const GUESS_WEEK_SECTIONS = 20

const samples = () => getSetting<number[]>(SAMPLES_SETTING, [])

/** Remember what a writing job used per section. */
export function recordSectionUsage(used: number, sections: number): void {
  if (!(sections > 0) || !(used >= 0)) return
  const per = used / sections
  // A reading that can't be right (the window was shared with something outside the app, say).
  if (per > 0.5) return
  setSetting(SAMPLES_SETTING, [...samples(), per].slice(-KEEP))
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Sections in a week of your library, usually (the median of your planned weeks). */
function typicalWeekSections(): number {
  const rows = getDb().prepare("SELECT week_id, plan FROM topics WHERE plan IS NOT NULL").all() as { week_id: string; plan: string }[]
  const byWeek = new Map<string, number>()
  for (const r of rows) {
    let n = 1
    try {
      n = Math.max(1, (JSON.parse(r.plan) as { sections?: unknown[] }).sections?.length ?? 1)
    } catch {
      /* an odd plan counts as one section */
    }
    byWeek.set(r.week_id, (byWeek.get(r.week_id) ?? 0) + n)
  }
  return byWeek.size ? Math.round(median([...byWeek.values()])) : GUESS_WEEK_SECTIONS
}

/** The rate from samples: their median once there are enough, else the guess. */
export function sectionRate(s: number[]): { perSection: number; measured: boolean } {
  const measured = s.length >= ENOUGH
  return { perSection: measured ? median(s) : GUESS_PER_SECTION, measured }
}

/** What one section takes, or null when there's no 5-hour limit to measure against (Ollama). */
export function usageRate(): UsageRate | null {
  if (activeProvider() !== 'claude' || isMock()) return null
  return { ...sectionRate(samples()), typicalWeekSections: typicalWeekSections() }
}

/** Your recent samples (for tests). */
export const sectionSamples = samples

export { typicalWeekSections }

/** Learn from every writing job measured on its own. Call once at startup. */
export function startUsageLearning(): void {
  onJobMeasured((job) => {
    const pu = job.planUsage
    const sections = Number(job.meta?.sectionsWritten ?? 0)
    if (!pu || pu.used === null || pu.shared || !sections) return
    if (job.status !== 'done') return
    recordSectionUsage(pu.used, sections)
  })
}
