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
/** Deadlines shown before Show all: a few, so the panel stays the size of the others. */
const SHOWN = 3

/** "Today", "Tomorrow", "3 days", "5 wks": short, for the badge. */
function soon(due: string, today: string): string {
  const n = daysUntil(due, today)
  return n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : n < 14 ? `${n} days` : `${Math.round(n / 7)} wks`
}

/** One deadline on one line: how long until it (red within 2 days, amber within a week), what it is, and the day. */
function DeadlineRow({ d, today, onDone }: { d: Deadline; today: string; onDone: () => void }) {
  const days = daysUntil(d.due, today)
  const tone = days <= 2 ? 'bg-bad-soft text-bad' : days <= 7 ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted'
  return (
    <li className="group flex items-center gap-2 rounded-md px-1 py-[3px] hover:bg-surface-2/60" title={[d.title, nameOf(d), `${whenText(d.due, today)}, ${dayText(d.due)}`].filter(Boolean).join(' · ')}>
      <span className={cx('w-[4.3rem] shrink-0 rounded px-1 py-[1px] text-center text-[0.72rem] font-semibold tabular', tone)}>{soon(d.due, today)}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-[0.88rem] font-medium">{d.title}</span>
        {d.module && <span className="shrink-0 text-[0.72rem] text-muted tabular">{d.module}</span>}
      </span>
      <span className="shrink-0 text-[0.75rem] text-muted tabular group-hover:hidden">{dayText(d.due)}</span>
      <button
        onClick={onDone}
        className="hidden size-5 shrink-0 place-items-center rounded-full border border-line text-muted group-hover:grid hover:border-good hover:text-good focus:grid"
        title="Done: tick it off"
        aria-label={`Tick off ${d.title}`}
      >
        <Check className="size-3" />
      </button>
    </li>
  )
}

export function DeadlinesPanel() {
  const version = useStore((s) => s.version)
  const [data, setData] = useState<{ deadlines: Deadline[]; tasks: StudyTask[] } | null>(null)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const load = () => void api.deadlines.list().then(setData).catch(() => setData({ deadlines: [], tasks: [] }))
  useEffect(load, [version])
  const today = todayIso()
  const upcoming = useMemo(() => (data?.deadlines ?? []).filter((d) => !d.done && d.due >= today), [data, today])
  // The next few; the rest a click away.
  const [all, setAll] = useState(false)
  const shown = all ? upcoming : upcoming.slice(0, SHOWN)

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
  return (
    <div className="mx-auto flex min-h-[250px] w-full max-w-[380px] flex-col rounded-2xl border border-line bg-surface p-5 shadow-[0_18px_40px_-24px_rgba(20,40,120,0.35)]">
      <div className="flex items-center gap-2">
        <div className="flex-1 text-[0.8rem] text-muted">
          Deadlines{upcoming.length > 0 && <span> · {upcoming.length} coming up</span>}
        </div>
        <button onClick={() => void upload()} className="inline-flex items-center gap-1 text-[0.78rem] text-muted hover:text-ink" title="Upload a spreadsheet of your deadlines (.xlsx or .csv). It replaces the ones you have.">
          <Upload className="size-3.5" /> {data.deadlines.length ? 'Replace' : 'Upload'}
        </button>
      </div>
      {upcoming.length ? (
        <>
          <ul className={cx('-mx-1 mt-1 flex flex-col', all && 'max-h-[150px] overflow-y-auto')}>
            {shown.map((d) => (
              <DeadlineRow key={d.id} d={d} today={today} onDone={() => run(() => api.deadlines.setDone({ id: d.id, done: true }))} />
            ))}
          </ul>
          {upcoming.length > SHOWN && (
            <button className="mt-1 self-start text-[0.8rem] text-muted hover:text-ink" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${upcoming.length}`}
            </button>
          )}
        </>
      ) : data.deadlines.length ? (
        <div className="mt-2 text-[0.95rem] text-muted">No deadlines coming up. Nice.</div>
      ) : (
        <div className="mt-2 flex flex-col items-start gap-2">
          <p className="text-[0.9rem] text-muted">Upload your deadlines spreadsheet and they show here, soonest first.</p>
          <Button size="sm" variant="primary" onClick={() => void upload()}>
            <Upload className="size-4" /> Upload deadlines (.xlsx)
          </Button>
        </div>
      )}

      <div className="mt-3 flex items-baseline border-t border-line pt-2.5">
        <div className="flex-1 text-[0.8rem] text-muted">My tasks</div>
        {left > 0 && <span className="text-[0.78rem] text-muted">{left} to do</span>}
        {data.tasks.some((t) => t.done) && (
          <button className="ml-3 text-[0.78rem] text-muted hover:text-ink" onClick={() => run(() => api.deadlines.clearDoneTasks())} title="Clear the ones you've ticked off">
            Clear done
          </button>
        )}
      </div>
      <ul className="-mx-1 mt-0.5 max-h-[84px] overflow-y-auto">
        {data.tasks.map((t) => (
          <li key={t.id} className="group flex items-center gap-2 rounded-md px-1 py-[3px] hover:bg-surface-2/60">
            <button
              onClick={() => run(() => api.deadlines.setTaskDone({ id: t.id, done: !t.done }))}
              className={cx('grid size-[18px] shrink-0 place-items-center rounded-[5px] border transition-colors', t.done ? 'border-good bg-good text-white' : 'border-line hover:border-ink/40')}
              aria-label={t.done ? `Not done: ${t.text}` : `Done: ${t.text}`}
              aria-pressed={t.done}
            >
              {t.done && <Check className="size-3" />}
            </button>
            <span className={cx('min-w-0 flex-1 truncate text-[0.88rem]', t.done && 'text-muted line-through')} title={t.text}>
              {t.text}
            </span>
            <button onClick={() => run(() => api.deadlines.removeTask({ id: t.id }))} className="invisible grid size-5 place-items-center rounded text-muted group-hover:visible hover:text-ink" aria-label={`Remove ${t.text}`} title="Remove">
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-1.5 flex items-center gap-2"
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
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 py-1 text-[0.86rem] outline-none focus:border-accent"
        />
        <Button type="submit" size="icon" variant="ghost" aria-label="Add task" disabled={!text.trim()}>
          <Plus className="size-4" />
        </Button>
      </form>
    </div>
  )
}
