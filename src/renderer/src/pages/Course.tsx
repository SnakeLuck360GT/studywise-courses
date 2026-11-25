import { useEffect, useState } from 'react'
import { SlidersHorizontal, Sparkles, Play, Layers, MoreHorizontal, Pencil, Trash2, Plus, ChevronRight, Download, BellOff, CalendarDays, Scissors, StickyNote, Store, Globe, Lock } from 'lucide-react'
import { offerPlan, writeTopics } from '../lib/courseFlows'
import { importSharedWeek } from '../lib/weekShare'
import { declinedMarketWeek, marketMatches, offerMarketWeek, publishAllToMarket, setCourseVisibility } from '../lib/market'
import { TrimCardsModal } from '../components/TrimCards'
import { examPhase, revisionMaxGapDays, sortWeeks, type CourseFull, type WeekFull, type WeekOrder } from '@shared/course'
import { useStore, toast } from '../lib/store'
import { api, errorText } from '../lib/api'
import { askText, confirmDialog } from '../lib/dialogs'
import { Shell, PageTitle } from '../components/Shell'
import { PrivatePill, VisibilityField, type Visibility } from '../components/Visibility'
import { IS_MOBILE } from '../lib/platform'
import { Button, Field, Input, Menu, MenuItem, Modal, Pill, ProgressBar, Segmented, Textarea } from '../components/ui'
import { FileDrop } from './Courses'
import { runningJob } from './Week'
import { DeckSettings } from './Deck'
import type { Deck } from '@shared/types'

