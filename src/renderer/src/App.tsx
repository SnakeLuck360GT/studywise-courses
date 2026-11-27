import { useEffect, useState, lazy, Suspense } from 'react'
import { AlertTriangle, X, FileUp, NotebookPen, Layers, Terminal, GraduationCap, Download, Megaphone } from 'lucide-react'
import type { UpdateStatus } from '@shared/update'
import { planUsageText } from '@shared/types'
import { OFFLINE_SETTING } from '@shared/offline'
import { importSharedWeek, dropOnWeek } from './lib/weekShare'

/** Jobs already announced as done, and those whose plan usage was shown. */
const announced = new Set<string>()
const usageShown = new Set<string>()
/** Marketplace download jobs: how many weeks each had added when last seen. */
const marketAdded = new Map<string, number>()
import { useStore, toast, type Route } from './lib/store'
import { api, onEvent, errorText } from './lib/api'
import { startCommandDispatch, useCommands, runCommand } from './lib/commands'
import { startArrowNav } from './lib/arrowNav'
import { historyNav, installMouseHistoryNav } from './lib/historyNav'
import { askText, confirmDialog, chooseDialog, DialogHost } from './lib/dialogs'
import { GooNav } from './components/GooNav'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutSheet } from './components/ShortcutSheet'
import { ExplainPanel } from './components/ExplainPanel'
import { GenerateCardsModal, CardPreviewModal, jobDeck, jobToast } from './components/GenerateCards'
import { GenerateNotesModal, followNoteJobs } from './components/GenerateNotes'
import { Button, Spinner, cx, useModalCount } from './components/ui'
import { Home } from './pages/Home'
import { useStudyTimer } from './lib/studyTime'
import { Onboarding } from './components/Onboarding'
import { Decks } from './pages/Decks'
import { DeckPage } from './pages/Deck'
import { Flashcards } from './pages/Flashcards'
import { Notes } from './pages/Notes'
import { Jobs } from './pages/Jobs'
import { Courses, NewCourseModal } from './pages/Courses'
import { Tracker } from './pages/Tracker'
import { Market } from './pages/Market'
import { MarketMatchesHost } from './components/MarketMatches'
import { JobDock } from './components/JobLive'
import { ReadyCard } from './components/ReadyCard'
import { CoursePage } from './pages/Course'
import { WeekPage } from './pages/Week'
import { IS_MOBILE } from './lib/platform'
import { offerCloudSync } from './components/PhoneSync'
import { MobileTopBar, MobileTabBar, MobileOnboarding, STUDY_ROUTES } from './components/MobileShell'

const Learn = lazy(() => import('./pages/Learn').then((m) => ({ default: m.Learn })))
const TopicPage = lazy(() => import('./pages/Topic').then((m) => ({ default: m.TopicPage })))
const WeekTestPage = lazy(() => import('./pages/WeekTest').then((m) => ({ default: m.WeekTestPage })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))

