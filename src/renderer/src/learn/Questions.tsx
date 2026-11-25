import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import { Check, X as XIcon, GripVertical } from 'lucide-react'
import type { LearnQuestion, LearnAnswer, Mark, PayloadOf } from '@shared/questions'
import type { BlankSegment } from '@shared/blanks'
import { Markdown } from '../components/Markdown'
import { Button, Kbd, Textarea, cx } from '../components/ui'

export interface QProps<T extends LearnQuestion['type']> {
  q: Extract<LearnQuestion, { type: T }>
  mark: Mark | null
  answer: LearnAnswer | null
  onAnswer: (a: LearnAnswer) => void
  disabled: boolean
}

function useKeys(handler: (e: KeyboardEvent) => void, active: boolean) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!active) return
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || document.querySelector('[data-modal]')) return
      ref.current(e)
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [active])
}

/** Enter in Learn goes through the learn.submit command, which fires this event
 * when the question isn't answered yet. */
export const SUBMIT_EVENT = 'sw:learn-submit'
function useSubmitSignal(fn: () => void, active: boolean) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const h = () => ref.current()
    window.addEventListener(SUBMIT_EVENT, h)
    return () => window.removeEventListener(SUBMIT_EVENT, h)
  }, [active])
}

function shuffled<T>(arr: T[], seed: string): T[] {
  // Stable shuffle per question so re-renders don't reorder.
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0
  const a = arr.map((x, i) => ({ x, i, k: Math.sin(h + i * 997) }))
  return a.sort((p, q) => p.k - q.k).map((p) => p.x)
}

// ---------------------------------------------------------------------------

export function ReadUnderstand({ q, onAnswer, disabled }: QProps<'read_understand'>) {
  return (
    <div className="flex flex-col gap-5">
      {q.payload.title && <h2 className="text-[clamp(1.3rem,2.6vw,1.8rem)] leading-tight font-semibold tracking-tight">{q.payload.title}</h2>}
      <Markdown className="text-[1.08rem] leading-relaxed">{q.payload.explanation}</Markdown>
      {!disabled && (
        <Button variant="primary" size="lg" className="self-start" onClick={() => onAnswer({ type: 'read_understand' })}>
          Got it <Kbd className="ml-1 border-current/30">↩</Kbd>
        </Button>
      )}
    </div>
  )
}

export function MultipleChoice({ q, mark, answer, onAnswer, disabled }: QProps<'multiple_choice'>) {
  const picked = answer?.type === 'multiple_choice' ? answer.index : null
  useKeys((e) => {
    const k = e.key.toLowerCase()
    const idx = ['1', '2', '3', '4'].indexOf(k) !== -1 ? Number(k) - 1 : ['a', 'b', 'c', 'd'].indexOf(k)
    if (idx >= 0 && idx < q.payload.options.length) {
      e.preventDefault()
      onAnswer({ type: 'multiple_choice', index: idx })
    }
  }, !disabled)
  return (
    <div className="flex flex-col gap-5">
      <Markdown className="text-[clamp(1.2rem,2.4vw,1.6rem)] leading-snug font-semibold">{q.payload.question}</Markdown>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {q.payload.options.map((o, i) => {
          const isCorrect = mark && i === q.payload.correct_index
          const isWrongPick = mark && picked === i && i !== q.payload.correct_index
          return (
            <button
              key={i}
              disabled={disabled}
              onClick={() => onAnswer({ type: 'multiple_choice', index: i })}
              className={cx(
                'group flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-[transform,border-color,background] duration-300 ease-out-soft',
                !mark && 'border-line bg-surface hover:border-accent active:scale-[0.98]',
                isCorrect && 'celebrate border-good bg-good-soft',
                isWrongPick && 'shake border-bad bg-bad-soft',
                mark && !isCorrect && !isWrongPick && 'border-line bg-surface opacity-55'
              )}
            >
              <span className={cx('grid size-7 shrink-0 place-items-center rounded-full text-[0.85rem] font-semibold', isCorrect ? 'bg-good text-white' : isWrongPick ? 'bg-bad text-white' : 'bg-surface-2')}>
                {isCorrect ? <Check className="size-4" /> : isWrongPick ? <XIcon className="size-4" /> : String.fromCharCode(65 + i)}
              </span>
              <Markdown className="min-w-0 flex-1 pt-0.5">{o}</Markdown>
            </button>
          )
        })}
      </div>
      {!disabled && <div className="desktop-only text-[0.82rem] text-muted">Press <Kbd>1</Kbd>–<Kbd>4</Kbd> or <Kbd>A</Kbd>–<Kbd>D</Kbd></div>}
    </div>
  )
}

