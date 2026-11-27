// Asking for weeks nobody has made yet, and donating your AI usage to make
// them: the marketplace's Requests tab, the 12-week strip on a marketplace
// course, and today's task on Home.

import { useEffect, useMemo, useState } from 'react'
import { CalendarCheck, CalendarX, Check, ChevronRight, FileText, HandHeart, Paperclip, Plus, Sparkles, ThumbsUp, Trash2, X } from 'lucide-react'
import { READING_WEEK, TEACHING_WEEKS, WEEKS_PER_MODULE, requestTitle, usageText, weekNumber, type MarketTask, type MarketWeek, type MissingInfo, type MissingWeek, type SlidesWanted, type UsageRate, type WeekRequest } from '@shared/market'
import { api, errorText } from '../lib/api'
import { addMarketWeek, downloadMarketCourse } from '../lib/market'
import { chooseDialog, confirmDialog } from '../lib/dialogs'
import { toast, useStore } from '../lib/store'
import { guessNote, useUsageRate } from '../lib/usageEstimate'
import { Button, Empty, Field, Input, Modal, Pill, Spinner, Toggle, cx } from './ui'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`

/** What making it will take of your 5-hour limit: what's left to write, or a typical week of yours when nobody has planned it yet. */
export function requestEstimate(r: Pick<WeekRequest, 'toWrite'>, rate: UsageRate | null): string | null {
  if (!rate) return null
  const sections = r.toWrite?.sections ?? rate.typicalWeekSections
  if (!sections) return null
  return `${usageText(sections * rate.perSection)}${r.toWrite ? '' : ' for a typical week'}`
}

/** What there is to make it from. */
function materialText(r: WeekRequest): string {
  if (r.partial && r.toWrite) return `Made partway by ${(r.partBy ?? []).join(', ')}: ${plural(r.toWrite.topics, 'topic')} left to write`
  if (r.kind === 'write') return r.toWrite ? `${plural(r.toWrite.topics, 'topic')} left to write` : 'Topics left to write'
  if (r.plan) return `Planned already (${plural(r.plan.topics, 'topic')}), nothing written`
  if (r.files.length) return `${plural(r.files.length, 'file')} to make it from`
  return 'No slides yet: add them if you have them'
}

/** The marketplace is set up (an address and a key); null while checking. */
function useMarketReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null)
  useEffect(() => {
    void api.market
      .status()
      .then((s) => setReady(!!s.url && s.hasKey))
      .catch(() => setReady(false))
  }, [])
  return ready
}

// ---------------------------------------------------------------------------
// Today's task, on Home

const taskOpen = (t: MarketTask | null): t is MarketTask => !!t && (t.status === 'assigned' || t.status === 'started') && !!t.request

/** Start (or carry on with) today's task: make the week with your AI and publish it. */
async function startTask(t: MarketTask): Promise<boolean> {
  const r = t.request!
  try {
    await api.market.startTask({ id: t.id, title: `${r.course} · ${r.kind === 'write' ? `the rest of ${r.label}` : r.label}` })
    toast(`Making ${requestTitle(r)}. It goes on the marketplace when it’s done; you can follow it in Jobs.`, 'info')
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** Someone can make it now: it has something to make it from, isn't done, and nobody else is on it. */
const canMake = (r: WeekRequest) => r.status === 'open' && r.ready && (!r.inProgress || r.yours)

/** Make a wanted week now (anyone's) with your AI, instead of waiting to be given it. */
async function makeNow(r: WeekRequest, rate: UsageRate | null): Promise<boolean> {
  const estimate = requestEstimate(r, rate)
  const ok = await confirmDialog(
    `Make ${requestTitle(r)} now?`,
    `It’s written with your own AI, topic by topic, and published for everyone who wants it; it goes into your courses too.${estimate ? ` It should take ${estimate}.` : ''} If you run out of limit partway, that’s fine: the topics written still go up, and the rest goes back for someone else.`,
    { confirmText: 'Make it' }
  )
  if (!ok) return false
  try {
    await api.market.make({ id: r.id, title: `${r.course} · ${r.kind === 'write' || r.partial ? `the rest of ${r.label}` : r.label}` })
    toast(`Making ${requestTitle(r)}. You can follow it in Jobs.`, 'info')
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

async function skipTask(t: MarketTask): Promise<boolean> {
  const ok = await confirmDialog('Skip today’s task?', 'Someone else gets it instead. You get one task a day, so the next one comes tomorrow.', { confirmText: 'Skip it' })
  if (!ok) return false
  try {
    await api.market.skipTask({ id: t.id })
    return true
  } catch (e) {
    toast(errorText(e), 'bad')
    return false
  }
}

/** A banner at the top of Home when the marketplace has handed you a week to make today. Nothing otherwise. */
export function TaskBanner() {
  const go = useStore((s) => s.go)
  const jobs = useStore((s) => s.jobs)
  const ready = useMarketReady()
  const rate = useUsageRate()
  const [task, setTask] = useState<MarketTask | null>(null)
  const load = () =>
    void api.market
      .task()
      .then((r) => setTask(r.task))
      .catch(() => setTask(null))
  useEffect(() => {
    if (ready) load()
  }, [ready])
  const job = task && jobs.find((j) => j.meta?.marketTask === task.id && j.status === 'running')
  // Finished just now: check what the marketplace says.
  const finished = task && jobs.some((j) => j.meta?.marketTask === task.id && j.status !== 'running')
  useEffect(() => {
    if (finished) load()
  }, [finished])
  if (!taskOpen(task)) return null
  const r = task.request!
  const estimate = requestEstimate(r, rate)
  return (
    <section className="mb-8 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-[color-mix(in_oklab,var(--accent)_30%,var(--line))] bg-accent-soft/60 px-5 py-4">
      <HandHeart className="size-6 shrink-0 text-accent" />
      <div className="min-w-[14rem] flex-1">
        <div className="text-[0.8rem] font-medium text-accent">Today’s task</div>
        <div className="font-semibold">Make {requestTitle(r)}</div>
        <div className="text-[0.88rem] text-muted">
          {r.votes === 1 ? 'Someone asked for it' : `${r.votes} people asked for it`} · {materialText(r)}
          {estimate && (
            <span title={`From what writing has taken you before${guessNote(rate)}`}>
              {' '}
              · ≈ {estimate.replace(/^about /, '')}
            </span>
          )}
        </div>
        {job && (
          <div className="mt-1 truncate text-[0.85rem] text-accent">
            <Sparkles className="mr-1 inline size-3.5" />
            {job.progress}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {job ? (
          <Button onClick={() => go({ name: 'jobs' })}>Follow it</Button>
        ) : (
          <>
            <Button variant="primary" onClick={() => void startTask(task)} title="Made with your AI, then published to the marketplace for everyone who asked">
              <Sparkles className="size-4" /> {task.status === 'started' ? 'Carry on' : 'Make it'}
            </Button>
            <Button variant="ghost" onClick={async () => (await skipTask(task)) && load()}>
              Skip today
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={() => go({ name: 'market' })}>
          Marketplace
        </Button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The Requests tab

/** Everything people have asked for, your task settings, and asking for more. compact: the most wanted few, with the rest a click away (the marketplace's front page). */
export function RequestsView({ compact = false }: { compact?: boolean }) {
  const [all, setAll] = useState(!compact)
  const version = useStore((s) => s.version)
  const rate = useUsageRate()
  const [requests, setRequests] = useState<WeekRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const load = () =>
    void api.market
      .requests()
      .then((r) => {
        setRequests(r)
        setError(null)
      })
      .catch((e) => setError(errorText(e)))
  useEffect(load, [version])
  const SHOWN = 6
  const groups = useMemo(() => {
    const m = new Map<string, WeekRequest[]>()
    for (const r of all ? (requests ?? []) : (requests ?? []).slice(0, SHOWN)) m.set(r.course, [...(m.get(r.course) ?? []), r])
    return [...m.entries()]
  }, [requests, all])

  const askMine = async () => {
    const weeks = await api.market.askable().catch(() => [])
    if (!weeks.length) return toast('None of your public weeks has anything left to write (weeks 1 to 12, not reading week).', 'info')
    const how = { finish: 'published, the rest asked for', plan: 'its plan goes up', files: 'its files go up' } as const
    const pick = await chooseDialog(
      'Ask for help with one of your weeks',
      weeks.map((w) => ({
        value: w.weekId,
        label: `${w.course} · ${w.label}: ${w.how === 'files' ? 'not planned yet' : `${plural(w.topics, 'topic')} to write`} (${how[w.how]})`
      })),
      {
        label: 'Which week?',
        confirmText: 'Ask',
        message: 'Someone with usage to spare writes it with their AI and it goes on the marketplace. When it’s done it comes back into your week, with your progress kept.'
      }
    )
    if (!pick) return
    try {
      const r = await api.market.askMine({ weekId: pick })
      toast(`Asked for ${requestTitle(r)}.`, 'good')
      load()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <TaskSettings rate={rate} />
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <p className="min-w-[18rem] flex-1 text-[0.9rem] text-muted">
          Weeks people want that aren’t on the marketplace yet. Vote for the ones you want: when one is made, it’s added to your courses the next time you sync with the cloud. Have the slides? Add them, so someone can make it.
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button onClick={() => void askMine()}>
            <HandHeart className="size-4" /> Ask for help with one of my weeks
          </Button>
          <Button variant="primary" onClick={() => setAsking(true)}>
            <Plus className="size-4" /> Ask for a week
          </Button>
        </div>
      </div>
      {error && <div className="rounded-lg bg-bad-soft px-3 py-2 text-[0.9rem] text-bad">{error}</div>}
      {!requests && !error && <Spinner />}
      {requests?.length === 0 && (
        <Empty icon={<CalendarCheck className="size-8" />} title="Nobody has asked for anything">
          Ask for a week you want, and it shows up here for everyone.
        </Empty>
      )}
      {groups.map(([course, rs]) => (
        <section key={course}>
          <h3 className="mb-2 font-semibold">{course}</h3>
          <div className="flex flex-col gap-2">
            {rs.map((r) => (
              <RequestRow key={r.id} r={r} rate={rate} onChange={load} />
            ))}
          </div>
        </section>
      ))}
      {!all && (requests?.length ?? 0) > SHOWN && (
        <Button className="self-start" variant="ghost" onClick={() => setAll(true)}>
          Show all {requests!.length} wanted weeks
        </Button>
      )}
      <AskDialog open={asking} onClose={() => setAsking(false)} onAsked={load} />
    </div>
  )
}

/** Getting a task a day, and today's. */
function TaskSettings({ rate }: { rate: UsageRate | null }) {
  const [state, setState] = useState<{ task: MarketTask | null; on: boolean } | null>(null)
  const jobs = useStore((s) => s.jobs)
  const load = () => void api.market.task().then(setState).catch(() => setState(null))
  useEffect(load, [])
  if (!state) return null
  const t = taskOpen(state.task) ? state.task : null
  const running = t && jobs.some((j) => j.meta?.marketTask === t.id && j.status === 'running')
  const estimate = t ? requestEstimate(t.request!, rate) : null
  const set = async (on: boolean) => {
    try {
      await api.market.setTasks({ on })
      load()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const status: Record<MarketTask['status'], string> = {
    assigned: '',
    started: '',
    done: 'You did today’s task. Thanks!',
    skipped: 'You skipped today’s task. The next one comes tomorrow.',
    beaten: 'Someone else made today’s week first. The next one comes tomorrow.',
    expired: '',
    gone: '',
    released: ''
  }
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <Toggle checked={state.on} onChange={(v) => void set(v)} label={<span className="font-semibold">Donate my AI usage: give me a task a day</span>} />
      <p className="mt-1.5 text-[0.88rem] text-muted">
        At most once a day you’re given the most wanted week someone has the slides for. Making it uses your own Claude (or Ollama), and it’s published to the marketplace under your name for everyone who asked. It goes into your courses too. You can skip any day.
      </p>
      {state.on && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[0.9rem]">
          {t ? (
            <>
              <span className="mr-auto">
                Today: <span className="font-medium">{requestTitle(t.request!)}</span>
                {estimate && <span className="text-muted"> · ≈ {estimate.replace(/^about /, '')}</span>}
              </span>
              {running ? (
                <Pill tone="accent">Being made…</Pill>
              ) : (
                <>
                  <Button size="sm" variant="primary" onClick={() => void startTask(t).then(load)}>
                    <Sparkles className="size-4" /> {t.status === 'started' ? 'Carry on' : 'Make it'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={async () => (await skipTask(t)) && load()}>
                    Skip today
                  </Button>
                </>
              )}
            </>
          ) : (
            <span className="text-muted">{(state.task && status[state.task.status]) || 'Nothing for you today: no week with slides is waiting.'}</span>
          )}
        </div>
      )}
    </div>
  )
}

function RequestRow({ r, rate, onChange }: { r: WeekRequest; rate: UsageRate | null; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    try {
      await fn()
      if (done) toast(done, 'good')
      onChange()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(null)
    }
  }
  const addFiles = async () => {
    const files = await api.app.pickFiles({ kind: 'course' })
    if (!files.length) return
    await run('files', () => api.market.addRequestFiles({ id: r.id, files }), `Added ${plural(files.length, 'file')} to ${r.label}. Thanks!`)
  }
  const estimate = requestEstimate(r, rate)
  const done = r.status === 'done'
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          className={cx('flex min-w-[6.5rem] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[0.88rem] font-medium transition-colors', r.voted ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-surface-2')}
          onClick={() => void run('vote', () => api.market.vote({ id: r.id, on: !r.voted }))}
          disabled={busy === 'vote' || done}
          title={r.voted ? 'You want this week (it’s added to your courses when it’s made). Click to take your vote back.' : 'I want this week too'}
          aria-pressed={r.voted}
        >
          <ThumbsUp className="size-4" /> {r.votes} {r.voted ? 'incl. you' : r.votes === 1 ? 'wants it' : 'want it'}
        </button>
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <div className="font-semibold">
            {r.kind === 'write' ? `The rest of ${r.label}` : r.label}
            {r.kind === 'write' && r.weekAuthor && <span className="ml-2 text-[0.86rem] font-normal text-muted">by {r.weekAuthor}</span>}
          </div>
          <div className="text-[0.86rem] text-muted">
            {materialText(r)}
            {!done && estimate && (
              <span title={`What making it should take of the 5-hour limit, from what writing has taken you before${guessNote(rate)}`}> · ≈ {estimate.replace(/^about /, '')}</span>
            )}
            {r.mine && ' · you asked'}
          </div>
        </button>
        {done && (
          <Pill tone="good">
            <Check className="size-3" /> Made by {r.doneBy.join(', ')}
          </Pill>
        )}
        {!done && r.yours && <Pill tone="accent">Your task today</Pill>}
        {!done && r.inProgress && !r.yours && <Pill tone="accent">Being made</Pill>}
        {!done && !r.ready && <Pill tone="warn">Needs slides</Pill>}
        {done && r.weekId && r.courseId && (
          <Button size="sm" onClick={() => void addMarketWeek({ id: r.weekId!, mine: false, courseId: r.courseId! }).then((ok) => ok && onChange())}>
            Add to my courses
          </Button>
        )}
        {canMake(r) && (
          <Button size="sm" variant="primary" onClick={() => void makeNow(r, rate).then((ok) => ok && onChange())} title="Donate your AI usage: make it now">
            <Sparkles className="size-4" /> Make it
          </Button>
        )}
        {!done && r.kind === 'week' && !r.plan && (
          <Button size="sm" variant={r.ready ? 'ghost' : 'primary'} loading={busy === 'files'} onClick={() => void addFiles()} title="Upload the lecture slides, transcripts or readings for this week">
            <Paperclip className="size-4" /> Add slides
          </Button>
        )}
        {r.canRemove && !done && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Take this request back"
            title="Take this request back"
            onClick={async () => {
              if (await confirmDialog(`Take back your request for ${requestTitle(r)}?`, undefined, { confirmText: 'Take it back', danger: true }))
                void run('remove', () => api.market.removeRequest({ id: r.id }))
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {open && (r.files.length > 0 || r.plan) && (
        <div className="flex flex-col gap-1 border-t border-line px-4 py-3 text-[0.86rem] text-muted">
          {r.plan && (
            <span className="inline-flex items-center gap-1.5">
              <FileText className="size-3.5" /> A planned week from {r.plan.by}: {plural(r.plan.topics, 'topic')}, with its slides · {mb(r.plan.size)}
            </span>
          )}
          {r.files.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1.5">
              <FileText className="size-3.5" /> {f.name} · {mb(f.size)} · from {f.mine ? 'you' : f.by}
              {(f.mine || r.mine) && !done && (
                <button className="ml-1 hover:text-bad" aria-label={`Take ${f.name} off`} title="Take this file off" onClick={() => void run('file', () => api.market.removeRequestFile({ id: r.id, fileId: f.id }))}>
                  <X className="size-3.5" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Asking for a week

/** Pick a course (yours, the marketplace's, or a new name) and a week, and optionally its slides. */
function AskDialog({ open, onClose, onAsked, course: fixed }: { open: boolean; onClose: () => void; onAsked: () => void; course?: { id: string; name: string; weeks: number[]; noContent?: number[] } }) {
  const [name, setName] = useState('')
  const [number, setNumber] = useState<number | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    if (!open) return
    setNumber(null)
    setFiles([])
    if (fixed) return setName(fixed.name)
    // Suggestions: your courses and the marketplace's.
    void Promise.all([api.courses.list().catch(() => []), api.market.courses({}).catch(() => [])]).then(([mine, market]) =>
      setNames([...new Set([...mine.map((c) => c.name), ...market.map((c) => c.name)])].sort((a, b) => a.localeCompare(b)))
    )
  }, [open])
  const ask = async () => {
    if (!name.trim() || number === null) return
    setBusy(true)
    try {
      const r = await api.market.ask(fixed ? { courseId: fixed.id, number } : { course: { name: name.trim() }, number })
      if (files.length) await api.market.addRequestFiles({ id: r.id, files })
      toast(r.votes > 1 ? `Others want ${requestTitle(r)} too: your vote is in.` : `Asked for ${requestTitle(r)}.`, 'good')
      onAsked()
      onClose()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={fixed ? `Ask for a week of ${fixed.name}` : 'Ask for a week'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || number === null} onClick={() => void ask()}>
            Ask for it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!fixed && (
          <Field label="Course" hint="Its name or module code. The same course under another name counts as the same.">
            <Input autoFocus list="ask-courses" value={name} onChange={(e) => setName(e.target.value)} placeholder="Software Engineering 1 (COMP23311)" />
            <datalist id="ask-courses">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
        )}
        <div>
          <div className="mb-1.5 text-[0.84rem] font-medium text-ink/80">Week</div>
          <div className="grid grid-cols-6 gap-1.5">
            {Array.from({ length: WEEKS_PER_MODULE }, (_, i) => i + 1).map((n) => {
              const reading = n === READING_WEEK
              const there = fixed?.weeks.includes(n) || fixed?.noContent?.includes(n)
              return (
                <button
                  key={n}
                  disabled={reading || there}
                  onClick={() => setNumber(n)}
                  title={reading ? 'Reading week: nothing to make' : fixed?.noContent?.includes(n) ? 'No content this week' : there ? 'On the marketplace already' : `Week ${n}`}
                  className={cx(
                    'rounded-lg border py-2 text-[0.9rem] font-medium tabular transition-colors',
                    number === n ? 'border-accent bg-accent text-white' : 'border-line hover:bg-surface-2',
                    (reading || there) && 'cursor-not-allowed opacity-40 hover:bg-transparent'
                  )}
                >
                  {reading ? 'RW' : n}
                </button>
              )
            })}
          </div>
          <div className="mt-1 text-[0.8rem] text-muted">Modules have 12 weeks; week {READING_WEEK} is reading week.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={async () => {
              const picked = await api.app.pickFiles({ kind: 'course' })
              if (picked.length) setFiles([...new Set([...files, ...picked])])
            }}
          >
            <Paperclip className="size-4" /> {files.length ? `${plural(files.length, 'file')} added` : 'Add its slides (optional)'}
          </Button>
          <span className="text-[0.8rem] text-muted">Someone can only make it once there are slides, transcripts or readings to make it from.</span>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// A marketplace course's 12 weeks

/**
 * Weeks 1 to 12 of a marketplace course: which are on the marketplace, which
 * people have asked for (vote with a click), and which nobody has (ask with a
 * click). Week 6 is reading week.
 */
export function WeekStrip({ course, weeks, onChange }: { course: { id: string; name: string; noContent?: number[] }; weeks: MarketWeek[]; onChange?: () => void }) {
  const version = useStore((s) => s.version)
  const [requests, setRequests] = useState<WeekRequest[]>([])
  const [asking, setAsking] = useState(false)
  // Weeks with no content (no lectures): set by marketplace admins, who get a mode to mark them.
  const [none, setNone] = useState<number[]>(course.noContent ?? [])
  useEffect(() => setNone(course.noContent ?? []), [course.id, course.noContent?.join(',')])
  const [admin, setAdmin] = useState(false)
  const [marking, setMarking] = useState(false)
  useEffect(() => {
    void api.market
      .test()
      .then((r) => setAdmin(r.owner))
      .catch(() => setAdmin(false))
  }, [])
  const mark = async (n: number) => {
    try {
      setNone(await api.market.setNoContent({ courseId: course.id, number: n, on: !none.includes(n) }))
      load()
      onChange?.()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const load = () =>
    void api.market
      .requests({ courseId: course.id })
      .then(setRequests)
      .catch(() => setRequests([]))
  useEffect(load, [course.id, version])
  const have = new Set(weeks.map((w) => weekNumber(w.label)).filter((n): n is number => n !== null))
  const asked = new Map(requests.filter((r) => r.kind === 'week' && r.status === 'open' && r.number !== null).map((r) => [r.number!, r]))
  const missing = TEACHING_WEEKS.filter((n) => !have.has(n) && !none.includes(n))
  const toggle = async (r: WeekRequest) => {
    try {
      await api.market.vote({ id: r.id, on: !r.voted })
      load()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  return (
    <div className="mb-5 rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h3 className="font-semibold">Weeks</h3>
        <span className="min-w-0 flex-1 text-[0.86rem] text-muted">
          {marking
            ? 'Click the weeks with no content (no lectures). Nobody can ask for them, and they’re never handed out.'
            : missing.length
              ? `${plural(missing.length, 'week')} not here yet. Click one to ask for it, or to vote for it if someone has.`
              : 'Every teaching week is here.'}
        </span>
        {admin && (
          <Button size="sm" variant={marking ? 'primary' : 'ghost'} onClick={() => setMarking(!marking)} title="Admins: mark weeks of this course that have no content">
            {marking ? 'Done' : 'Mark weeks with no content'}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
        {Array.from({ length: WEEKS_PER_MODULE }, (_, i) => i + 1).map((n) => {
          const r = asked.get(n)
          if (marking && !have.has(n) && n !== READING_WEEK)
            return (
              <button
                key={n}
                onClick={() => void mark(n)}
                aria-pressed={none.includes(n)}
                className={cx('rounded-lg border py-2 text-center text-[0.75rem] transition-colors', none.includes(n) ? 'border-ink/40 bg-surface-2 text-ink' : 'border-dashed border-line text-muted hover:bg-surface-2')}
                title={none.includes(n) ? `Week ${n} has no content. Click to undo.` : `Mark week ${n} as having no content`}
              >
                <div className="text-[0.9rem] font-medium tabular">{n}</div>
                {none.includes(n) ? 'No content' : 'Has content'}
              </button>
            )
          if (none.includes(n) && !have.has(n))
            return (
              <div key={n} className="rounded-lg border border-dashed border-line py-2 text-center text-[0.75rem] text-muted" title="No content this week (no lectures)">
                <div className="text-[0.9rem] font-medium tabular">{n}</div>
                No content
              </div>
            )
          if (n === READING_WEEK && !have.has(n))
            return (
              <div key={n} className="rounded-lg border border-dashed border-line py-2 text-center text-[0.75rem] text-muted" title="Reading week">
                <div className="text-[0.9rem] font-medium tabular">{n}</div>
                Reading
              </div>
            )
          if (have.has(n))
            return (
              <div key={n} className="rounded-lg bg-good-soft py-2 text-center text-[0.75rem] text-good" title={`Week ${n} is on the marketplace`}>
                <div className="text-[0.9rem] font-medium tabular">{n}</div>
                <Check className="mx-auto size-3.5" />
              </div>
            )
          return (
            <button
              key={n}
              onClick={() => (r ? void toggle(r) : setAsking(true))}
              className={cx('rounded-lg border py-2 text-center text-[0.75rem] transition-colors', r?.voted ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-surface-2')}
              title={r ? `${plural(r.votes, 'person')} asked for week ${n}${r.ready ? '' : ' (no slides yet)'}. ${r.voted ? 'Click to take your vote back.' : 'Click to vote for it.'}` : `Nobody has made week ${n}. Click to ask for it.`}
            >
              <div className="text-[0.9rem] font-medium tabular text-ink">{n}</div>
              {r ? (
                <span className="inline-flex items-center gap-0.5">
                  <ThumbsUp className="size-3" /> {r.votes}
                </span>
              ) : (
                'Ask'
              )}
            </button>
          )
        })}
      </div>
      <AskDialog
        open={asking}
        onClose={() => setAsking(false)}
        onAsked={() => {
          load()
          onChange?.()
        }}
        course={{ id: course.id, name: course.name, weeks: [...have], noContent: none }}
      />
    </div>
  )
}

/** On a published week with topics nobody has written: ask for the rest to be written (or vote for it). */
export function FinishButton({ week, request, onChange }: { week: MarketWeek; request?: WeekRequest; onChange?: () => void }) {
  const [busy, setBusy] = useState(false)
  const rate = useUsageRate()
  if (week.writtenCount >= week.topicCount) return null
  const left = week.topicCount - week.writtenCount
  const sections = week.topics.filter((t) => !t.levels.length).reduce((n, t) => n + Math.max(1, t.sections.length), 0)
  const estimate = rate ? usageText(sections * rate.perSection) : null
  const click = async () => {
    setBusy(true)
    try {
      if (request) await api.market.vote({ id: request.id, on: !request.voted })
      else {
        await api.market.askFinish({ weekId: week.id })
        toast(`Asked for the ${plural(left, 'topic')} left in ${week.label}. Whoever writes them adds them to this week, for everyone.`, 'good')
      }
      onChange?.()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      size="sm"
      variant={request?.voted ? 'soft' : 'ghost'}
      loading={busy}
      onClick={() => void click()}
      title={`${plural(left, 'topic')} of this week aren’t written. Ask for someone with usage to spare to write them${estimate ? ` (${estimate}${guessNote(rate)})` : ''}.`}
    >
      <HandHeart className="size-4" /> {request ? `${request.votes} asked for the rest${request.voted ? ' (you)' : ''}` : 'Ask for the rest'}
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Your missing weeks, on the marketplace's front page

/**
 * Weeks of your courses you don't have (gaps up to the latest week you've
 * got to): asked for automatically, with a prompt to add their slides, or
 * an Add when they're on the marketplace already. Below them, weeks of your
 * courses others asked for that still need slides.
 */
/**
 * A slim line on the marketplace's front page when your courses have missing
 * weeks (or weeks wanting your slides), opening the Missing weeks tab.
 * Loading it is also when missing weeks get asked for automatically.
 */
export function MissingWeeksBanner({ onOpen, onLoaded }: { onOpen: () => void; onLoaded?: () => void }) {
  const version = useStore((s) => s.version)
  const [info, setInfo] = useState<MissingInfo | null>(null)
  useEffect(() => {
    let live = true
    void api.market
      .missing()
      .then((i) => {
        if (!live) return
        setInfo(i)
        onLoaded?.()
      })
      .catch(() => setInfo(null))
    return () => {
      live = false
    }
  }, [version])
  if (!info) return null
  const toMake = info.missing.filter((m) => !m.available).length
  const toAdd = info.missing.filter((m) => m.available).length
  const slides = info.slidesWanted.length
  const parts = [
    toMake ? `${plural(toMake, 'week')} of your courses ${toMake === 1 ? 'is' : 'are'} missing` : '',
    toAdd ? `${plural(toAdd, 'week')} you don’t have ${toAdd === 1 ? 'is' : 'are'} here to add` : '',
    slides ? `${plural(slides, 'week')} of your courses ${slides === 1 ? 'needs' : 'need'} slides` : ''
  ].filter(Boolean)
  if (!parts.length) return null
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-xl border border-[color-mix(in_oklab,var(--accent)_25%,var(--line))] bg-accent-soft/40 px-4 py-2.5 text-left text-[0.92rem] transition-colors hover:bg-accent-soft/70"
    >
      <CalendarX className="size-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">{text.charAt(0).toUpperCase() + text.slice(1)}.</span>
      <span className="inline-flex shrink-0 items-center gap-0.5 font-medium text-accent">
        See them <ChevronRight className="size-4" />
      </span>
    </button>
  )
}

/** The Missing weeks tab: empty, it says so. */
export function MissingWeeksTab() {
  return <MissingWeeksPanel empty={<Empty icon={<CalendarCheck className="size-8" />} title="No missing weeks">Every week of your courses, up to the latest one you’ve got to, is there.</Empty>} />
}

export function MissingWeeksPanel({ onLoaded, empty = null }: { onLoaded?: () => void; empty?: React.ReactNode }) {
  const version = useStore((s) => s.version)
  const [info, setInfo] = useState<MissingInfo | null>(null)
  const load = () =>
    void api.market
      .missing()
      .then((i) => {
        setInfo(i)
        // It may have just asked for weeks: the wanted list shows them.
        onLoaded?.()
      })
      .catch(() => setInfo(null))
  useEffect(load, [version])
  // Weeks on the marketplace already: one row per course, to add them all.
  const available = useMemo(() => {
    const m = new Map<string, { course: string; marketCourseId: string; numbers: number[] }>()
    for (const x of info?.missing ?? []) {
      if (!x.available) continue
      const g = m.get(x.courseId) ?? { course: x.course, marketCourseId: x.available.courseId, numbers: [] }
      g.numbers.push(x.number)
      m.set(x.courseId, g)
    }
    return [...m.entries()]
  }, [info])
  if (!info) return null
  if (!info.missing.length && !info.slidesWanted.length) return <>{empty}</>
  const setAuto = async (on: boolean) => {
    try {
      await api.market.setAutoRequest({ on })
      load()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  return (
    <section className="rounded-2xl border border-[color-mix(in_oklab,var(--accent)_30%,var(--line))] bg-accent-soft/40 p-5">
      {info.missing.length > 0 && (
        <>
          <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
            <div className="min-w-[16rem] flex-1">
              <h2 className="text-[1.05rem] font-semibold">Your missing weeks</h2>
              <p className="text-[0.88rem] text-muted">
                Weeks of your courses you don’t have yet. Got the slides? Upload them, and someone donating their usage can make the week. It comes into your course when it’s done.
              </p>
            </div>
            <Toggle checked={info.autoRequest} onChange={(v) => void setAuto(v)} label={<span className="text-[0.9rem]">Ask for them automatically</span>} />
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            {available.map(([courseId, g]) => (
              <div key={courseId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5">
                <div className="min-w-[12rem] flex-1">
                  <span className="font-medium">{weekList(g.numbers)}</span> <span className="text-muted">· {g.course}</span>
                  <div className="text-[0.84rem] text-muted">On the marketplace already: nothing to generate</div>
                </div>
                <Button size="sm" variant="primary" onClick={() => void downloadMarketCourse({ id: g.marketCourseId, name: g.course }, 'missing').then((ok) => ok && load())}>
                  {g.numbers.length === 1 ? 'Add it' : 'Add them'}
                </Button>
              </div>
            ))}
            {info.missing
              .filter((m) => !m.available)
              .map((m) => (
                <MissingRow key={`${m.courseId}:${m.number}`} m={m} onChange={load} />
              ))}
          </div>
        </>
      )}
      {info.slidesWanted.length > 0 && (
        <>
          <h3 className={cx('font-semibold', info.missing.length > 0 && 'mt-5')}>Slides wanted for your courses</h3>
          <p className="text-[0.88rem] text-muted">People asked for these weeks, but nobody has added the slides. If you have them, upload them.</p>
          <div className="mt-3 flex flex-col gap-1.5">
            {info.slidesWanted.map((w) => (
              <SlidesWantedRow key={w.request.id} w={w} onChange={load} />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

/** "Week 3", "Weeks 1, 2 and 5". */
const weekList = (ns: number[]) => (ns.length === 1 ? `Week ${ns[0]}` : `Weeks ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`)

/** Upload slides you pick, or the ones already in your week. */
function SlideButtons({ files, onPick, onShare, busy }: { files: number; onPick: () => void; onShare: () => void; busy: string | null }) {
  return (
    <>
      {files > 0 && (
        <Button size="sm" variant="primary" loading={busy === 'share'} onClick={onShare} title="Upload the slides and transcripts already in your week">
          <Paperclip className="size-4" /> Share my {plural(files, 'file')}
        </Button>
      )}
      <Button size="sm" variant={files > 0 ? 'ghost' : 'primary'} loading={busy === 'pick'} onClick={onPick}>
        <Paperclip className="size-4" /> Upload slides
      </Button>
    </>
  )
}

function useBusy(onChange: () => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    try {
      await fn()
      if (done) toast(done, 'good')
      onChange()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

function MissingRow({ m, onChange }: { m: MissingWeek; onChange: () => void }) {
  const { busy, run } = useBusy(onChange)
  const rate = useUsageRate()
  const r = m.request
  const thanks = `Thanks: someone can make Week ${m.number} of ${m.course} now. It comes into your course when it’s done.`
  const pick = async () => {
    const files = await api.app.pickFiles({ kind: 'course' })
    if (!files.length) return
    await run('pick', () => (r ? api.market.addRequestFiles({ id: r.id, files }) : api.market.askWithFiles({ courseId: m.courseId, number: m.number, files })), thanks)
  }
  const share = () => run('share', () => api.market.shareSlides({ weekId: m.weekId!, requestId: r?.id }), thanks)
  const state = m.available
    ? 'On the marketplace already'
    : !r
      ? 'Not asked for'
      : r.inProgress
        ? r.yours
          ? 'Your task: make it now, or from Home'
          : 'Being made'
        : r.partial
          ? materialText(r)
          : r.ready
          ? `Has slides · waiting for someone to make it${r.votes > 1 ? ` · ${r.votes} want it` : ''}`
          : `Needs slides${r.votes > 1 ? ` · ${r.votes} want it` : ''}`
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5">
      <div className="min-w-[12rem] flex-1">
        <span className="font-medium">Week {m.number}</span> <span className="text-muted">· {m.course}</span>
        <div className="text-[0.84rem] text-muted">{state}</div>
      </div>
      {m.available ? (
        <Button size="sm" variant="primary" onClick={() => void addMarketWeek({ id: m.available!.weekId, mine: false, courseId: m.available!.courseId }).then((ok) => ok && onChange())}>
          Add to my course
        </Button>
      ) : r && !r.voted ? (
        <Button size="sm" loading={busy === 'vote'} onClick={() => void run('vote', () => api.market.vote({ id: r.id, on: true }))}>
          <ThumbsUp className="size-4" /> I want it too
        </Button>
      ) : !r ? (
        <Button size="sm" loading={busy === 'ask'} onClick={() => void run('ask', () => api.market.ask({ course: { name: m.course }, number: m.number }))}>
          Ask for it
        </Button>
      ) : null}
      {r && canMake(r) && (
        <Button size="sm" variant="primary" onClick={() => void makeNow(r, rate).then((ok) => ok && onChange())} title="Make it now with your AI">
          <Sparkles className="size-4" /> Make it
        </Button>
      )}
      {!m.available && !r?.ready && <SlideButtons files={m.files} onPick={() => void pick()} onShare={() => void share()} busy={busy} />}
    </div>
  )
}

function SlidesWantedRow({ w, onChange }: { w: SlidesWanted; onChange: () => void }) {
  const { busy, run } = useBusy(onChange)
  const r = w.request
  const thanks = `Thanks: someone can make ${requestTitle(r)} now.`
  const pick = async () => {
    const files = await api.app.pickFiles({ kind: 'course' })
    if (files.length) await run('pick', () => api.market.addRequestFiles({ id: r.id, files }), thanks)
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5">
      <div className="min-w-[12rem] flex-1">
        <span className="font-medium">{r.label}</span> <span className="text-muted">· {r.course}</span>
        <div className="text-[0.84rem] text-muted">{r.votes === 1 ? 'Someone wants it' : `${r.votes} people want it`}</div>
      </div>
      <SlideButtons files={w.files} onPick={() => void pick()} onShare={() => void run('share', () => api.market.shareSlides({ weekId: w.weekId!, requestId: r.id }), thanks)} busy={busy} />
    </div>
  )
}
