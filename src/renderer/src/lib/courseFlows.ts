import { NOTE_LEVEL_INFO, type CourseFull, type NoteLevel, type Topic, type WeekFull } from '@shared/course'
import { duplicateWeekGroups } from '@shared/weekMerge'
import { api, errorText } from './api'
import { askPlan, askWrite, chooseDialog, confirmDialog } from './dialogs'
import { toast, useStore } from './store'
import { askAboutMatches } from '../components/MarketMatches'
import { useMarketWeekHere } from './market'

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`

/**
 * Ask whether to plan a week now (with optional instructions that take
 * priority), and start planning if so. Adding files never plans by itself.
 * Returns true when planning started.
 */
export async function offerPlan(week: { id: string; label: string; topics?: { status: string }[] }, opts: { added?: number } = {}): Promise<boolean> {
  const topics = week.topics?.length ?? 0
  // Before spending tokens on a new week: has someone published one made from the same slides?
  if (!topics) {
    const matches = await api.market.similar({ weekId: week.id }).catch(() => [])
    if (matches.length) {
      const a = await askAboutMatches(week.label, matches)
      if (a === null) return false
      if (a !== 'plan') return useMarketWeekHere({ id: a.use, mine: a.mine, courseId: a.courseId, topics: matches.find((m) => m.week.id === a.use)?.week.topics }, week)
    }
  }
  const written = week.topics?.filter((t) => t.status === 'ready').length ?? 0
  const message = [
    opts.added ? `Added ${files(opts.added)} to ${week.label}.` : '',
    topics
      ? `Planning again replaces its ${topics} topic${topics === 1 ? '' : 's'}${written ? `, including ${written} you’ve already written` : ''}. Recall cards you’ve made stay in the deck.`
      : 'Claude reads the files and splits them into topics. You can also add more files first and plan later from the week page.'
  ]
    .filter(Boolean)
    .join(' ')
  const instructions = await askPlan(topics ? `Plan ${week.label} again?` : `Plan ${week.label} now?`, {
    message,
    confirmText: topics ? 'Plan again' : 'Plan topics',
    danger: written > 0
  })
  if (instructions === null) return false
  try {
    await api.courses.plan({ weekId: week.id, instructions })
    useStore.getState().bump()
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

const levelList = (levels: NoteLevel[]) => levels.map((l) => NOTE_LEVEL_INFO[l].inline).join(' and ')

/**
 * Pick the level(s) of detail and write topics. For one written topic, the
 * levels it already has are marked (writing one again replaces just that one).
 */
export async function writeTopics(topics: Topic[], opts: { title?: string; levels?: NoteLevel[] } = {}): Promise<boolean> {
  if (!topics.length) return false
  const one = topics.length === 1 ? topics[0] : null
  const name = one ? (one.content?.title ?? one.plan.title) : `${topics.length} topics`
  const r = await askWrite(opts.title ?? `Write ${name}`, {
    message: one?.levels.length ? `Already written as ${levelList(one.levels)}. Every level you write is kept, and you can switch between them.` : undefined,
    levels: opts.levels,
    written: one?.levels ?? [],
    confirmText: 'Write'
  })
  if (!r) return false
  try {
    await api.courses.write({ topicIds: topics.map((t) => t.id), levels: r.levels, instructions: r.instructions })
    useStore.getState().bump()
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/**
 * Write a quick review of written topics, saved alongside the notes they
 * already have: those stay as they are (and stay shown), the recall cards are
 * reused, and you can switch between the two. Sharing or publishing the week
 * takes both. A topic that already has a quick review gets it rewritten.
 */
export async function writeQuickReview(topics: Topic[], name: string): Promise<boolean> {
  if (!topics.length) return false
  const redo = topics.filter((t) => t.levels.includes('quick')).length
  const r = await askWrite(`Quick review of ${name}`, {
    message: `Shorter sections that take less time, still covering nearly everything. It’s saved alongside the notes you have: they stay as they are, the recall cards are reused, and you can switch between them on the week page.${redo ? ` ${redo === topics.length ? 'Its quick review is' : `${redo} of them already have a quick review, which is`} written again.` : ''} Publishing or sharing the week includes both.`,
    levels: ['quick'],
    multi: false,
    written: topics.length === 1 ? topics[0].levels : [],
    confirmText: 'Write quick review'
  })
  if (!r) return false
  try {
    await api.courses.write({ topicIds: topics.map((t) => t.id), levels: r.levels, instructions: r.instructions, keepShown: true })
    useStore.getState().bump()
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Show every written topic of a week at a level, where it's written at that level. */
export async function switchWeekLevel(topics: Topic[], level: NoteLevel): Promise<boolean> {
  const change = topics.filter((t) => t.status === 'ready' && t.level !== level && t.levels.includes(level))
  try {
    for (const t of change) await api.courses.setLevel({ topicId: t.id, level })
    useStore.getState().bump()
    return change.length > 0
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Show a topic at another level of detail it's written at. */
export async function switchLevel(topic: Topic, level: NoteLevel): Promise<Topic | null> {
  if (topic.level === level) return topic
  try {
    const t = await api.courses.setLevel({ topicId: topic.id, level })
    useStore.getState().bump()
    return t
  } catch (e) {
    toast(errorText(e), 'bad')
    return null
  }
}

// ---------------------------------------------------------------------------
// Merging duplicate weeks (the same week added twice, or two people's versions)

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const writtenIn = (w: WeekFull) => w.topics.filter((t) => t.status === 'ready').length
const WHAT_MERGES =
  'Every topic, every depth (quick, standard, in-depth…), every section, question and flashcard, its files and its recall cards go into one week. Only repeats are taken out: nothing is shortened or summarised, and nothing is generated. Your progress and card reviews are kept.'

async function runMerge(target: WeekFull, others: WeekFull[]): Promise<boolean> {
  try {
    const r = await api.courses.mergeWeeks({ weekId: target.id, otherIds: others.map((o) => o.id) })
    const parts = [r.merged && `${plural(r.merged, 'topic')} combined`, r.added && `${plural(r.added, 'topic')} added`, r.cards && `${plural(r.cards, 'recall card')} moved over`].filter(Boolean)
    toast(`Merged into ${target.label}${parts.length ? `: ${parts.join(', ')}` : ''}.`, 'good')
    useStore.getState().bump()
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Merge copies of the same week in a course into one: the copy with the most written. True when merged. */
export async function mergeDuplicateWeeks(weeks: WeekFull[], title: string): Promise<boolean> {
  const target = [...weeks].sort((a, b) => writtenIn(b) - writtenIn(a) || a.position - b.position)[0]
  const others = weeks.filter((w) => w.id !== target.id)
  const ok = await confirmDialog(
    `Merge the ${weeks.length} copies of ${title} into one?`,
    `${WHAT_MERGES} Everything goes into ${target.label} (it has the most written), and ${others.map((w) => w.label).join(', ')} ${others.length === 1 ? 'is' : 'are'} then removed.`,
    { confirmText: 'Merge into one' }
  )
  return ok ? runMerge(target, others) : false
}

/** Pick another week of the course to merge into this one. True when merged. */
export async function mergeWeekWith(course: CourseFull, week: WeekFull): Promise<boolean> {
  const others = course.weeks.filter((w) => w.id !== week.id)
  if (!others.length) {
    toast('This course has no other week to merge in.', 'info')
    return false
  }
  // Its duplicate, if it has one, comes picked.
  const dup = duplicateWeekGroups(course.weeks).find((g) => g.weeks.some((w) => w.id === week.id))
  const choice = await chooseDialog(
    `Merge another week into ${week.label}`,
    others.map((w) => ({ value: w.id, label: `${w.label} (${plural(w.topics.length, 'topic')})` })),
    { message: `${WHAT_MERGES} The week you pick is removed afterwards.`, confirmText: 'Merge', initial: dup?.weeks.find((w) => w.id !== week.id)?.id }
  )
  const other = others.find((w) => w.id === choice)
  return other ? runMerge(week, [other]) : false
}
