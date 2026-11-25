import { create } from 'zustand'
import type { AiStatus, ClaudeStatus, JobInfo } from '@shared/types'
import type { ExplainOpen } from '../components/ExplainPanel'
import type { PreviewCardT } from '../components/GenerateCards'
import { OFFLINE_SETTING } from '@shared/offline'
import { api } from './api'

export type Route =
  | { name: 'home' }
  | { name: 'decks'; folderId?: string | null }
  | { name: 'deck'; id: string; cardId?: string }
  /** With courseId, reviews the due cards from every week of that course (deckId is unused). */
  | { name: 'flashcards'; deckId: string; mode: 'due' | 'all'; courseId?: string }
  | { name: 'learn'; deckId: string; cardIds?: string[] }
  | { name: 'notes'; id?: string | null }
  | { name: 'settings'; tab?: string }
  | { name: 'jobs' }
  | { name: 'courses' }
  | { name: 'course'; id: string }
  | { name: 'week'; courseId: string; weekId: string }
  /**
   * section opens the topic at that section's notes instead of where you left off.
   * test: take the topic's test (its check questions) instead of learning it.
   */
  | { name: 'topic'; id: string; section?: number; test?: boolean }
  /** A week's end-of-week test (multiple choice). */
  | { name: 'weektest'; courseId: string; weekId: string }
  /** The course marketplace; with courseId, one course's weeks. */
  | { name: 'market'; courseId?: string }

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'good' | 'bad'
  action?: { label: string; run: () => void }
  /** Set while it animates out. */
  leaving?: boolean
}

export interface GeneratorPrefill {
  text?: string
  files?: string[]
  noteIds?: string[]
  topic?: string
  deckId?: string | null
}

interface State {
  route: Route
  back: Route[]
  forward: Route[]
  go: (r: Route) => void
  goBack: () => void
  goForward: () => void
  /** The Courses tab: back to where you last were in it (a topic, week or course), or the list when you're already there. */
  goCourses: () => void

  claude: ClaudeStatus | null
  setClaude: (s: ClaudeStatus) => void
  /** Which AI provider is active, and Ollama's setup. */
  ai: AiStatus | null
  setAi: (s: AiStatus) => void

  jobs: JobInfo[]
  setJobs: (j: JobInfo[]) => void
  upsertJob: (j: JobInfo) => void

  toasts: Toast[]
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => number
  dismissToast: (id: number) => void

  explain: ExplainOpen | null
  openExplain: (e: ExplainOpen | null) => void

  genCards: GeneratorPrefill | null
  openGenCards: (p: GeneratorPrefill | null) => void
  genNotes: GeneratorPrefill | null
  openGenNotes: (p: GeneratorPrefill | null) => void
  preview: { cards: PreviewCardT[]; deckId: string | null; jobId?: string; presetName?: string } | null
  openPreview: (p: State['preview']) => void

  /** Files for the New course dialog; null when it's closed. */
  newCourse: string[] | null
  openNewCourse: (files: string[] | null) => void

  palette: boolean
  setPalette: (v: boolean) => void
  sheet: boolean
  setSheet: (v: boolean) => void
  rail: boolean
  toggleRail: () => void
  focus: boolean
  toggleFocus: () => void
  dropFiles: string[] | null
  setDropFiles: (f: string[] | null) => void
  /** Bumped when data changes elsewhere, so pages refetch. */
  version: number
  bump: () => void

  /** Offline mode: nothing uses AI, and studying only asks questions marked without it (per device). */
  offline: boolean
  setOffline: (on: boolean, opts?: { save?: boolean; quiet?: boolean }) => void
}

const OFFLINE_HINT = 'Offline mode is on, so AI features are off. Turn it off with Offline at the top.'

let toastSeq = 0

/** Pages that belong to the Courses tab. */
const COURSE_ROUTES: Route['name'][] = ['courses', 'course', 'week', 'topic', 'weektest']
const COURSES_PLACE_KEY = 'sw.coursesPlace'

