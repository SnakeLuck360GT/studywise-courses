// Two spaced-repetition models share one state shape.
//
// "adaptive" is modelled on observed scheduling data from a real 1,187-card
// physics set (the server-side formula isn't public; this reproduces the
// pattern in the numbers):
//   - every card starts at difficulty 0.60; the first reviews are fixed 1-day
//     steps and difficulty doesn't move during them
//   - after that the stored interval grows fast (≈3, 8, 20, 115, 280, 340,
//     600 days at reviews 4–10), shrunk for harder cards
//   - successful reviews nudge difficulty down; most settled cards end up
//     around 0.41–0.46
//   - the card comes back well before the interval runs out:
//       days until due ≈ interval × (0.694 − 0.187 × difficulty)
//     (~63% at d=0.3, 60% at 0.5, 55% at 0.8), in whole days
//   - learned after two Good-or-better ratings; forgetting puts the card into
//     relearning with a much shorter interval
//
// "sm2" is the classic SuperMemo-2 algorithm (see sm2.ts).
//
// "studysmarter" (the default) works the way StudySmarter's flashcards do,
// with three colours: red (didn't know), yellow (sort of), green (knew it).
//   - learning: a card is learnt after two greens (the first makes it light
//     green). Yellow and red send it round again (see cardPile.ts) without
//     undoing a green. Until it's learnt it stays due.
//   - review: a learnt card comes back after 1 day, then 3, 7, 14, 30, 60, 120,
//     240 days, doubling after that. One green on review counts as reviewed
//     and moves it up a step.
//   - a yellow or red on review starts it again: it has to be learnt again
//     (two greens) and its next review is back to 1 day.

import { review as sm2Review, type Sm2State } from './sm2'

export type SchedulerKind = 'studysmarter' | 'adaptive' | 'sm2'
export const DEFAULT_SCHEDULER: SchedulerKind = 'studysmarter'

/** sr_state: -1 relearning, 0 unlearned, 1 learned, 2 mastered */
export type SrState = -1 | 0 | 1 | 2

export interface SchedState extends Sm2State {
  difficulty: number
  sr_state: SrState
  /** Good-or-better ratings so far (a card is learned after two). */
  good_count: number
}

export const START_DIFFICULTY = 0.6
const EARLY_STEPS = 3
/** Median stored interval (days) after the nth successful review, n ≥ 4. */
const GROWTH: Record<number, number> = { 4: 3, 5: 8, 6: 20, 7: 115, 8: 280, 9: 340, 10: 600 }
const MASTERED_DAYS = 115
const DAY = 86_400_000

