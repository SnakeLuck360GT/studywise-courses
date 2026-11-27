import { useEffect, useState } from 'react'
import {
  Scissors,
  BellOff,
  BellRing,
  AlertTriangle,
  Captions,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  FileText,
  FolderOpen,
  Layers,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Play,
  Plus,
  Presentation,
  RefreshCw,
  RotateCcw,
  Share2,
  Store,
  Globe,
  Lock,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
  Zap,
  FilePlus2,
  Merge,
  BookOpen, UploadCloud, Download } from 'lucide-react'
import { NOTE_LEVEL_INFO, NOTE_LEVELS, READING_WEEK, showError, WEEK_TEST_INFO, asReadingWeek, isReadingWeek, notReadingWeek, unreviewedSections, weekNumber, type CourseFile, type CourseFull, type NoteLevel, type Topic, type WeekFull } from '@shared/course'
import { estimateText, guessNote, topicSections, useUsageRate } from '../lib/usageEstimate'
import { mergeWeekWith, offerPlan, switchLevel, switchWeekLevel, writeQuickReview, writeTopics, writeWeekTest } from '../lib/courseFlows'
import { planUsageText, type JobInfo } from '@shared/types'
import { shareWeek, addSharedToWeek } from '../lib/weekShare'
import { chooseMarketWeek, declinedMarketWeek, findMarketWeek, marketMatches, modelsText, publishToMarket, setWeekVisibility } from '../lib/market'
import type { MarketMatch } from '@shared/market'
import { useStore, toast } from '../lib/store'
import { api, errorText } from '../lib/api'
import { askText, confirmDialog } from '../lib/dialogs'
import { Shell, PageTitle } from '../components/Shell'
import { Button, Dots, Menu, MenuItem, Pill, ProgressBar, Segmented, cx } from '../components/ui'
import { TrimCardsModal } from '../components/TrimCards'
import { AddNotesModal } from '../components/AddNotes'
import { JobBar, JobLive } from '../components/JobLive'
import { PrivatePill } from '../components/Visibility'
import { IS_MOBILE } from '../lib/platform'

export const runningJob = (jobs: JobInfo[], kind: JobInfo['kind'], key: string, value: string) => jobs.find((j) => j.kind === kind && j.status === 'running' && j.meta?.[key] === value)

/** One week of a course: its topics (with their sections), its files and its flashcards. */
export function WeekPage({ courseId, weekId }: { courseId: string; weekId: string }) {
  const go = useStore((s) => s.go)
  // Course jobs bump `version` when they start and finish, so topics written in
  // the background show up without leaving the page.
  const version = useStore((s) => s.version)
  const [c, setC] = useState<CourseFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    api.courses
      .get({ id: courseId })
      .then(setC)
      .catch((e) => setError(errorText(e)))
  useEffect(() => void load(), [courseId, version])

  if (error)
    return (
      <Shell>
        <p className="text-muted">{error}</p>
      </Shell>
    )
  if (!c) return null
  const idx = c.weeks.findIndex((w) => w.id === weekId)
  const w = c.weeks[idx]
  if (!w)
    return (
      <Shell>
        <p className="text-muted">This week isn’t in the course any more.</p>
        <Button className="mt-4" variant="outline" onClick={() => go({ name: 'course', id: courseId })}>
          Back to {c.name}
        </Button>
      </Shell>
    )
  const prev = c.weeks[idx - 1]
  const next = c.weeks[idx + 1]
  return <WeekView key={w.id} course={c} week={w} prev={prev} next={next} reload={load} />
}

