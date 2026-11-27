// The course marketplace: weeks people have generated and published, grouped
// into courses, so others can add them instead of generating their own.
// Courses belong to nobody: everyone's weeks for a course with the same name
// are in the same course. Each week belongs to whoever published it. The
// server is a separate site (studywise-server); these are the shapes its API
// returns.

import type { ModelChoice } from './types'
import { READING_WEEK, weekNumber } from './course'

/** A model and effort, and how many topics (or levels of a topic) were written with it. */
export interface MarketModel {
  model: string
  effort: string | null
  provider: string | null
  count: number
}

export interface MarketTopic {
  title: string
  goal: string
  sections: string[]
  /** Levels of detail it's written at (standard, revision, deep); empty if only planned. */
  levels: string[]
}

export interface MarketWeek {
  id: string
  courseId: string
  label: string
  /** The week's place in its author's own course (1 = their first week). */
  number: number
  /** Who published it (for a merged week, who merged it: it's theirs to take down). */
  author: string
  /** Everyone whose work is in it: one person, or everyone whose copies were merged into it. Missing from older marketplaces. */
  authors?: string[]
  /** Several people's copies merged into one. */
  merged?: boolean
  topics: MarketTopic[]
  topicCount: number
  writtenCount: number
  cardCount: number
  files: { name: string; size: number }[]
  /** Size of the download in bytes. */
  size: number
  plannedWith: ModelChoice | null
  writtenWith: MarketModel[]
  downloads: number
  createdAt: string
  updatedAt: string
  mine: boolean
}

export interface MarketCourse {
  id: string
  name: string
  module: string
  level: string
  /** Everyone who has published a week of it, most weeks first. */
  authors: string[]
  weekCount: number
  topicCount: number
  cardCount: number
  /** Every model its topics were written with, most used first. */
  models: MarketModel[]
  downloads: number
  updatedAt: string
  /** You've published a week of it. */
  mine: boolean
  /** Week numbers a marketplace admin marked as having no content (no lectures), like reading week. Missing from older marketplaces. */
  noContent?: number[]
}

export interface MarketCourseFull extends MarketCourse {
  weeks: MarketWeek[]
}

/** A published week made from (nearly) the same material as one of yours. */
export interface MarketMatch {
  week: MarketWeek
  course: { id: string; name: string }
  /** How much of the material is the same, 0–1. */
  score: number
  /** How many of your files are byte-for-byte the same as theirs. */
  sameFiles: number
  /** The same week number of what looks like the same course (by name), whatever the slides. */
  sameWeek: boolean
}

/** A marketplace week you already have on this device: you added it here, or published it from here. */
export interface MarketCopy {
  weekId: string
  courseId: string
  course: string
  week: string
  how: 'added' | 'published'
  /** When you added it (null for one you published). */
  at: string | null
}

export interface MarketStatus {
  url: string
  hasKey: boolean
}

/** Settings: publish your weeks as their topics are written. */
export const AUTO_PUBLISH_SETTING = 'market.autoPublish'
/** Weeks that hold someone else's work (a shared or marketplace week went into them): never published automatically. */
export const IMPORTED_WEEKS_SETTING = 'market.importedWeeks'

export type MarketSort = 'recent' | 'popular'

/** One of your weeks that can be published, and whether it needs uploading. */
export interface PublishableWeek {
  weekId: string
  course: string
  label: string
  /** new: not on the marketplace (or taken down there). changed: edited since you published it. same: up to date, so it's skipped. */
  state: 'new' | 'changed' | 'same'
}

/** "alex", "alex and sam", "alex, sam and 3 others". */
export function authorsText(shown: string[]): string {
  if (shown.length <= 2) return shown.join(' and ')
  if (shown.length === 3) return `${shown[0]}, ${shown[1]} and ${shown[2]}`
  return `${shown[0]}, ${shown[1]} and ${shown.length - 2} others`
}

/**
 * 9 from "Week 9", "W9", "Week 9: Testing"; null when there's no number. One
 * rule for the whole app (see course.ts), so "COMP23311 Week 3" is week 3.
 */
export { weekNumber }

export interface WeekGroup<W> {
  /** "w9" for everyone's Week 9; the label itself for a week with no number in it. */
  key: string
  /** "Week 9", or the label when it has no number. */
  title: string
  /** The number from the label, or null. */
  number: number | null
  /** Most downloaded first, then the most recently updated. */
  versions: W[]
  /** How many different people published a version of it. */
  people: number
}

/**
 * A course's weeks grouped so everyone's version of the same week sits
 * together. Weeks are the same when their labels have the same number ("Week 3",
 * "W3: Testing"), whatever position they have in their author's own course;
 * a label without a number only groups with the same label. Groups come in week
 * order.
 */
