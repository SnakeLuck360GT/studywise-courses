import type { NoteLevel } from '@shared/course'
import { api, errorText } from './api'
import { chooseDialog, confirmDialog, confirmOrElse } from './dialogs'
import { offerPlan } from './courseFlows'
import { toast, useStore } from './store'

/**
 * Add a week someone shared (a .studyweek file): say what's in it, ask where it
 * goes (one of your courses, or a new one), import it and open that course.
 * With `courseId` it goes straight into that course after a confirm; with
 * `remembered` too, that's where this course's weeks went before, and the
 * confirm offers somewhere else. With `market` it's that marketplace week,
 * remembered so adding it again asks first (and its course remembered, so
 * the next week of it goes to the same place). True when it was added.
 */
export async function importSharedWeek(
  opts: {
    file?: string
    courseId?: string
    remembered?: boolean
    market?: { id: string; mine: boolean; courseId?: string }
    /** Levels of detail to bring in (all when missing). */
    levels?: NoteLevel[]
    /** More to say in the "Added" toast, given how many topics came in at a depth that wasn't picked. */
    afterAdd?: (fellBack: number) => string
  } = {}
): Promise<boolean> {
  try {
    const p = await api.courses.previewWeek(opts.file ? { file: opts.file } : undefined)
    if (!p) return false
    const what = `${p.written} of ${p.topics} topic${p.topics === 1 ? '' : 's'} written, ${p.cards} recall card${p.cards === 1 ? '' : 's'}, ${p.files.length} file${p.files.length === 1 ? '' : 's'}. Nothing is generated, so it costs no tokens.`
    let courseId: string | null = opts.courseId ?? null
    const courses = await api.courses.list()
    const remembered = opts.remembered ? courses.find((c) => c.id === opts.courseId) : undefined
    let ask = !opts.courseId || (!!opts.remembered && !remembered)
    if (remembered) {
      const a = await confirmOrElse(`Add “${p.week}” to ${remembered.name}?`, `${what} ${remembered.name} is where you put this course’s weeks before.`, {
        confirmText: 'Add week',
        altText: 'Somewhere else…'
      })
      if (a === null) return false
      ask = a === 'alt'
    } else if (!ask) {
      if (!(await confirmDialog(`Add “${p.week}” to this course?`, `From ${p.course}: ${what}`, { confirmText: 'Add week' }))) return false
    }
    if (ask) {
      const same = courses.find((c) => c.name.trim().toLowerCase() === p.course.trim().toLowerCase())
      const choice = await chooseDialog(
        `Add “${p.week}” from ${p.course}`,
        [{ value: '', label: `A new course called “${p.course}”` }, ...courses.map((c) => ({ value: c.id, label: `Add to ${c.name}` }))],
        { message: what, confirmText: 'Add week', initial: same?.id ?? '' }
      )
      if (choice === null) return false
      courseId = choice || null
    }
    const r = await api.courses.importWeek({ file: p.file, courseId, market: opts.market, levels: opts.levels })
    toast(`Added ${p.week}: ${r.topics} topic${r.topics === 1 ? '' : 's'} and ${r.cards} card${r.cards === 1 ? '' : 's'}.${opts.afterAdd?.(r.fellBack) ?? ''}`, 'good')
    useStore.getState().bump()
    useStore.getState().go({ name: 'course', id: r.courseId })
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Save one week as a .studyweek file to send to someone. */
export async function shareWeek(weekId: string): Promise<void> {
  try {
    const r = await api.courses.exportWeek({ weekId })
    if (r) toast(`Saved ${r.week} (${r.written} written topic${r.written === 1 ? '' : 's'}). Send the file; they add it with “Add a shared week”.`, 'good')
  } catch (e) {
    toast(errorText(e), 'bad')
  }
}

/** What a week takes: slides, transcripts, readings, pictures of slides or the whiteboard. */
export const WEEK_SOURCE = /\.(pdf|docx|pptx|txt|md|markdown|vtt|srt|html?|rtf|csv|png|jpe?g|webp|gif)$/i

/**
 * Files dropped on a week's page: sources are added to the week like Add files,
 * and a shared .studyweek is merged into it (its topics, cards and files join
 * this week's) after a confirm.
 */
export async function dropOnWeek(weekId: string, weekLabel: string, paths: string[], courseId?: string): Promise<void> {
  const shared = paths.filter((p) => /\.studyweek$/i.test(p))
  const sources = paths.filter((p) => WEEK_SOURCE.test(p))
  const skipped = paths.length - shared.length - sources.length
  try {
    if (sources.length) {
      await api.courses.addFiles({ weekId, files: sources })
      if (skipped) toast(`${skipped} file${skipped === 1 ? '' : 's'} skipped: that kind of file can’t be read.`, 'info')
      // Adding files never plans by itself: ask first.
      const week = courseId ? (await api.courses.get({ id: courseId })).weeks.find((w) => w.id === weekId) : undefined
      await offerPlan(week ?? { id: weekId, label: weekLabel }, { added: sources.length })
    } else if (skipped && !shared.length) {
      toast('That kind of file can’t be added to a week. Try PDF, Word, PowerPoint, text, Markdown, a web page, RTF, CSV or a picture.', 'bad')
    }
    for (const file of shared) await sharedIntoWeek(weekId, weekLabel, file)
  } catch (e) {
    toast(errorText(e), 'bad')
  }
  useStore.getState().bump()
}

/** A shared week (picked, or the file given) goes into this week of yours, after its own topics. True when it was added. */
async function sharedIntoWeek(weekId: string, weekLabel: string, file?: string): Promise<boolean> {
  const p = await api.courses.previewWeek(file ? { file } : undefined)
  if (!p) return false
  const ok = await confirmDialog(
    `Add “${p.week}” from ${p.course} into ${weekLabel}?`,
    `Its ${p.topics} topic${p.topics === 1 ? '' : 's'} (${p.written} written), ${p.cards} recall card${p.cards === 1 ? '' : 's'} and ${p.files.length} file${p.files.length === 1 ? '' : 's'} join this week's, after its own topics. Nothing is generated, so it costs no tokens.`,
    { confirmText: 'Add to this week' }
  )
  if (!ok) return false
  const r = await api.courses.importWeek({ file: p.file, courseId: null, weekId })
  toast(`Added ${r.topics} topic${r.topics === 1 ? '' : 's'} and ${r.cards} card${r.cards === 1 ? '' : 's'} to ${weekLabel}`, 'good')
  return true
}

/** A week's ⋯ menu: pick a shared week (.studyweek) a friend sent and add it into this week. */
export async function addSharedToWeek(weekId: string, weekLabel: string): Promise<boolean> {
  try {
    const ok = await sharedIntoWeek(weekId, weekLabel)
    if (ok) useStore.getState().bump()
    return ok
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}
