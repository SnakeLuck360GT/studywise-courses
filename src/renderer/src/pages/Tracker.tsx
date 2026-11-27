import { useState } from 'react'
import { ListChecks, Star } from 'lucide-react'
import { examPhase, type TrackerCourse } from '@shared/course'
import { useStore } from '../lib/store'
import { Shell, PageTitle } from '../components/Shell'
import { Button, Empty, Segmented, cx } from '../components/ui'
import { ConfidenceScale, PriorityStar, TickBox, confidenceColour, saveWeek, useTracker } from '../components/ReviewPicker'

// Every course's weeks in one list: tick them off as learnt and revised, say
// how confident you are (1-5), and star the ones whose cards should come first.

type Show = 'all' | 'todo' | 'priority'

/** The columns, the same for the header and every row: week, (topics, due,) priority, learnt, revised, confidence. */
const ROW =
  'grid items-center gap-x-2 grid-cols-[minmax(0,1fr)_32px_50px_54px_106px] sm:gap-x-3 sm:grid-cols-[minmax(0,1fr)_90px_60px_40px_60px_60px_106px] lg:grid-cols-[minmax(0,1fr)_90px_60px_40px_60px_60px_210px]'

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function Tracker() {
  const go = useStore((s) => s.go)
  const [t, update] = useTracker()
  const [show, setShow] = useState<Show>('all')

  if (!t)
    return (
      <Shell>
        <div className="skeleton h-[60vh] w-full rounded-xl" />
      </Shell>
    )

  const weeks = t.courses.flatMap((c) => c.weeks)
  const rated = weeks.flatMap((w) => (w.confidence ? [w.confidence] : []))
  const conf = avg(rated)
  const keep = (w: TrackerCourse['weeks'][number]) => (show === 'priority' ? w.priority : show === 'todo' ? !w.learnt || !w.revised : true)
  const courses = t.courses.map((c) => ({ ...c, shown: c.weeks.filter(keep) })).filter((c) => c.shown.length > 0)

  return (
    <Shell>
      <PageTitle
        title="Tracker"
        actions={
          weeks.length > 0 && (
            <Segmented<Show>
              value={show}
              onChange={setShow}
              options={[
                { value: 'all', label: 'All weeks' },
                { value: 'todo', label: 'Still to do' },
                { value: 'priority', label: 'Priority' }
              ]}
            />
          )
        }
      >
        Tick off each week once you've learnt it and revised it, and rate how confident you feel. Star a week to make it a priority: its flashcards come first when you review.
      </PageTitle>

      {!weeks.length ? (
        <Empty icon={<ListChecks className="size-7" />} title="No course weeks yet">
          <p>Weeks show up here once you add a course.</p>
          <Button className="mt-4" variant="primary" onClick={() => go({ name: 'courses' })}>
            Go to Courses
          </Button>
        </Empty>
      ) : (
        <>
          <section className="mb-10 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {[
              { label: 'Learnt', value: `${weeks.filter((w) => w.learnt).length} / ${weeks.length}`, sub: 'weeks ticked off' },
              { label: 'Revised', value: `${weeks.filter((w) => w.revised).length} / ${weeks.length}`, sub: 'weeks ticked off' },
              { label: 'Confidence', value: conf === null ? '—' : `${conf.toFixed(1)} / 5`, sub: rated.length ? `average of ${rated.length} rated` : 'rate a week to see it' },
              { label: 'Priority', value: String(weeks.filter((w) => w.priority).length), sub: 'weeks whose cards come first' }
            ].map((x) => (
              <div key={x.label} className="min-w-0 border-t border-line pt-3">
                <div className="text-[0.8rem] text-muted">{x.label}</div>
                <div className="tabular text-[1.5rem] leading-tight font-semibold tracking-tight">{x.value}</div>
                <div className="truncate text-[0.8rem] text-muted">{x.sub}</div>
              </div>
            ))}
          </section>

          {!courses.length && <p className="py-10 text-center text-muted">{show === 'priority' ? 'No priority weeks. Star a week to add it.' : 'Every week is learnt and revised.'}</p>}

          <div className="flex flex-col gap-10">
            {courses.map((c) => {
              const learnt = c.weeks.filter((w) => w.learnt).length
              const revised = c.weeks.filter((w) => w.revised).length
              const cAvg = avg(c.weeks.flatMap((w) => (w.confidence ? [w.confidence] : [])))
              const exam = examPhase(c.exam_date)
              const examDays = exam.phase === 'steady' || exam.phase === 'revision' ? exam.days : null
              return (
                <section key={c.id}>
                  <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <button className="text-left text-[1.05rem] font-semibold hover:text-accent" onClick={() => go({ name: 'course', id: c.id })}>
                      {c.name}
                    </button>
                    {c.module && c.module !== c.name && <span className="text-[0.88rem] text-muted">{c.module}</span>}
                    <span className="ml-auto flex flex-wrap gap-x-4 text-[0.85rem] text-muted">
                      <span className="tabular">{learnt}/{c.weeks.length} learnt</span>
                      <span className="tabular">{revised}/{c.weeks.length} revised</span>
                      {cAvg !== null && (
                        <span className="tabular inline-flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ background: confidenceColour(Math.round(cAvg)) }} />
                          {cAvg.toFixed(1)} confidence
                        </span>
                      )}
                      {examDays !== null && <span className={cx('tabular', exam.phase === 'revision' && 'font-medium text-warn')}>Exam in {examDays === 1 ? '1 day' : `${examDays} days`}</span>}
                    </span>
                  </div>

                  <div role="table" aria-label={`${c.name} weeks`} className="border-t border-line">
                    <div role="row" className={`${ROW} border-b border-line py-2 text-[0.78rem] font-medium text-muted`}>
                      <span role="columnheader">Week</span>
                      <span role="columnheader" className="hidden sm:block">
                        Topics
                      </span>
                      <span role="columnheader" className="hidden sm:block">
                        Due
                      </span>
                      <span role="columnheader" className="text-center" title="Priority: its cards come first">
                        <Star className="mx-auto size-3.5" />
                      </span>
                      <span role="columnheader" className="text-center">
                        Learnt
                      </span>
                      <span role="columnheader" className="text-center">
                        Revised
                      </span>
                      <span role="columnheader">Confidence</span>
                    </div>
                    {c.shown.map((w) => (
                      <div
                        role="row"
                        key={w.id}
                        className={cx(
                          ROW,
                          'group border-b border-line py-1.5 transition-colors hover:bg-surface-2/50',
                          w.priority && 'bg-[color-mix(in_oklab,var(--warn)_6%,transparent)]'
                        )}
                      >
                        <button role="cell" className="min-w-0 truncate py-1 text-left text-[0.95rem] hover:text-accent" onClick={() => go({ name: 'week', courseId: c.id, weekId: w.id })} title={`Open ${w.label}`}>
                          {w.label}
                        </button>
                        <span role="cell" className="tabular hidden text-[0.85rem] text-muted sm:block">
                          {w.topic_count ? `${w.done_count}/${w.topic_count} done` : '—'}
                        </span>
                        <span role="cell" className={cx('tabular hidden text-[0.85rem] sm:block', w.due_count ? 'font-medium text-accent' : 'text-muted/50')}>
                          {w.recall_off ? 'Off' : w.due_count || '—'}
                        </span>
                        <span role="cell" className="flex justify-center">
                          <PriorityStar on={w.priority} label={w.label} onChange={(v) => void saveWeek(update, w, { priority: v })} />
                        </span>
                        <span role="cell" className="flex justify-center">
                          <TickBox on={w.learnt} label={w.learnt ? `${w.label} learnt` : `Mark ${w.label} learnt`} onChange={(v) => void saveWeek(update, w, { learnt: v })} />
                        </span>
                        <span role="cell" className="flex justify-center">
                          <TickBox on={w.revised} label={w.revised ? `${w.label} revised` : `Mark ${w.label} revised`} onChange={(v) => void saveWeek(update, w, { revised: v })} />
                        </span>
                        <span role="cell">
                          <ConfidenceScale value={w.confidence} label={w.label} onChange={(v) => void saveWeek(update, w, { confidence: v })} />
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </>
      )}
    </Shell>
  )
}
