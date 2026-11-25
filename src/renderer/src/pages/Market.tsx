import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight, Download, FileText, Search, Store, Trash2, Upload, Users } from 'lucide-react'
import { authorsText, modelLabel, weeksByWeek, type MarketCourse, type MarketCourseFull, type MarketSort, type MarketWeek, type WeekGroup } from '@shared/market'
import { NOTE_LEVEL_INFO, isNoteLevel } from '@shared/course'
import { api, errorText } from '../lib/api'
import { addMarketWeek, modelsText, publishAllToMarket, weekSummary } from '../lib/market'
import { confirmDialog } from '../lib/dialogs'
import { toast, useStore } from '../lib/store'
import { Shell, PageTitle } from '../components/Shell'
import { MarketSetup } from '../components/MarketSetup'
import { Button, Card, Empty, Input, Pill, Segmented, Spinner, cx } from '../components/ui'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function BackToCourses() {
  const go = useStore((s) => s.go)
  return (
    <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => go({ name: 'courses' })}>
      <ArrowLeft className="size-3.5" /> Courses
    </button>
  )
}

/** Courses other people have generated, and the weeks in each. */
export function Market({ courseId }: { courseId?: string }) {
  const [ready, setReady] = useState<boolean | null>(null)
  const check = () =>
    void api.market
      .status()
      .then((s) => setReady(!!s.url && s.hasKey))
      .catch(() => setReady(false))
  useEffect(check, [])
  if (ready === null) return null
  if (!ready)
    return (
      <Shell>
        <PageTitle eyebrow={<BackToCourses />} title="Marketplace">Courses other people have made in Studywise. Add a week to your own course without generating anything.</PageTitle>
        <div className="max-w-2xl">
          <MarketSetup onConnected={check} />
        </div>
      </Shell>
    )
  return courseId ? <MarketCoursePage id={courseId} /> : <MarketList />
}