export function CoursePage({ id }: { id: string }) {
  const go = useStore((s) => s.go)
  const version = useStore((s) => s.version)
  const [c, setC] = useState<CourseFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [aiDeck, setAiDeck] = useState<Deck | null>(null)
  const [trimAll, setTrimAll] = useState(false)
  const [examOpen, setExamOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const load = () =>
    api.courses
      .get({ id })
      .then(setC)
      .catch((e) => setError(errorText(e)))
  useEffect(() => void load(), [id, version])
  const made = useMadeWeeks(c)
  const [order, setOrder] = useWeekOrder()

  if (error)
    return (
      <Shell>
        <p className="text-muted">{error}</p>
      </Shell>
    )
  if (!c) return null

  const topics = c.weeks.flatMap((w) => w.topics)
  const write = async (list: typeof topics) => {
    if (await writeTopics(list)) void load()
  }
  const rename = async () => {
    const name = await askText('Rename course', { initial: c.name, confirmText: 'Rename' })
    if (name) await api.courses.rename({ id, name }).then(load)
  }
  const del = async () => {
    if (!(await confirmDialog(`Delete ${c.name}?`, 'All weeks, topics, figures and copies of your files go. Its flashcard folder and week decks go too.', { confirmText: 'Delete', danger: true }))) return
    await api.courses.delete({ id, keepDeck: false })
    useStore.getState().bump()
    go({ name: 'courses' })
  }

  // Course-wide Models & instructions, shared by every week deck.
  const openAiSettings = async () => {
    const s = await api.courses.deckSettings({ courseId: c.id })
    const t = new Date().toISOString()
    setAiDeck({ id: '', folder_id: c.deck_folder_id, name: c.name, description: '', learn_settings: null, created_at: t, updated_at: t, ...s })
  }

  const unwritten = topics.filter((t) => t.status === 'planned' || t.status === 'error')
  const done = topics.filter((t) => t.progress.done).length
  const minutes = topics.reduce((n, t) => n + (t.plan.minutes || 0), 0)
  const next = topics.find((t) => t.status === 'ready' && !t.progress.done)

  return (
    <Shell>
      <PageTitle
        eyebrow={
          <button className="hover:text-ink" onClick={() => go({ name: 'courses' })}>
            Courses
          </button>
        }
        title={c.name}
        actions={
          <>
            {next && (
              <Button variant="primary" onClick={() => go({ name: 'topic', id: next.id })}>
                <Play className="size-4" /> {next.progress.section > 0 ? 'Continue' : 'Start'} {next.content?.title ?? next.plan.title}
              </Button>
            )}
            {unwritten.length > 0 && (
              <Button variant={next ? 'outline' : 'primary'} onClick={() => write(unwritten)}>
                <Sparkles className="size-4" /> Write {unwritten.length} topic{unwritten.length === 1 ? '' : 's'}
              </Button>
            )}
            {topics.some((t) => t.card_count > 0) && (
              <Button variant="outline" onClick={() => go({ name: 'flashcards', deckId: '', mode: 'due', courseId: c.id })} title="Due cards from every week">
                <Layers className="size-4" /> Recall cards
              </Button>
            )}
            <Menu
              trigger={(open) => (
                <Button variant="ghost" size="icon" onClick={open} aria-label="More">
                  <MoreHorizontal className="size-5" />
                </Button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem icon={<Plus className="size-4" />} onClick={() => (close(), setAdding(true))}>
                    Add a week
                  </MenuItem>
                  <MenuItem desktopOnly icon={<Download className="size-4" />} onClick={() => (close(), void importSharedWeek({ courseId: id }))}>
                    Add a shared week…
                  </MenuItem>
                  {topics.some((t) => t.status === 'ready') && !c.private && (
                    <MenuItem desktopOnly icon={<Store className="size-4" />} onClick={() => (close(), void publishAllToMarket(id))}>
                      Publish course to marketplace…
                    </MenuItem>
                  )}
                  <MenuItem desktopOnly icon={c.private ? <Globe className="size-4" /> : <Lock className="size-4" />} onClick={() => (close(), void setCourseVisibility(c, !c.private).then((ok) => void (ok && load())))}>
                    {c.private ? 'Make course public' : 'Make course private…'}
                  </MenuItem>
                  <MenuItem icon={<CalendarDays className="size-4" />} onClick={() => (close(), setExamOpen(true))}>
                    {c.exam_date ? 'Change exam date…' : 'Set exam date…'}
                  </MenuItem>
                  {topics.some((t) => t.card_count > 0) && (
                    <MenuItem icon={<Scissors className="size-4" />} onClick={() => (close(), setTrimAll(true))}>
                      Trim recall cards (whole course)…
                    </MenuItem>
                  )}
                  <MenuItem icon={<StickyNote className="size-4" />} onClick={() => (close(), setNoteOpen(true))}>
                    {c.note ? 'Edit note for the AI…' : 'Add a note for the AI…'}
                  </MenuItem>
                  <MenuItem icon={<SlidersHorizontal className="size-4" />} onClick={() => (close(), void openAiSettings())}>
                    Models &amp; instructions
                  </MenuItem>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), void rename())}>
                    Rename course
                  </MenuItem>
                  {c.deck_folder_id && (
                    <MenuItem icon={<Layers className="size-4" />} onClick={() => (close(), go({ name: 'decks', folderId: c.deck_folder_id }))}>
                      Open flashcard folder
                    </MenuItem>
                  )}
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), void del())}>
                    Delete course
                  </MenuItem>
                </>
              )}
            </Menu>
          </>
        }
      >
        <span>
          {c.weeks.length} week{c.weeks.length === 1 ? '' : 's'}
          {topics.length > 0 && ` · ${topics.length} topics · about ${Math.round(minutes / 5) * 5 || minutes} minutes · ${done} done`}
        </span>
        <ExamBadge date={c.exam_date} onClick={() => setExamOpen(true)} />
        {c.private && !IS_MOBILE && (
          <span className="ml-2 align-middle">
            <PrivatePill title="Private: none of this course’s weeks go on the marketplace. Make it public from the ⋯ menu." />
          </span>
        )}
      </PageTitle>

      {topics.length > 0 && <ProgressBar value={done / topics.length} className="mb-8" />}

      <CourseNote note={c.note} onEdit={() => setNoteOpen(true)} />

      {c.weeks.length > 1 && (
        <div className="mb-2 flex justify-end">
          <Segmented
            value={order}
            onChange={setOrder}
            options={[
              { value: 'asc', label: 'Week 1 first' },
              { value: 'desc', label: 'Latest week first' }
            ]}
          />
        </div>
      )}
      {c.weeks.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {sortWeeks(c.weeks, order).map((w) => (
            <WeekRow key={w.id} c={c} w={w} made={made.has(w.id)} />
          ))}
        </ul>
      )}

      <button
        onClick={() => setAdding(true)}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line py-5 font-semibold text-muted transition-colors hover:border-accent hover:text-accent"
      >
        <Plus className="size-5" /> Add {c.weeks.length ? 'next week' : 'the first week'}
      </button>

      {aiDeck && <DeckSettings deck={aiDeck} courseId={c.id} onClose={() => setAiDeck(null)} onSaved={() => setAiDeck(null)} />}
      {trimAll && (
        <TrimCardsModal
          courseId={c.id}
          title={c.name}
          onClose={() => {
            setTrimAll(false)
            void load()
          }}
        />
      )}
      {examOpen && (
        <ExamDateModal
          courseId={c.id}
          date={c.exam_date}
          onClose={(changed) => {
            setExamOpen(false)
            if (changed) {
              void load()
              useStore.getState().bump()
            }
          }}
        />
      )}

      {noteOpen && (
        <CourseNoteModal
          courseId={c.id}
          note={c.note}
          onClose={(changed) => {
            setNoteOpen(false)
            if (changed) void load()
          }}
        />
      )}

      {adding && (
        <AddWeekModal
          course={c}
          defaultLabel={`Week ${c.weeks.length + 1}`}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            void load()
          }}
        />
      )}
    </Shell>
  )
}