export function newState(now = new Date()): SchedState {
  return { ease: 2.5, interval: 0, repetitions: 0, lapses: 0, due: now.toISOString(), last_reviewed: null, difficulty: START_DIFFICULTY, sr_state: 0, good_count: 0 }
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/** Share of the stored interval after which the card is due. */
export function dueFraction(difficulty: number): number {
  return 0.694 - 0.187 * difficulty
}

/** Harder cards get shorter intervals; ~1.0 at the typical settled difficulty (≈0.44). */
function difficultyScale(d: number): number {
  return clamp(1 + (0.44 - d) * 1.6, 0.45, 1.5)
}

function baseInterval(rep: number): number {
  if (rep <= EARLY_STEPS) return 1
  if (GROWTH[rep]) return GROWTH[rep]
  return Math.round(GROWTH[10] * Math.pow(1.6, rep - 10))
}

/** Whole days from now, at least 1. */
function dueAfter(now: Date, days: number): string {
  const d = new Date(now.getTime() + Math.max(1, Math.round(days)) * DAY)
  return d.toISOString()
}

export function adaptiveReview(s: SchedState, rating: 1 | 2 | 3 | 4, now = new Date()): SchedState {
  let { difficulty, repetitions, lapses, interval } = s
  let sr: SrState = s.sr_state
  const early = repetitions < EARLY_STEPS

  if (rating === 1) {
    // Forgotten: back to relearning, much shorter interval, harder card.
    difficulty = clamp(difficulty + 0.1, 0, 1)
    lapses += 1
    interval = Math.max(1, Math.round(interval * 0.2))
    repetitions = Math.max(0, Math.min(repetitions, EARLY_STEPS) - 1)
    sr = -1
    return { ...s, difficulty: round3(difficulty), repetitions, lapses, interval, sr_state: sr, good_count: 0, due: dueAfter(now, 1), last_reviewed: now.toISOString() }
  }

  repetitions += 1
  if (!early) {
    if (rating === 2) difficulty += 0.02
    if (rating === 3) difficulty -= 0.03
    if (rating === 4) difficulty -= 0.05
    difficulty = clamp(difficulty, 0.05, 1)
  }

  let next = baseInterval(repetitions) * (repetitions > EARLY_STEPS ? difficultyScale(difficulty) : 1)
  if (rating === 2) next = Math.max(1, next * 0.6)
  if (rating === 4) next = repetitions <= EARLY_STEPS ? Math.max(next, 2) : next * 1.3
  // Never shrink on a success.
  if (repetitions > EARLY_STEPS) next = Math.max(next, interval + 1)
  interval = Math.max(1, Math.round(next))

  const good_count = (s.good_count ?? 0) + (rating >= 3 ? 1 : 0)
  if (sr === 0 && good_count >= 2) sr = 1
  else if (sr === -1 && rating >= 3) sr = 1
  if (interval >= MASTERED_DAYS) sr = 2

  const days = repetitions <= EARLY_STEPS ? interval : interval * dueFraction(difficulty)
  return {
    ...s,
    difficulty: round3(difficulty),
    repetitions,
    lapses,
    interval,
    sr_state: sr,
    good_count,
    due: dueAfter(now, days),
    last_reviewed: now.toISOString()
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/** Days between reviews of a learnt card, one step per green on review; doubling after the last. */
export const REVIEW_DAYS = [1, 3, 7, 14, 30, 60, 120, 240]

/** The next gap after one of `days` (0 for a card that was only just learnt). */
export function nextReviewDays(days: number): number {
  const step = REVIEW_DAYS.find((d) => d > days)
  return step ?? Math.max(REVIEW_DAYS[REVIEW_DAYS.length - 1], days) * 2
}

/** A learnt card (green twice while learning, and not forgotten since). */
export const isLearnt = (s: { sr_state?: number } | null | undefined): boolean => (s?.sr_state ?? 0) >= 1

/**
 * StudySmarter-style colours. 3 or 4 is green, 2 yellow, 1 red. While learning,
 * the card stays due (it's still in the pile); once learnt it's due after the
 * review gap.
 */
export function trafficReview(s: SchedState, rating: 1 | 2 | 3 | 4, now = new Date()): SchedState {
  const green = rating >= 3
  const at = now.toISOString()
  if (isLearnt(s)) {
    if (green) {
      const interval = nextReviewDays(s.interval)
      return { ...s, interval, repetitions: s.repetitions + 1, sr_state: interval >= MASTERED_DAYS ? 2 : 1, due: dueAfter(now, interval), last_reviewed: at }
    }
    // Forgotten on review: learn it again, and the review gaps start over.
    return { ...s, interval: 0, repetitions: 0, lapses: s.lapses + 1, sr_state: -1, good_count: 0, difficulty: round3(clamp(s.difficulty + (rating === 1 ? 0.1 : 0.05), 0, 1)), due: at, last_reviewed: at }
  }
  if (!green) return { ...s, due: at, last_reviewed: at }
  const good_count = (s.good_count ?? 0) + 1
  if (good_count < 2) return { ...s, good_count, due: at, last_reviewed: at }
  // Learnt (green twice): the first review is a day later.
  const interval = nextReviewDays(0)
  return { ...s, good_count, interval, repetitions: 0, sr_state: 1, due: dueAfter(now, interval), last_reviewed: at }
}

export function schedule(kind: SchedulerKind, s: SchedState, rating: 1 | 2 | 3 | 4, now = new Date()): SchedState {
  if (kind === 'studysmarter') return trafficReview(s, rating, now)
  if (kind === 'sm2') {
    const r = sm2Review(s, rating, now)
    const good_count = (s.good_count ?? 0) + (rating >= 3 ? 1 : 0)
    const sr: SrState = rating === 1 ? -1 : r.interval >= 21 ? 2 : good_count >= 2 ? 1 : 0
    return { ...s, ...r, sr_state: sr, good_count }
  }
  return adaptiveReview(s, rating, now)
}

/** Fill in fields older rows don't have. */
export function withDefaults(s: Sm2State & { difficulty?: number; sr_state?: number; good_count?: number }): SchedState {
  return { ...s, difficulty: s.difficulty ?? START_DIFFICULTY, sr_state: (s.sr_state ?? 0) as SrState, good_count: s.good_count ?? 0 }
}
