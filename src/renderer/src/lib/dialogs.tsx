import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Check } from 'lucide-react'
import { NOTE_LEVELS, NOTE_LEVEL_INFO, type NoteLevel } from '@shared/course'
import { Button, Input, Modal, Select, Textarea, cx } from '../components/ui'

interface Ask {
  title: string
  label?: string
  initial?: string
  confirmText?: string
  danger?: boolean
  /**
   * "confirm" shows only a message; "text" asks for a string; "choose" picks from
   * options; "plan" asks whether to plan, with optional instructions; "write" picks
   * levels of detail, with optional instructions.
   */
  kind: 'text' | 'confirm' | 'choose' | 'plan' | 'write' | 'levels'
  message?: string
  /** For "levels": the levels there are to pick from, with a note on each (how many topics have it). */
  only?: NoteLevel[]
  notes?: Partial<Record<NoteLevel, string>>
  options?: { value: string; label: string }[]
  /** For "write": levels ticked to start with, whether more than one can be picked, and levels already written. */
  levels?: NoteLevel[]
  multi?: boolean
  written?: NoteLevel[]
  cancelText?: string
  /** A third button (for "confirm"), between Cancel and the main one. */
  altText?: string
  placeholder?: string
  resolve: (v: string | null) => void
}

const useDialog = create<{ ask: Ask | null; set: (a: Ask | null) => void }>((set) => ({ ask: null, set: (ask) => set({ ask }) }))

export function askText(title: string, opts: { label?: string; initial?: string; confirmText?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().set({ title, kind: 'text', ...opts, resolve }))
}
export function confirmDialog(title: string, message?: string, opts: { confirmText?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => useDialog.getState().set({ title, kind: 'confirm', message, ...opts, resolve: (v) => resolve(v !== null) }))
}
/** Confirm with a second way on (like "Somewhere else…"): 'ok', 'alt', or null when cancelled. */
export function confirmOrElse(title: string, message: string, opts: { confirmText: string; altText: string }): Promise<'ok' | 'alt' | null> {
  return new Promise((resolve) => useDialog.getState().set({ title, kind: 'confirm', message, ...opts, resolve: (v) => resolve(v === 'alt' ? 'alt' : v === null ? null : 'ok') }))
}
export function chooseDialog(title: string, options: { value: string; label: string }[], opts: { label?: string; confirmText?: string; initial?: string; message?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().set({ title, kind: 'choose', options, ...opts, resolve }))
}

/**
 * Ask before planning a week. Resolves to the instructions typed (maybe empty)
 * to plan now, or null to leave it for later.
 */
export function askPlan(title: string, opts: { message?: string; confirmText?: string; cancelText?: string; danger?: boolean; placeholder?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().set({ title, kind: 'plan', confirmText: 'Plan topics', cancelText: 'Not now', ...opts, resolve }))
}

const LEVELS_KEY = 'studywise.writeLevels'
const lastLevels = (): NoteLevel[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LEVELS_KEY) ?? '[]') as string[]
    const ok = NOTE_LEVELS.filter((l) => v.includes(l))
    return ok.length ? ok : ['standard']
  } catch {
    return ['standard']
  }
}

/**
 * Pick the level(s) of detail to write topics at, and optional instructions.
 * Null when cancelled. With `multi`, several levels can be ticked (each is a
 * separate write, and every level is kept).
 */
export function askWrite(
  title: string,
  opts: { message?: string; confirmText?: string; levels?: NoteLevel[]; multi?: boolean; written?: NoteLevel[]; placeholder?: string; danger?: boolean } = {}
): Promise<{ levels: NoteLevel[]; instructions: string } | null> {
  return new Promise((resolve) =>
    useDialog.getState().set({
      title,
      kind: 'write',
      confirmText: 'Write',
      multi: true,
      ...opts,
      levels: opts.levels ?? lastLevels(),
      resolve: (v) => resolve(v === null ? null : (JSON.parse(v) as { levels: NoteLevel[]; instructions: string }))
    })
  )
}

/**
 * Pick which levels of detail to download, from the ones a week (or several)
 * has. `available` is how many topics have each level. Resolves to the levels
 * picked (every one of them for "All depths"), or null when cancelled.
 */
export function askLevels(title: string, available: Partial<Record<NoteLevel, number>>, opts: { message?: string; confirmText?: string; topics?: number } = {}): Promise<NoteLevel[] | null> {
  const only = NOTE_LEVELS.filter((l) => (available[l] ?? 0) > 0)
  const notes = Object.fromEntries(only.map((l) => [l, opts.topics ? `${available[l]} of ${opts.topics} topic${opts.topics === 1 ? '' : 's'}` : `${available[l]} topic${available[l] === 1 ? '' : 's'}`]))
  return new Promise((resolve) =>
    useDialog.getState().set({
      title,
      kind: 'levels',
      confirmText: 'Download',
      ...opts,
      only,
      notes,
      levels: only,
      resolve: (v) => resolve(v === null ? null : (JSON.parse(v) as NoteLevel[]))
    })
  )
}

