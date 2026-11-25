import { Check } from 'lucide-react'
import { COURSE_FOCUSES, COURSE_FOCUS_INFO, type CourseFocus } from '@shared/course'
import { cx } from './ui'

/**
 * Tick what kind of course it is: theory heavy, practical/coding heavy,
 * formula & method heavy (any mix, or none). Every AI call for the course
 * tailors its notes, examples, questions and cards to what's ticked.
 */
export function CourseFocusPicker({ value, onChange }: { value: CourseFocus[]; onChange: (v: CourseFocus[]) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[0.84rem] font-medium text-ink/80">What kind of course is it? (optional, pick any)</span>
      <div className="flex flex-col gap-2" role="group" aria-label="What kind of course">
        {COURSE_FOCUSES.map((f) => {
          const on = value.includes(f)
          return (
            <button
              key={f}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onChange(on ? value.filter((x) => x !== f) : COURSE_FOCUSES.filter((x) => x === f || value.includes(x)))}
              className={cx(
                'flex items-start gap-3 rounded-xl border px-4 py-2.5 text-left transition-colors',
                on ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-[color-mix(in_oklab,var(--ink)_22%,transparent)]'
              )}
            >
              <span className={cx('mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border', on ? 'border-accent bg-accent text-accent-ink' : 'border-line')}>{on && <Check className="size-3.5" />}</span>
              <span className="min-w-0 flex-1">
                <span className="font-semibold">{COURSE_FOCUS_INFO[f].label}</span>
                <span className="block text-[0.86rem] text-muted">{COURSE_FOCUS_INFO[f].about}</span>
              </span>
            </button>
          )
        })}
      </div>
      <span className="text-[0.8rem] text-muted">Planning, writing topics, tests and flashcards are all tailored to what you tick. You can change it later from the course page.</span>
    </div>
  )
}

export const focusText = (focus: CourseFocus[]) => focus.map((f) => COURSE_FOCUS_INFO[f].label).join(' · ')