export function weeksByWeek<W extends Pick<MarketWeek, 'label' | 'number' | 'author' | 'downloads' | 'updatedAt'>>(weeks: W[]): WeekGroup<W>[] {
  const groups = new Map<string, { number: number | null; order: number; versions: W[] }>()
  for (const w of weeks) {
    const n = weekNumber(w.label)
    const key = n !== null ? `w${n}` : `l:${w.label.replace(/\s+/g, ' ').trim().toLowerCase()}`
    const g = groups.get(key) ?? { number: n, order: n ?? (Number.isFinite(w.number) ? w.number : Infinity), versions: [] }
    if (n === null && Number.isFinite(w.number)) g.order = Math.min(g.order, w.number)
    g.versions.push(w)
    groups.set(key, g)
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => a.order - b.order || (a.number === null ? 1 : 0) - (b.number === null ? 1 : 0) || ka.localeCompare(kb))
    .map(([key, g]) => {
      const versions = [...g.versions].sort((a, b) => b.downloads - a.downloads || b.updatedAt.localeCompare(a.updatedAt))
      return { key, number: g.number, title: g.number !== null ? `Week ${g.number}` : versions[0].label, versions, people: new Set(versions.map((v) => v.author)).size }
    })
}

/** "opus · high", "sonnet", "gpt-oss:120b (Ollama) · high". */
export function modelLabel(m: { model: string; effort?: string | null; provider?: string | null }): string {
  const name = m.provider === 'ollama' ? `${m.model} (Ollama)` : m.model
  return m.effort ? `${name} · ${m.effort}` : name
}

// ---------------------------------------------------------------------------
// Downloading a whole course (or the weeks of it you don't have)

/** Every week of a course, or only the weeks your course doesn't have yet. */
export type AddMode = 'all' | 'missing'

/** One marketplace week to add, and where it goes. */
export interface AddItem {
  week: MarketWeek
  /** A blank week of yours with the same number, which it fills; null to add it as a new week. */
  into: { id: string; label: string } | null
}

/** Weeks are the same week when they have the same number ("Week 3", "W3"), or failing that the same label. */
export function weekKey(label: string): string {
  const n = weekNumber(label)
  return n === null ? `label:${label.trim().toLowerCase()}` : `n:${n}`
}

/**
 * Which of a marketplace course's weeks to add to one of your courses (none
 * yet for a new course). One version of each week: where several people
 * published the same week, the one already in your course, else yours, else
 * the most written, most downloaded, newest. A week already added to that
 * course from the marketplace is always skipped; with 'missing', so is any
 * week the course already has with topics in it (made by you or anyone). A
 * blank week of yours with the same number is filled rather than added again.
 */
export function planAdd(
  remote: MarketWeek[],
  local: { id: string; label: string; topics: number }[],
  have: Record<string, { courseId: string }>,
  courseId: string | null,
  mode: AddMode
): { items: AddItem[]; skipped: number } {
  const inCourse = (w: MarketWeek) => !!courseId && have[w.id]?.courseId === courseId
  const groups = new Map<string, MarketWeek[]>()
  for (const w of remote) groups.set(weekKey(w.label), [...(groups.get(weekKey(w.label)) ?? []), w])
  const items: AddItem[] = []
  let skipped = 0
  for (const [key, ws] of groups) {
    const [best] = [...ws].sort(
      (a, b) =>
        Number(inCourse(b)) - Number(inCourse(a)) ||
        Number(b.mine) - Number(a.mine) ||
        b.writtenCount - a.writtenCount ||
        b.downloads - a.downloads ||
        b.updatedAt.localeCompare(a.updatedAt)
    )
    const same = local.filter((l) => weekKey(l.label) === key)
    if (inCourse(best) || (mode === 'missing' && same.some((l) => l.topics > 0))) {
      skipped++
      continue
    }
    const blank = same.find((l) => l.topics === 0)
    items.push({ week: best, into: blank ? { id: blank.id, label: blank.label } : null })
  }
  const order = (w: MarketWeek) => weekNumber(w.label) ?? w.number
  items.sort((a, b) => order(a.week) - order(b.week) || a.week.label.localeCompare(b.week.label))
  return { items, skipped }
}

/** "COMP23311", "CS 1001": capitals then digits, as module codes are written. */
const moduleCode = (s: string) => s.match(/\b([A-Z]{2,6})\s?(\d{3,6}[A-Z]?)\b/)?.slice(1).join('') ?? null
const bareName = (s: string) =>
  s
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .toLowerCase()
    // "Languages & Paradigms" is "Languages and Paradigms" (as the marketplace matches them).
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** The same course under (maybe) different names: the same module code when both have one, otherwise the same name without brackets, punctuation or case. */
export function sameCourse(a: { name: string; module?: string }, b: { name: string; module?: string }): boolean {
  const ca = moduleCode(a.module || a.name) ?? moduleCode(a.name)
  const cb = moduleCode(b.module || b.name) ?? moduleCode(b.name)
  if (ca && cb) return ca === cb
  return bareName(a.name) === bareName(b.name)
}

// ---------------------------------------------------------------------------
// Requests and tasks: asking for weeks nobody has made yet, and donating your
// AI usage to make them (studywise-server's lib/requests.js).

