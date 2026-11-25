// Merging duplicate weeks (two people's "Week 3", or the same week added twice)
// into one, without AI and without dropping anything: the result is the larger
// set, with repeats taken out.
//
//   topics    matched by title (or, failing that, by their section headings);
//             a matched pair becomes one topic, unmatched ones are added
//   levels    each level of detail (standard, quick, …) merges with the same
//             level; a level only one side has is kept as it is
//   sections  matched by heading; a matched pair becomes one section whose
//             notes are the first's plus every paragraph of the second's that
//             isn't already there; sections only one side has are added at
//             the end (so places you've reached in a topic stay where they were)
//   questions, flashcards, test questions: the union, without repeats
//   recall cards (the week's deck): the union, a card whose front is already
//             there counting as a repeat
//
// "Already there" means the same once case, punctuation, Markdown and spacing
// are ignored, or nearly the same wording (most of the same three-word runs).
//
// Plain functions over the stored shapes, so the same code merges weeks in your
// library (src/main/services/course.ts) and weeks on the marketplace
// (src/main/services/weekMerge.ts).

import { weekNumber, type CourseQuestion, type OutlineTopic, type TopicContent, type TopicSection } from './course'

// ---------------------------------------------------------------------------
// Comparing text

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'its', 'it', 'as', 'by', 'at', 'from', 'how', 'what', 'why', 'into', 'vs', 'versus'])

/** Lower case, no Markdown, punctuation or extra spaces. */
export function normText(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~#>|]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const words = (s: string) => new Set(normText(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)))

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const x of a) if (b.has(x)) both++
  return both / (a.size + b.size - both)
}

function shingles(s: string): Set<string> {
  const w = normText(s).split(' ').filter(Boolean)
  if (w.length < 3) return new Set(w.length ? [w.join(' ')] : [])
  const out = new Set<string>()
  for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(' '))
  return out
}

/** How alike two titles or headings are, 0–1 (1 when they're the same words). */
export function titleSimilarity(a: string, b: string): number {
  if (normText(a) === normText(b)) return 1
  return jaccard(words(a), words(b))
}

/** How alike two passages are, 0–1, by their three-word runs. */
export function textSimilarity(a: string, b: string): number {
  const na = normText(a)
  const nb = normText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  return jaccard(shingles(na), shingles(nb))
}

/** Close enough to count as a repeat: the same words, or nearly the same wording. */
export const isRepeat = (a: string, b: string) => textSimilarity(a, b) >= 0.8

// ---------------------------------------------------------------------------
// Questions, flashcards, sections

function questionKey(q: CourseQuestion): string {
  const r = q as Record<string, unknown>
  return `${q.type}:${normText(String(r.q ?? r.text ?? r.statement ?? ''))}`
}

/** The union of two lists of questions, without repeats. */
export function mergeQuestions(a: CourseQuestion[], b: CourseQuestion[]): CourseQuestion[] {
  const out = [...a]
  const seen = new Set(a.map(questionKey))
  for (const q of b) {
    const k = questionKey(q)
    if (!seen.has(k)) {
      seen.add(k)
      out.push(q)
    }
  }
  return out
}

type SectionCard = NonNullable<TopicSection['cards']>[number]

/** The union of two sets of flashcards, a card with the same front counting as a repeat. */
export function mergeCards(a: SectionCard[] = [], b: SectionCard[] = []): SectionCard[] {
  const out = [...a]
  const seen = new Set(a.map((c) => normText(c.front)))
  for (const c of b) {
    const k = normText(c.front)
    if (k && !seen.has(k)) {
      seen.add(k)
      out.push(c)
    }
  }
  return out
}