/** Where you were in Courses, so the tab takes you back there (also after a restart). */
export function rememberCoursesPlace(r: Route): void {
  if (!COURSE_ROUTES.includes(r.name)) return
  // A topic is remembered without the section it was opened at, so coming back resumes your exact place.
  if (r.name === 'topic' && 'section' in r) {
    const { section: _s, ...rest } = r as Route & { section?: number }
    r = rest as Route
  }
  try {
    if (r.name === 'courses') localStorage.removeItem(COURSES_PLACE_KEY)
    else localStorage.setItem(COURSES_PLACE_KEY, JSON.stringify(r))
  } catch {
    /* storage unavailable: the tab just opens the list */
  }
}
function lastCoursesPlace(): Route | null {
  try {
    const r = JSON.parse(localStorage.getItem(COURSES_PLACE_KEY) ?? 'null') as Route | null
    return r && COURSE_ROUTES.includes(r.name) ? r : null
  } catch {
    return null
  }
}

export const useStore = create<State>((set, get) => ({
  route: { name: 'home' },
  back: [],
  forward: [],
  go: (r) => {
    // Jobs lives in Settings now.
    if (r.name === 'jobs') r = { name: 'settings', tab: 'jobs' }
    const cur = get().route
    if (JSON.stringify(cur) === JSON.stringify(r)) return
    rememberCoursesPlace(r)
    set({ route: r, back: [...get().back.slice(-50), cur], forward: [] })
  },
  goCourses: () => {
    const here = COURSE_ROUTES.includes(get().route.name)
    const last = lastCoursesPlace()
    get().go(!here && last ? last : { name: 'courses' })
  },
  goBack: () => {
    const b = get().back
    if (!b.length) return
    set({ route: b[b.length - 1], back: b.slice(0, -1), forward: [get().route, ...get().forward] })
  },
  goForward: () => {
    const f = get().forward
    if (!f.length) return
    set({ route: f[0], forward: f.slice(1), back: [...get().back, get().route] })
  },

  claude: null,
  setClaude: (s) => set({ claude: s }),
  ai: null,
  setAi: (s) => set({ ai: s }),

  jobs: [],
  setJobs: (jobs) => set({ jobs }),
  upsertJob: (j) => {
    const jobs = get().jobs.filter((x) => x.id !== j.id)
    set({ jobs: [j, ...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
  },

  toasts: [],
  toast: (text, kind = 'info', action) => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, text, kind, action }] })
    setTimeout(() => get().dismissToast(id), action ? 7000 : 4200)
    return id
  },
  dismissToast: (id) => {
    const t = get().toasts.find((x) => x.id === id)
    if (!t || t.leaving) return
    set({ toasts: get().toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) })
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== id) }), 200)
  },

  explain: null,
  // Explain and the generators are all AI, so offline they say so instead of opening.
  openExplain: (e) => (e && get().offline ? void get().toast(OFFLINE_HINT) : set({ explain: e })),

  genCards: null,
  openGenCards: (p) => (p && get().offline ? void get().toast(OFFLINE_HINT) : set({ genCards: p })),
  genNotes: null,
  openGenNotes: (p) => (p && get().offline ? void get().toast(OFFLINE_HINT) : set({ genNotes: p })),
  preview: null,
  openPreview: (p) => set({ preview: p }),

  newCourse: null,
  openNewCourse: (f) => set({ newCourse: f }),

  palette: false,
  setPalette: (v) => set({ palette: v }),
  sheet: false,
  setSheet: (v) => set({ sheet: v }),
  rail: true,
  toggleRail: () => set({ rail: !get().rail }),
  focus: false,
  toggleFocus: () => set({ focus: !get().focus }),
  dropFiles: null,
  setDropFiles: (f) => set({ dropFiles: f }),
  version: 0,
  bump: () => set({ version: get().version + 1 }),

  offline: false,
  setOffline: (on, opts = {}) => {
    set({ offline: on, ...(on ? { explain: null, genCards: null, genNotes: null } : {}) })
    if (opts.save !== false) void api.settings.set({ key: OFFLINE_SETTING, value: on })
    if (!opts.quiet) get().toast(on ? 'Offline mode on. Studying only asks questions that don’t need AI.' : 'Offline mode off. AI features are back.', 'good')
    get().bump()
  }
}))

export const toast = (text: string, kind?: Toast['kind'], action?: Toast['action']): number => useStore.getState().toast(text, kind, action)
