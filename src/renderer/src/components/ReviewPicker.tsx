import { useEffect, useMemo, useState } from 'react'
import { Star, Check, Minus } from 'lucide-react'
import { CONFIDENCE_LABELS, CONFIDENCE_MAX, type TrackerCourse, type TrackerDeck, type TrackerWeek } from '@shared/course'
import { useStore, toast } from '../lib/store'
import { api, errorText } from '../lib/api'
import { Button, Modal, cx } from './ui'

// Choosing which weeks of which courses (and which other decks) a review on
// Home covers, and marking weeks as a priority so their cards come first.
// The pick is kept on this device; null means everything that's due.

export const REVIEW_PICK_SETTING = 'review.pick'

export type Tracker = { courses: TrackerCourse[]; decks: TrackerDeck[] }

/** The decks picked for review on Home (null: everything), and a way to change it. */
export function useReviewPick(): [Set<string> | null, (p: Set<string> | null) => void] {
  const version = useStore((s) => s.version)
  const [pick, setPick] = useState<Set<string> | null>(null)
  useEffect(() => {
    void api.settings.all().then((s) => {
      const v = s[REVIEW_PICK_SETTING]
      setPick(Array.isArray(v) ? new Set(v as string[]) : null)
    })
  }, [version])
  const save = (p: Set<string> | null) => {
    setPick(p)
    void api.settings.set({ key: REVIEW_PICK_SETTING, value: p ? [...p] : null })
  }
  return [pick, save]
}

/** Every course's weeks and the other decks, reloaded when anything changes. */
export function useTracker(): [Tracker | null, (f: (t: Tracker) => Tracker) => void] {
  const version = useStore((s) => s.version)
  const [t, setT] = useState<Tracker | null>(null)
  useEffect(() => void api.courses.tracker().then(setT).catch(() => setT({ courses: [], decks: [] })), [version])
  return [t, (f) => setT((x) => (x ? f(x) : x))]
}

/** Change one week in a tracker list (optimistically), then save it. */
export async function saveWeek(
  update: (f: (t: Tracker) => Tracker) => void,
  week: TrackerWeek,
  patch: Partial<Pick<TrackerWeek, 'priority' | 'learnt' | 'revised' | 'confidence'>>
): Promise<void> {
  const apply = (p: typeof patch) => update((t) => ({ ...t, courses: t.courses.map((c) => ({ ...c, weeks: c.weeks.map((w) => (w.id === week.id ? { ...w, ...p } : w)) })) }))
  apply(patch)
  try {
    await api.courses.setWeekTrack({ weekId: week.id, ...patch })
  } catch (e) {
    apply(Object.fromEntries(Object.keys(patch).map((k) => [k, week[k as keyof typeof patch]])))
    toast(errorText(e), 'bad')
  }
}

/** The star that makes a week a priority for review. */
export function PriorityStar({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={on ? `${label} is a priority: its cards come first. Click to stop.` : `Make ${label} a priority: its cards come first`}
      aria-label={on ? `Stop prioritising ${label}` : `Prioritise ${label}`}
      onClick={(e) => (e.stopPropagation(), onChange(!on))}
      className={cx('grid size-8 shrink-0 place-items-center rounded-md transition-[color,background,transform] duration-200 active:scale-90', on ? 'text-warn hover:bg-warn-soft' : 'text-muted/45 hover:bg-surface-2 hover:text-muted')}
    >
      <Star className="size-[18px]" fill={on ? 'currentColor' : 'none'} strokeWidth={on ? 1.8 : 2} />
    </button>
  )
}

/** A square tick box. */
export function TickBox({ on, onChange, label, indeterminate }: { on: boolean; onChange: (v: boolean) => void; label: string; indeterminate?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : on}
      aria-label={label}
      title={label}
      onClick={(e) => (e.stopPropagation(), onChange(!on))}
      className={cx(
        'grid size-[22px] shrink-0 place-items-center rounded-md border transition-[background,border-color,transform] duration-200 active:scale-90',
        on || indeterminate ? 'border-good bg-good text-white' : 'border-line bg-surface hover:border-[color-mix(in_oklab,var(--ink)_30%,transparent)]'
      )}
    >
      {indeterminate ? <Minus className="size-3.5" strokeWidth={3.5} /> : on && <Check className="pop-in size-3.5" strokeWidth={3.5} />}
    </button>
  )
}

