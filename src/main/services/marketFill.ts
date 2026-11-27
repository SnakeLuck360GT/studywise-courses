// When writing a week runs out of your Claude limit (or fails for another
// reason), what didn't get written can come from the marketplace instead:
// someone else's copy of the same week, with those topics written at the same
// level of detail. Checked each time you open the course; when a copy has
// them, they go in (nothing generated, nothing of yours changed) and the
// warning goes. A week whose planning failed takes a whole published copy.

import { rmSync } from 'node:fs'
import { fillTopicsFrom, getCourse } from './course'
import { importWeek } from './weekShare'
import { download, isWeekPrivate, marketAuth, recordAdded, recordWeeksMerged, similar } from './market'
import { matchTopics, type MergeTopic } from '@shared/weekMerge'
import type { MarketWeek } from '@shared/market'
import type { NoteLevel, OutlineTopic, Topic, WeekFull } from '@shared/course'

export interface FillResult {
  /** "Week 3: 2 topics", for the message. */
  filled: string[]
  topics: number
  weeks: number
}

/** What a topic is matched on: its title and planned sections. */
const asMerge = (title: string, sections: string[]): MergeTopic => ({ title, plan: { title, sections } as OutlineTopic, contents: {} })

/** A failed topic and the level it needs. */
function wanted(t: Topic): { topic: Topic; level: NoteLevel } | null {
  if (!t.error || t.status === 'writing') return null
  // Never written: the level it failed at (or the usual one). Written, but another level failed: that level.
  if (t.status === 'error') return { topic: t, level: t.error_level ?? 'standard' }
  return t.error_level && !t.levels.includes(t.error_level) ? { topic: t, level: t.error_level } : null
}

/** Which of the wanted topics a published copy has written at the wanted level. */
function covers(m: MarketWeek, wants: { topic: Topic; level: NoteLevel }[]): { topic: Topic; level: NoteLevel }[] {
  const match = matchTopics(
    wants.map((w) => asMerge(w.topic.content?.title ?? w.topic.plan.title, w.topic.plan.sections ?? [])),
    m.topics.map((t) => asMerge(t.title, t.sections))
  )
  const out: { topic: Topic; level: NoteLevel }[] = []
  match.forEach((i, j) => {
    if (m.topics[j].levels.includes(wants[i].level)) out.push(wants[i])
  })
  return out
}

async function fillWeek(w: WeekFull): Promise<{ topics: number; whole: boolean } | null> {
  const planFailed = w.status === 'error' && !w.topics.length
  const wants = w.topics.map(wanted).filter((x): x is { topic: Topic; level: NoteLevel } => !!x)
  if (!planFailed && !wants.length) return null
  // Something is being written or planned right now: leave it.
  if (w.status === 'planning' || w.topics.some((t) => t.status === 'writing')) return null
  const matches = (await similar(w.id)).map((m) => m.week)

  if (planFailed) {
    const best = matches.filter((m) => m.writtenCount > 0).sort((a, b) => b.writtenCount - a.writtenCount)[0]
    if (!best) return null
    const file = await download(best.id)
    try {
      const r = await importWeek(file, { weekId: w.id })
      recordAdded(best.id, w.id, best.mine, best.courseId)
      return { topics: r.topics, whole: true }
    } finally {
      rmSync(file, { force: true })
    }
  }

  const best = matches
    .map((m) => ({ m, has: covers(m, wants) }))
    .filter((x) => x.has.length)
    .sort((a, b) => b.has.length - a.has.length || b.m.writtenCount - a.m.writtenCount)[0]
  if (!best) return null
  const file = await download(best.m.id)
  try {
    const levels = [...new Set(best.has.map((x) => x.level))]
    const fresh = await importWeek(file, { courseId: w.course_id }, { levels })
    const filled = await fillTopicsFrom(
      w.id,
      fresh.weekId,
      best.has.map((x) => ({ topicId: x.topic.id, level: x.level }))
    )
    // Someone else's work is in the week now (never published for you automatically).
    if (filled.length) recordWeeksMerged(w.id, [fresh.weekId])
    return filled.length ? { topics: filled.length, whole: false } : null
  } finally {
    rmSync(file, { force: true })
  }
}

/**
 * Every week of a course with topics that failed to write (at any level), or
 * whose planning failed: filled from the marketplace where someone has them.
 * Never throws (no marketplace, or it's down, just means nothing is filled).
 */
export async function fillFailed(courseId: string): Promise<FillResult> {
  const out: FillResult = { filled: [], topics: 0, weeks: 0 }
  if (!marketAuth()) return out
  let c
  try {
    c = getCourse(courseId)
  } catch {
    return out
  }
  for (const w of c.weeks) {
    // Private weeks aren't described to the marketplace, even to look.
    if (isWeekPrivate(w.id)) continue
    try {
      const r = await fillWeek(w)
      if (!r) continue
      out.weeks++
      out.topics += r.topics
      out.filled.push(r.whole ? w.label : `${w.label}: ${r.topics} topic${r.topics === 1 ? '' : 's'}`)
    } catch (e) {
      console.warn(`Couldn’t fill ${w.label} from the marketplace: ${(e as Error).message}`)
    }
  }
  return out
}

