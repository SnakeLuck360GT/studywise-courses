// A week you asked or voted for on the marketplace is done: a card at the
// bottom of the window, straight away, to add it to your course. Not now
// leaves it to be added at the next sync. Several at once: one at a time.

import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import type { WeekRequest } from '@shared/market'
import { api, errorText, onEvent } from '../lib/api'
import { toast, useStore } from '../lib/store'
import { Button } from './ui'

export function ReadyCard() {
  const go = useStore((s) => s.go)
  const [queue, setQueue] = useState<WeekRequest[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(
    () =>
      onEvent((ev) => {
        if (ev.type !== 'market:ready') return
        setQueue((q) => [...q, ...ev.requests.filter((r) => !q.some((x) => x.id === r.id))])
      }),
    []
  )
  const r = queue[0]
  if (!r) return null
  const next = () => setQueue((q) => q.slice(1))
  const add = async () => {
    setBusy(true)
    try {
      const at = await api.market.addReady({ id: r.id })
      useStore.getState().bump()
      toast(`${r.label} is in your courses now.`, 'good', at ? { label: 'Open it', run: () => go({ name: 'week', courseId: at.courseId, weekId: at.weekId }) } : undefined)
      next()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  const by = r.doneBy.length ? `Made by ${r.doneBy.join(', ')}` : 'Made on the marketplace'
  return (
    <section
      role="status"
      className="pop-in fixed bottom-5 left-1/2 z-40 flex w-[min(820px,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-4 rounded-xl border border-accent/30 bg-accent-soft px-5 py-4 shadow-[0_18px_40px_-18px_rgba(20,40,120,0.45)]"
    >
      <div className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
        <Download className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[0.85rem] text-muted">Ready to add · {r.kind === 'write' ? 'the rest of a week you asked for' : 'a week you asked for'}</div>
        <div className="truncate text-[1.1rem] font-semibold tracking-[-0.01em]">
          {r.label} · {r.course}
        </div>
        <div className="text-[0.88rem] text-muted">
          {by}
          {queue.length > 1 && ` · ${queue.length - 1} more ready`}
        </div>
      </div>
      <Button variant="primary" size="lg" loading={busy} onClick={() => void add()}>
        Add it
      </Button>
      <button onClick={() => (void api.market.notNow({ id: r.id }).catch(() => {}), next())} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink" aria-label="Not now" title="Not now: it’s added by itself at the next sync">
        <X className="size-4" />
      </button>
    </section>
  )
}