function WeekView({ course: c, week: w, prev, next, reload }: { course: CourseFull; week: WeekFull; prev?: WeekFull; next?: WeekFull; reload: () => void }) {
  const go = useStore((s) => s.go)
  const jobs = useStore((s) => s.jobs)
  const planJob = runningJob(jobs, 'course_outline', 'weekId', w.id)
  const planning = w.status === 'planning' || !!planJob
  // Planning failed in the last day: warned about. Older, it's just a week to plan again.
  const planFailed = w.status === 'error' && showError(w)
  // Adding new notes to the week (Claude works what's new into its topics).
  const notesJob = runningJob(jobs, 'course_update', 'weekId', w.id)
  const [addingNotes, setAddingNotes] = useState(false)
  const canAddNotes = !IS_MOBILE && w.topics.length > 0 && !planning && !notesJob
  // Sections added later that you haven't reviewed yet, across the week.
  const newSections = w.topics.reduce((n, t) => n + unreviewedSections(t).length, 0)
  const unwritten = w.topics.filter((t) => t.status === 'planned' || t.status === 'error')
  const done = w.topics.filter((t) => t.progress.done).length
  const nextUp = w.topics.find((t) => t.status === 'ready' && !t.progress.done)
  // Written topics, and the ones that don't have a quick review yet.
  const written = w.topics.filter((t) => t.status === 'ready')
  const noQuick = written.filter((t) => !t.levels.includes('quick'))
  // Every level any written topic has: more than one, and the week can switch them all at once.
  const weekLevels = NOTE_LEVELS.filter((l) => written.some((t) => t.levels.includes(l)))
  const shownLevels = [...new Set(written.map((t) => t.level))]
  // Trimming recall cards: the whole week, or one topic. cut: Cut down flashcards (pick how far first).
  const [trim, setTrim] = useState<{ topicId?: string; title: string; cut?: boolean } | null>(null)
  // The end-of-week test being written (on its own, or straight after planning).
  const testJob = runningJob(jobs, 'course_week_test', 'weekId', w.id)
  // Going up to the marketplace (published automatically once it's written, or by hand).
  const publishJob = jobs.find((j) => j.status === 'running' && j.meta?.publishing && j.meta?.weekId === w.id)
  const canWriteTest = !IS_MOBILE && !planning && !testJob && (w.files.length > 0 || written.length > 0)
  // Reading week (usually week 6): no lectures, so nothing to plan or look for unless it gets files.
  const reading = isReadingWeek(w.label)
  const canBeReading = reading || weekNumber(w.label) === READING_WEEK
  // A blank week someone has already published: offered on the page.
  const blank = !w.topics.length && !planning && !reading
  const [made, setMade] = useState<MarketMatch[]>([])
  useEffect(() => {
    setMade([])
    if (!blank || declinedMarketWeek(w.id)) return
    let live = true
    void marketMatches(w.id).then((m) => live && setMade(m))
    return () => {
      live = false
    }
  }, [w.id, blank, w.files.length])
  const takeMade = async () => {
    if (await chooseMarketWeek(w, made)) reload()
    else if (declinedMarketWeek(w.id)) setMade([])
  }
  const toggleRecall = async () => {
    try {
      await api.courses.setWeekRecall({ weekId: w.id, on: w.recall_off })
      toast(w.recall_off ? `Recall is back on for ${w.label}` : `Recall off for ${w.label}: its cards won’t come up in recall, course review or due counts. Nothing is deleted.`, 'good')
      useStore.getState().bump()
      reload()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const minutes = w.topics.reduce((n, t) => n + (t.plan.minutes || 0), 0)
  // Roughly what writing the rest will take of the 5-hour limit.
  const rate = useUsageRate()
  const unwrittenSections = unwritten.reduce((n, t) => n + topicSections(t), 0)
  const writeEstimate = estimateText(unwrittenSections, rate)

  // Pick the level(s) of detail first; every level written is kept.
  const write = async (topics: Topic[]) => {
    if (await writeTopics(topics)) reload()
  }
  const quickReview = async (topics: Topic[], name: string) => {
    if (await writeQuickReview(topics, name)) reload()
  }
  const showWeekAt = async (level: NoteLevel) => {
    if (await switchWeekLevel(written, level)) reload()
  }
  // Planning always asks first, with room for instructions that take priority.
  const plan = async () => {
    if (await offerPlan(w)) reload()
  }
  const addFiles = async () => {
    const files = await api.app.pickFiles({ kind: 'course' })
    if (!files.length) return
    const n = (await api.courses.addFiles({ weekId: w.id, files })).length - w.files.length
    reload()
    if (n <= 0) return toast('None of those files can be added to a week.', 'bad')
    // Adding files doesn't plan by itself: ask.
    if (await offerPlan(w, { added: n })) reload()
  }
  const rename = async () => {
    const label = await askText('Rename week', { initial: w.label, confirmText: 'Rename' })
    if (label) await api.courses.renameWeek({ weekId: w.id, label }).then(reload)
  }
  const toggleReading = async () => {
    const label = reading ? notReadingWeek(w.label) : asReadingWeek(w.label)
    await api.courses.renameWeek({ weekId: w.id, label })
    toast(reading ? `${label} is a normal week again` : `${label}: no lectures, nothing to plan`, 'good')
    reload()
  }
  const del = async () => {
    if (!(await confirmDialog(`Delete ${w.label}?`, 'Its files, topics and their recall cards go.', { confirmText: 'Delete week', danger: true }))) return
    await api.courses.deleteWeek({ weekId: w.id })
    useStore.getState().bump()
    go({ name: 'course', id: c.id })
  }
  const saveNote = async (t: Topic) => {
    // Notes are made when the topic is written; this also makes them if they were deleted.
    const noteId = await api.courses.saveNote({ topicId: t.id })
    go({ name: 'notes', id: noteId })
  }

  return (
    <Shell>
      <PageTitle
        eyebrow={
          <span className="flex min-w-0 items-center gap-1.5">
            <button className="hover:text-ink" onClick={() => go({ name: 'courses' })}>
              Courses
            </button>
            <ChevronRight className="size-3.5 shrink-0" />
            <button className="truncate hover:text-ink" onClick={() => go({ name: 'course', id: c.id })}>
              {c.name}
            </button>
          </span>
        }
        title={w.label}
        actions={
          <>
            {nextUp && (
              <Button variant="primary" onClick={() => go({ name: 'topic', id: nextUp.id })}>
                <Play className="size-4" /> {nextUp.progress.section > 0 || nextUp.progress.step ? 'Continue' : 'Start'} {nextUp.content?.title ?? nextUp.plan.title}
              </Button>
            )}
            {!planning && w.files.length > 0 && !w.topics.length && !planFailed && (
              <Button variant="primary" onClick={plan}>
                <Sparkles className="size-4" /> Plan topics
              </Button>
            )}
            {!planning && unwritten.length > 0 && (
              <Button variant={nextUp ? 'outline' : 'primary'} onClick={() => write(unwritten)}>
                <Sparkles className="size-4" /> Write {unwritten.length === w.topics.length ? `all ${unwritten.length}` : `${unwritten.length} more`}
              </Button>
            )}
            {canAddNotes && (
              <Button onClick={() => setAddingNotes(true)} title="Paste or add new material: anything new is added after what you’ve already reviewed">
                <FilePlus2 className="size-4" /> Add new notes
              </Button>
            )}
            {!planning && noQuick.length > 0 && (
              <Button
                onClick={() => quickReview(noQuick, noQuick.length === 1 ? (noQuick[0].content?.title ?? noQuick[0].plan.title) : `${noQuick.length} topics`)}
                title="Just the main ideas, in about a third of the time. Saved alongside the notes you have; publishing the week includes both."
              >
                <Zap className="size-4" /> Quick review{noQuick.length < written.length ? ` of ${noQuick.length} more` : ''}
              </Button>
            )}
            <Menu
              trigger={(open) => (
                <Button variant="ghost" size="icon" onClick={open} aria-label={`${w.label} options`}>
                  <MoreHorizontal className="size-5" />
                </Button>
              )}
            >
              {(close) => (
                <>
                  {canAddNotes && (
                    <MenuItem desktopOnly icon={<FilePlus2 className="size-4" />} onClick={() => (close(), setAddingNotes(true))}>
                      Add new notes…
                    </MenuItem>
                  )}
                  <MenuItem desktopOnly icon={<Upload className="size-4" />} onClick={() => (close(), void addFiles())}>
                    Add files
                  </MenuItem>
                  {w.files.length > 0 && !planning && (
                    <MenuItem icon={<RefreshCw className="size-4" />} onClick={() => (close(), void plan())}>
                      {w.topics.length ? 'Plan again' : 'Plan topics'}
                    </MenuItem>
                  )}
                  {w.card_count > 0 && (
                    <MenuItem icon={<Scissors className="size-4" />} onClick={() => (close(), setTrim({ title: w.label }))}>
                      Trim recall cards…
                    </MenuItem>
                  )}
                  {w.card_count > 0 && (
                    <MenuItem icon={<Scissors className="size-4" />} onClick={() => (close(), setTrim({ title: w.label, cut: true }))}>
                      Cut down flashcards to key content…
                    </MenuItem>
                  )}
                  {canWriteTest && (
                    <MenuItem desktopOnly icon={<ClipboardCheck className="size-4" />} onClick={() => (close(), void writeWeekTest(w).then((ok) => ok && reload()))}>
                      {w.test ? 'Write the end-of-week test again…' : 'Write an end-of-week test…'}
                    </MenuItem>
                  )}
                  <MenuItem icon={w.recall_off ? <BellRing className="size-4" /> : <BellOff className="size-4" />} onClick={() => (close(), void toggleRecall())}>
                    {w.recall_off ? 'Turn recall back on' : 'Turn off recall for this week'}
                  </MenuItem>
                  <MenuItem icon={<Share2 className="size-4" />} onClick={() => (close(), void shareWeek(w.id))}>
                    Share this week…
                  </MenuItem>
                  <MenuItem desktopOnly icon={<Download className="size-4" />} onClick={() => (close(), void addSharedToWeek(w.id, w.label).then((ok) => ok && reload()))}>
                    Add a shared week here…
                  </MenuItem>
                  {blank && (
                    <MenuItem icon={<Search className="size-4" />} onClick={() => (close(), void findMarketWeek(w).then((ok) => ok && reload()))}>
                      Find on marketplace…
                    </MenuItem>
                  )}
                  {w.topics.some((t) => t.status === 'ready') && !w.private && !c.private && (
                    <MenuItem desktopOnly icon={<Store className="size-4" />} onClick={() => (close(), void publishToMarket(w))}>
                      Publish to marketplace…
                    </MenuItem>
                  )}
                  {!c.private && (
                    <MenuItem desktopOnly icon={w.private ? <Globe className="size-4" /> : <Lock className="size-4" />} onClick={() => (close(), void setWeekVisibility(w, !w.private).then((ok) => ok && reload()))}>
                      {w.private ? 'Make week public' : 'Make week private…'}
                    </MenuItem>
                  )}
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), void rename())}>
                    Rename week
                  </MenuItem>
                  {canBeReading && (
                    <MenuItem icon={<BookOpen className="size-4" />} onClick={() => (close(), void toggleReading())}>
                      {reading ? 'Not a reading week' : 'Mark as reading week'}
                    </MenuItem>
                  )}
                  {c.weeks.length > 1 && (
                    <MenuItem icon={<Merge className="size-4" />} onClick={() => (close(), void mergeWeekWith(c, w).then((ok) => ok && reload()))}>
                      Merge another week into this one…
                    </MenuItem>
                  )}
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), void del())}>
                    Delete week
                  </MenuItem>
                </>
              )}
            </Menu>
          </>
        }
      >
        <span>
          {w.topics.length ? `${w.topics.length} topic${w.topics.length === 1 ? '' : 's'} · about ${Math.round(minutes / 5) * 5 || minutes} minutes · ${done} done` : 'No topics yet'}
          {writeEstimate && !planning && (
            <span title={`${unwrittenSections} section${unwrittenSections === 1 ? '' : 's'} to write${guessNote(rate)}`}>
              {' '}· writing the {unwritten.length === w.topics.length ? 'topics' : `${unwritten.length} left`} ≈ {writeEstimate.replace(/^about /, '')}
            </span>
          )}
          {` · ${w.files.length} file${w.files.length === 1 ? '' : 's'} · ${w.card_count} flashcard${w.card_count === 1 ? '' : 's'}`}
        </span>
        {newSections > 0 && (
          <span className="ml-2 align-middle">
            <NewPill title="Sections added since you studied these topics. Everything without this mark you’ve already reviewed.">
              {newSections} new section{newSections === 1 ? '' : 's'} to review
            </NewPill>
          </span>
        )}
        {w.recall_off && (
          <button onClick={() => void toggleRecall()} className="ml-2 align-middle" title="Its cards don’t come up in recall, course review or due counts. Click to turn recall back on.">
            <Pill>
              <BellOff className="size-3" /> Recall off · turn on
            </Pill>
          </button>
        )}
        {(w.private || c.private) && !IS_MOBILE && (
          <span className="ml-2 align-middle">
            <PrivatePill title={c.private ? `Private: ${c.name} is private, so this week never goes on the marketplace. Make the course public from its ⋯ menu.` : 'Private: this week never goes on the marketplace. Make it public from the ⋯ menu.'} />
          </span>
        )}
      </PageTitle>

      {w.topics.length > 0 && <ProgressBar value={done / w.topics.length} className={weekLevels.length > 1 ? 'mb-4' : 'mb-8'} />}
      {weekLevels.length > 1 && (
        <div className="mb-8 flex flex-wrap items-center gap-2 text-[0.88rem]">
          <span className="text-muted">Show the week’s notes as</span>
          <Segmented
            value={(shownLevels.length === 1 ? shownLevels[0] : '') as NoteLevel}
            onChange={(l) => void showWeekAt(l)}
            options={weekLevels.map((l) => ({ value: l, label: NOTE_LEVEL_INFO[l].label }))}
          />
          {shownLevels.length > 1 && <span className="text-muted">(mixed)</span>}
        </div>
      )}

      <div className="flex flex-col gap-10">
        <section>
          <h2 className="mb-3 text-[1.1rem] font-semibold tracking-tight">Topics</h2>
          {publishJob && (
            <div className="mb-3 rounded-xl border border-accent/30 bg-accent-soft/40 p-5" data-publishing>
              <div className="flex items-center gap-2 font-semibold">
                <UploadCloud className="size-4 text-accent" /> Publishing {w.label} to the marketplace <Dots />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <JobBar job={publishJob} className="flex-1" />
                <span className="tabular w-10 text-right text-[0.8rem] font-semibold text-muted">{publishJob.percent === null ? '' : `${Math.round(publishJob.percent * 100)}%`}</span>
              </div>
              <div className="mt-1.5 text-[0.86rem] text-muted">{publishJob.progress}</div>
            </div>
          )}
          {notesJob && (
            <div className="mb-3 rounded-xl border border-accent/30 bg-accent-soft/40 p-5">
              <div className="flex items-center gap-2 font-semibold">
                <FilePlus2 className="size-4 text-accent" /> Adding your new notes to {w.label} <Dots />
              </div>
              <p className="mt-1 text-[0.9rem] text-muted">Claude is working out what’s new and where it goes. What you’ve already studied stays as it is. You can leave this page; it keeps going.</p>
              <div className="mt-4">
                <JobLive job={notesJob} />
              </div>
            </div>
          )}
          {planning && (
            <div className="rounded-xl border border-line bg-surface p-5">
              <div className="flex items-center gap-2 font-semibold">
                <Sparkles className="size-4 text-accent" /> Planning {w.label} <Dots />
              </div>
              <p className="mt-1 text-[0.9rem] text-muted">This takes a minute or two. You can leave this page; it keeps going.</p>
              <div className="mt-4">
                {planJob ? (
                  <JobLive job={planJob} />
                ) : (
                  <div className="flex flex-col gap-2">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="skeleton h-14" />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {planFailed && !planning && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-bad/40 bg-bad-soft px-5 py-4">
              <AlertTriangle className="size-5 text-bad" />
              <div className="min-w-0 flex-1 text-[0.92rem]">
                <div className="font-semibold">Planning didn’t finish</div>
                <div className="text-muted">{w.error}</div>
              </div>
              <Button size="sm" variant="ink" onClick={plan}>
                Try again
              </Button>
              <button
                onClick={() => void api.courses.dismissError({ weekId: w.id }).then(reload)}
                className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink"
                aria-label="Dismiss"
                title="Dismiss: the week stays as it is"
              >
                <X className="size-4" />
              </button>
            </div>
          )}
          {!planning && w.topics.length > 0 && (
            <ol className="flex flex-col gap-2">
              {w.topics.map((t) => (
                <TopicRow key={t.id} t={t} write={write} saveNote={saveNote} reload={reload} onTrim={() => setTrim({ topicId: t.id, title: t.content?.title ?? t.plan.title })} />
              ))}
            </ol>
          )}
          {blank && made.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-5 py-4">
              <Store className="size-5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1 text-[0.92rem]">
                <div className="font-semibold">Someone has already made {w.label}</div>
                <div className="text-muted">
                  {made[0].course.name} · {made[0].week.label} by {made[0].week.author}: {made[0].week.writtenCount} of {made[0].week.topicCount} topics written{made[0].week.writtenWith.length ? `, with ${modelsText(made[0].week.writtenWith)}` : ''}.
                  {made.length > 1 ? ` And ${made.length - 1} more.` : ''} Adding it costs no tokens.
                </div>
              </div>
              <Button size="sm" variant="ink" onClick={takeMade}>
                Use this week…
              </Button>
            </div>
          )}
          {!planning && !w.topics.length && !planFailed && reading && !w.files.length ? (
            <div className="flex items-start gap-3 rounded-xl border border-good/30 bg-good-soft px-5 py-4">
              <BookOpen className="mt-0.5 size-5 shrink-0 text-good" />
              <div className="text-[0.92rem]">
                <div className="font-semibold">Reading week</div>
                <div className="text-muted">No lectures this week, so there’s nothing to plan. A good time to catch up on earlier weeks. If you have readings, add them below and plan topics from them.</div>
              </div>
            </div>
          ) : (
            !planning &&
            !w.topics.length &&
            !planFailed && (
              <p className="rounded-xl border border-dashed border-line px-5 py-6 text-center text-[0.92rem] text-muted">
                {w.files.length ? 'Plan this week to split its files into topics you learn in short sections.' : 'Add this week’s files, then plan its topics.'}
              </p>
            )
          )}
        </section>

        {(w.test || testJob || (canWriteTest && w.topics.length > 0)) && (
          <section>
            <h2 className="mb-3 text-[1.1rem] font-semibold tracking-tight">End-of-week test</h2>
            {testJob ? (
              <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-5">
                <div className="flex items-center gap-2 font-semibold">
                  <ClipboardCheck className="size-4 text-accent" /> Writing the end-of-week test <Dots />
                </div>
                <p className="mt-1 text-[0.9rem] text-muted">Multiple choice across the whole week. You can leave this page; it keeps going.</p>
                <div className="mt-4">
                  <JobLive job={testJob} />
                </div>
              </div>
            ) : w.test ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-5 py-4">
                <ClipboardCheck className="size-5 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {w.test.questions.length} multiple-choice questions · {WEEK_TEST_INFO[w.test.difficulty].label}
                  </div>
                  <div className="text-[0.88rem] text-muted">
                    {w.test.best
                      ? `Best ${w.test.best.score}/${w.test.best.total} (${Math.round((w.test.best.score / Math.max(1, w.test.best.total)) * 100)}%)${w.test.last && w.test.last.at !== w.test.best.at ? ` · last time ${w.test.last.score}/${w.test.last.total}` : ''}`
                      : 'Across every topic of the week. Take it from memory once you’ve studied them.'}
                  </div>
                </div>
                <Button size="sm" variant={w.test.best ? 'soft' : 'primary'} onClick={() => go({ name: 'weektest', courseId: c.id, weekId: w.id })}>
                  {w.test.best ? 'Take it again' : 'Take the test'}
                </Button>
                {canWriteTest && (
                  <Button size="sm" variant="ghost" onClick={() => void writeWeekTest(w).then((ok) => ok && reload())} title="New questions, at the same or another difficulty">
                    <RefreshCw className="size-4" /> Write again
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line px-5 py-4">
                <ClipboardCheck className="size-5 text-muted" />
                <div className="min-w-0 flex-1 text-[0.9rem] text-muted">Test yourself on the whole week: multiple choice only, easy, medium or hard. Optional, one AI call.</div>
                <Button size="sm" variant="soft" onClick={() => void writeWeekTest(w).then((ok) => ok && reload())}>
                  Write a test…
                </Button>
              </div>
            )}
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[1.1rem] font-semibold tracking-tight">Files</h2>
            {!planning && !IS_MOBILE && (
              <span className="flex items-center gap-2">
                <span className="hidden text-[0.82rem] text-muted sm:inline">or drop files (or a shared week) on this page</span>
                <Button size="sm" variant="ghost" onClick={addFiles}>
                  <Plus className="size-4" /> Add files
                </Button>
              </span>
            )}
          </div>
          {w.files.length > 0 ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {w.files.map((f) => (
                <FileRow key={f.id} f={f} canRemove={!planning} reload={reload} />
              ))}
            </ul>
          ) : IS_MOBILE ? (
            <p className="rounded-xl border border-dashed border-line px-5 py-6 text-center text-[0.92rem] text-muted">Add this week’s slides and transcripts in Studywise on your computer.</p>
          ) : (
            <button onClick={addFiles} className="flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed border-line px-5 py-6 text-center transition-colors hover:border-accent">
              <Upload className="size-5 text-muted" />
              <span className="font-semibold">{reading ? 'Add readings (optional)' : `Add ${w.label}’s files`}</span>
              <span className="text-[0.88rem] text-muted">Slides, lecture transcripts, readings or pictures, or a week a friend shared. Click, or drop them anywhere on this page.</span>
            </button>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-[1.1rem] font-semibold tracking-tight">Flashcards</h2>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-5 py-4">
            <Layers className="size-5 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {w.card_count} card{w.card_count === 1 ? '' : 's'} in {c.name} · {w.label}
              </div>
              <div className="text-[0.88rem] text-muted">Recall cards from this week’s topics, plus any you’ve imported or added.</div>
            </div>
            {w.deck_id && w.card_count > 0 && (
              <Button size="sm" variant="soft" onClick={() => go({ name: 'flashcards', deckId: w.deck_id!, mode: 'due' })}>
                Review due
              </Button>
            )}
            {w.card_count > 1 && (
              <Button size="sm" variant="ghost" onClick={() => setTrim({ title: w.label, cut: true })} title="Keep only the key content: pick how far to cut, then check the list before anything goes">
                <Scissors className="size-4" /> Cut down…
              </Button>
            )}
            {w.deck_id && (
              <Button size="sm" variant="ghost" onClick={() => go({ name: 'deck', id: w.deck_id! })}>
                Open deck
              </Button>
            )}
          </div>
        </section>
      </div>

      {(prev || next) && (
        <nav className="mt-10 flex items-center justify-between gap-3 border-t border-line pt-5">
          {prev ? (
            <Button variant="ghost" onClick={() => go({ name: 'week', courseId: c.id, weekId: prev.id })}>
              <ChevronLeft className="size-4" /> {prev.label}
            </Button>
          ) : (
            <span />
          )}
          {next && (
            <Button variant="ghost" onClick={() => go({ name: 'week', courseId: c.id, weekId: next.id })}>
              {next.label} <ChevronRight className="size-4" />
            </Button>
          )}
        </nav>
      )}
      <AddNotesModal open={addingNotes} onClose={() => setAddingNotes(false)} week={w} onStarted={reload} />
      {trim && (
        <TrimCardsModal
          weekId={w.id}
          topicId={trim.topicId}
          title={trim.title}
          cut={trim.cut}
          cards={w.card_count}
          onClose={() => {
            setTrim(null)
            reload()
          }}
        />
      )}
    </Shell>
  )
}

const fileIcon = (name: string) => {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (ext === '.pptx') return Presentation
  if (ext === '.vtt' || ext === '.srt') return Captions
  return FileText
}

function FileRow({ f, canRemove, reload }: { f: CourseFile; canRemove: boolean; reload: () => void }) {
  const Icon = fileIcon(f.name)
  const open = (reveal: boolean) => api.courses.openFile({ fileId: f.id, reveal }).catch((e) => toast(errorText(e), 'bad'))
  // The files themselves stay on the computer.
  if (IS_MOBILE)
    return (
      <li className="flex items-center gap-3 px-4 py-3">
        <Icon className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{f.name}</span>
        {f.pages ? <span className="shrink-0 text-[0.85rem] text-muted">{f.pages} pages</span> : null}
      </li>
    )
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Icon className="size-4 shrink-0 text-muted" />
      <button className="min-w-0 flex-1 truncate text-left hover:text-accent" onClick={() => void open(false)} title={`Open ${f.name}`}>
        {f.name}
      </button>
      {f.pages ? <span className="shrink-0 text-[0.85rem] text-muted">{f.pages} pages</span> : null}
      <Button size="icon" variant="ghost" onClick={() => void open(true)} aria-label={`Show ${f.name} in its folder`} title="Show in folder">
        <FolderOpen className="size-4" />
      </Button>
      {canRemove && (
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Remove ${f.name}`}
          title="Remove from the course"
          onClick={async () => {
            if (await confirmDialog(`Remove ${f.name}?`, 'Topics already written from it stay as they are.', { confirmText: 'Remove' })) await api.courses.removeFile({ fileId: f.id }).then(reload)
          }}
        >
          <X className="size-4" />
        </Button>
      )}
    </li>
  )
}

function TopicRow({ t, write, saveNote, reload, onTrim }: { t: Topic; write: (topics: Topic[]) => void; saveNote: (t: Topic) => void; reload: () => void; onTrim: () => void }) {
  const go = useStore((s) => s.go)
  const jobs = useStore((s) => s.jobs)
  const job = runningJob(jobs, 'course_topic', 'topicId', t.id)
  // The last write of this topic since the app started, for its share of the 5-hour limit.
  const lastWrite = jobs.find((j) => j.kind === 'course_topic' && j.status === 'done' && j.meta?.topicId === t.id)
  const used = planUsageText(lastWrite?.planUsage, true)
  // Not written yet: roughly what writing it will take, from what sections have taken before.
  const rate = useUsageRate()
  const estimate = estimateText(topicSections(t), rate, true)
  const writing = t.status === 'writing' || !!job
  const ready = t.status === 'ready' && !!t.content
  const [open, setOpen] = useState(ready)
  const p = t.progress
  const headings = ready ? t.content!.sections.map((s) => s.heading) : t.plan.sections
  const n = Number(t.key.match(/t(\d+)$/)?.[1] ?? t.position + 1)
  // Added by "Add new notes": sections you haven't reviewed yet, or a whole new topic.
  const fresh = new Set(unreviewedSections(t))
  return (
    <li className="rounded-xl border border-line bg-surface transition-[border-color,box-shadow] duration-300 ease-out-soft hover:border-[color-mix(in_oklab,var(--ink)_22%,transparent)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 sm:gap-x-4 sm:px-5 sm:py-4">
        <div className={cx('grid size-8 shrink-0 place-items-center rounded-full text-[0.9rem] font-semibold transition-colors duration-500 sm:size-9', p.done ? 'bg-good text-white' : 'bg-surface-2')}>{p.done ? <CheckCircle2 className="size-5" /> : n}</div>
        <button className="min-w-[min(12rem,100%)] flex-1 text-left" onClick={() => headings.length && setOpen((v) => !v)} aria-expanded={open}>
          <div className="flex flex-wrap items-center gap-1.5 font-semibold">
            {t.content?.title ?? t.plan.title}
            {headings.length > 0 && <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />}
            {fresh.size > 0 && <NewPill title="Added since you studied this topic. Continue picks up at the first new section.">{fresh.size} new section{fresh.size === 1 ? '' : 's'}</NewPill>}
            {!ready && t.plan.added && <NewPill title="A topic from notes you added later">New topic</NewPill>}
          </div>
          <div className="truncate text-[0.88rem] text-muted">{t.content?.goal ?? t.plan.goal}</div>
          {writing && !job && (
            <div className="mt-1 flex items-center gap-1.5 text-[0.85rem] text-accent">
              <Sparkles className="size-3.5" /> Writing…
            </div>
          )}
          {t.error && !writing && showError(t) && (
            <div className="mt-1 flex items-center gap-1.5 text-[0.85rem] text-bad">
              <span className="min-w-0">{t.status === 'ready' ? `Last write didn’t finish: ${t.error}` : t.error}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => (e.stopPropagation(), void api.courses.dismissError({ topicId: t.id }).then(reload))}
                onKeyDown={(e) => e.key === 'Enter' && (e.stopPropagation(), void api.courses.dismissError({ topicId: t.id }).then(reload))}
                className="grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-surface-2 hover:text-ink"
                aria-label="Dismiss"
                title="Dismiss this warning"
              >
                <X className="size-3.5" />
              </span>
            </div>
          )}
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-[0.85rem] text-muted">
          {t.plan.minutes > 0 && (
            <span className="hidden items-center gap-1 sm:flex">
              <Clock className="size-3.5" /> {t.plan.minutes} min
            </span>
          )}
          {!job && !ready && !writing && estimate && (
            <span className="hidden text-[0.8rem] sm:inline" title={`Writing its ${topicSections(t)} section${topicSections(t) === 1 ? '' : 's'} should use ${estimateText(topicSections(t), rate)}${guessNote(rate)}`}>
              ≈ {estimate.replace(/^about /, '')}
            </span>
          )}
          {!job && lastWrite?.planUsage?.measuring && <span className="text-[0.8rem]">Measuring usage…</span>}
          {!job && used && (
            <span className="hidden text-[0.8rem] sm:inline" title={`Writing this topic used ${planUsageText(lastWrite?.planUsage)}`}>
              Used {used}
            </span>
          )}
          {p.checkTotal ? (
            <Pill tone={p.checkScore != null && p.checkScore / p.checkTotal >= 0.8 ? 'good' : 'warn'}>
              Test {p.checkScore}/{p.checkTotal}
            </Pill>
          ) : null}
          {ready ? (
            <>
              <Button size="sm" variant={p.done ? 'ghost' : 'soft'} onClick={() => go({ name: 'topic', id: t.id })}>
                {p.done ? <RotateCcw className="size-4" /> : <Play className="size-4" />} {p.done ? 'Again' : p.section > 0 || p.step ? 'Continue' : 'Start'}
              </Button>
              {!!t.content?.check.length && (
                <Button size="sm" variant="ghost" onClick={() => go({ name: 'topic', id: t.id, test: true })} title={`Topic test: ${t.content.check.length} questions, from memory`}>
                  <ClipboardCheck className="size-4" /> Test
                </Button>
              )}
              <Menu
                trigger={(openMenu) => (
                  <Button size="icon" variant="ghost" onClick={openMenu} aria-label="Topic options">
                    <MoreHorizontal className="size-4" />
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem icon={<NotebookPen className="size-4" />} onClick={() => (close(), void saveNote(t))}>
                      Open notes
                    </MenuItem>
                    <MenuItem icon={<RotateCcw className="size-4" />} onClick={() => (close(), void api.courses.resetProgress({ topicId: t.id }).then(reload))}>
                      Reset progress
                    </MenuItem>
                    {t.card_count > 0 && (
                      <MenuItem icon={<Scissors className="size-4" />} onClick={() => (close(), onTrim())}>
                        Trim its recall cards…
                      </MenuItem>
                    )}
                    <MenuItem icon={<Layers className="size-4" />} onClick={() => (close(), write([t]))}>
                      Write at another level…
                    </MenuItem>
                    <MenuItem
                      icon={<RefreshCw className="size-4" />}
                      onClick={async () => {
                        close()
                        const lvl = NOTE_LEVEL_INFO[t.level].inline
                        const note = t.levels.length > 1 ? `Only the ${lvl} notes are replaced; your other levels and the recall cards stay.` : 'You get new notes and questions, and its recall cards are replaced (with their review history).'
                        if (await confirmDialog(`Write the ${lvl} notes again?`, note, { confirmText: 'Rewrite', danger: true })) {
                          try {
                            await api.courses.write({ topicIds: [t.id], levels: [t.level] })
                            reload()
                          } catch (e) {
                            toast(errorText(e), 'bad')
                          }
                        }
                      }}
                    >
                      Write again
                    </MenuItem>
                  </>
                )}
              </Menu>
            </>
          ) : (
            !writing && (
              <Button size="sm" variant="soft" onClick={() => write([t])}>
                <Sparkles className="size-4" /> {t.status === 'error' ? 'Try again' : 'Write'}
              </Button>
            )
          )}
          {job && (
            <Button size="sm" variant="ghost" onClick={() => api.jobs.cancel({ id: job.id })}>
              Cancel
            </Button>
          )}
        </div>
        {ready && !writing && (
          <div className="flex basis-full flex-wrap items-center gap-2 sm:pl-13">
            <span className="text-[0.8rem] text-muted">Notes:</span>
            {t.levels.length > 1 ? (
              <Segmented
                value={t.level}
                onChange={(l) => void switchLevel(t, l).then((x) => x && reload())}
                options={t.levels.map((l) => ({ value: l, label: NOTE_LEVEL_INFO[l].label }))}
              />
            ) : (
              <Pill tone="accent">{NOTE_LEVEL_INFO[t.level].label}</Pill>
            )}
            {!t.levels.includes('quick') && (
              <Button size="sm" variant="ghost" onClick={() => void writeQuickReview([t], t.content?.title ?? t.plan.title).then((ok) => ok && reload())} title="Just the main ideas, in about a third of the time. Saved alongside these; publishing the week includes both.">
                <Zap className="size-3.5" /> Add a quick review
              </Button>
            )}
          </div>
        )}
        {job && (
          <div className="basis-full pl-13">
            <JobLive job={job} />
          </div>
        )}
      </div>
      {open && headings.length > 0 && (
        <ol className="flex flex-col border-t border-line px-2 py-2 sm:pl-14">
          {headings.map((h, i) => {
            const passed = p.done || p.section > i
            return (
              <li key={i}>
                {ready ? (
                  <button
                    onClick={() => go({ name: 'topic', id: t.id, section: i })}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[0.92rem] transition-colors hover:bg-surface-2"
                    title={`Review “${h}”`}
                  >
                    {passed ? <CheckCircle2 className="size-4 shrink-0 text-good" /> : <span className="grid size-4 shrink-0 place-items-center text-[0.75rem] text-muted tabular">{i + 1}</span>}
                    <span className="min-w-0 flex-1 truncate">{h}</span>
                    {fresh.has(i) && <NewPill title="Added since you studied this topic: not reviewed yet">New</NewPill>}
                    <ChevronRight className="size-3.5 shrink-0 text-muted" />
                  </button>
                ) : (
                  <div className="flex items-center gap-2.5 px-3 py-1.5 text-[0.92rem] text-muted">
                    <span className="grid size-4 shrink-0 place-items-center text-[0.75rem] tabular">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{h}</span>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </li>
  )
}

/** Marks what was added by "Add new notes" and isn't reviewed yet. */
function NewPill({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-2 py-px text-[0.72rem] font-semibold text-accent-ink">
      <Sparkles className="size-3" /> {children}
    </span>
  )
}