type Theme = 'system' | 'light' | 'dark'

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function App() {
  const route = useStore((s) => s.route)
  const go = useStore((s) => s.go)
  const focus = useStore((s) => s.focus)
  const [theme, setTheme] = useState<Theme>('system')
  const [zoom, setZoom] = useState(1)
  const [ready, setReady] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  // Counts time spent on study pages, for the home page.
  useStudyTimer()

  // Boot: settings, last route, claude status, jobs.
  useEffect(() => {
    startCommandDispatch()
    startArrowNav()
    void (async () => {
      const s = await api.settings.all()
      if (s[OFFLINE_SETTING] === true) useStore.getState().setOffline(true, { save: false, quiet: true })
      const t = (s['ui.theme'] as Theme) ?? 'system'
      setTheme(t)
      applyTheme(t)
      const z = Number(s['ui.zoom'] ?? 1)
      setZoom(z)
      // The app always opens on the home page; a study session you quit partway through shows Continue there.
      useStore.getState().setClaude(await api.claude.status())
      useStore.getState().setAi(await api.ai.status())
      useStore.getState().setJobs(await api.jobs.list())
      if (!s['onboarding.done']) setOnboarding(true)
      setReady(true)
      // Connected to a marketplace and cloud sync not decided yet: offer it once, after things settle.
      if (s['onboarding.done'] && !IS_MOBILE) setTimeout(() => void offerCloudSync(), 4000)
    })()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onMq = () => applyTheme((document.documentElement.dataset.theme as Theme) || 'system')
    mq.addEventListener('change', onMq)
    return () => mq.removeEventListener('change', onMq)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    applyTheme(theme)
  }, [theme])
  useEffect(() => {
    document.documentElement.style.setProperty('--zoom', String(zoom))
  }, [zoom])

  // Remember the last open deck / note.
  useEffect(() => {
    if (!ready) return
    if (route.name === 'course' || route.name === 'week') void api.settings.set({ key: 'ui.lastRoute', value: route })
    if (route.name === 'deck' || (route.name === 'notes' && route.id)) void api.settings.set({ key: 'ui.lastRoute', value: route.name === 'deck' ? { name: 'deck', id: route.id } : route })
  }, [route, ready])

  // The mouse's back and forward buttons.
  useEffect(() => installMouseHistoryNav(), [])

  // Events from the main process.
  useEffect(
    () =>
      onEvent((ev) => {
        const st = useStore.getState()
        if (ev.type === 'fullscreen') document.documentElement.classList.toggle('is-fullscreen', ev.on)
        if (ev.type === 'claude:status') st.setClaude(ev.status)
        // Another device synced changes into this library: show them.
        if (ev.type === 'sync' && ev.received) st.bump()
        if (ev.type === 'open-files') openFiles(ev.paths)
        if (ev.type === 'nav') historyNav(ev.dir, 'system')
        if (ev.type === 'job') {
          const j = ev.job
          st.upsertJob(j)
          if (j.status !== 'running' && jobToast.has(j.id)) {
            st.dismissToast(jobToast.get(j.id)!)
            jobToast.delete(j.id)
          }
          if (j.kind === 'generate_notes' && followNoteJobs.has(j.id) && typeof j.meta?.noteId === 'string') {
            followNoteJobs.delete(j.id)
            st.go({ name: 'notes', id: j.meta.noteId })
          }
          if (j.status === 'done' && j.kind === 'generate_cards' && jobDeck.has(j.id)) {
            const r = j.result as { cards: never[]; presetName: string }
            st.openPreview({ cards: r.cards, deckId: jobDeck.get(j.id) ?? null, jobId: j.id, presetName: r.presetName })
            jobDeck.delete(j.id)
          }
          // A finished job gets more updates (its usage is measured afterwards); announce it once.
          const first = j.status === 'done' && !announced.has(j.id)
          if (first) announced.add(j.id)
          if (first && j.kind === 'generate_notes') {
            st.bump()
            toast(`${j.title.replace(/^Notes: /, '')}: notes ready`, 'good')
          }
          if (j.kind === 'course_update') {
            if (j.status !== 'done' || first) st.bump()
            // The job's result says what was added (or that it was all covered already).
            const summary = (j.result as { summary?: string } | null)?.summary
            if (first) toast(`${j.title.replace(/^Add notes: /, '')}: ${summary || 'new notes added'}`, 'good')
          }
          if (j.kind === 'course_outline' || j.kind === 'course_topic') {
            if (j.status !== 'done' || first) st.bump()
            // Planning can also write the end-of-week test: say how that went too.
            const r = j.result as { test?: number; testError?: string } | null
            const test = r?.test ? `, and a ${r.test}-question end-of-week test` : ''
            if (first) toast(j.kind === 'course_outline' ? `${j.title.replace(/^Plan: /, '')}: topics planned${test}` : `${j.title.replace(/^Topic: /, '')} is ready`, 'good')
            if (first && r?.testError) toast(`The end-of-week test didn’t get written: ${r.testError} Try again from the week page.`, 'bad')
          }
          if (j.kind === 'course_week_test') {
            if (j.status !== 'done' || first) st.bump()
            const n = (j.result as { questions?: number } | null)?.questions
            if (first) toast(`${j.title.replace(/^Test: /, '')}: end-of-week test ready${n ? ` (${n} questions)` : ''}`, 'good')
          }
          // Downloading marketplace weeks: show each as it goes in, and say when it's finished.
          if (typeof j.meta?.marketAdded === 'number') {
            if (marketAdded.get(j.id) !== j.meta.marketAdded) st.bump()
            marketAdded.set(j.id, j.meta.marketAdded)
            if (first) {
              const r = j.result as { added: number; failed: string[] } | null
              if (r) toast(`Added ${r.added} week${r.added === 1 ? '' : 's'} from the marketplace${r.failed.length ? `; ${r.failed.length} didn’t download` : ''}`, r.failed.length ? 'info' : 'good')
            }
          }
          // Merging marketplace copies: the course page shows the merged week once it's up.
          if (typeof j.meta?.marketMerged === 'string' && first) {
            st.bump()
            toast(`${j.title.replace(/^Merge /, '')} is one week on the marketplace now, for everyone.`, 'good')
          }
          const used = j.status === 'done' && !usageShown.has(j.id) ? planUsageText(j.planUsage) : null
          if (used) {
            usageShown.add(j.id)
            toast(`${j.title.replace(/^(Topic|Plan|Notes|Flashcards): /, '')} used ${used}`, 'info')
          }
          if (j.status === 'error') toast(`${j.title}: ${j.error}`, 'bad', { label: 'Jobs', run: () => st.go({ name: 'jobs' }) })
        }
      }),
    []
  )

  const setThemeSaved = (t: Theme) => {
    setTheme(t)
    void api.settings.set({ key: 'ui.theme', value: t })
  }
  const setZoomSaved = (z: number) => {
    const v = Math.round(Math.min(1.5, Math.max(0.75, z)) * 100) / 100
    setZoom(v)
    void api.settings.set({ key: 'ui.zoom', value: v })
  }

  const lastDeckId = async (): Promise<string | null> => {
    const r = useStore.getState().route
    if (r.name === 'deck') return r.id
    if (r.name === 'flashcards' || r.name === 'learn') return r.deckId || null
    const s = await api.settings.all()
    const last = s['ui.lastRoute'] as Route | undefined
    if (last?.name === 'deck') return last.id
    const decks = await api.decks.list()
    if (decks.length === 1) return decks[0].id
    if (!decks.length) return null
    return chooseDialog(
      'Which deck?',
      decks.map((d) => ({ value: d.id, label: `${d.name} · ${d.card_count} card${d.card_count === 1 ? "" : "s"}` })),
      { confirmText: 'Continue' }
    )
  }

  const newDeck = async () => {
    const name = await askText('New deck', { label: 'Deck name', confirmText: 'Create' })
    if (!name) return
    const d = await api.decks.create({ name })
    useStore.getState().bump()
    go({ name: 'deck', id: d.id })
  }

  useCommands(
    {
      'go.home': () => go({ name: 'home' }),
      'go.decks': () => go({ name: 'decks' }),
      'go.courses': () => go({ name: 'courses' }),
      'go.tracker': () => go({ name: 'tracker' }),
      'go.market': () => go({ name: 'market' }),
      'go.notes': () => go({ name: 'notes', id: (useStore.getState().route as { id?: string }).id ?? null }),
      'go.jobs': () => go({ name: 'jobs' }),
      'view.jobs': () => go({ name: 'jobs' }),
      'go.settings': () => go({ name: 'settings' }),
      'go.prompts': () => go({ name: 'settings', tab: 'prompts' }),
      'go.models': () => go({ name: 'settings', tab: 'models' }),
      'go.usage': () => go({ name: 'settings', tab: 'usage' }),
      'go.actions': () => go({ name: 'settings', tab: 'actions' }),
      'help.claude': () => go({ name: 'settings', tab: 'claude' }),
      'go.back': () => useStore.getState().goBack(),
      'go.forward': () => useStore.getState().goForward(),
      palette: () => useStore.getState().setPalette(!useStore.getState().palette),
      search: () => useStore.getState().setPalette(true),
      shortcuts: () => useStore.getState().setSheet(!useStore.getState().sheet),
      'view.sidebar': () => useStore.getState().toggleRail(),
      'view.focus': () => useStore.getState().toggleFocus(),
      'view.offline': () => useStore.getState().setOffline(!useStore.getState().offline),
      'view.explain': () => useStore.getState().openExplain(null),
      'view.theme': () => setThemeSaved(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'),
      'view.zoomIn': () => setZoomSaved(zoom + 0.05),
      'view.zoomOut': () => setZoomSaved(zoom - 0.05),
      'view.zoomReset': () => setZoomSaved(1),
      'gen.cards': () => useStore.getState().openGenCards({ deckId: route.name === 'deck' ? route.id : null }),
      'gen.notes': () => useStore.getState().openGenNotes({}),
      'deck.new': newDeck,
      'folder.new': async () => {
        const name = await askText('New folder', { label: 'Folder name', confirmText: 'Create' })
        if (!name) return
        await api.folders.create({ name, kind: route.name === 'notes' ? 'note' : 'deck' })
        useStore.getState().bump()
      },
      'note.new': async () => {
        const n = await api.notes.create({ title: 'Untitled' })
        useStore.getState().bump()
        go({ name: 'notes', id: n.id })
      },
      'card.new': async () => {
        const id = await lastDeckId()
        if (!id) return newDeck()
        go({ name: 'deck', id })
        setTimeout(() => runCommand('card.new'), 60)
      },
      'study.learn': async () => {
        const id = await lastDeckId()
        if (id) go({ name: 'learn', deckId: id })
        else toast('Create a deck first', 'info')
      },
      'study.flashcards': async () => {
        const id = await lastDeckId()
        if (id) go({ name: 'flashcards', deckId: id, mode: 'due' })
      },
      'study.cram': async () => {
        const id = await lastDeckId()
        if (id) go({ name: 'flashcards', deckId: id, mode: 'all' })
      },
      'io.importDeck': async () => {
        try {
          const ids = await api.io.importDeck()
          if (ids.length) {
            toast(`Imported ${ids.length} deck${ids.length === 1 ? '' : 's'}`, 'good')
            useStore.getState().bump()
            go({ name: 'deck', id: ids[0] })
          }
        } catch (e) {
          toast(errorText(e), 'bad')
        }
      },
      'io.importNotes': async () => {
        try {
          const ids = await api.io.importNotes()
          if (ids.length) {
            toast(`Imported ${ids.length} note${ids.length === 1 ? '' : 's'}`, 'good')
            useStore.getState().bump()
            go({ name: 'notes', id: ids[0] })
          }
        } catch (e) {
          toast(errorText(e), 'bad')
        }
      },
      'app.backup': async () => {
        const f = await api.app.backup()
        if (f) toast('Library backed up', 'good')
      },
      'app.restore': () => void api.app.restore().catch((e) => toast(errorText(e), 'bad')),
      'app.showData': () => void api.app.showDataFolder(),
      'ai.cancelAll': async () => {
        if (await confirmDialog('Cancel all running jobs?', undefined, { confirmText: 'Cancel jobs', danger: true })) await api.jobs.cancelAll()
      },
      'help.readme': () => useStore.getState().setSheet(true),
      'help.onboarding': () => setOnboarding(true),
      'study.end': () => {
        const r = useStore.getState()
        if (r.explain) r.openExplain(null)
      }
    },
    [route, theme, zoom]
  )

  // Drag files anywhere onto the window.
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      depth++
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const all = [...(e.dataTransfer?.files ?? [])].map((f) => window.studywise.pathForFile(f))
      // A library export dropped on the window is imported (added to this library).
      // A week a friend shared: ask which course it goes in.
      // On a week's page, files go straight into that week (a shared week merges into it).
      const here = useStore.getState().route
      if (here.name === 'week') {
        void api.courses
          .get({ id: here.courseId })
          .then((c) => dropOnWeek(here.weekId, c.weeks.find((w) => w.id === here.weekId)?.label ?? 'this week', all, here.courseId))
          .catch((err) => toast(errorText(err), 'bad'))
        return
      }
      const week = all.find((p) => /\.studyweek$/i.test(p))
      if (week) return void importSharedWeek({ file: week })
      const lib = all.find((p) => /\.studywise$/i.test(p))
      if (lib) {
        void confirmDialog('Import this library?', 'Its decks, notes and courses are added to yours. Nothing is replaced.', { confirmText: 'Import' }).then(async (ok) => {
          if (!ok) return
          try {
            const r = await api.io.importLibrary({ files: [lib] })
            if (r) toast(`Added ${r.decks} decks, ${r.cards} cards, ${r.notes} notes and ${r.courses} courses`, 'good')
            useStore.getState().bump()
          } catch (err) {
            toast(errorText(err), 'bad')
          }
        })
        return
      }
      const files = all.filter((p) => /\.(pdf|docx|pptx|txt|md|markdown|vtt|srt|apkg|colpkg)$/i.test(p))
      if (files.length) openFiles(files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // Notes stays mounted while you move between notes, so its folder tree keeps its place.
  const pageKey = route.name === 'notes' ? 'notes' : `${route.name}:${(route as { id?: string; deckId?: string }).id ?? (route as { deckId?: string }).deckId ?? ''}`

  const studying = IS_MOBILE && STUDY_ROUTES.includes(route.name)
  return (
    <div className="flex h-full flex-col">
      {IS_MOBILE ? !studying && <MobileTopBar /> : !focus && <GooNav />}
      {IS_MOBILE && studying && <div className="mobile-safe-top shrink-0" />}
      {!IS_MOBILE && focus && <div className="drag h-9 shrink-0" />}
      {!IS_MOBILE && <SetupBanner />}
      {!IS_MOBILE && <UpdateBanner />}
      {!IS_MOBILE && <AnnouncementBanner />}
      <main className="relative min-h-0 flex-1">
        <div key={pageKey} className={cx('page-in absolute inset-0 overflow-y-auto', !IS_MOBILE && '[scrollbar-gutter:stable_both-edges]')}>
          {!ready ? (
            <div className="grid h-full place-items-center">
              <Spinner className="size-6 text-muted" />
            </div>
          ) : (
            <Suspense fallback={<div className="grid h-full place-items-center"><Spinner className="size-6 text-muted" /></div>}>
              <Page route={route} />
            </Suspense>
          )}
        </div>
      </main>
      {IS_MOBILE && !studying && <MobileTabBar />}
      {IS_MOBILE && studying && <div className="mobile-safe-bottom shrink-0" />}
      <ExplainPanel />
      <GenerateCardsModal />
      <GenerateNotesModal />
      <NewCourseModal />
      <JobDock />
      {/* A week you asked for on the marketplace is done: add it. */}
      <ReadyCard />
      <CardPreviewModal />
      <CommandPalette />
      <ShortcutSheet />
      <DialogHost />
      <MarketMatchesHost />
      <DropChooser />
      <Toasts />
      {onboarding && (IS_MOBILE ? <MobileOnboarding onDone={() => setOnboarding(false)} /> : <Onboarding onDone={() => setOnboarding(false)} />)}
      {dragging && !IS_MOBILE && (
        <div className="fade-in pointer-events-none fixed inset-3 z-[70] grid place-items-center rounded-xl border-4 border-dashed border-accent bg-accent-soft/80 backdrop-blur-sm">
          <div className="pop-in flex flex-col items-center gap-3 text-center">
            <FileUp className="size-12 text-accent" />
            {route.name === 'week' ? (
              <>
                <div className="text-2xl font-semibold">Drop to add to this week</div>
                <div className="text-muted">Slides, transcripts, readings or pictures (PDF, Word, PowerPoint, text, Markdown, web pages, RTF, CSV, images), or a shared .studyweek</div>
              </>
            ) : (
              <>
                <div className="text-2xl font-semibold">Drop to make a course, notes or flashcards</div>
                <div className="text-muted">PDF, Word, PowerPoint, text or Markdown</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <Home />
    case 'decks':
      return <Decks folderId={route.folderId ?? null} />
    case 'deck':
      return <DeckPage id={route.id} focusCardId={route.cardId} />
    case 'flashcards':
      return <Flashcards key={route.deckIds?.join(',') ?? ''} deckId={route.deckId} mode={route.mode} courseId={route.courseId} deckIds={route.deckIds} />
    case 'learn':
      return <Learn deckId={route.deckId} cardIds={route.cardIds} />
    case 'notes':
      return <Notes noteId={route.id ?? null} />
    case 'settings':
      return <Settings tab={route.tab} />
    case 'jobs':
      return <Jobs />
    case 'courses':
      return <Courses />
    case 'tracker':
      return <Tracker />
    case 'market':
      return <Market key={route.courseId ?? ''} courseId={route.courseId} />
    case 'course':
      return <CoursePage id={route.id} />
    case 'week':
      return <WeekPage courseId={route.courseId} weekId={route.weekId} />
    case 'weektest':
      return <WeekTestPage key={route.weekId} courseId={route.courseId} weekId={route.weekId} />
    case 'topic':
      return (
        <TopicPage
          key={`${route.id}:${route.test ? 'test' : 'learn'}`}
          id={route.id}
          section={route.section}
          test={!!route.test}
        />
      )
  }
}

const isAnki = (p: string) => /\.(apkg|colpkg)$/i.test(p)

/** Anki packages import straight away as decks; anything else asks what to make. */
function openFiles(paths: string[]) {
  const st = useStore.getState()
  // A shared week opened with the app (or dropped on its Dock icon).
  const week = paths.find((p) => /\.studyweek$/i.test(p))
  if (week) void importSharedWeek({ file: week })
  paths = paths.filter((p) => !/\.studyweek$/i.test(p))
  const decks = paths.filter(isAnki)
  const rest = paths.filter((p) => !isAnki(p))
  if (rest.length) st.setDropFiles(rest)
  if (!decks.length) return
  st.toast(`Importing ${decks.length === 1 ? decks[0].split(/[\\/]/).pop() : `${decks.length} Anki packages`}…`)
  api.io
    .importDeck({ files: decks })
    .then((ids) => {
      if (!ids.length) return
      st.toast(`Imported ${ids.length} deck${ids.length === 1 ? '' : 's'} from Anki`, 'good')
      st.bump()
      if (!rest.length) st.go({ name: 'deck', id: ids[0] })
    })
    .catch((e) => st.toast(errorText(e), 'bad'))
}

const CLOSED_ANNOUNCEMENT = 'sw.closedAnnouncement'

/** The marketplace admin's message for everyone (checked hourly), until you close it. */
function AnnouncementBanner() {
  const [a, setA] = useState<{ id: string; text: string; level: 'info' | 'warn'; link: string | null } | null>(null)
  const [closed, setClosed] = useState(() => localStorage.getItem(CLOSED_ANNOUNCEMENT))
  useEffect(() => {
    const check = () => void api.market.announcement().then(setA).catch(() => {})
    check()
    const t = setInterval(check, 60 * 60_000)
    return () => clearInterval(t)
  }, [])
  if (!a || closed === a.id) return null
  const warn = a.level === 'warn'
  return (
    <div className={cx('pop-in mx-3 mt-2.5 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 sm:mx-4', warn ? 'border-warn/40 bg-warn-soft' : 'border-accent/30 bg-accent-soft')}>
      <Megaphone className={cx('size-5 shrink-0', warn ? 'text-warn' : 'text-accent')} />
      <div className="min-w-0 flex-1 text-[0.92rem]">{a.text}</div>
      {a.link && (
        <Button size="sm" variant="ghost" onClick={() => void api.app.openExternal({ url: a.link! })}>
          More
        </Button>
      )}
      <button
        onClick={() => {
          localStorage.setItem(CLOSED_ANNOUNCEMENT, a.id)
          setClosed(a.id)
        }}
        className="text-muted hover:text-ink"
        aria-label="Dismiss"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

function OllamaBanner({ problem, onHide }: { problem: string; onHide: () => void }) {
  return (
    <div className="pop-in mx-3 mt-2.5 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 sm:mx-4">
      <AlertTriangle className="size-5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 text-[0.92rem]">
        <div className="font-semibold">Ollama isn’t set up yet</div>
        <div className="text-muted">{problem}</div>
      </div>
      <Button size="sm" variant="ink" onClick={() => useStore.getState().go({ name: 'settings', tab: problem.includes('model') ? 'models' : 'claude' })}>
        Open settings
      </Button>
      <button onClick={onHide} className="text-muted hover:text-ink" aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  )
}

/**
 * "Update available" when GitHub has new commits for this checkout. Update
 * pulls them, installs packages if needed and restarts the app.
 */
function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  // "Later" hides the banner until more changes arrive.
  const [dismissedAt, setDismissedAt] = useState(0)
  // Installed builds: "Later" hides this version until it's ready (or a newer one comes out).
  const [dismissedRelease, setDismissedRelease] = useState<string | null>(null)
  useEffect(() => {
    void api.updates.status().then(setStatus)
    return onEvent((ev) => ev.type === 'update' && setStatus(ev.status))
  }, [])
  if (!status?.supported) return null
  if (status.kind === 'release') {
    const key = `${status.version}:${status.ready}:${status.state === 'error'}`
    return dismissedRelease === key ? null : <ReleaseBanner status={status} onLater={() => setDismissedRelease(key)} />
  }
  const busy = status.state === 'updating' || status.state === 'restarting'
  if (!busy && ((status.behind === 0 && status.state !== 'error') || (dismissedAt > 0 && status.behind <= dismissedAt))) return null
  const n = status.behind
  const blocked = status.ahead > 0
  const update = async () => {
    try {
      await api.updates.apply()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  return (
    <div className="pop-in mx-3 mt-2.5 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 sm:mx-4">
      {busy ? <Spinner className="size-5 shrink-0 text-accent" /> : status.state === 'error' ? <AlertTriangle className="size-5 shrink-0 text-warn" /> : <Download className="size-5 shrink-0 text-accent" />}
      <div className="min-w-0 flex-1 text-[0.92rem]">
        <div className="font-semibold">
          {busy ? status.stage ?? 'Updating…' : status.state === 'error' ? 'The update didn’t finish' : `Update available: ${n} new change${n === 1 ? '' : 's'}`}
        </div>
        <div className="truncate text-muted">
          {busy
            ? status.state === 'restarting'
              ? 'The app will close and open again in a few seconds.'
              : 'Keep the app open.'
            : status.state === 'error'
              ? status.error
              : blocked
                ? `This copy has ${status.ahead} commit${status.ahead === 1 ? '' : 's'} of its own, so it can’t update automatically. Run git pull in the project folder.`
                : status.changes.join(' · ')}
        </div>
      </div>
      {!busy && !blocked && (
        <Button size="sm" variant="ink" onClick={update}>
          {status.state === 'error' ? 'Try again' : 'Update & restart'}
        </Button>
      )}
      {!busy && (
        <Button size="sm" variant="ghost" onClick={() => setDismissedAt(Math.max(status.behind, 0) || 1)} aria-label="Hide until there are more changes">
          Later
        </Button>
      )}
    </div>
  )
}

/** An installed build: a new release is downloading, ready to install, or failed to download (Windows), or out to download (Mac). */
function ReleaseBanner({ status, onLater }: { status: UpdateStatus; onLater: () => void }) {
  if (!status.version) return null
  const downloading = status.state === 'updating'
  const restarting = status.state === 'restarting'
  const failed = status.state === 'error'
  // Only a Mac build has a page to download from; Windows installs it itself.
  const manual = !!status.downloadUrl
  const install = async () => {
    try {
      await api.updates.apply()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const title = restarting
    ? 'Installing the update…'
    : downloading
      ? (status.stage ?? `Downloading version ${status.version}…`)
      : failed
        ? `Version ${status.version} didn’t download`
        : status.ready
          ? `Version ${status.version} is ready`
          : `Version ${status.version} is out`
  const detail = restarting
    ? 'Studywise will close and open again.'
    : downloading
      ? 'Keep working. It installs when you restart Studywise.'
      : failed
        ? (status.error ?? 'Check your connection and try again.')
        : status.ready
          ? 'Restart to update now, or it installs next time you quit. Your courses, decks and notes stay.'
          : manual
            ? 'Download it and drag it to Applications to replace this one. Your courses, decks and notes stay.'
            : 'It downloads in the background, then installs when you restart.'
  return (
    <div className="pop-in mx-3 mt-2.5 flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 sm:mx-4">
      {downloading || restarting ? <Spinner className="size-5 shrink-0 text-accent" /> : failed ? <AlertTriangle className="size-5 shrink-0 text-warn" /> : <Download className="size-5 shrink-0 text-accent" />}
      <div className="min-w-0 flex-1 text-[0.92rem]">
        <div className="font-semibold">{title}</div>
        <div className="text-muted">{detail}</div>
      </div>
      {!downloading && !restarting && (failed || status.ready || manual) && (
        <Button size="sm" variant="ink" onClick={install}>
          {failed ? 'Try again' : status.ready ? 'Restart to update' : 'Download'}
        </Button>
      )}
      {!restarting && (
        <Button size="sm" variant="ghost" onClick={onLater}>
          Later
        </Button>
      )}
    </div>
  )
}

function SetupBanner() {
  const claude = useStore((s) => s.claude)
  const ai = useStore((s) => s.ai)
  const [hidden, setHidden] = useState(false)
  const [checking, setChecking] = useState(false)
  if (ai?.provider === 'ollama') {
    if (hidden || claude?.mock) return null
    const problem = !ai.ollama.ready
      ? 'Add your Ollama API key in Settings → AI provider. You can create one at ollama.com/settings/keys.'
      : !ai.ollama.defaultModel
        ? 'Choose a default model in Settings → Models.'
        : null
    return problem ? <OllamaBanner problem={problem} onHide={() => setHidden(true)} /> : null
  }
  if (!claude || hidden || claude.mock || (claude.path && claude.loggedIn)) return null
  return (
    <div className="pop-in mx-3 mt-2.5 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 sm:mx-4">
      <AlertTriangle className="size-5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1 text-[0.92rem]">
        <div className="font-semibold">{claude.path ? 'Claude Code isn’t logged in' : 'Claude Code isn’t installed'}</div>
        <div className="text-muted">
          {claude.path ? (
            <>
              AI features need your own Claude login. Open Terminal and run <code className="rounded bg-surface px-1.5 font-mono">claude</code>, sign in, then press Re-check.
            </>
          ) : (
            <>
              Install it with <code className="rounded bg-surface px-1.5 font-mono">npm install -g @anthropic-ai/claude-code</code>, run <code className="rounded bg-surface px-1.5 font-mono">claude</code> once to log in, then press Re-check.
            </>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="ink"
        loading={checking}
        onClick={async () => {
          setChecking(true)
          useStore.getState().setClaude(await api.claude.recheck())
          setChecking(false)
        }}
      >
        Re-check
      </Button>
      <Button size="sm" variant="ghost" onClick={() => useStore.getState().go({ name: 'settings', tab: 'claude' })}>
        Settings
      </Button>
      <button onClick={() => setHidden(true)} className="text-muted hover:text-ink" aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  )
}

function DropChooser() {
  const files = useStore((s) => s.dropFiles)
  const set = useStore((s) => s.setDropFiles)
  if (!files) return null
  const names = files.map((f) => f.split('/').pop()).join(', ')
  const pick = (kind: 'course' | 'notes' | 'cards') => {
    set(null)
    if (kind === 'course') useStore.getState().openNewCourse(files)
    else if (kind === 'notes') useStore.getState().openGenNotes({ files })
    else {
      const r = useStore.getState().route
      useStore.getState().openGenCards({ files, deckId: r.name === 'deck' ? r.id : null })
    }
  }
  return (
    <div data-modal className="fade-in fixed inset-0 z-[65] grid place-items-center bg-black/30 p-4 backdrop-blur-[3px]" onMouseDown={(e) => e.target === e.currentTarget && set(null)} onKeyDown={(e) => e.key === 'Escape' && set(null)}>
      <div className="pop-in w-full max-w-[860px] rounded-xl border border-line bg-bg p-6 shadow-2xl">
        <h2 className="text-xl font-semibold">What should we make?</h2>
        <p className="mt-1 truncate text-muted">{names}</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {(
            [
              ['course', GraduationCap, 'Make a course', 'Split it into topics and learn them in short sections with questions'],
              ['notes', NotebookPen, 'Generate notes', 'Structured study notes in your style, streamed into the editor'],
              ['cards', Layers, 'Generate flashcards', 'Exam-style cards, with a preview to check and fix before saving']
            ] as const
          ).map(([k, Icon, title, sub]) => (
            <button
              key={k}
              autoFocus={k === 'course'}
              onClick={() => pick(k)}
              className="group flex flex-col items-start gap-3 rounded-xl border border-line bg-surface p-5 text-left transition-[transform,box-shadow,border-color] duration-500 ease-out-soft hover:border-accent active:scale-[0.98]"
            >
              <span className="text-accent">
                <Icon className="size-5" />
              </span>
              <span className="text-lg font-semibold">{title}</span>
              <span className="text-[0.9rem] text-muted">{sub}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 text-right">
          <Button variant="ghost" onClick={() => set(null)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  // With a dialog open, its buttons are at the bottom: show toasts at the top instead.
  const top = useModalCount((s) => s.n > 0)
  return (
    <div
      className={cx(
        'pointer-events-none fixed right-4 left-4 z-[80] flex flex-col items-center gap-2',
        top ? 'top-[calc(var(--nav-h)+12px)]' : IS_MOBILE ? 'bottom-[calc(var(--tab-h)+12px)]' : 'bottom-4 sm:left-auto sm:items-end'
      )}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'bad' ? 'alert' : 'status'}
          className={cx(
            'pointer-events-auto flex max-w-[440px] items-center gap-3 rounded-full py-2.5 pr-2.5 pl-5 text-[0.92rem] font-medium shadow-xl',
            t.leaving ? 'toast-out' : top ? 'toast-in-top' : 'toast-in',
            t.kind === 'bad' ? 'bg-bad text-white' : 'bg-ink text-bg'
          )}
        >
          <span className="min-w-0 flex-1">{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
              className="shrink-0 rounded-full bg-white/15 px-3 py-1 font-semibold hover:bg-white/25"
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} className="grid size-7 shrink-0 place-items-center rounded-full opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