/** The course's note to the AI, shown on the course page so you know what every prompt is told. */
function CourseNote({ note, onEdit }: { note: string; onEdit: () => void }) {
  if (!note)
    return (
      <button
        onClick={onEdit}
        className="mb-6 flex w-full items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3 text-left text-[0.9rem] text-muted transition-colors hover:border-accent hover:text-ink"
      >
        <StickyNote className="size-4 shrink-0" />
        <span>
          <span className="font-semibold text-ink">Add a note for the AI.</span> It goes into every prompt for this course, e.g. “This course is coding heavy and in C, so teach the theory and the coding together.”
        </span>
      </button>
    )
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <StickyNote className="mt-0.5 size-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[0.78rem] font-semibold text-muted">Note for the AI · added to every prompt for this course</div>
        <p className="whitespace-pre-wrap text-[0.95rem]">{note}</p>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        <Pencil className="size-4" /> Edit
      </Button>
    </div>
  )
}

function CourseNoteModal({ courseId, note, onClose }: { courseId: string; note: string; onClose: (changed: boolean) => void }) {
  const [value, setValue] = useState(note)
  const [busy, setBusy] = useState(false)
  const save = async (v: string) => {
    setBusy(true)
    try {
      await api.courses.setNote({ courseId, note: v })
      toast(v.trim() ? 'Saved. Every prompt for this course now includes your note.' : 'Note removed.', 'good')
      onClose(true)
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title="Note for the AI"
      footer={
        <>
          {note && (
            <Button variant="ghost" onClick={() => void save('')}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save(value)}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[0.92rem] text-muted">
        This is added automatically to everything the AI does for this course: planning weeks, writing topics, marking your answers, trimming cards and explaining its cards. Use it for what the AI should always know about the course.
      </p>
      <Textarea
        rows={4}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. This course is coding heavy and in C, so tailor the notes towards learning the theory and the coding at the same time."
      />
      <p className="mt-2 text-[0.82rem] text-muted">It applies to new AI calls. Topics already written stay as they are until you write them again.</p>
    </Modal>
  )
}

const fmtDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** "Exam 14 Jan 2027 · in 53 days · revision from 3 Dec", or a prompt to set one. */
function ExamBadge({ date, onClick }: { date: string | null; onClick: () => void }) {
  const p = examPhase(date)
  const text =
    p.phase === 'none'
      ? 'Set an exam date'
      : p.phase === 'over'
        ? `Exam was ${fmtDate(date!)} · recall resting`
        : p.phase === 'steady'
          ? `Exam ${fmtDate(date!)} · in ${p.days} days · steady recall, revision from ${p.startsOn ? fmtDate(p.startsOn) : 'later'}`
          : `Exam ${fmtDate(date!)} · ${p.days === 0 ? 'today' : `in ${p.days} day${p.days === 1 ? '' : 's'}`} · revision: every card at least every ${revisionMaxGapDays(p.days)} day${revisionMaxGapDays(p.days) === 1 ? '' : 's'}`
  return (
    <button
      onClick={onClick}
      className="ml-2 align-middle"
      title={
        p.phase === 'none'
          ? 'With an exam date, recall stays steady until 6 weeks before it, then ramps up, and every card gets a last look before the exam.'
          : 'More than 6 weeks out, reviews keep going a little more spread out. In the last 6 weeks they ramp up: the longest gap between reviews shrinks from 10 days to every day, and every card is due once more at least 2 days before the exam. After the exam the course rests.'
      }
    >
      <Pill tone={p.phase === 'revision' ? 'warn' : 'neutral'}>
        <CalendarDays className="size-3" /> {text}
      </Pill>
    </button>
  )
}

function ExamDateModal({ courseId, date, onClose }: { courseId: string; date: string | null; onClose: (changed: boolean) => void }) {
  const [value, setValue] = useState(date ?? '')
  const save = async (d: string | null) => {
    try {
      await api.courses.setExamDate({ courseId, date: d })
      onClose(true)
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title="Exam date"
      footer={
        <>
          {date && (
            <Button variant="ghost" onClick={() => void save(null)}>
              Clear
            </Button>
          )}
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!value} onClick={() => void save(value)}>
            Save
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[0.92rem] text-muted">
        Until 6 weeks before the exam, reviews keep going at a steady pace, a little more spread out than usual. Then revision starts and they ramp up: no card goes longer than 10 days without a review, shrinking to every day in the final days, and every card gets a last look at least 2 days before the exam. After the exam the course rests.
      </p>
      <Input type="date" value={value} onChange={(e) => setValue(e.target.value)} />
    </Modal>
  )
}

const ORDER_KEY = 'sw.weekOrder'

/**
 * Which way every course lists its weeks, by week number (so a week added
 * later, like one from the marketplace, sits in its place). Remembered on
 * this device.
 */
function useWeekOrder(): [WeekOrder, (o: WeekOrder) => void] {
  const [order, setOrder] = useState<WeekOrder>(() => (localStorage.getItem(ORDER_KEY) === 'desc' ? 'desc' : 'asc'))
  const set = (o: WeekOrder) => {
    setOrder(o)
    try {
      localStorage.setItem(ORDER_KEY, o)
    } catch {
      /* storage unavailable: still works until you leave the page */
    }
  }
  return [order, set]
}

/** Blank weeks (no topics) that someone has already published on the marketplace. */
function useMadeWeeks(c: CourseFull | null): Set<string> {
  const [made, setMade] = useState<Set<string>>(new Set())
  const blank = (c?.weeks ?? []).filter((w) => !w.topics.length && w.status !== 'planning' && !declinedMarketWeek(w.id)).map((w) => w.id)
  const key = blank.join(',')
  useEffect(() => {
    let live = true
    void Promise.all(blank.map(async (id) => ((await marketMatches(id)).length ? id : null))).then((ids) => live && setMade(new Set(ids.filter((x): x is string => !!x))))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return made
}

function WeekRow({ c, w, made }: { c: CourseFull; w: WeekFull; made: boolean }) {
  const go = useStore((s) => s.go)
  const jobs = useStore((s) => s.jobs)
  const planning = w.status === 'planning' || !!runningJob(jobs, 'course_outline', 'weekId', w.id)
  const writing = w.topics.filter((t) => t.status === 'writing' || runningJob(jobs, 'course_topic', 'topicId', t.id)).length
  const ready = w.topics.filter((t) => t.status === 'ready').length
  const done = w.topics.filter((t) => t.progress.done).length
  const status = planning
    ? { text: 'Planning…', tone: 'accent' as const }
    : w.status === 'error'
      ? { text: 'Planning failed', tone: 'bad' as const }
      : writing
        ? { text: `Writing ${writing}…`, tone: 'accent' as const }
        : !w.topics.length
          ? { text: w.files.length ? 'Not planned' : 'No files', tone: 'muted' as const }
          : done === w.topics.length
            ? { text: 'Done', tone: 'good' as const }
            : ready < w.topics.length
              ? { text: `${ready}/${w.topics.length} written`, tone: 'muted' as const }
              : null
  const facts = [
    w.topics.length ? `${w.topics.length} topic${w.topics.length === 1 ? '' : 's'}${done ? ` · ${done} done` : ''}` : null,
    `${w.files.length} file${w.files.length === 1 ? '' : 's'}`,
    w.card_count ? `${w.card_count} flashcard${w.card_count === 1 ? '' : 's'}` : null
  ].filter(Boolean)
  return (
    <li>
      <button
        onClick={() => go({ name: 'week', courseId: c.id, weekId: w.id })}
        className="group flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-surface-2 sm:px-5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{w.label}</span>
            {w.recall_off && (
              <span className="shrink-0" title="Recall is off for this week: its cards don’t come up in recall or review. Turn it back on from the week’s ⋯ menu.">
                <Pill>
                  <BellOff className="size-3" /> Recall off
                </Pill>
              </span>
            )}
            {w.private && !c.private && !IS_MOBILE && <PrivatePill title="Private: this week never goes on the marketplace. Make it public from the week’s ⋯ menu." />}
            {status && (
              <Pill tone={status.tone === 'muted' ? 'neutral' : status.tone}>{status.text}</Pill>
            )}
            {made && (
              <span className="shrink-0" title="Someone has already published this week on the marketplace. Open it to add theirs, at no cost.">
                <Pill tone="accent">
                  <Store className="size-3" /> Already made
                </Pill>
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[0.88rem] text-muted">{facts.join(' · ')}</div>
        </div>
        {w.topics.length > 0 && <ProgressBar value={done / w.topics.length} className="hidden h-1.5 w-28 shrink-0 sm:block" />}
        <ChevronRight className="size-4 shrink-0 text-muted transition-transform duration-200 group-hover:translate-x-0.5" />
      </button>
    </li>
  )
}

function AddWeekModal({ course, defaultLabel, onClose, onDone }: { course: CourseFull; defaultLabel: string; onClose: () => void; onDone: () => void }) {
  const courseId = course.id
  const [label, setLabel] = useState(defaultLabel)
  const [visibility, setVisibility] = useState<Visibility>(course.private ? 'private' : 'public')
  const [files, setFiles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    try {
      const w = await api.courses.addWeek({ courseId, label: label.trim(), files, private: visibility === 'private' })
      onDone()
      // Files are added, not planned: ask first (that checks the marketplace too).
      if (files.length) await offerPlan(w, { added: files.length })
      // No files yet: has someone already made this week?
      else await offerMarketWeek(w)
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a week"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={create}>
            Add week
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Week 3, Reading week, Revision…" />
        </Field>
        <Field label="Files" hint="This week’s slides, lecture transcripts and readings. Once they’re added you’re asked whether to plan the week’s topics now.">
          <FileDrop list={files} setList={setFiles} />
        </Field>
        {!IS_MOBILE && <VisibilityField what="week" value={visibility} onChange={setVisibility} lockedBy={course.private ? course.name : undefined} />}
      </div>
    </Modal>
  )
}