function LevelPicker({ value, onChange, multi, written, only, notes }: { value: NoteLevel[]; onChange: (v: NoteLevel[]) => void; multi: boolean; written: NoteLevel[]; only?: NoteLevel[]; notes?: Partial<Record<NoteLevel, string>> }) {
  return (
    <div className="flex flex-col gap-2" role={multi ? 'group' : 'radiogroup'} aria-label="Level of detail">
      {(only ?? NOTE_LEVELS).map((l) => {
        const on = value.includes(l)
        return (
          <button
            key={l}
            type="button"
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={on}
            onClick={() => onChange(multi ? (on ? value.filter((x) => x !== l) : NOTE_LEVELS.filter((x) => x === l || value.includes(x))) : [l])}
            className={cx(
              'flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
              on ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-[color-mix(in_oklab,var(--ink)_22%,transparent)]'
            )}
          >
            <span className={cx('mt-0.5 grid size-5 shrink-0 place-items-center border', multi ? 'rounded-md' : 'rounded-full', on ? 'border-accent bg-accent text-accent-ink' : 'border-line')}>
              {on && <Check className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-semibold">{NOTE_LEVEL_INFO[l].label}</span>
              {l === 'standard' && <span className="ml-1.5 text-[0.8rem] text-muted">default</span>}
              {written.includes(l) && <span className="ml-1.5 text-[0.8rem] text-muted">· already written, this replaces it</span>}
              {notes?.[l] && <span className="ml-1.5 text-[0.8rem] text-muted">· {notes[l]}</span>}
              <span className="block text-[0.86rem] text-muted">{NOTE_LEVEL_INFO[l].about}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function DialogHost() {
  const ask = useDialog((s) => s.ask)
  const set = useDialog((s) => s.set)
  const [value, setValue] = useState('')
  const [levels, setLevels] = useState<NoteLevel[]>([])
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ask) {
      setValue(ask.initial ?? ask.options?.[0]?.value ?? '')
      setLevels(ask.levels ?? ['standard'])
      setTimeout(() => ref.current?.select(), 30)
    }
  }, [ask])
  if (!ask) return null
  const close = (v: string | null) => {
    set(null)
    ask.resolve(v)
  }
  const ok = () => {
    if (ask.kind === 'text' && !value.trim()) return
    if (ask.kind === 'write') {
      if (!levels.length) return
      if (ask.multi) localStorage.setItem(LEVELS_KEY, JSON.stringify(levels))
      return close(JSON.stringify({ levels, instructions: value.trim() }))
    }
    if (ask.kind === 'levels') return levels.length ? close(JSON.stringify(levels)) : undefined
    close(ask.kind === 'confirm' ? 'ok' : value.trim())
  }
  const many = ask.kind === 'write' && levels.length > 1
  return (
    <Modal
      open
      onClose={() => close(null)}
      title={ask.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            {ask.cancelText ?? 'Cancel'}
          </Button>
          {ask.altText && <Button onClick={() => close('alt')}>{ask.altText}</Button>}
          <Button variant={ask.danger ? 'danger' : 'primary'} onClick={ok} disabled={(ask.kind === 'write' || ask.kind === 'levels') && !levels.length}>
            {ask.confirmText ?? 'OK'}
            {many ? ` · ${levels.length} levels` : ''}
            {ask.kind === 'levels' && ask.only && (levels.length === ask.only.length ? ' all depths' : ` · ${levels.length} of ${ask.only.length} depths`)}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          ok()
        }}
        className="flex flex-col gap-3"
      >
        {ask.message && <p className="text-muted">{ask.message}</p>}
        {ask.kind === 'text' && <Input ref={ref} autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={ask.label} />}
        {ask.kind === 'choose' && (
          <Select autoFocus value={value} onChange={(e) => setValue(e.target.value)}>
            {ask.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
        {ask.kind === 'write' && (
          <>
            <div className="text-[0.84rem] font-medium text-ink/80">{ask.multi ? 'Level of detail (pick one or more)' : 'Level of detail'}</div>
            <LevelPicker value={levels} onChange={setLevels} multi={!!ask.multi} written={ask.written ?? []} />
            {many && <p className="text-[0.84rem] text-muted">Each level is written separately (one AI call each) and all of them are kept. Pick which one to study on the week page.</p>}
          </>
        )}
        {ask.kind === 'levels' && ask.only && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.84rem] font-medium text-ink/80">Depths to download</span>
              <button
                type="button"
                className="text-[0.84rem] font-medium text-accent hover:underline"
                onClick={() => setLevels(levels.length === ask.only!.length ? [ask.only![0]] : ask.only!)}
              >
                {levels.length === ask.only.length ? 'Just one' : 'All depths'}
              </button>
            </div>
            <LevelPicker value={levels} onChange={setLevels} multi written={[]} only={ask.only} notes={ask.notes} />
            <p className="text-[0.84rem] text-muted">A topic that isn’t written at any depth you pick comes in at the depth it has. You can switch depths, or write another, on the week page later.</p>
          </>
        )}
        {(ask.kind === 'plan' || ask.kind === 'write') && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.84rem] font-medium text-ink/80">Your instructions (optional)</span>
            <Textarea
              rows={3}
              autoFocus={ask.kind === 'plan'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  ok()
                }
              }}
              placeholder={ask.placeholder ?? (ask.kind === 'plan' ? 'e.g. Skip the guest lecture. Give the recursion examples their own topic.' : 'e.g. More code examples. Go really slowly on pointers.')}
            />
            <span className="text-[0.8rem] text-muted">These take priority over the usual {ask.kind === 'plan' ? 'planning' : 'writing'} rules.</span>
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