function MarketList() {
  const go = useStore((s) => s.go)
  const [view, setView] = useState<'all' | 'mine'>('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<MarketSort>('recent')
  const [courses, setCourses] = useState<MarketCourse[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (view !== 'all') return
    // Wait for typing to pause before searching.
    const t = setTimeout(() => {
      api.market
        .courses({ q, sort })
        .then((c) => {
          setCourses(c)
          setError(null)
        })
        .catch((e) => setError(errorText(e)))
    }, 250)
    return () => clearTimeout(t)
  }, [q, sort, view])

  return (
    <Shell>
      <PageTitle
        eyebrow={<BackToCourses />}
        title="Marketplace"
        actions={
          <>
            <Button onClick={() => void publishAllToMarket()} title="Publish every week you’ve written, from all your courses">
              <Upload className="size-4" /> Publish all my courses
            </Button>
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'all', label: 'All courses' },
                { value: 'mine', label: 'Published by you' }
              ]}
            />
          </>
        }
      >
        Courses other people have made in Studywise, and which model wrote them. Add a week to one of your courses: nothing is generated, so it costs no tokens. To publish one of yours, open the week and use its ⋯ menu.
      </PageTitle>
      {view === 'mine' ? (
        <MyWeeks />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[16rem] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <Input autoFocus className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search courses, modules, topics or people" />
            </div>
            <Segmented
              value={sort}
              onChange={setSort}
              options={[
                { value: 'recent', label: 'Recent' },
                { value: 'popular', label: 'Popular' }
              ]}
            />
          </div>
          {error && <div className="mb-4 rounded-lg bg-bad-soft px-3 py-2 text-[0.9rem] text-bad">{error}</div>}
          {!courses && !error && <Spinner />}
          {courses?.length === 0 && (
            <Empty icon={<Store className="size-8" />} title={q ? 'Nothing matches that' : 'Nothing published yet'}>
              {q ? 'Try the module code, or a topic from it.' : 'Publish one of your weeks from its ⋯ menu and it’ll be the first.'}
            </Empty>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {courses?.map((c) => (
              <Card key={c.id} onClick={() => go({ name: 'market', courseId: c.id })} className="flex flex-col gap-2.5">
                <div>
                  <h3 className="text-[1.05rem] leading-snug font-semibold">{c.name}</h3>
                  {c.module && c.module !== c.name && <div className="text-[0.85rem] text-muted">{c.module}</div>}
                </div>
                <div className="flex items-center gap-1.5 text-[0.85rem] text-muted">
                  <Users className="size-3.5" /> {authorsText(c.authors)}
                  {c.mine && <Pill tone="accent">Has your weeks</Pill>}
                </div>
                <div className="text-[0.88rem] text-muted">
                  {plural(c.weekCount, 'week')} · {plural(c.topicCount, 'topic')} · {plural(c.cardCount, 'flashcard')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {c.models.slice(0, 3).map((m) => (
                    <Pill key={`${m.provider}${m.model}${m.effort}`}>{modelLabel(m)}</Pill>
                  ))}
                  {!c.models.length && <Pill>Model not recorded</Pill>}
                </div>
                <div className="mt-auto text-[0.8rem] text-muted">
                  {plural(c.downloads, 'download')} · updated {when(c.updatedAt)}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </Shell>
  )
}

function MarketCoursePage({ id }: { id: string }) {
  const go = useStore((s) => s.go)
  const [c, setC] = useState<MarketCourseFull | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    api.market
      .course({ id })
      .then(setC)
      .catch((e) => setError(errorText(e)))
  useEffect(() => void load(), [id])

  const back = (
    <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => go({ name: 'market' })}>
      <ArrowLeft className="size-3.5" /> Marketplace
    </button>
  )
  if (error)
    return (
      <Shell>
        <PageTitle eyebrow={back} title="Course" />
        <div className="rounded-lg bg-bad-soft px-3 py-2 text-[0.9rem] text-bad">{error}</div>
      </Shell>
    )
  if (!c) return null
  return (
    <Shell>
      <PageTitle eyebrow={back} title={c.name}>
        <span>
          Weeks by {authorsText(c.authors)}
          {c.module && c.module !== c.name ? ` · ${c.module}` : ''}
          {c.level ? ` · for ${c.level}` : ''} · {plural(c.weekCount, 'week')} · {plural(c.topicCount, 'topic')} · {plural(c.downloads, 'download')}
        </span>
        <div className="mt-1.5 text-[0.88rem]">Written with {modelsText(c.models)}</div>
      </PageTitle>
      <div className="flex flex-col gap-3">
        {weeksByWeek(c.weeks).map((g) => (g.versions.length === 1 ? <WeekRow key={g.versions[0].id} w={g.versions[0]} onRemoved={load} /> : <WeekGroupRow key={g.key} g={g} onRemoved={load} />))}
      </div>
    </Shell>
  )
}

/**
 * Several people have generated the same week: one row for the week, with how
 * many people made it. Open it to see every version, each with its own Add.
 */
function WeekGroupRow({ g, onRemoved }: { g: WeekGroup<MarketWeek>; onRemoved: () => void }) {
  const [open, setOpen] = useState(false)
  const downloads = g.versions.reduce((n, v) => n + v.downloads, 0)
  const mine = g.versions.some((v) => v.mine)
  const models = [...new Set(g.versions.map((v) => v.writtenWith[0] && modelLabel(v.writtenWith[0])).filter(Boolean))]
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button className="flex w-full flex-wrap items-center gap-3 p-4 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="size-4 shrink-0 text-muted" /> : <ChevronRight className="size-4 shrink-0 text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{g.title}</div>
          <div className="text-[0.86rem] text-muted">
            {plural(g.versions.length, 'version')} · {plural(downloads, 'download')}
            {models.length > 0 && ` · ${models.slice(0, 3).join(', ')}${models.length > 3 ? ` and ${models.length - 3} more` : ''}`}
          </div>
        </div>
        {mine && <Pill tone="accent">Includes yours</Pill>}
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[0.82rem] font-medium text-accent">
          <Users className="size-3.5" />
          {g.people} {g.people === 1 ? 'person' : 'people'} generated
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-line p-3">
          {g.versions.map((v) => (
            <WeekRow key={v.id} w={v} onRemoved={onRemoved} />
          ))}
        </div>
      )}
    </div>
  )
}

function WeekRow({ w, onRemoved }: { w: MarketWeek; onRemoved: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    await addMarketWeek(w.id, undefined, w.mine)
    setBusy(false)
  }
  const remove = async () => {
    if (!(await confirmDialog(`Take ${w.label} off the marketplace?`, 'People who already added it keep their copy. Your own course isn’t changed.', { confirmText: 'Take it down', danger: true }))) return
    try {
      await api.market.remove({ id: w.id })
      toast(`Took ${w.label} off the marketplace`, 'good')
      onRemoved()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button className="flex min-w-0 flex-1 items-start gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown className="mt-1 size-4 shrink-0 text-muted" /> : <ChevronRight className="mt-1 size-4 shrink-0 text-muted" />}
          <div className="min-w-0">
            <div className="font-semibold">
              {w.label}
              <span className="ml-2 text-[0.86rem] font-normal text-muted">
                by {w.author}
                {w.mine && ' (you)'}
              </span>
            </div>
            <div className="text-[0.86rem] text-muted">
              {weekSummary(w)} · {mb(w.size)} · {plural(w.downloads, 'download')}
            </div>
            <div className="mt-1 text-[0.85rem]">
              <span className="text-muted">Written with </span>
              {modelsText(w.writtenWith)}
              {w.plannedWith && <span className="text-muted"> · planned with {modelLabel(w.plannedWith)}</span>}
            </div>
          </div>
        </button>
        {w.mine && (
          <Button variant="ghost" size="sm" onClick={remove}>
            <Trash2 className="size-4" /> Take down
          </Button>
        )}
        {/* Yours too: say you deleted it, or you're on another computer. */}
        <Button
          variant={w.mine ? 'outline' : 'primary'}
          size="sm"
          loading={busy}
          onClick={add}
          title={w.mine ? 'Download your week back into your courses. Publishing it again updates this copy.' : undefined}
        >
          <Download className="size-4" /> {w.mine ? 'Add back to my courses' : 'Add to my courses'}
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
          {w.topics.map((t, i) => (
            <div key={i}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={cx('font-medium', !t.levels.length && 'text-muted')}>{t.title}</span>
                {t.levels.map((l) => (
                  <Pill key={l}>{isNoteLevel(l) ? NOTE_LEVEL_INFO[l].short : l}</Pill>
                ))}
                {!t.levels.length && <Pill tone="warn">Not written</Pill>}
              </div>
              {t.goal && <div className="text-[0.86rem] text-muted">{t.goal}</div>}
              {t.sections.length > 0 && (
                <ol className="mt-1 ml-5 list-decimal text-[0.86rem] text-muted">
                  {t.sections.map((s, j) => (
                    <li key={j}>{s}</li>
                  ))}
                </ol>
              )}
            </div>
          ))}
          {w.files.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[0.84rem] text-muted">
              {w.files.map((f) => (
                <span key={f.name} className="inline-flex items-center gap-1">
                  <FileText className="size-3.5" /> {f.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MyWeeks() {
  const go = useStore((s) => s.go)
  const [weeks, setWeeks] = useState<(MarketWeek & { courseName: string })[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () =>
    api.market
      .mine()
      .then(setWeeks)
      .catch((e) => setError(errorText(e)))
  useEffect(() => void load(), [])
  if (error) return <div className="rounded-lg bg-bad-soft px-3 py-2 text-[0.9rem] text-bad">{error}</div>
  if (!weeks) return <Spinner />
  if (!weeks.length)
    return (
      <Empty icon={<Store className="size-8" />} title="You haven’t published anything">
        <p className="mb-4">Publish every course you’ve made at once, or one week at a time from a week’s ⋯ menu.</p>
        <Button variant="primary" onClick={() => void publishAllToMarket()}>
          <Upload className="size-4" /> Publish all my courses
        </Button>
      </Empty>
    )
  return (
    <div className="flex flex-col gap-3">
      {weeks.map((w) => (
        <div key={w.id}>
          <button className="mb-1 text-[0.85rem] font-semibold text-muted hover:text-ink" onClick={() => go({ name: 'market', courseId: w.courseId })}>
            {w.courseName}
          </button>
          <WeekRow w={w} onRemoved={load} />
        </div>
      ))}
    </div>
  )
}
