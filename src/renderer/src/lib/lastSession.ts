import { useEffect } from 'react'
import type { Route } from './store'
import { api } from './api'

// The study session you're in (a topic, its test, Learn, a flashcard review),
// remembered so the home page can offer Continue after you quit the app, or
// leave, partway through. Cleared when the session is finished. Kept on each
// device (settings don't sync).

export const LAST_SESSION_SETTING = 'ui.lastSession'

export type StudyRoute = Extract<Route, { name: 'topic' | 'learn' | 'flashcards' }>

export interface LastSession {
  route: StudyRoute
  /** The topic's or deck's name when you were last in it. */
  title: string
  at: string
}

/**
 * Remembers this session while it's going and forgets it once it's done.
 * route is null until the page knows it's a real session (loaded, not an error).
 */
export function useStudySession(route: StudyRoute | null, title: string, done: boolean): void {
  const key = route ? JSON.stringify(route) : ''
  useEffect(() => {
    if (!route || !title) return
    void api.settings.set({ key: LAST_SESSION_SETTING, value: done ? null : ({ route, title, at: new Date().toISOString() } satisfies LastSession) })
  }, [key, title, done])
}

export const forgetSession = (): Promise<unknown> => api.settings.set({ key: LAST_SESSION_SETTING, value: null })