/** Colour for a confidence level, from red (1) to green (5). */
export const confidenceColour = (n: number) => {
  const mix = [
    'var(--bad)',
    'color-mix(in oklab, var(--bad) 50%, var(--warn))',
    'var(--warn)',
    'color-mix(in oklab, var(--warn) 45%, var(--good))',
    'var(--good)'
  ]
  return mix[Math.min(CONFIDENCE_MAX, Math.max(1, n)) - 1]
}

/** Confidence as a 1-5 scale. Clicking the level it's on clears it. */
export function ConfidenceScale({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover ?? value
  return (
    <div className="flex items-center gap-2.5" onMouseLeave={() => setHover(null)}>
      <div role="radiogroup" aria-label={`How confident you are with ${label}`} className="flex gap-1">
        {Array.from({ length: CONFIDENCE_MAX }, (_, i) => i + 1).map((n) => {
          const lit = shown !== null && n <= shown
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} of ${CONFIDENCE_MAX}: ${CONFIDENCE_LABELS[n - 1]}`}
              title={value === n ? `${CONFIDENCE_LABELS[n - 1]}. Click to clear.` : `${n}: ${CONFIDENCE_LABELS[n - 1]}`}
              onMouseEnter={() => setHover(n)}
              onClick={(e) => (e.stopPropagation(), onChange(value === n ? null : n))}
              className={cx('h-[22px] w-[18px] rounded-[5px] transition-[background,transform,opacity] duration-200 active:scale-90', !lit && 'bg-surface-2 ring-1 ring-line ring-inset', hover !== null && !lit && 'opacity-70')}
              style={lit ? { background: confidenceColour(shown!), opacity: hover !== null && value !== null && n > value ? 0.7 : 1 } : undefined}
            />
          )
        })}
      </div>
      <span className="hidden w-[92px] truncate text-[0.8rem] text-muted lg:inline">{shown ? CONFIDENCE_LABELS[shown - 1] : 'Not rated'}</span>
    </div>
  )
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * Pick which weeks of which courses (and which other decks) Home's review
 * covers, and star weeks to make them a priority.
 */
export function ReviewPicker({ open, onClose, pick, onPick }: { open: boolean; onClose: () => void; pick: Set<string> | null; onPick: (p: Set<string> | null) => void }) {
  const [t, update] = useTracker()
  const [sel, setSel] = useState<Set<string>>(new Set())
  // Every deck you could review: weeks with a deck and recall on, and the other decks.
  const all = useMemo(() => (t ? [...t.courses.flatMap((c) => c.weeks.filter((w) => w.deck_id && !w.recall_off).map((w) => w.deck_id!)), ...t.decks.map((d) => d.id)] : []), [t])
  const dueOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of t?.courses ?? []) for (const w of c.weeks) if (w.deck_id) m.set(w.deck_id, w.due_count)
    for (const d of t?.decks ?? []) m.set(d.id, d.due_count)
    return m
  }, [t])
  const priority = useMemo(() => new Set((t?.courses ?? []).flatMap((c) => c.weeks.filter((w) => w.priority && w.deck_id).map((w) => w.deck_id!))), [t])
  // Start from what's picked now, each time it opens.
  useEffect(() => {
    if (open && t) setSel(new Set(pick ? all.filter((d) => pick.has(d)) : all))
  }, [open, !!t])

  const toggle = (ids: string[], on: boolean) =>
    setSel((s) => {
      const n = new Set(s)
      for (const id of ids) on ? n.add(id) : n.delete(id)
      return n
    })
  const due = [...sel].reduce((n, d) => n + (dueOf.get(d) ?? 0), 0)
  const priDue = [...sel].filter((d) => priority.has(d)).reduce((n, d) => n + (dueOf.get(d) ?? 0), 0)
  const everything = all.length > 0 && all.every((d) => sel.has(d))
  const save = () => {
    onPick(everything ? null : new Set(sel))
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose what to review"
      wide
      footer={
        <>
          <span className="mr-auto text-[0.88rem] text-muted">
            {plural(due, 'card')} due{priDue > 0 && <> · {priDue} from priority weeks first</>}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!sel.size}>
            Use these
          </Button>
        </>
      }
    >
      <p className="text-[0.9rem] text-muted">
        Tick the weeks to include. Star a week to make it a priority: its due cards come before the rest, here and in each course's review.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="soft" onClick={() => setSel(new Set(all))}>
          Everything
        </Button>
        <Button size="sm" variant="soft" onClick={() => setSel(new Set(all.filter((d) => priority.has(d))))} disabled={!priority.size}>
          Priority weeks only
        </Button>
        <Button size="sm" variant="soft" onClick={() => setSel(new Set(all.filter((d) => (dueOf.get(d) ?? 0) > 0)))}>
          Only what's due
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>
          None
        </Button>
      </div>

      {!t ? (
        <div className="skeleton mt-5 h-48 w-full rounded-xl" />
      ) : !all.length ? (
        <p className="py-8 text-center text-muted">No decks or course weeks yet.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {t.courses
            .filter((c) => c.weeks.some((w) => w.deck_id))
            .map((c) => {
              const ids = c.weeks.filter((w) => w.deck_id && !w.recall_off).map((w) => w.deck_id!)
              const n = ids.filter((d) => sel.has(d)).length
              const courseDue = c.weeks.reduce((s, w) => s + w.due_count, 0)
              return (
                <section key={c.id}>
                  <div className="flex items-center gap-3 border-b border-line pb-2">
                    <TickBox on={ids.length > 0 && n === ids.length} indeterminate={n > 0 && n < ids.length} onChange={(v) => toggle(ids, v)} label={`All of ${c.name}`} />
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold">{c.name}</span>
                      {c.module && c.module !== c.name && <span className="ml-2 text-[0.85rem] text-muted">{c.module}</span>}
                    </div>
                    <span className="tabular text-[0.85rem] text-muted">{courseDue ? `${courseDue} due` : 'Nothing due'}</span>
                  </div>
                  {c.weeks
                    .filter((w) => w.deck_id)
                    .map((w) => (
                      <div
                        key={w.id}
                        onClick={() => !w.recall_off && toggle([w.deck_id!], !sel.has(w.deck_id!))}
                        className={cx('-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5', w.recall_off ? 'opacity-50' : 'cursor-pointer hover:bg-surface-2/70')}
                      >
                        <span className="w-[22px]" />
                        {w.recall_off ? <span className="size-[22px] shrink-0" /> : <TickBox on={sel.has(w.deck_id!)} onChange={(v) => toggle([w.deck_id!], v)} label={`Include ${w.label}`} />}
                        <span className="min-w-0 flex-1 truncate">{w.label}</span>
                        {w.recall_off && <span className="text-[0.8rem] text-muted">Recall off</span>}
                        <span className={cx('tabular w-16 text-right text-[0.88rem]', w.due_count ? 'font-medium text-accent' : 'text-muted/50')}>{w.due_count ? `${w.due_count} due` : '—'}</span>
                        <PriorityStar on={w.priority} label={w.label} onChange={(v) => void saveWeek(update, w, { priority: v })} />
                      </div>
                    ))}
                </section>
              )
            })}
          {t.decks.length > 0 && (
            <section>
              <div className="flex items-center gap-3 border-b border-line pb-2">
                {(() => {
                  const ids = t.decks.map((d) => d.id)
                  const n = ids.filter((d) => sel.has(d)).length
                  return <TickBox on={n === ids.length} indeterminate={n > 0 && n < ids.length} onChange={(v) => toggle(ids, v)} label="All other decks" />
                })()}
                <span className="flex-1 font-semibold">Other decks</span>
              </div>
              {t.decks.map((d) => (
                <div key={d.id} onClick={() => toggle([d.id], !sel.has(d.id))} className="-mx-2 flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-2/70">
                  <span className="w-[22px]" />
                  <TickBox on={sel.has(d.id)} onChange={(v) => toggle([d.id], v)} label={`Include ${d.name}`} />
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <span className={cx('tabular w-16 text-right text-[0.88rem]', d.due_count ? 'font-medium text-accent' : 'text-muted/50')}>{d.due_count ? `${d.due_count} due` : '—'}</span>
                  <span className="size-8 shrink-0" />
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}