export function TrueFalse({ q, mark, answer, onAnswer, disabled }: QProps<'true_false'>) {
  const picked = answer?.type === 'true_false' ? answer.value : null
  return (
    <div className="flex flex-col gap-5">
      <div className="text-[0.8rem] font-semibold text-muted">True or false?</div>
      <Markdown className="text-[clamp(1.2rem,2.4vw,1.6rem)] leading-snug font-semibold">{q.payload.statement}</Markdown>
      <div className="grid grid-cols-2 gap-3">
        {[true, false].map((v) => {
          const right = mark && v === q.payload.is_true
          const wrongPick = mark && picked === v && v !== q.payload.is_true
          return (
            <button
              key={String(v)}
              disabled={disabled}
              onClick={() => onAnswer({ type: 'true_false', value: v })}
              className={cx(
                'rounded-xl border-2 py-6 text-xl font-semibold transition-[transform,border-color,background] duration-300 ease-out-soft',
                !mark && 'border-line bg-surface hover:border-accent active:scale-[0.97]',
                right && 'celebrate border-good bg-good-soft text-good',
                wrongPick && 'shake border-bad bg-bad-soft text-bad',
                mark && !right && !wrongPick && 'border-line opacity-50'
              )}
            >
              {v ? 'True' : 'False'} {!disabled && <Kbd className="ml-1 align-middle">{v ? 'T' : 'F'}</Kbd>}
            </button>
          )
        })}
      </div>
      {mark && !q.payload.is_true && q.payload.correction && (
        <div className="pop-in rounded-lg bg-surface-2 p-4">
          <span className="font-semibold">Actually: </span>
          <Markdown className="inline">{q.payload.correction}</Markdown>
        </div>
      )}
    </div>
  )
}

export function FreeAnswer({ q, mark, answer, onAnswer, disabled }: QProps<'free_answer'>) {
  const [text, setText] = useState(answer?.type === 'free_answer' ? answer.text : '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!disabled) setTimeout(() => ref.current?.focus(), 80)
  }, [q.id, disabled])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Markdown className="min-w-0 flex-1 text-[clamp(1.2rem,2.4vw,1.6rem)] leading-snug font-semibold">{q.payload.question}</Markdown>
        {q.payload.marks && (
          <span className="mt-1 shrink-0 rounded-md bg-surface-2 px-2 py-0.5 text-[0.85rem] font-semibold text-muted tabular" title="One mark for each key point">
            {q.payload.marks} mark{q.payload.marks === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <Textarea
        ref={ref}
        rows={4}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (text.trim()) onAnswer({ type: 'free_answer', text })
          }
        }}
        placeholder={keyLabel("Type your answer…  (↩ to submit, ⇧↩ for a new line)")}
        className="text-[1.05rem]"
      />
      {!disabled && (
        <Button variant="primary" size="lg" className="self-start" disabled={!text.trim()} onClick={() => onAnswer({ type: 'free_answer', text })}>
          Check answer
        </Button>
      )}
      {mark && (
        <div className="pop-in grid gap-3 sm:grid-cols-[auto_1fr]">
          <div className={cx('grid size-20 place-items-center rounded-xl text-center', mark.verdict === 'correct' ? 'bg-good-soft text-good' : mark.verdict === 'partial' ? 'bg-warn-soft text-warn' : 'bg-bad-soft text-bad')}>
            <div>
              <div className="text-3xl leading-none font-semibold">{mark.detail?.marks ? mark.detail.marks.got : Math.round(mark.score)}</div>
              <div className="text-[0.75rem] font-semibold">{mark.detail?.marks ? `/ ${mark.detail.marks.total} mark${mark.detail.marks.total === 1 ? '' : 's'}` : '/ 10'}</div>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {mark.detail?.short_feedback && <p className="font-medium">{mark.detail.short_feedback}</p>}
            <div className="flex flex-wrap gap-1.5">
              {mark.detail?.points_found?.map((p, i) => (
                <span key={`f${i}`} className="inline-flex items-center gap-1 rounded-full bg-good-soft px-2.5 py-0.5 text-[0.82rem] font-semibold text-good">
                  <Check className="size-3" /> {p}
                </span>
              ))}
              {mark.detail?.points_missing?.map((p, i) => (
                <span key={`m${i}`} className="inline-flex items-center gap-1 rounded-full bg-bad-soft px-2.5 py-0.5 text-[0.82rem] font-semibold text-bad">
                  <XIcon className="size-3" /> {p}
                </span>
              ))}
            </div>
          </div>
          <div className="rounded-lg bg-surface-2 p-4 sm:col-span-2">
            <div className="mb-1 text-[0.75rem] font-semibold text-muted">Expected answer</div>
            <Markdown>{q.payload.expected_answer}</Markdown>
          </div>
        </div>
      )}
    </div>
  )
}

