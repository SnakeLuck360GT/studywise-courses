import { AUTO_PUBLISH_SETTING, modelLabel, sameCourse, type AddMode, type MarketCopy, type MarketMatch, type MarketModel, type MarketWeek } from '@shared/market'
import { api, errorText } from './api'
import { chooseDialog, confirmDialog, confirmOrElse } from './dialogs'
import { importSharedWeek } from './weekShare'
import { toast, useStore } from './store'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** "opus · high (4), sonnet (1)". */
export function modelsText(models: MarketModel[]): string {
  if (!models.length) return 'Model not recorded'
  return models.map((m) => (models.length > 1 ? `${modelLabel(m)} (${m.count})` : modelLabel(m))).join(', ')
}

export const weekSummary = (w: MarketWeek) => `${w.writtenCount} of ${plural(w.topicCount, 'topic')} written · ${plural(w.cardCount, 'flashcard')} · ${plural(w.files.length, 'file')}`

/** Marketplace weeks you already have here, by marketplace week id (none if it can't tell). */
export const marketCopies = (): Promise<Record<string, MarketCopy>> => api.market.copies().catch(() => ({}))

/** "Week 3 in Algorithms". */
export const copyText = (c: MarketCopy) => `${c.week} in ${c.course}`

/**
 * Before downloading a marketplace week: if you already have it here, say
 * where, and only go on if you want a second copy. True to go on.
 */