/** Modules are 12 weeks long, with week 6 a reading week (nothing to make). */
export const WEEKS_PER_MODULE = 12
export { READING_WEEK }
export const TEACHING_WEEKS = Array.from({ length: WEEKS_PER_MODULE }, (_, i) => i + 1).filter((n) => n !== READING_WEEK)

/**
 * A week someone asked for. "week": a week of a course that isn't on the
 * marketplace yet, made from slides people upload (or a week they planned in
 * Studywise but haven't written). "write": the unwritten topics of a week
 * that's on the marketplace.
 */
export interface WeekRequest {
  id: string
  kind: 'week' | 'write'
  /** The marketplace course, once there is one. */
  courseId: string | null
  course: string
  module: string
  level: string
  number: number | null
  label: string
  /** open: still wanted. done: on the marketplace (for "write", fully written). gone: the week to finish was taken down. */
  status: 'open' | 'done' | 'gone'
  /** "write": the week to finish. "week": the week made for it, once done. */
  weekId: string | null
  /** Who made it (for a merged week, everyone whose work is in it). */
  doneBy: string[]
  /** "write": who published the week being finished. */
  weekAuthor: string | null
  /** Made partway (someone ran out of limit): weekId is that week, toWrite what's left. Missing from older marketplaces. */
  partial?: boolean
  /** Who has written some of it so far. */
  partBy?: string[]
  votes: number
  voted: boolean
  mine: boolean
  createdBy: string
  createdAt: string
  files: { id: string; name: string; size: number; by: string; mine: boolean }[]
  /** A week planned in Studywise (no topics written), to write from instead of planning again. */
  plan: { size: number; by: string; topics: number; at: string } | null
  /** It has something to make it from, so it can be handed out as a task. */
  ready: boolean
  /** What's left to write, when it's known (a "write" request, or one with a plan). */
  toWrite: { topics: number; sections: number } | null
  /** Someone has it as their task right now. */
  inProgress: boolean
  /** That someone is you. */
  yours: boolean
  canRemove: boolean
}

/** Today's task: one request handed to you to make with your own AI. One a day at most. */
export interface MarketTask {
  id: string
  /** beaten: someone else made it first. expired: not started in time, so it went back. */
  /** released: given back unstarted when you chose to make another week instead. */
  status: 'assigned' | 'started' | 'done' | 'skipped' | 'expired' | 'beaten' | 'gone' | 'released'
  day: string
  startedAt: string | null
  request: WeekRequest | null
}

/** Settings: requests you asked for or voted for that were added to your library already: {requestId: "weekId|when"}. */
export const REQUESTS_DELIVERED_SETTING = 'market.requestsDelivered'

/** "Week 4 of COMP23311", "the rest of Week 2 of Optics 301". */
export function requestTitle(r: Pick<WeekRequest, 'kind' | 'label' | 'course'>): string {
  return r.kind === 'write' ? `the rest of ${r.label} of ${r.course}` : `${r.label} of ${r.course}`
}

// ---------------------------------------------------------------------------
// How much of your Claude plan's 5-hour limit writing takes, worked out from
// what writing topics has used before (see usageEstimate in the main process).

export interface UsageRate {
  /** Share of the 5-hour limit one section takes to write (0.01 = 1%). */
  perSection: number
  /** From your own topics (true), or a rough starting guess until a few are measured. */
  measured: boolean
  /** How many sections a week usually has in your library, for a week nobody has planned yet. */
  typicalWeekSections: number
}

/** "about 6%", "under 1%", "about 1.4 times" a whole 5-hour limit. */
export function usageText(share: number): string {
  if (share >= 1) return `about ${(Math.round(share * 10) / 10).toString()}× your 5-hour limit`
  const pct = Math.round(share * 100)
  return pct < 1 ? 'under 1% of your 5-hour limit' : `about ${pct}% of your 5-hour limit`
}

/** Settings: ask for your courses' missing weeks automatically (on unless turned off). */
export const AUTO_REQUEST_SETTING = 'market.autoRequest'

/**
 * A teaching week of one of your courses you don't have written, up to the
 * latest week you've got to (week 6, reading week, never counts).
 */
export interface MissingWeek {
  courseId: string
  course: string
  number: number
  /** Your week with that number, if you have one (blank, or not written). */
  weekId: string | null
  /** Slides and transcripts in that week of yours. */
  files: number
  /** The request for it (yours, or someone else's you can vote for). */
  request: WeekRequest | null
  /** On the marketplace already: add it instead. */
  available: { weekId: string; courseId: string } | null
}

/** A week of one of your courses someone asked for that has no slides yet: maybe you have them. */
export interface SlidesWanted {
  request: WeekRequest
  /** Your week with that number and how many files it has (0: none). */
  weekId: string | null
  files: number
}

export interface MissingInfo {
  missing: MissingWeek[]
  slidesWanted: SlidesWanted[]
  autoRequest: boolean
}
