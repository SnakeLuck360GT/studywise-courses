import { randomUUID } from 'node:crypto'
import type { JobInfo, JobLive } from '@shared/types'

// Long AI jobs (note/card generation) run here in the main process, so they
// keep going when the window is closed. Cancelling aborts the signal, which
// kills the claude child process.

export interface JobContext {
  signal: AbortSignal
  progress: (msg: string) => void
  /** Streamed text for the renderer (e.g. notes appearing in the editor). */
  delta: (text: string) => void
  /** Small facts the UI needs early, e.g. the id of the note being written. */
  meta: (m: Record<string, unknown>) => void
  /** Progress bar and live panel. Updates are throttled. */
  live?: (patch: Partial<JobLive> & { percent?: number | null }) => void
}

/**
 * How jobs measure their share of the plan's 5-hour limit: the first reading
 * during the job is the "before", and a fresh reading once it finishes is the
 * "after". Set at startup; without it jobs don't measure anything.
 */
export interface UsageProbe {
  enabled: () => boolean
  /** Calls back with each 5-hour utilization reading (0–1) Claude Code reports. */
  onReading: (fn: (fiveHour: number) => void) => () => void
  /** A fresh 5-hour reading, or null if there isn't one. */
  refresh: () => Promise<number | null>
}
let probe: UsageProbe | null = null
export function setUsageProbe(p: UsageProbe | null): void {
  probe = p
}

const emptyLive = (): JobLive => ({ stage: '', log: [], thinkingTokens: 0, thinking: false, preview: null })

type Listener = (ev: { type: 'update'; job: JobInfo } | { type: 'delta'; jobId: string; text: string }) => void

const jobs = new Map<string, JobInfo & { controller: AbortController }>()
const listeners = new Set<Listener>()

export function onJobEvent(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
const emit: Listener = (ev) => listeners.forEach((l) => l(ev))

const publicInfo = (j: JobInfo & { controller?: AbortController }): JobInfo => {
  const { controller: _c, ...rest } = j as JobInfo & { controller?: AbortController }
  return rest
}

export function startJob<T>(kind: JobInfo['kind'], title: string, run: (ctx: JobContext) => Promise<T>): JobInfo {
  const controller = new AbortController()
  const job: JobInfo & { controller: AbortController } = {
    id: randomUUID(),
    kind,
    title,
    status: 'running',
    progress: 'Starting…',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null,
    meta: {},
    percent: null,
    live: null,
    controller
  }
  let stopWatching: (() => void) | null = null
  if (probe?.enabled()) {
    const others = [...jobs.values()].filter((o) => o.status === 'running')
    job.planUsage = { before: null, used: null, shared: others.length > 0, measuring: true }
    // A job starting now overlaps the running ones too.
    for (const o of others) if (o.planUsage) o.planUsage.shared = true
    stopWatching = probe.onReading((v) => {
      if (job.planUsage && job.planUsage.before === null) job.planUsage.before = v
    })
  }
  jobs.set(job.id, job)
  emit({ type: 'update', job: publicInfo(job) })
  const ctx: JobContext = {
    signal: controller.signal,
    progress: (msg) => {
      job.progress = msg
      emit({ type: 'update', job: publicInfo(job) })
    },
    delta: (text) => emit({ type: 'delta', jobId: job.id, text }),
    meta: (m) => {
      job.meta = { ...job.meta, ...m }
      emit({ type: 'update', job: publicInfo(job) })
    },
    live: ({ percent, ...patch }) => {
      if (job.status !== 'running') return
      if (percent !== undefined) job.percent = percent === null ? null : Math.max(job.percent ?? 0, Math.min(1, percent))
      const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<JobLive>
      job.live = { ...(job.live ?? emptyLive()), ...set }
      if (set.stage) job.progress = set.stage
      // At most ~6 updates a second reach the window.
      if (liveTimer) return
      liveTimer = setTimeout(() => {
        liveTimer = null
        if (job.status === 'running') emit({ type: 'update', job: publicInfo(job) })
      }, 160)
    }
  }
  let liveTimer: ReturnType<typeof setTimeout> | null = null
  run(ctx)
    .then((result) => {
      if (job.status === 'cancelled') return
      job.status = 'done'
      job.result = result
      job.progress = 'Done'
      job.percent = 1
    })
    .catch((e: Error) => {
      if (controller.signal.aborted) {
        job.status = 'cancelled'
        job.progress = 'Cancelled'
      } else {
        job.status = 'error'
        job.error = e?.message ?? String(e)
        job.progress = 'Failed'
      }
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString()
      stopWatching?.()
      emit({ type: 'update', job: publicInfo(job) })
      if (job.planUsage) void measureUsage(job)
    })
  return publicInfo(job)
}

async function measureUsage(job: JobInfo): Promise<void> {
  const pu = job.planUsage!
  if (pu.before !== null && probe) {
    const after = await probe.refresh().catch(() => null)
    // Lower than before means the 5-hour window reset during the job: unknown.
    pu.used = after === null || after < pu.before ? null : Math.round((after - pu.before) * 100) / 100
  }
  pu.measuring = false
  emit({ type: 'update', job: publicInfo(job) })
}

export function cancelJob(id: string): void {
  const j = jobs.get(id)
  if (!j || j.status !== 'running') return
  j.status = 'cancelled'
  j.progress = 'Cancelled'
  try {
    j.controller.abort()
  } catch (e) {
    // Something tidying up after the cancel failed: the job is cancelled all the same.
    console.error('[jobs] cancelling', j.title, e)
  }
  emit({ type: 'update', job: publicInfo(j) })
}

export function listJobs(): JobInfo[] {
  return [...jobs.values()].map(publicInfo).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getJob(id: string): JobInfo | null {
  const j = jobs.get(id)
  return j ? publicInfo(j) : null
}

export function clearFinishedJobs(): void {
  for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id)
}

export function runningJobCount(): number {
  return [...jobs.values()].filter((j) => j.status === 'running').length
}
