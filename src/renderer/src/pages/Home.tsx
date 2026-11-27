import { useEffect, useMemo, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import type { Deck, Card, HomeStats } from '@shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { runCommand, useCommands } from '../lib/commands'
import { STUDY_TIME_EVENT, fmtDuration } from '../lib/studyTime'
import { Shell } from '../components/Shell'
import { Button, Kbd, cx } from '../components/ui'
import { ResumeCard, useResumable } from '../components/ResumeCard'
import { TaskBanner } from '../components/MarketRequests'
import { DeadlinesPanel } from '../components/DeadlinesPanel'
import { HOME_PANEL_SETTING } from '@shared/deadlines'
import { ReviewPicker, useReviewPick, useTracker } from '../components/ReviewPicker'
import { SlidersHorizontal, Star } from 'lucide-react'

type DeckRow = Deck & { card_count: number; due_count: number }
type Overview = { activity: { date: string; count: number }[]; streak: number; today: number; week: number; next: (Card & { deck_name: string }) | null }

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** A stable, pleasant hue per deck so the list has some colour. */
export function deckHue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const hues = [222, 262, 190, 152, 28, 340, 205, 48]
  return hues[h % hues.length]
}

export function Home() {
  const go = useStore((s) => s.go)
  const version = useStore((s) => s.version)
  const [resumable, dismissResumable] = useResumable(version)
  const jobs = useStore((s) => s.jobs)
  const [decks, setDecks] = useState<DeckRow[]>([])
  const [notes, setNotes] = useState<{ id: string; title: string; module: string; updated_at: string }[]>([])
  const [ov, setOv] = useState<Overview | null>(null)
  const [stats, setStats] = useState<HomeStats | null>(null)
  // What the panel beside the cards due shows (Settings → Home): time studied, or deadlines and tasks.
  const [panel, setPanel] = useState<'time' | 'deadlines'>('time')
  useEffect(() => {
    void api.settings.all().then((s) => setPanel(s[HOME_PANEL_SETTING] === 'deadlines' ? 'deadlines' : 'time'))
  }, [version])

  useEffect(() => {
    void api.decks.list().then(setDecks)
    void api.notes.list().then(setNotes)
    void api.decks.overview().then((o) => setOv(o as Overview))
    void api.stats.home().then(setStats)
  }, [version])
  // Time saved from a study page (or another device syncing) shows up straight away.
  useEffect(() => {
    const refresh = () => void api.stats.home().then(setStats)
    window.addEventListener(STUDY_TIME_EVENT, refresh)
    return () => window.removeEventListener(STUDY_TIME_EVENT, refresh)
  }, [])

  // Which weeks and decks the review covers (Choose weeks), and which weeks are a priority.
  const [pick, setPick] = useReviewPick()
  const [tracker] = useTracker()
  const [picking, setPicking] = useState(false)
  const priority = useMemo(() => new Set((tracker?.courses ?? []).flatMap((c) => c.weeks.filter((w) => w.priority && w.deck_id).map((w) => w.deck_id!))), [tracker])
  const weekLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of tracker?.courses ?? []) for (const w of c.weeks) if (w.deck_id) m.set(w.deck_id, `${c.name} · ${w.label}`)
    return m
  }, [tracker])
  const picked = pick ? decks.filter((d) => pick.has(d.id)) : decks
  const due = picked.reduce((n, d) => n + d.due_count, 0)
  const priorityDue = picked.filter((d) => priority.has(d.id)).reduce((n, d) => n + d.due_count, 0)
  const running = jobs.filter((j) => j.status === 'running')
  const sorted = [...decks].sort((a, b) => b.due_count - a.due_count || a.name.localeCompare(b.name))
  const withDue = [...picked].filter((d) => d.due_count > 0).sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)) || b.due_count - a.due_count || a.name.localeCompare(b.name))
  const top = withDue[0]

  // Everything due in what's picked, priority weeks first; one deck reviews on its own.
  const startReview = () =>
    !top ? runCommand('study.learn') : withDue.length === 1 ? go({ name: 'flashcards', deckId: top.id, mode: 'due' }) : go({ name: 'flashcards', deckId: '', mode: 'due', deckIds: withDue.map((d) => d.id) })
  const resume = resumable ? () => go(resumable.session.route) : null
  // Enter carries on where you left off, else starts reviewing.
  useCommands({ 'learn.submit': resume ?? (top ? startReview : null) }, [top, resumable])

  return (
    <Shell className="max-w-[1000px]">
      {/* A week the marketplace has handed you to make today (Marketplace → Requests). */}
      <TaskBanner />
      {resumable && resume && <ResumeCard r={resumable} onContinue={resume} onDismiss={dismissResumable} enterKey />}
      <section className="grid items-center gap-10 pt-2 pb-12 md:grid-cols-[1.1fr_1fr]">
        <div>
          <p className="text-[0.95rem] text-muted">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          {decks.length === 0 ? (
            <>
              <h1 className="mt-2 text-[2.6rem] leading-[1.05] font-semibold tracking-[-0.035em]">No decks yet.</h1>
            </>
          ) : (
            <>
              <h1 className="mt-1 flex items-baseline gap-3 tracking-[-0.04em]">
                <span key={due} className="pop-in text-[5.5rem] leading-none font-semibold text-accent tabular">
                  {due}
                </span>
                <span className="text-[1.6rem] font-semibold tracking-[-0.02em]">{due === 1 ? 'card due' : 'cards due'}</span>
              </h1>
              <p className="mt-3 text-muted">
                {priorityDue > 0 ? (
                  <>
                    <span className="text-ink">{priorityDue}</span> from priority weeks first.
                  </>
                ) : due > 0 ? (
                  <>
                    Most in <span className="text-ink">{weekLabel.get(top!.id) ?? top?.name}</span>.
                  </>
                ) : (
                  'All caught up.'
                )}
                {ov && ov.streak > 0 && (
                  <>
                    {' '}
                    <span className="text-ink">{ov.streak}-day streak</span>
                    .
                  </>
                )}
              </p>
              <button
                onClick={() => setPicking(true)}
                className="mt-3 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[0.85rem] text-muted transition-colors hover:border-[color-mix(in_oklab,var(--ink)_25%,transparent)] hover:text-ink"
                title="Choose which weeks of which courses to review, and which come first"
              >
                <SlidersHorizontal className="size-3.5" />
                {pick ? `Reviewing ${picked.length} of ${decks.length} weeks and decks` : 'Reviewing every week and deck'}
                {priority.size > 0 && (
                  <span className="inline-flex items-center gap-1 text-warn">
                    <Star className="size-3" fill="currentColor" /> {priority.size}
                  </span>
                )}
                <span className="font-medium text-accent">Choose weeks</span>
              </button>
            </>
          )}
          <div className="mt-7 flex flex-wrap items-center gap-2">
            {decks.length === 0 ? (
              <Button variant="primary" size="lg" onClick={() => runCommand('gen.cards')}>
                Generate flashcards
              </Button>
            ) : (
              <Button variant="primary" size="lg" onClick={startReview}>
                {due > 0 ? 'Start reviewing' : 'Start Learn'} {!resumable && <Kbd className="ml-1 border-white/30 text-white/80">↩</Kbd>}
              </Button>
            )}
            <Button size="lg" variant="ghost" onClick={() => runCommand('gen.notes')}>
              Generate notes
            </Button>
            <Button size="lg" variant="ghost" onClick={() => runCommand('deck.new')}>
              New deck
            </Button>
          </div>
        </div>

        <ReviewPicker open={picking} onClose={() => setPicking(false)} pick={pick} onPick={setPick} />
        {/* Time studied this week, or (Settings → Home) your next deadline and tasks. */}
        {panel === 'deadlines' ? <DeadlinesPanel /> : <StudyPanel stats={stats} />}
      </section>

      {running.length > 0 && (
        <button onClick={() => go({ name: 'jobs' })} className="mb-10 flex w-full items-center gap-3 rounded-xl bg-accent-soft px-4 py-3 text-left text-[0.92rem]">
          <span className="pulse-dot size-2 rounded-full bg-accent" />
          <span className="min-w-0 flex-1 truncate">
            {running[0].title} <span className="text-muted">· {running[0].progress}</span>
          </span>
          {running.length > 1 && <span className="text-muted">+{running.length - 1} more</span>}
        </button>
      )}

      {stats && <StatTiles stats={stats} />}

      {ov && <Heatmap ov={ov} />}

      <div className="mt-12 grid gap-10 md:grid-cols-[1.4fr_1fr]">
        <Section title="Decks" action={decks.length > 0 ? { label: 'All decks', run: () => go({ name: 'decks' }) } : undefined}>
          {sorted.length === 0 ? (
            <EmptyRow>None yet.</EmptyRow>
          ) : (
            sorted.slice(0, 8).map((d) => (
              <Row key={d.id} onClick={() => go({ name: 'deck', id: d.id })}>
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: `hsl(${deckHue(d.name)} 70% 55%)` }} />
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span className="tabular text-[0.88rem] text-muted">{plural(d.card_count, 'card')}</span>
                <span className={cx('tabular w-14 text-right text-[0.88rem]', d.due_count ? 'font-medium text-accent' : 'text-muted/50')}>{d.due_count ? `${d.due_count} due` : '—'}</span>
              </Row>
            ))
          )}
        </Section>
        <Section title="Recent notes" action={notes.length > 0 ? { label: 'All notes', run: () => go({ name: 'notes' }) } : undefined}>
          {notes.length === 0 ? (
            <EmptyRow>None yet.</EmptyRow>
          ) : (
            notes.slice(0, 6).map((n) => (
              <Row key={n.id} onClick={() => go({ name: 'notes', id: n.id })}>
                <span className="min-w-0 flex-1 truncate">{n.title}</span>
                <span className="text-[0.85rem] text-muted">{n.module}</span>
              </Row>
            ))
          )}
        </Section>
      </div>

    </Shell>
  )
}