async function checkNotAdded(remoteWeekId: string, whereTo?: string): Promise<boolean> {
  const c = (await marketCopies())[remoteWeekId]
  if (!c) return true
  return confirmDialog(
    `You already have this week: ${copyText(c)}`,
    `${c.how === 'published' ? 'You published it from this device.' : `You added it on ${new Date(c.at!).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.`} Adding it ${whereTo ? `to ${whereTo} ` : 'again '}makes a second copy, with its own progress.`,
    { confirmText: 'Add another copy' }
  )
}

/** Download a published week, then ask which course it goes in (like a shared week). True when it was added. */
export async function addMarketWeek(w: { id: string; mine: boolean; courseId: string }): Promise<boolean> {
  try {
    if (!(await checkNotAdded(w.id))) return false
    // The course you put this course's weeks in before: straight there, no "which course?".
    const linked = await linkedCourse(w.courseId)
    const { file } = await api.market.download({ id: w.id })
    return await importSharedWeek({ file, courseId: linked ?? undefined, remembered: !!linked, market: { id: w.id, mine: w.mine, courseId: w.courseId } })
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Instead of planning a week yourself, fill it with a published one. */
export async function useMarketWeekHere(remote: { id: string; mine: boolean; courseId?: string }, week: { id: string; label: string }): Promise<boolean> {
  try {
    if (!(await checkNotAdded(remote.id, week.label))) return false
    const { file } = await api.market.download({ id: remote.id })
    const r = await api.courses.importWeek({ file, courseId: null, weekId: week.id, market: { id: remote.id, mine: remote.mine, courseId: remote.courseId } })
    toast(`Added ${plural(r.topics, 'topic')} and ${plural(r.cards, 'card')} to ${week.label}. Nothing was generated.`, 'good')
    useStore.getState().bump()
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Publish a week (with its slides and transcripts), or publish it again to update it. */
export async function publishToMarket(week: { id: string; label: string }): Promise<void> {
  try {
    const status = await api.market.status()
    if (!status.url || !status.hasKey) {
      toast('Connect to a marketplace first: add its address and your API key here.', 'info')
      useStore.getState().go({ name: 'settings', tab: 'market' })
      return
    }
    const already = (await api.market.published())[week.id]
    const ok = await confirmDialog(
      already ? `Publish ${week.label} again?` : `Publish ${week.label} to the marketplace?`,
      `${already ? 'This replaces the copy you published before. ' : ''}Everyone on ${new URL(status.url).host} can see and add it: its topics, questions and flashcards, and its slides and transcripts. Your progress isn't included. Only publish material you’re allowed to share.`,
      { confirmText: already ? 'Publish again' : 'Publish' }
    )
    if (!ok) return
    toast(`Publishing ${week.label}…`, 'info')
    const r = await api.market.publish({ weekId: week.id })
    toast(`${r.replaced ? 'Updated' : 'Published'} ${week.label} on the marketplace`, 'good')
  } catch (e) {
    toast(errorText(e), 'bad')
  }
}

/** What changing visibility did, as a toast. */
async function visibilityToast(name: string, isPrivate: boolean, r: { removed: number; failed: string[] }): Promise<void> {
  if (isPrivate) {
    if (r.failed.length) toast(`${name} is private, but ${r.failed.length === 1 ? 'a week' : `${r.failed.length} weeks`} couldn’t be taken down from the marketplace: ${r.failed[0]} Take ${r.failed.length === 1 ? 'it' : 'them'} down from Marketplace → Published by you.`, 'bad')
    else toast(`${name} is private${r.removed ? `, and ${plural(r.removed, 'week')} ${r.removed === 1 ? 'was' : 'were'} taken down from the marketplace` : ''}. It won’t be published.`, 'good')
    return
  }
  const auto = (await api.settings.all().catch(() => ({}) as Record<string, unknown>))[AUTO_PUBLISH_SETTING] === true
  toast(auto ? `${name} is public. Written weeks are published automatically.` : `${name} is public. Publish it from its ⋯ menu when you’re ready.`, 'good')
}

/** Make a course public or private. Private takes its published weeks down from the marketplace. */
export async function setCourseVisibility(course: { id: string; name: string }, isPrivate: boolean): Promise<boolean> {
  try {
    if (isPrivate) {
      const on = await api.market.published().catch(() => ({}) as Record<string, string>)
      const c = await api.courses.get({ id: course.id })
      const up = c.weeks.filter((w) => on[w.id]).length
      if (up && !(await confirmDialog(`Make ${course.name} private?`, `${plural(up, 'week')} of it ${up === 1 ? 'is' : 'are'} on the marketplace and will be taken down. Nobody can add ${up === 1 ? 'it' : 'them'} after that, but anyone who already has ${up === 1 ? 'it' : 'them'} keeps their copy.`, { confirmText: 'Make private', danger: true })))
        return false
    }
    const r = await api.courses.setVisibility({ courseId: course.id, private: isPrivate })
    useStore.getState().bump()
    await visibilityToast(course.name, isPrivate, r)
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Make a week public or private. Private takes it down from the marketplace if it's there. */
export async function setWeekVisibility(week: { id: string; label: string }, isPrivate: boolean): Promise<boolean> {
  try {
    if (isPrivate && (await api.market.published().catch(() => ({}) as Record<string, string>))[week.id]) {
      const ok = await confirmDialog(`Make ${week.label} private?`, 'It’s on the marketplace and will be taken down. Nobody can add it after that, but anyone who already has it keeps their copy.', { confirmText: 'Make private', danger: true })
      if (!ok) return false
    }
    const r = await api.courses.setWeekVisibility({ weekId: week.id, private: isPrivate })
    useStore.getState().bump()
    await visibilityToast(week.label, isPrivate, r)
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/**
 * Publish every week you've written something in (or one course's), as a job.
 * Weeks already on the marketplace are only uploaded again if they've changed
 * since; the rest are skipped.
 */
export async function publishAllToMarket(courseId?: string): Promise<boolean> {
  try {
    const status = await api.market.status()
    if (!status.url || !status.hasKey) {
      toast('Connect to a marketplace first: add its address and your API key here.', 'info')
      useStore.getState().go({ name: 'settings', tab: 'market' })
      return false
    }
    const all = await api.market.publishable(courseId ? { courseId } : undefined)
    if (!all.length) {
      toast('There’s nothing to publish: write some topics first, and only public courses and weeks are published.', 'info')
      return false
    }
    const weeks = all.filter((w) => w.state !== 'same')
    const same = all.length - weeks.length
    if (!weeks.length) {
      toast(`${courseId ? `${all[0].course} is` : 'Everything is'} already on the marketplace and up to date (${plural(all.length, 'week')}).`, 'good')
      return false
    }
    const fresh = weeks.filter((w) => w.state === 'new').length
    const changed = weeks.length - fresh
    const courses = [...new Set(weeks.map((w) => w.course))]
    const what = [fresh && `${plural(fresh, 'new week')}`, changed && `${plural(changed, 'week')} you’ve changed since publishing`].filter(Boolean).join(' and ')
    const ok = await confirmDialog(
      courseId ? `Publish ${courses[0]} to the marketplace?` : `Publish all your courses to the marketplace?`,
      `${what}${courseId ? '' : ` from ${plural(courses.length, 'course')} (${courses.join(', ')})`}, with their topics, questions, flashcards, slides and transcripts.${same ? ` ${plural(same, 'week')} already up to date ${same === 1 ? 'is' : 'are'} skipped.` : ''} Everyone on ${new URL(status.url).host} can see and add them. Only weeks with a written topic are included, and your progress isn’t. Only publish material you’re allowed to share.`,
      { confirmText: `Publish ${plural(weeks.length, 'week')}` }
    )
    if (!ok) return false
    await api.market.publishAll(courseId ? { courseId } : undefined)
    toast(`Publishing ${plural(weeks.length, 'week')}. You can follow it in Jobs.`, 'info')
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/**
 * Just added a week with nothing in it yet: if someone has already published
 * that week of what looks like the same course, offer theirs.
 */
export async function offerMarketWeek(week: { id: string; label: string }): Promise<void> {
  const matches = await marketMatches(week.id, true)
  if (matches.length) await chooseMarketWeek(week, matches)
}

// What the marketplace has for each blank week, kept for a few minutes so the
// course and week pages don't ask again on every visit.
const FRESH_MS = 5 * 60_000
const found = new Map<string, { at: number; matches: Promise<MarketMatch[]> }>()
/** Weeks you answered "I'll make it myself" for, this session: no banner for them. */
const declined = new Set<string>()

/** Published weeks someone else already made of this week (none when not connected). */
export function marketMatches(weekId: string, fresh = false): Promise<MarketMatch[]> {
  const f = found.get(weekId)
  if (!fresh && f && Date.now() - f.at < FRESH_MS) return f.matches
  const matches = api.market.similar({ weekId }).catch(() => [] as MarketMatch[])
  found.set(weekId, { at: Date.now(), matches })
  return matches
}

export const declinedMarketWeek = (weekId: string) => declined.has(weekId)

/** Show what's been made of this week and, if you pick one, fill the week with it. True when it did. */
export async function chooseMarketWeek(week: { id: string; label: string }, matches: MarketMatch[]): Promise<boolean> {
  const { askAboutMatches } = await import('../components/MarketMatches')
  const a = await askAboutMatches(week.label, matches, { planning: false })
  if (a === 'plan') declined.add(week.id)
  if (!a || a === 'plan') return false
  found.delete(week.id)
  return useMarketWeekHere({ id: a.use, mine: a.mine, courseId: a.courseId }, week)
}

/** From a week's ⋯ menu: look now, and say so when nobody has made it. */
export async function findMarketWeek(week: { id: string; label: string }): Promise<boolean> {
  const status = await api.market.status().catch(() => null)
  if (!status?.url || !status.hasKey) {
    toast('Connect to a marketplace first: add its address and your API key here.', 'info')
    useStore.getState().go({ name: 'settings', tab: 'market' })
    return false
  }
  const matches = await marketMatches(week.id, true)
  if (!matches.length) {
    toast(`Nobody has published ${week.label} of this course yet.`, 'info')
    return false
  }
  declined.delete(week.id)
  return chooseMarketWeek(week, matches)
}

export const matchPercent = (m: MarketMatch) => `${Math.round(m.score * 100)}%`

// ---------------------------------------------------------------------------
// Downloading a whole course, or the weeks of it you don't have

type Target = { marketCourseId: string; courseId: string | null }

/** Your course a marketplace course goes into by default: the same course under its name or module code. */
const matching = <T extends { name: string; module: string }>(courses: T[], c: { name: string; module?: string }) => courses.find((x) => sameCourse(x, c))

const list = (labels: string[], max = 10) => (labels.length > max ? `${labels.slice(0, max).join(', ')} and ${labels.length - max} more` : labels.join(', '))

/** The course of yours a marketplace course's weeks went into before (null when there isn't one). */
async function linkedCourse(marketCourseId: string): Promise<string | null> {
  const links = await api.market.linkedCourses({ ids: [marketCourseId] }).catch((): Record<string, string> => ({}))
  return links[marketCourseId] ?? null
}

/**
 * Say what's coming, then download it as a job: 'started', or false. With
 * `remembered` (the remembered course's name), the confirm offers
 * "Somewhere else…", which answers 'alt'.
 */
async function confirmAndAdd(targets: Target[], mode: AddMode, onlyMine: boolean, remembered?: string): Promise<'started' | 'alt' | false> {
  const plans = await api.market.planAdd({ targets, mode, onlyMine })
  const n = plans.reduce((s, p) => s + p.items.length, 0)
  const skipped = plans.reduce((s, p) => s + p.skipped, 0)
  if (!n) {
    toast(skipped ? `You already have ${skipped === 1 ? 'that week' : `all ${skipped} of those weeks`}${remembered ? ` in ${remembered}` : ''}.` : 'There are no weeks to download.', 'info')
    return false
  }
  const where = plans
    .filter((p) => p.items.length)
    .map((p) => `${p.target ? `Into ${p.target}` : `Into a new course for ${p.name}`}: ${list(p.items.map((i) => (i.into ? `${i.label} (fills your blank ${i.into.label})` : i.label)))}.`)
  const message = [
    ...where,
    remembered ? `${remembered} is where you put this course’s weeks before.` : '',
    skipped ? `${plural(skipped, 'week')} you already have ${skipped === 1 ? 'is' : 'are'} left out.` : '',
    onlyMine ? '' : 'Where several people published the same week, yours is used if you published one, otherwise the most complete.',
    'Nothing is generated, so it costs no tokens.'
  ]
    .filter(Boolean)
    .join(' ')
  const title = `Download ${plural(n, 'week')}?`
  const confirmText = `Download ${plural(n, 'week')}`
  const a = remembered ? await confirmOrElse(title, message, { confirmText, altText: 'Somewhere else…' }) : (await confirmDialog(title, message, { confirmText })) ? 'ok' : null
  if (a !== 'ok') return a === 'alt' ? 'alt' : false
  await api.market.addMany({ targets, mode, onlyMine })
  toast(`Downloading ${plural(n, 'week')}. You can follow it in Jobs.`, 'info')
  return 'started'
}

/**
 * Download a marketplace course: every week, or just the weeks your course
 * doesn't have yet. Asks which of your courses they go into (the same course
 * if you have it), then what's coming.
 */
export async function downloadMarketCourse(course: { id: string; name: string; module?: string }, mode: AddMode): Promise<boolean> {
  try {
    const courses = await api.courses.list()
    // Where you put this course's weeks before: straight there, with "Somewhere else…" in the confirm.
    const linked = await linkedCourse(course.id)
    const remembered = courses.find((c) => c.id === linked)
    if (remembered) {
      const r = await confirmAndAdd([{ marketCourseId: course.id, courseId: remembered.id }], mode, false, remembered.name)
      if (r !== 'alt') return r === 'started'
    }
    const choice = await chooseDialog(
      mode === 'all' ? `Download all of ${course.name}` : `Download the weeks of ${course.name} you don’t have`,
      [{ value: '', label: 'A new course' }, ...courses.map((c) => ({ value: c.id, label: `Add to ${c.name}` }))],
      {
        message:
          mode === 'all'
            ? 'Every week goes in, except ones you’ve already added to that course from the marketplace. Blank weeks of yours with the same number are filled.'
            : 'Weeks that course already has (by week number) are left out, and blank ones are filled.',
        confirmText: 'Next',
        initial: matching(courses, course)?.id ?? ''
      }
    )
    if (choice === null) return false
    return (await confirmAndAdd([{ marketCourseId: course.id, courseId: choice || null }], mode, false)) === 'started'
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/**
 * Download everything you've published (or what this device is missing of it),
 * say on a new computer: each course into your course of the same name, or a
 * new one.
 */
export async function downloadMyWeeks(mode: AddMode): Promise<boolean> {
  try {
    const [mine, courses] = await Promise.all([api.market.mine(), api.courses.list()])
    const names = new Map(mine.map((w) => [w.courseId, w.courseName]))
    if (!names.size) {
      toast('You haven’t published anything yet.', 'info')
      return false
    }
    // Each into the course you put it in before, else your course of the same name, else a new one.
    const linked = await api.market.linkedCourses({ ids: [...names.keys()] })
    const targets = [...names].map(([marketCourseId, name]) => ({ marketCourseId, courseId: linked[marketCourseId] ?? matching(courses, { name })?.id ?? null }))
    return (await confirmAndAdd(targets, mode, true)) === 'started'
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}
