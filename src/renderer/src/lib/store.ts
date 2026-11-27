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
  /**
   * With courseId, reviews the due cards from every week of that course (deckId is unused).
   * With deckIds, the due cards from the weeks and decks picked on Home (Choose weeks), priority weeks first.
   */
  | { name: 'flashcards'; deckId: string; mode: 'due' | 'all'; courseId?: string; deckIds?: string[] }
  | { name: 'learn'; deckId: string; cardIds?: string[] }
  | { name: 'notes'; id?: string | null }
  | { name: 'settings'; tab?: string }
  | { name: 'jobs' }
  | { name: 'courses' }
  /** Every course's weeks: learnt, revised, how confident you are, and which are a priority. */
  | { name: 'tracker' }
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

export const useStore = create<State>((set, get) => ({
  route: { name: 'home' },
  back: [],
  forward: [],
  go: (r) => {
    // Jobs lives in Settings now.
    if (r.name === 'jobs') r = { name: 'settings', tab: 'jobs' }
    const cur = get().route
    if (JSON.stringify(cur) === JSON.stringify(r)) return
    set({ route: r, back: [...get().back.slice(-50), cur], forward: [] })
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
