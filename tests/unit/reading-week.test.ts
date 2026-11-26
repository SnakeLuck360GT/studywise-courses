import { describe, expect, it } from 'vitest'
import { asReadingWeek, isReadingWeek, missingReadingWeek, nextWeekLabel, notReadingWeek, sortWeeks, weekNumber } from '@shared/course'

const weeks = (...labels: string[]) => labels.map((label, position) => ({ label, position }))

describe('reading week', () => {
  it('is marked in the label and keeps its week number', () => {
    expect(asReadingWeek('Week 6')).toBe('Week 6 · Reading week')
    expect(asReadingWeek('Week 6 · Reading week')).toBe('Week 6 · Reading week')
    expect(isReadingWeek('Week 6 · Reading week')).toBe(true)
    expect(isReadingWeek('Reading Week')).toBe(true)
    expect(isReadingWeek('Week 6: Readings')).toBe(false)
    expect(weekNumber('Week 6 · Reading week')).toBe(6)
    expect(notReadingWeek('Week 6 · Reading week')).toBe('Week 6')
    expect(notReadingWeek('Week 6 (Reading week)')).toBe('Week 6')
    expect(notReadingWeek('Reading week')).toBe('Week 6')
  })

  it('sits in its place among the weeks', () => {
    const sorted = sortWeeks(weeks('Week 1', 'Week 7', 'Week 6 · Reading week', 'Week 5'))
    expect(sorted.map((w) => w.label)).toEqual(['Week 1', 'Week 5', 'Week 6 · Reading week', 'Week 7'])
  })

  it('is missing when there are weeks after 6 but no week 6', () => {
    expect(missingReadingWeek(weeks('Week 5', 'Week 7'))).toBe(true)
    expect(missingReadingWeek(weeks('Week 1', 'Week 5'))).toBe(false)
    expect(missingReadingWeek(weeks('Week 5', 'Week 6', 'Week 7'))).toBe(false)
    expect(missingReadingWeek(weeks('Week 5', 'Week 6 · Reading week', 'Week 7'))).toBe(false)
  })

  it('the next week follows the highest week number', () => {
    expect(nextWeekLabel(weeks('Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5'))).toBe('Week 6')
    expect(nextWeekLabel(weeks('Week 1', 'Week 5', 'Week 7'))).toBe('Week 8')
    expect(nextWeekLabel([])).toBe('Week 1')
  })
})
