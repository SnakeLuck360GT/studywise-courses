import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown, ChevronUp, Sparkles, X } from 'lucide-react'
import type { JobInfo } from '@shared/types'
import { useStore } from '../lib/store'
import { api } from '../lib/api'
import { Markdown } from './Markdown'
import { cx } from './ui'

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** The progress bar: real percent when the job knows it, a sweep when it doesn't. */
export function JobBar({ job, className }: { job: JobInfo; className?: string }) {
  const pct = job.percent
  return (
    <div className={cx('relative h-2 overflow-hidden rounded-full bg-surface-2', className)} role="progressbar" aria-valuenow={pct === null ? undefined : Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
      {pct === null ? (
        <div className="job-sweep absolute inset-y-0 w-1/3 rounded-full bg-accent/70" />
      ) : (
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, pct * 100)}%` }} />
      )}
    </div>
  )
}

/** Progress, what Claude is doing, and the part it's writing right now. */
export function JobLive({ job, defaultOpen = true }: { job: JobInfo; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const live = job.live
  const previewRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = previewRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [live?.preview?.text])
  return (
    <div className="flex flex-col gap-2.5" data-job-live>
      <div className="flex items-center gap-3">
        <JobBar job={job} className="flex-1" />
        <span className="tabular w-10 text-right text-[0.8rem] font-semibold text-muted">{job.percent === null ? '' : `${Math.round(job.percent * 100)}%`}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.86rem]">
        <span className="min-w-0 flex-1 truncate font-medium">{live?.stage || job.progress}</span>
        {live && live.thinkingTokens > 0 && (
          <span className={cx('inline-flex items-center gap-1.5 text-[0.8rem] text-muted', live.thinking && 'text-accent')} title="Claude Code shows how much Claude is thinking, but not the thinking itself">
            <Brain className={cx('size-3.5', live.thinking && 'animate-pulse')} /> {live.thinking ? 'Thinking' : 'Thought'} · ~{fmtTokens(live.thinkingTokens)} tokens
          </span>
        )}
        {live && (live.log.length > 0 || live.preview) && (
          <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[0.8rem] text-muted hover:text-ink">
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} {open ? 'Hide' : 'Show'} what Claude’s doing
          </button>
        )}
      </div>
      {open && live && (live.log.length > 0 || live.preview) && (
        <div className="fade-in grid gap-2.5 md:grid-cols-[minmax(0,14rem)_1fr]">
          {live.log.length > 0 && (
            <ol className="flex flex-col gap-1 text-[0.8rem] text-muted">
              {live.log.map((l, i) => (
                <li key={`${i}-${l}`} className={cx('flex items-start gap-1.5', i === live.log.length - 1 && 'text-ink')}>
                  <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', i === live.log.length - 1 ? 'bg-accent' : 'bg-line')} />
                  <span className="min-w-0 break-words">{l}</span>
                </li>
              ))}
            </ol>
          )}
          {live.preview && (
            <div className="rounded-lg bg-surface-2 p-3 text-[0.85rem]">
              <div className="mb-1 flex items-center gap-1.5 text-[0.75rem] font-semibold text-accent">
                <Sparkles className="size-3 shrink-0" /> <span className="truncate">{live.preview.heading}</span>
              </div>
              <div ref={previewRef} className="max-h-40 overflow-y-auto">
                <Markdown streaming>{live.preview.text || '…'}</Markdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Running jobs, bottom left, on every page except Jobs. */
export function JobDock() {
  const jobs = useStore((s) => s.jobs)
  const route = useStore((s) => s.route)
  const go = useStore((s) => s.go)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const running = jobs.filter((j) => j.status === 'running')
  useEffect(() => {
    if (running.length === 0) setHidden(false)
  }, [running.length])
  // Studying shouldn't be crowded; the course page shows its own.
  if (!running.length || hidden || (route.name === 'settings' && route.tab === 'jobs') || route.name === 'course' || route.name === 'week') return null
  const quiet = route.name === 'topic' || route.name === 'weektest' || route.name === 'learn' || route.name === 'flashcards'
  return (
    <div className="pop-in fixed bottom-4 left-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 rounded-xl border border-line bg-surface/95 p-3 shadow-xl backdrop-blur" data-job-dock>
      <div className="flex items-center gap-2 text-[0.78rem] font-semibold text-muted">
        <Sparkles className="size-3.5 text-accent" /> Generating
        <span className="flex-1" />
        <button className="hover:text-ink" onClick={() => go({ name: 'jobs' })}>
          All jobs
        </button>
        <button className="hover:text-ink" onClick={() => setHidden(true)} aria-label="Hide">
          <X className="size-3.5" />
        </button>
      </div>
      {running.slice(0, quiet ? 1 : 3).map((j) => (
        <div key={j.id} className="flex flex-col gap-1.5">
          <button className="flex items-center gap-2 text-left" onClick={() => setExpanded(expanded === j.id ? null : j.id)}>
            <span className="min-w-0 flex-1 truncate text-[0.85rem] font-semibold">{j.title.replace(/^(Topic|Plan|Notes|Flashcards): /, '')}</span>
            <span className="tabular text-[0.75rem] text-muted">{j.percent === null ? '' : `${Math.round(j.percent * 100)}%`}</span>
          </button>
          {expanded === j.id ? (
            <JobLive job={j} />
          ) : (
            <>
              <JobBar job={j} />
              <div className="truncate text-[0.78rem] text-muted">{j.live?.stage || j.progress}</div>
            </>
          )}
        </div>
      ))}
      {running.length > (quiet ? 1 : 3) && <div className="text-[0.78rem] text-muted">+{running.length - (quiet ? 1 : 3)} more</div>}
      {!quiet && running.length === 1 && (
        <button className="self-start text-[0.78rem] text-muted hover:text-bad" onClick={() => api.jobs.cancel({ id: running[0].id })}>
          Cancel
        </button>
      )}
    </div>
  )
}
