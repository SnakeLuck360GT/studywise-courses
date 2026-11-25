import { describe, it, expect } from 'vitest'
import { trafficReview, newState, nextReviewDays, isLearnt, schedule, DEFAULT_SCHEDULER, type SchedState } from '../../src/shared/scheduler'

const t0 = new Date('2026-01-01T10:00:00Z')
const daysAfter = (s: SchedState, from: Date) => Math.round((new Date(s.due).getTime() - from.getTime()) / 86_400_000)

describe('StudySmarter scheduler (red, yellow, green)', () => {
  it('is the default', () => {
    expect(DEFAULT_SCHEDULER).toBe('studysmarter')
  })

  it('learns a card with two greens (light green first), and keeps it due until then', () => {
    let s = trafficReview(newState(t0), 3, t0)
    expect(s.good_count).toBe(1)
    expect(isLearnt(s)).toBe(false)
    expect(daysAfter(s, t0)).toBe(0)
    s = trafficReview(s, 3, t0)
    expect(isLearnt(s)).toBe(true)
    expect(daysAfter(s, t0)).toBe(1)
  })

  it('yellow and red send it round again without undoing a green', () => {
    let s = trafficReview(newState(t0), 1, t0)
    expect(s.good_count).toBe(0)
    s = trafficReview(s, 3, t0)
    s = trafficReview(s, 2, t0)
    expect(s.good_count).toBe(1)
    expect(isLearnt(s)).toBe(false)
    s = trafficReview(s, 3, t0)
    expect(isLearnt(s)).toBe(true)
  })

  it('one green on review counts, and the gaps grow 1, 3, 7, 14, 30…', () => {
    let s = trafficReview(trafficReview(newState(t0), 3, t0), 3, t0)
    const gaps = [s.interval]
    for (let i = 0; i < 6; i++) {
      s = trafficReview(s, 3, t0)
      gaps.push(s.interval)
    }
    expect(gaps).toEqual([1, 3, 7, 14, 30, 60, 120])
    expect(nextReviewDays(240)).toBe(480)
    expect(s.sr_state).toBe(2)
  })

  it('a yellow or red on review means learning it again, back to 1 day', () => {
    let s = trafficReview(trafficReview(newState(t0), 3, t0), 3, t0)
    s = trafficReview(trafficReview(s, 3, t0), 3, t0) // 3, then 7 days
    expect(s.interval).toBe(7)
    s = trafficReview(s, 2, t0)
    expect(isLearnt(s)).toBe(false)
    expect(s.lapses).toBe(1)
    expect(daysAfter(s, t0)).toBe(0)
    s = trafficReview(s, 3, t0)
    expect(isLearnt(s)).toBe(false)
    s = trafficReview(s, 3, t0)
    expect(isLearnt(s)).toBe(true)
    expect(s.interval).toBe(1)
  })

  it('treats Easy as green, and picks up cards scheduled by the other schedulers', () => {
    expect(schedule('studysmarter', newState(t0), 4, t0).good_count).toBe(1)
    const old = { ...newState(t0), sr_state: 1 as const, interval: 20, repetitions: 6 }
    expect(trafficReview(old, 3, t0).interval).toBe(30)
  })
})
