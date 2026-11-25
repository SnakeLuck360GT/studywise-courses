import { api, errorText } from './api'
import { chooseDialog, confirmDialog } from './dialogs'
import { offerPlan } from './courseFlows'
import { toast, useStore } from './store'

/**
 * Add a week someone shared (a .studyweek file): say what's in it, ask where it
 * goes (one of your courses, or a new one), import it and open that course.
 * With `courseId` it goes straight into that course after a confirm.
 */
export async function importSharedWeek(opts: { file?: string; courseId?: string; ownRemoteId?: string } = {}): Promise<void> {
  try {
    const p = await api.courses.previewWeek(opts.file ? { file: opts.file } : undefined)
    if (!p) return
    const what = `${p.written} of ${p.topics} topic${p.topics === 1 ? '' : 's'} written, ${p.cards} recall card${p.cards === 1 ? '' : 's'}, ${p.files.length} file${p.files.length === 1 ? '' : 's'}. Nothing is generated, so it costs no tokens.`
    let courseId: string | null = opts.courseId ?? null
    if (opts.courseId) {
      if (!(await confirmDialog(`Add “${p.week}” to this course?`, `From ${p.course}: ${what}`, { confirmText: 'Add week' }))) return
    } else {
      const courses = await api.courses.list()
      const same = courses.find((c) => c.name.trim().toLowerCase() === p.course.trim().toLowerCase())
      const choice = await chooseDialog(
        `Add “${p.week}” from ${p.course}`,
        [{ value: '', label: `A new course called “${p.course}”` }, ...courses.map((c) => ({ value: c.id, label: `Add to ${c.name}` }))],
        { message: what, confirmText: 'Add week', initial: same?.id ?? '' }
      )
      if (choice === null) return
      courseId = choice || null
    }
    const r = await api.courses.importWeek({ file: p.file, courseId })
    // One of your own published weeks: linked back to its marketplace copy (unless the week it came from is still here).
    const linked = opts.ownRemoteId ? await api.market.claim({ weekId: r.weekId, remoteId: opts.ownRemoteId }).catch(() => false) : false
    toast(
      `Added ${p.week}: ${r.topics} topic${r.topics === 1 ? '' : 's'} and ${r.cards} card${r.cards === 1 ? '' : 's'}${linked ? '. It’s still on the marketplace: publishing it again updates that copy.' : ''}`,
      'good'
    )
    useStore.getState().bump()
    useStore.getState().go({ name: 'course', id: r.courseId })
  } catch (e) {
    toast(errorText(e), 'bad')
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
    for (const file of shared) {
      const p = await api.courses.previewWeek({ file })
      if (!p) continue
      const ok = await confirmDialog(
        `Add “${p.week}” from ${p.course} into ${weekLabel}?`,
        `Its ${p.topics} topic${p.topics === 1 ? '' : 's'} (${p.written} written), ${p.cards} recall card${p.cards === 1 ? '' : 's'} and ${p.files.length} file${p.files.length === 1 ? '' : 's'} join this week's, after its own topics. Nothing is generated, so it costs no tokens.`,
        { confirmText: 'Add to this week' }
      )
      if (!ok) continue
      const r = await api.courses.importWeek({ file: p.file, courseId: null, weekId })
      toast(`Added ${r.topics} topic${r.topics === 1 ? '' : 's'} and ${r.cards} card${r.cards === 1 ? '' : 's'} to ${weekLabel}`, 'good')
    }
  } catch (e) {
    toast(errorText(e), 'bad')
  }
  useStore.getState().bump()
}