const paragraphs = (s: string) =>
  String(s ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

/** The first notes, then every paragraph of the second that isn't already there. */
export function mergeNotes(a: string, b: string): string {
  const mine = paragraphs(a)
  const extra = paragraphs(b).filter((p) => !mine.some((m) => isRepeat(m, p)))
  return [...mine, ...extra].join('\n\n')
}

/** Two sections are the same section when their headings are (nearly) the same, or their notes are. */
export function sameSection(a: TopicSection, b: TopicSection): boolean {
  return titleSimilarity(a.heading, b.heading) >= 0.6 || isRepeat(a.notes, b.notes)
}

export function mergeSection(a: TopicSection, b: TopicSection): TopicSection {
  const cards = mergeCards(a.cards, b.cards)
  return {
    ...a,
    notes: mergeNotes(a.notes, b.notes),
    figure: a.figure ?? b.figure ?? null,
    ...(a.cards || b.cards ? { cards } : {}),
    questions: mergeQuestions(a.questions ?? [], b.questions ?? [])
  }
}

/** One level of a topic merged with the same level of its duplicate. */
export function mergeContent(a: TopicContent, b: TopicContent): TopicContent {
  const sections = a.sections.map((s) => ({ ...s }))
  const used = new Set<number>()
  for (const s of b.sections) {
    const i = sections.findIndex((x, j) => !used.has(j) && j < a.sections.length && sameSection(x, s))
    if (i >= 0) {
      used.add(i)
      sections[i] = mergeSection(sections[i], s)
    } else sections.push({ ...s })
  }
  return { title: a.title, goal: a.goal || b.goal, sections, check: mergeQuestions(a.check ?? [], b.check ?? []) }
}

/** Two topics' plans: every section, source and point either mentions. */
export function mergePlan(a: OutlineTopic, b: OutlineTopic): OutlineTopic {
  const union = (x: string[] = [], y: string[] = []) => [...x, ...y.filter((s) => !x.some((t) => titleSimilarity(t, s) >= 0.6))]
  const sources = [...(a.sources ?? [])]
  for (const s of b.sources ?? []) if (!sources.some((t) => t.file === s.file && t.where === s.where)) sources.push(s)
  return {
    ...a,
    goal: a.goal || b.goal,
    sections: union(a.sections, b.sections),
    sources,
    needs: union(a.needs, b.needs),
    stressed: union(a.stressed, b.stressed),
    minutes: Math.max(a.minutes ?? 0, b.minutes ?? 0) || a.minutes
  }
}

// ---------------------------------------------------------------------------
// Topics

/** What's compared to find duplicate topics, and what's merged. */
export interface MergeTopic {
  title: string
  plan: OutlineTopic | null
  /** Each written level's content, the shown level included. */
  contents: Record<string, TopicContent>
}

const headingsOf = (t: MergeTopic) => [...new Set([...(t.plan?.sections ?? []), ...Object.values(t.contents).flatMap((c) => c.sections.map((s) => s.heading))])]

/** How sure we are these are the same topic, 0–1 (0.5 or more counts). */
export function topicMatch(a: MergeTopic, b: MergeTopic): number {
  const title = titleSimilarity(a.title, b.title)
  if (title >= 0.6) return title
  const ha = headingsOf(a)
  const hb = headingsOf(b)
  const shared = ha.filter((h) => hb.some((x) => titleSimilarity(h, x) >= 0.6)).length
  const headings = shared / Math.max(1, Math.min(ha.length, hb.length))
  return title >= 0.3 && headings >= 0.5 ? 0.5 + headings / 4 : headings >= 0.75 ? 0.5 : title / 2
}

/** Which topic of `into` each of `from` duplicates (by index), best matches first, each used once. */
export function matchTopics(into: MergeTopic[], from: MergeTopic[]): Map<number, number> {
  const pairs: { i: number; j: number; s: number }[] = []
  from.forEach((b, j) => into.forEach((a, i) => {
    const s = topicMatch(a, b)
    if (s >= 0.5) pairs.push({ i, j, s })
  }))
  pairs.sort((x, y) => y.s - x.s)
  const out = new Map<number, number>()
  const taken = new Set<number>()
  for (const p of pairs) if (!out.has(p.j) && !taken.has(p.i)) {
    out.set(p.j, p.i)
    taken.add(p.i)
  }
  return out
}

/** Every level either topic is written at, levels both have merged. */
export function mergeLevels(a: Record<string, TopicContent>, b: Record<string, TopicContent>): Record<string, TopicContent> {
  const out: Record<string, TopicContent> = { ...a }
  for (const [level, c] of Object.entries(b)) out[level] = out[level] ? mergeContent(out[level], c) : c
  return out
}

// ---------------------------------------------------------------------------
// Pointers inside a topic that change when its week merges into another

/** A copy of a topic's content with figures pointing at other files and flashcards at other deck cards. */
export function remapContent(c: TopicContent, files: Map<string, string>, cards: Map<string, string>): TopicContent {
  return {
    ...c,
    sections: c.sections.map((s) => ({
      ...s,
      figure: s.figure ? { ...s.figure, fileId: files.get(s.figure.fileId) ?? s.figure.fileId } : null,
      ...(s.cards ? { cards: s.cards.map((card) => (card.id && cards.has(card.id) ? { ...card, id: cards.get(card.id) } : card)) } : {})
    }))
  }
}

/** Recall cards' fronts, for spotting the same card in two decks. */
export const cardKey = (front: string) => normText(front.replace(/\(\d+\)\s*$/, ''))

// ---------------------------------------------------------------------------
// Spotting duplicate weeks in a course

/**
 * Weeks of a course that are the same week: the same week number ("Week 3",
 * "W3: Testing", "Week 3 (2)"), or the same label when there's no number. Only
 * groups of two or more, in course order.
 */
export function duplicateWeekGroups<W extends { id: string; label: string; position: number }>(weeks: W[]): { title: string; weeks: W[] }[] {
  const groups = new Map<string, W[]>()
  for (const w of [...weeks].sort((a, b) => a.position - b.position)) {
    const n = weekNumber(w.label.replace(/\s*\(\d+\)\s*$/, ''))
    const key = n !== null ? `n${n}` : `l${normText(w.label.replace(/\s*\(\d+\)\s*$/, ''))}`
    groups.set(key, [...(groups.get(key) ?? []), w])
  }
  return [...groups.entries()].filter(([, ws]) => ws.length > 1).map(([key, ws]) => ({ title: key.startsWith('n') ? `Week ${key.slice(1)}` : ws[0].label, weeks: ws }))
}
