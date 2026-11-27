// Home's panel beside the cards due, when Settings → Home says Deadlines: the
// next deadline from your spreadsheet (how long until it, and the one after),
// and tasks of your own to tick off.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Plus, Upload, X } from 'lucide-react'
import { daysUntil, whenText, type Deadline, type StudyTask } from '@shared/deadlines'
import { api, errorText } from '../lib/api'
import { toast, useStore } from '../lib/store'
import { Button, cx } from './ui'

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dayText = (iso: string) => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const nameOf = (d: Deadline) => [d.module, d.code].filter(Boolean).join(' · ')

export function DeadlinesPanel() {
  const version = useStore((s) => s.version)
  const [data, setData] = useState<{ deadlines: Deadline[]; tasks: StudyTask[] } | null>(null)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const load = () => void api.deadlines.list().then(setData).catch(() => setData({ deadlines: [], tasks: [] }))
  useEffect(load, [version])
  const today = todayIso()
  const upcoming = useMemo(() => (data?.deadlines ?? []).filter((d) => !d.done && d.due >= today), [data, today])
  const next = upcoming[0]
  // Others due the same day as the next one, then the one after.
  const sameDay = upcoming.filter((d) => next && d.due === next.due && d.id !== next.id)
  const after = upcoming.find((d) => next && d.due > next.due)

  const upload = async () => {
    try {
      const r = await api.deadlines.import()
      if (!r) return
      toast(`Read ${r.count} deadline${r.count === 1 ? '' : 's'}.${r.next ? ` Next: ${r.next.title}, ${whenText(r.next.due, today).toLowerCase()}.` : ''}`, 'good')
      load()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const run = (fn: () => Promise<unknown>) => void fn().then(load).catch((e) => toast(errorText(e), 'bad'))
  const add = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    run(() => api.deadlines.addTask({ text: t }))
    input.current?.focus()
  }

  if (!data) return <div className="skeleton mx-auto h-[250px] w-full max-w-[380px] rounded-2xl" />
  const left = data.tasks.filter((t) => !t.done).length
  const days = next ? daysUntil(next.due, today) : null
  return (
    <div className="mx-auto flex max-h-[420px] min-h-[250px] w-full max-w-[380px] flex-col rounded-2xl border border-line bg-surface p-6 shadow-[0_18px_40px_-24px_rgba(20,40,120,0.35)]">
      <div className="flex items-center gap-2">
        <div className="flex-1 text-[0.8rem] text-muted">Next deadline</div>
        <button onClick={() => void upload()} className="inline-flex items-center gap-1 text-[0.78rem] text-muted hover:text-ink" title="Upload a spreadsheet of your deadlines (.xlsx or .csv). It replaces the ones you have.">
          <Upload className="size-3.5" /> {data.deadlines.length ? 'Replace' : 'Upload'}
        </button>
      </div>
      {next ? (
        <>
          <div className="mt-1 flex items-baseline gap-3">
            <span className={cx('text-[2.2rem] leading-none font-semibold tracking-tight tabular', days !== null && days <= 2 && 'text-bad')}>{whenText(next.due, today)}</span>
            <span className="text-[0.9rem] text-muted">{dayText(next.due)}</span>
          </div>
          <div className="mt-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold" title={next.title}>
                {next.title}
              </div>
              <div className="truncate text-[0.84rem] text-muted">
                {nameOf(next)}
                {sameDay.length > 0 && ` · and ${sameDay.length} more that day`}
              </div>
            </div>
            <button onClick={() => run(() => api.deadlines.setDone({ id: next.id, done: true }))} className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-muted hover:border-good hover:text-good" title="Done: tick it off" aria-label={`Tick off ${next.title}`}>
              <Check className="size-4" />
            </button>
          </div>
          {after && (
            <div className="mt-1.5 truncate text-[0.82rem] text-muted" title={`${after.title} · ${nameOf(after)}`}>
              Then {after.title} · {whenText(after.due, today).toLowerCase()}
            </div>
          )}
        </>
      ) : data.deadlines.length ? (
        <div className="mt-2 text-[0.95rem] text-muted">No deadlines coming up. Nice.</div>
      ) : (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-[0.9rem] text-muted">Upload your deadlines spreadsheet and the next one shows here.</p>
          <Button size="sm" variant="primary" onClick={() => void upload()}>
            <Upload className="size-4" /> Upload deadlines (.xlsx)
          </Button>
        </div>
      )}

      <div className="mt-4 flex items-baseline border-t border-line pt-3">
        <div className="flex-1 text-[0.8rem] text-muted">My tasks</div>
        {left > 0 && <span className="text-[0.78rem] text-muted">{left} to do</span>}
        {data.tasks.some((t) => t.done) && (
          <button className="ml-3 text-[0.78rem] text-muted hover:text-ink" onClick={() => run(() => api.deadlines.clearDoneTasks())} title="Clear the ones you've ticked off">
            Clear done
          </button>
        )}
      </div>
      <ul className="-mx-1 mt-1 min-h-0 flex-1 overflow-y-auto">
        {data.tasks.map((t) => (
          <li key={t.id} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2/60">
            <button
              onClick={() => run(() => api.deadlines.setTaskDone({ id: t.id, done: !t.done }))}
              className={cx('grid size-[18px] shrink-0 place-items-center rounded-[5px] border transition-colors', t.done ? 'border-good bg-good text-white' : 'border-line hover:border-ink/40')}
              aria-label={t.done ? `Not done: ${t.text}` : `Done: ${t.text}`}
              aria-pressed={t.done}
            >
              {t.done && <Check className="size-3" />}
            </button>
            <span className={cx('min-w-0 flex-1 truncate text-[0.9rem]', t.done && 'text-muted line-through')} title={t.text}>
              {t.text}
            </span>
            <button onClick={() => run(() => api.deadlines.removeTask({ id: t.id }))} className="invisible grid size-5 place-items-center rounded text-muted group-hover:visible hover:text-ink" aria-label={`Remove ${t.text}`} title="Remove">
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a task…"
          maxLength={300}
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[0.9rem] outline-none focus:border-accent"
        />
        <Button type="submit" size="icon" variant="ghost" aria-label="Add task" disabled={!text.trim()}>
          <Plus className="size-4" />
        </Button>
      </form>
    </div>
  )
}