interface Pt {
  x: number
  y: number
}

/** A curve from one side to the other, leaving and arriving level. */
const curve = (a: Pt, b: Pt): string => {
  const dx = Math.max(16, (b.x - a.x) / 2)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

/**
 * Match up: tap a term, then its meaning, and a line joins them (tap a joined
 * meaning to undo it). Once marked, right lines go green and wrong ones red and
 * dashed, with the right answer under each wrong term.
 */
export function MatchPairs({ q, mark, answer, onAnswer, disabled }: QProps<'match_pairs'>) {
  const rights = useMemo(() => shuffled(q.payload.pairs.map((p, i) => ({ text: p.right, i })), q.id), [q])
  const [mapping, setMapping] = useState<Record<number, number>>(answer?.type === 'match_pairs' ? answer.mapping : {})
  const [left, setLeft] = useState<number | null>(null)
  const wrong = new Set(mark?.detail?.wrongItems ?? [])
  const box = useRef<HTMLDivElement>(null)
  const leftEls = useRef<(HTMLButtonElement | null)[]>([])
  const rightEls = useRef<Record<number, HTMLButtonElement | null>>({})
  // Where each term's and meaning's connector sits, inside the box.
  const [pts, setPts] = useState<{ l: (Pt | null)[]; r: Record<number, Pt> }>({ l: [], r: {} })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => {
      const b = el.getBoundingClientRect()
      const at = (r: DOMRect | undefined, side: 'left' | 'right'): Pt | null => (r ? { x: r[side] - b.left, y: r.top + r.height / 2 - b.top } : null)
      const l = q.payload.pairs.map((_, i) => at(leftEls.current[i]?.getBoundingClientRect(), 'right'))
      const r: Record<number, Pt> = {}
      for (const { i } of rights) {
        const p = at(rightEls.current[i]?.getBoundingClientRect(), 'left')
        if (p) r[i] = p
      }
      setPts({ l, r })
    }
    measure()
    // Text wraps differently as the window changes, and marking adds the right answers under wrong terms.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const b of [...leftEls.current, ...Object.values(rightEls.current)]) if (b) ro.observe(b)
    return () => ro.disconnect()
  }, [q, rights, mark])

  const pickRight = (r: number) => {
    if (left === null) {
      // Clicking a matched right unpairs it.
      const l = Object.entries(mapping).find(([, v]) => v === r)?.[0]
      if (l !== undefined) {
        const m = { ...mapping }
        delete m[Number(l)]
        setMapping(m)
      }
      return
    }
    const m = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== r)) as Record<number, number>
    m[left] = r
    setMapping(m)
    setLeft(null)
  }
  const complete = Object.keys(mapping).length === q.payload.pairs.length
  useSubmitSignal(() => complete && onAnswer({ type: 'match_pairs', mapping }), !disabled)
  const joined = new Set(Object.values(mapping))
  const lineColour = (l: number) => (!mark ? 'var(--accent)' : wrong.has(l) ? 'var(--bad)' : 'var(--good)')
  return (
    <div className="flex flex-col gap-5">
      <div className="text-[0.8rem] font-semibold text-muted">Tap a term, then its meaning, to join them</div>
      <div ref={box} className="relative flex items-start gap-12 sm:gap-28">
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
          {Object.entries(mapping).map(([l, r]) => {
            const a = pts.l[Number(l)]
            const b = pts.r[r]
            if (!a || !b) return null
            const bad = mark && wrong.has(Number(l))
            return (
              <path
                key={`${l}-${r}-${mark ? 'm' : ''}`}
                d={curve(a, b)}
                pathLength={mark ? undefined : 1}
                className={mark ? undefined : 'line-draw'}
                fill="none"
                stroke={lineColour(Number(l))}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray={bad ? '6 6' : undefined}
              />
            )
          })}
          {/* A dot on each side: hollow until it's joined. */}
          {pts.l.map((p, i) =>
            p ? <circle key={`l${i}`} cx={p.x} cy={p.y} r={5} strokeWidth={2} stroke={mapping[i] !== undefined ? lineColour(i) : left === i ? 'var(--accent)' : 'var(--muted)'} fill={mapping[i] !== undefined || left === i ? (mapping[i] !== undefined ? lineColour(i) : 'var(--accent)') : 'var(--surface)'} /> : null
          )}
          {Object.entries(pts.r).map(([r, p]) => {
            const owner = Object.entries(mapping).find(([, v]) => v === Number(r))?.[0]
            const c = owner !== undefined ? lineColour(Number(owner)) : 'var(--muted)'
            return <circle key={`r${r}`} cx={p.x} cy={p.y} r={5} strokeWidth={2} stroke={c} fill={owner !== undefined ? c : 'var(--surface)'} />
          })}
        </svg>
        <div className="flex min-w-0 flex-1 flex-col gap-4" data-match="terms">
          {q.payload.pairs.map((p, i) => (
            <button
              key={i}
              ref={(el) => {
                leftEls.current[i] = el
              }}
              disabled={disabled}
              onClick={() => setLeft(left === i ? null : i)}
              className={cx(
                'min-h-14 rounded-xl border-2 bg-surface px-4 py-3 text-left text-[0.95rem] font-semibold transition-[border-color,background,box-shadow] duration-200',
                left === i ? 'border-accent bg-accent-soft shadow-[0_0_0_3px_var(--accent-soft)]' : 'border-line',
                !disabled && left !== i && 'hover:border-accent',
                mark && wrong.has(i) && 'border-bad'
              )}
            >
              <Markdown>{p.left}</Markdown>
              {mark && wrong.has(i) && <div className="mt-1 text-[0.82rem] font-medium text-good">→ {p.right}</div>}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4" data-match="meanings">
          {rights.map(({ text, i: r }) => (
            <button
              key={r}
              ref={(el) => {
                rightEls.current[r] = el
              }}
              disabled={disabled}
              onClick={() => pickRight(r)}
              className={cx(
                'min-h-14 rounded-xl border-2 border-line bg-surface px-4 py-3 text-left text-[0.92rem] transition-[border-color,background] duration-200',
                !disabled && (left !== null || joined.has(r)) && 'hover:border-accent'
              )}
            >
              <Markdown>{text}</Markdown>
            </button>
          ))}
        </div>
      </div>
      {!disabled && (
        <Button variant="primary" size="lg" className="self-start" disabled={!complete} onClick={() => onAnswer({ type: 'match_pairs', mapping })}>
          Check matches
        </Button>
      )}
    </div>
  )
}

export function Categorize({ q, mark, answer, onAnswer, disabled }: QProps<'categorize'>) {
  const [assign, setAssign] = useState<Record<number, string>>(answer?.type === 'categorize' ? answer.assignments : {})
  const [picked, setPicked] = useState<number | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const wrong = new Set(mark?.detail?.wrongItems ?? [])
  const unassigned = q.payload.items.map((_, i) => i).filter((i) => assign[i] === undefined)
  const put = (i: number, cat: string) => {
    setAssign((a) => ({ ...a, [i]: cat }))
    setPicked(null)
  }
  const complete = unassigned.length === 0
  useSubmitSignal(() => complete && onAnswer({ type: 'categorize', assignments: assign }), !disabled)
  useKeys((e) => {
    const n = Number(e.key)
    if (picked !== null && n >= 1 && n <= q.payload.categories.length) put(picked, q.payload.categories[n - 1])
  }, !disabled)

  const Chip = ({ i }: { i: number }) => (
    <div
      draggable={!disabled}
      onDragStart={(e) => e.dataTransfer.setData('text/item', String(i))}
      onClick={() => !disabled && setPicked(picked === i ? null : i)}
      className={cx(
        'flex cursor-grab items-center gap-1.5 rounded-full border-2 bg-surface px-3.5 py-2 text-[0.9rem] font-medium transition-[transform,border-color,background] duration-300 ease-out-soft active:cursor-grabbing',
        picked === i ? 'scale-105 border-accent bg-accent-soft' : 'border-line hover:border-accent',
        mark && (wrong.has(i) ? 'shake border-bad bg-bad-soft' : 'border-good bg-good-soft')
      )}
    >
      {!disabled && <GripVertical className="size-3.5 text-muted" />}
      <span>{q.payload.items[i].text}</span>
      {mark && wrong.has(i) && <span className="text-[0.78rem] font-semibold text-good">→ {q.payload.items[i].category}</span>}
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[0.8rem] font-semibold text-muted">Sort each item into its category</div>
      {!disabled && (
        <div className="flex min-h-14 flex-wrap gap-2 rounded-xl bg-surface-2 p-3">
          {unassigned.length === 0 ? <span className="px-2 py-2 text-muted">All sorted. Press ↩ to check.</span> : unassigned.map((i) => <Chip key={i} i={i} />)}
        </div>
      )}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))` }}>
        {q.payload.categories.map((cat, ci) => (
          <div
            key={cat}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(cat)
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const i = Number(e.dataTransfer.getData('text/item'))
              if (!Number.isNaN(i)) put(i, cat)
            }}
            onClick={() => picked !== null && put(picked, cat)}
            className={cx('flex min-h-40 flex-col gap-2 rounded-xl border-2 border-dashed p-3 transition-colors duration-300', over === cat || picked !== null ? 'border-accent bg-accent-soft/50' : 'border-line')}
          >
            <div className="flex items-center justify-between px-1 font-semibold">
              {cat} {!disabled && <Kbd className="text-muted">{ci + 1}</Kbd>}
            </div>
            <div className="flex flex-wrap gap-2">
              {q.payload.items.map((_, i) =>
                assign[i] === cat ? (
                  <div key={i} onDoubleClick={() => !disabled && setAssign((a) => Object.fromEntries(Object.entries(a).filter(([k]) => Number(k) !== i)))}>
                    <Chip i={i} />
                  </div>
                ) : null
              )}
            </div>
          </div>
        ))}
      </div>
      {!disabled && (
        <Button variant="primary" size="lg" className="self-start" disabled={!complete} onClick={() => onAnswer({ type: 'categorize', assignments: assign })}>
          Check
        </Button>
      )}
    </div>
  )
}

function BlankSentence({
  segments,
  render
}: {
  segments: BlankSegment[]
  render: (blankIndex: number) => React.ReactNode
}) {
  let b = 0
  return (
    <div className="text-[clamp(1.1rem,2.2vw,1.45rem)] leading-[2.2] font-medium">
      {segments.map((s, i) =>
        s.type === 'text' ? (
          <span key={i} className="whitespace-pre-wrap">
            {s.value.replace(/\*\*/g, '')}
          </span>
        ) : (
          <span key={i} className="mx-1 inline-block align-baseline">
            {render(b++)}
          </span>
        )
      )}
    </div>
  )
}

export function FillBlank({ q, mark, answer, onAnswer, disabled }: QProps<'fill_blank'>) {
  const n = q.payload.answers.length
  const [values, setValues] = useState<string[]>(answer?.type === 'fill_blank' ? answer.values : Array(n).fill(''))
  const refs = useRef<(HTMLInputElement | null)[]>([])
  useEffect(() => {
    if (!disabled) setTimeout(() => refs.current[0]?.focus(), 80)
  }, [q.id, disabled])
  const blanks = mark?.detail?.blanks
  return (
    <div className="flex flex-col gap-5">
      {q.payload.prompt && <Markdown className="text-muted">{q.payload.prompt}</Markdown>}
      <BlankSentence
        segments={q.payload.segments}
        render={(i) => (
          <span className="inline-flex flex-col">
            <input
              ref={(el) => void (refs.current[i] = el)}
              value={values[i] ?? ''}
              disabled={disabled}
              onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (i < n - 1 && !e.metaKey) refs.current[i + 1]?.focus()
                  else onAnswer({ type: 'fill_blank', values })
                }
              }}
              style={{ width: `${Math.max(6, (q.payload.answers[i]?.length ?? 6) + 2)}ch` }}
              className={cx(
                'rounded-xl border-b-[3px] bg-surface-2 px-2 py-0.5 text-center font-semibold outline-none transition-colors focus:border-accent',
                blanks ? (blanks[i] ? 'border-good bg-good-soft text-good' : 'shake border-bad bg-bad-soft text-bad') : 'border-line'
              )}
            />
            {blanks && !blanks[i] && <span className="text-center text-[0.8rem] leading-tight font-semibold text-good">{q.payload.answers[i]}</span>}
          </span>
        )}
      />
      {!disabled && (
        <Button variant="primary" size="lg" className="self-start" onClick={() => onAnswer({ type: 'fill_blank', values })}>
          Check <Kbd className="ml-1 border-current/30">↩</Kbd>
        </Button>
      )}
    </div>
  )
}

export function ChoiceBlank({ q, mark, answer, onAnswer, disabled }: QProps<'choice_blank'>) {
  const n = q.payload.answers.length
  const [values, setValues] = useState<string[]>(answer?.type === 'choice_blank' ? answer.values : Array(n).fill(''))
  const blanks = mark?.detail?.blanks
  const complete = values.every((v) => v)
  useSubmitSignal(() => complete && onAnswer({ type: 'choice_blank', values }), !disabled)
  return (
    <div className="flex flex-col gap-5">
      {q.payload.prompt && <Markdown className="text-muted">{q.payload.prompt}</Markdown>}
      <BlankSentence
        segments={q.payload.segments}
        render={(i) => (
          <span className="inline-flex flex-col">
            <select
              value={values[i] ?? ''}
              disabled={disabled}
              onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
              className={cx(
                'appearance-none rounded-xl border-b-[3px] bg-surface-2 px-3 py-0.5 text-center font-semibold outline-none transition-colors focus:border-accent',
                blanks ? (blanks[i] ? 'border-good bg-good-soft text-good' : 'shake border-bad bg-bad-soft text-bad') : values[i] ? 'border-accent' : 'border-line'
              )}
            >
              <option value="" disabled>
                choose…
              </option>
              {(q.payload as PayloadOf<'choice_blank'>).choices[i]?.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {blanks && !blanks[i] && <span className="text-center text-[0.8rem] leading-tight font-semibold text-good">{q.payload.answers[i]}</span>}
          </span>
        )}
      />
      {!disabled && (
        <Button variant="primary" size="lg" className="self-start" disabled={!complete} onClick={() => onAnswer({ type: 'choice_blank', values })}>
          Check
        </Button>
      )}
    </div>
  )
}

export function QuestionView(props: { q: LearnQuestion; mark: Mark | null; answer: LearnAnswer | null; onAnswer: (a: LearnAnswer) => void; disabled: boolean }) {
  const { q } = props
  switch (q.type) {
    case 'read_understand':
      return <ReadUnderstand {...(props as QProps<'read_understand'>)} />
    case 'multiple_choice':
      return <MultipleChoice {...(props as QProps<'multiple_choice'>)} />
    case 'true_false':
      return <TrueFalse {...(props as QProps<'true_false'>)} />
    case 'free_answer':
      return <FreeAnswer {...(props as QProps<'free_answer'>)} />
    case 'match_pairs':
      return <MatchPairs {...(props as QProps<'match_pairs'>)} />
    case 'categorize':
      return <Categorize {...(props as QProps<'categorize'>)} />
    case 'fill_blank':
      return <FillBlank {...(props as QProps<'fill_blank'>)} />
    case 'choice_blank':
      return <ChoiceBlank {...(props as QProps<'choice_blank'>)} />
  }
}
