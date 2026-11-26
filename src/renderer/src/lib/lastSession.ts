import { useEffect } from 'react'
import type { Route } from './store'
import { api } from './api'

// The study session you're in (a topic, its test, Learn, a flashcard review),
// remembered so the home page can offer Continue after you quit the app, or
// leave, partway through. Cleared when the session is finished. Kept on each
// device (settings don't sync). The last course session (a topic, or a
// course's flashcards) is kept apart as well, for Continue on the Courses
// page, so studying a deck afterwards doesn't lose it.

export const LAST_SESSION_SETTING = 'ui.lastSession'
export const LAST_COURSE_SESSION_SETTING = 'ui.lastCourseSession'

export type StudyRoute = Extract<Route, { name: 'topic' | 'learn' | 'flashcards' }>

export interface LastSession {
  route: StudyRoute
  /** The topic's or deck's name when you were last in it. */
  title: string
  at: string
}

/** A session that belongs to a course: a topic (or its test), or a course's flashcards. */
export const isCourseSession = (r: StudyRoute) => r.name === 'topic' || (r.name === 'flashcards' && !!r.courseId)

/**
 * Remembers this session while it's going and forgets it once it's done.
 * route is null until the page knows it's a real session (loaded, not an error).
 */
export function useStudySession(route: StudyRoute | null, title: string, done: boolean): void {
  const key = route ? JSON.stringify(route) : ''
  useEffect(() => {
    if (!route || !title) return
    const value = done ? null : ({ route, title, at: new Date().toISOString() } satisfies LastSession)
    void api.settings.set({ key: LAST_SESSION_SETTING, value })
    if (isCourseSession(route)) void api.settings.set({ key: LAST_COURSE_SESSION_SETTING, value })
  }, [key, title, done])
}

/** Forget a session (finished, gone, or dismissed): wherever it's remembered. */
export async function forgetSession(route: StudyRoute): Promise<void> {
  const all = await api.settings.all().catch(() => ({}) as Record<string, unknown>)
  const same = (k: string) => JSON.stringify((all[k] as LastSession | null | undefined)?.route ?? null) === JSON.stringify(route)
  for (const k of [LAST_SESSION_SETTING, LAST_COURSE_SESSION_SETTING]) if (same(k)) await api.settings.set({ key: k, value: null })
}