const shortDay = (iso: string) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: 'short' })
const longDay = (iso: string) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`)

/** Today's time studied as the headline, with the last 7 days as bars. */
function StudyPanel({ stats }: { stats: HomeStats | null }) {
  if (!stats)
    return <div className="skeleton mx-auto h-[250px] w-full max-w-[380px] rounded-2xl" />
  const max = Math.max(...stats.days.map((d) => d.seconds), 15 * 60)
  return (
    <div className="mx-auto flex h-[250px] w-full max-w-[380px] flex-col rounded-2xl border border-line bg-surface p-6 shadow-[0_18px_40px_-24px_rgba(20,40,120,0.35)]">
      <div className="text-[0.8rem] text-muted">Time studied today</div>
      <div className="mt-1 flex items-baseline gap-3">
        <span key={stats.time.today} className="pop-in text-[2.6rem] leading-none font-semibold tracking-tight tabular">
          {fmtDuration(stats.time.today)}
        </span>
        <span className="text-[0.9rem] text-muted">{fmtDuration(stats.time.week)} this week</span>
      </div>
      <div className="relative mt-auto flex h-[110px] items-end gap-[2px]" role="img" aria-label="Time studied each day for the last 7 days">
        {stats.days.map((d) => {
          const h = d.seconds ? Math.max(4, Math.round((d.seconds / max) * 96)) : 0
          const isToday = d.date === stats.days[stats.days.length - 1].date
          return (
            // The whole column is the hover target, not just the bar.
            <div key={d.date} className="group relative flex h-full flex-1 flex-col items-center justify-end gap-1.5">
              <div className="pointer-events-none absolute -top-1 left-1/2 z-10 hidden -translate-x-1/2 -translate-y-full rounded-md bg-ink px-2 py-1 text-[0.75rem] whitespace-nowrap text-bg shadow-lg group-hover:block">
                {longDay(d.date)} · {fmtDuration(d.seconds)}
              </div>
              <div
                className={cx('w-full max-w-[34px] rounded-t-[4px] transition-[height] duration-500 ease-out-soft', d.seconds ? (isToday ? 'bg-accent' : 'bg-[color-mix(in_oklab,var(--accent)_55%,var(--surface))]') : '')}
                style={{ height: h }}
              />
              <div className="h-px w-full bg-line" />
              <span className={cx('text-[0.72rem]', isToday ? 'font-semibold text-ink' : 'text-muted')}>{shortDay(d.date)}</span>
            </div>
          )
        })}
      </div>
      <ul className="sr-only">
        {stats.days.map((d) => (
          <li key={d.date}>
            {longDay(d.date)}: {fmtDuration(d.seconds)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The numbers: time, streak, topics, questions and cards. */
function StatTiles({ stats }: { stats: HomeStats }) {
  const t = stats.topics
  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: 'Total time studied', value: fmtDuration(stats.time.total), sub: stats.time.dailyAverage ? `${fmtDuration(stats.time.dailyAverage)} a day on average` : 'Counted while you study' },
    { label: 'Last 30 days', value: fmtDuration(stats.time.month), sub: stats.bestDay ? `Best day ${fmtDuration(stats.bestDay.seconds)}` : undefined },
    { label: 'Study streak', value: plural(stats.streak, 'day'), sub: 'Days in a row with studying or reviews' },
    { label: 'Topics done', value: t.total ? `${t.done} / ${t.total}` : '—', sub: stats.courses ? `${plural(t.written, 'topic')} written in ${plural(stats.courses, 'course')}` : 'No courses yet' },
    { label: 'Topic questions', value: t.answered.toLocaleString(), sub: t.answered ? `${pct(t.correct / t.answered)} right first time` : 'Answered while learning topics' },
    { label: 'Topic tests', value: t.tests ? pct(t.testAverage) : '—', sub: t.tests ? `Average over ${plural(t.tests, 'test')}` : 'None taken yet' },
    { label: 'Cards reviewed', value: stats.cards.reviewedToday.toLocaleString(), sub: `today · ${stats.cards.reviewedWeek.toLocaleString()} this week · ${stats.cards.total.toLocaleString()} in all` },
    { label: 'Retention', value: pct(stats.cards.retention), sub: stats.cards.known ? `${plural(stats.cards.known, 'card')} well known (3+ weeks)` : 'Reviews not rated Again, last 30 days' }
  ]
  return (
    <section className="mb-12 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
      {tiles.map((x) => (
        <div key={x.label} className="min-w-0 border-t border-line pt-3">
          <div className="text-[0.8rem] text-muted">{x.label}</div>
          <div className="tabular text-[1.5rem] leading-tight font-semibold tracking-tight">{x.value}</div>
          {x.sub && <div className="truncate text-[0.8rem] text-muted" title={x.sub}>{x.sub}</div>}
        </div>
      ))}
    </section>
  )
}

function Heatmap({ ov }: { ov: Overview }) {
  const max = Math.max(1, ...ov.activity.map((a) => a.count))
  // Columns are weeks (Mon–Sun), oldest on the left.
  const weeks = useMemo(() => {
    const first = new Date(ov.activity[0].date + 'T12:00')
    const pad = (first.getDay() + 6) % 7
    const cells: ({ date: string; count: number } | null)[] = [...Array(pad).fill(null), ...ov.activity]
    const cols: (typeof cells)[] = []
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7))
    return cols
  }, [ov])
  const level = (c: number) => (c === 0 ? 0 : c / max < 0.25 ? 1 : c / max < 0.5 ? 2 : c / max < 0.75 ? 3 : 4)
  const shades = ['var(--surface-2)', 'color-mix(in oklab, var(--accent) 28%, var(--surface))', 'color-mix(in oklab, var(--accent) 50%, var(--surface))', 'color-mix(in oklab, var(--accent) 75%, var(--surface))', 'var(--accent)']
  const total = ov.activity.reduce((n, a) => n + a.count, 0)
  return (
    <section className="flex flex-wrap items-end gap-x-10 gap-y-5">
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {weeks.map((col, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {Array.from({ length: 7 }).map((_, j) => {
              const c = col[j]
              return (
                <div
                  key={j}
                  title={c ? `${new Date(c.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${plural(c.count, 'review')}` : ''}
                  className="size-[13px] rounded-[3px] transition-transform duration-200 hover:scale-125"
                  style={{ background: c ? shades[level(c.count)] : 'transparent' }}
                />
              )
            })}
          </div>
        ))}
      </div>
      <dl className="flex gap-8">
        {[
          ['streak', ov.streak, ov.streak === 1 ? 'day' : 'days'],
          ['this week', ov.week, 'reviews'],
          ['12 weeks', total, 'reviews']
        ].map(([label, n, unit]) => (
          <div key={label as string}>
            <dt className="text-[0.8rem] text-muted">{label as string}</dt>
            <dd className="tabular text-[1.5rem] leading-tight font-semibold tracking-tight">
              {n as number} <span className="text-[0.85rem] font-normal text-muted">{unit as string}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function Section({ title, action, children }: { title: string; action?: { label: string; run: () => void }; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-[0.95rem] font-semibold">{title}</h2>
        {action && (
          <button onClick={action.run} className="text-[0.85rem] text-muted hover:text-ink">
            {action.label}
          </button>
        )}
      </div>
      <div className="border-t border-line">{children}</div>
    </section>
  )
}

export function Row({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <div
      onClick={onClick}
      className={cx('-mx-3 flex cursor-pointer items-center gap-3 rounded-md border-b border-line px-3 py-2.5 text-[0.95rem] transition-colors hover:bg-surface-2/70', active && 'bg-accent-soft/60')}
    >
      {children}
    </div>
  )
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-[0.92rem] text-muted">{children}</div>
}
