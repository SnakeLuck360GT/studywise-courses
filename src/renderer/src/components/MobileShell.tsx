// The phone app's frame: a slim top bar (back, title, sync state) and a tab bar
// at the bottom, in place of the desktop's navigation bar.

import { useState } from 'react'
import { ArrowLeft, House, GraduationCap, Layers, NotebookPen, Settings, Cloud, CloudOff, RefreshCw, Laptop, ArrowRight } from 'lucide-react'
import { useStore, type Route } from '../lib/store'
import { mobile } from '../lib/platform'
import { cx, Button } from './ui'
import { Logo } from './GooNav'
import { OfflineButton } from './Offline'
import { usePhoneSync, MobileSyncTab } from './PhoneSync'
import { api } from '../lib/api'

const TABS: { label: string; route: Route; match: Route['name'][]; icon: typeof House }[] = [
  { label: 'Home', route: { name: 'home' }, match: ['home'], icon: House },
  { label: 'Courses', route: { name: 'courses' }, match: ['courses', 'course', 'week', 'topic'], icon: GraduationCap },
  { label: 'Decks', route: { name: 'decks' }, match: ['decks', 'deck', 'flashcards', 'learn'], icon: Layers },
  { label: 'Notes', route: { name: 'notes' }, match: ['notes'], icon: NotebookPen },
  { label: 'Settings', route: { name: 'settings' }, match: ['settings', 'jobs'], icon: Settings }
]

/** Pages that take the whole screen while you study; they have their own way out. */
export const STUDY_ROUTES: Route['name'][] = ['topic', 'flashcards', 'learn']

const TITLES: Partial<Record<Route['name'], string>> = {
  home: 'Studywise',
  courses: 'Courses',
  course: 'Course',
  week: 'Week',
  decks: 'Decks',
  deck: 'Deck',
  notes: 'Notes',
  settings: 'Settings',
  jobs: 'Jobs'
}

const isTabRoot = (r: Route) => TABS.some((t) => t.route.name === r.name) && !(r.name === 'notes' && r.id) && !(r.name === 'decks' && r.folderId)

export function MobileTopBar() {
  const route = useStore((s) => s.route)
  const canGoBack = useStore((s) => s.back.length > 0)
  const go = useStore((s) => s.go)
  const sync = usePhoneSync()
  const back = !isTabRoot(route) && canGoBack
  return (
    <header className="mobile-top z-30 shrink-0 border-b border-line bg-nav backdrop-blur-xl">
      <div className="flex h-[var(--nav-h)] items-center gap-2 px-2">
        {back ? (
          <button onClick={() => useStore.getState().goBack()} aria-label="Back" className="grid size-11 place-items-center rounded-full text-ink active:bg-surface-2">
            <ArrowLeft className="size-[22px]" />
          </button>
        ) : (
          <button onClick={() => go({ name: 'home' })} className="grid size-11 place-items-center" aria-label="Home">
            <Logo size={26} />
          </button>
        )}
        {/* Pages show their own title; the bar names the app on the home page only. */}
        <div className="min-w-0 flex-1 truncate text-[1.02rem] font-semibold tracking-[-0.01em]">{route.name === 'home' ? 'Studywise' : back ? '' : TITLES[route.name]}</div>
        <OfflineButton mobile />
        {sync && <SyncChip />}
      </div>
    </header>
  )
}

function SyncChip() {
  const s = usePhoneSync()
  const go = useStore((st) => st.go)
  if (!s) return null
  const open = () => go({ name: 'settings', tab: 'sync' })
  if (!s.paired)
    return (
      <button onClick={open} className="flex h-9 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[0.85rem] font-semibold text-accent active:scale-95">
        <Laptop className="size-4" /> Connect
      </button>
    )
  const Icon = s.state === 'syncing' ? RefreshCw : s.online ? Cloud : CloudOff
  return (
    <button
      onClick={() => (s.online ? void mobile().sync.now() : open())}
      aria-label={s.state === 'syncing' ? 'Syncing' : s.online ? 'Synced. Tap to sync now' : 'Can’t reach your computer'}
      className={cx('relative grid size-11 place-items-center rounded-full active:bg-surface-2', s.online ? 'text-muted' : 'text-warn')}
    >
      <Icon className={cx('size-[20px]', s.state === 'syncing' && 'animate-spin')} />
      {s.pending > 0 && s.state !== 'syncing' && <span className="absolute top-2 right-2 size-2 rounded-full bg-accent" />}
    </button>
  )
}

export function MobileTabBar() {
  const route = useStore((s) => s.route)
  const go = useStore((s) => s.go)
  const running = useStore((s) => s.jobs.filter((j) => j.status === 'running').length)
  return (
    <nav className="mobile-tabs z-30 shrink-0 border-t border-line bg-nav backdrop-blur-xl">
      <div className="mx-auto flex max-w-[640px]">
        {TABS.map((t) => {
          const active = t.match.includes(route.name)
          return (
            <button
              key={t.label}
              onClick={() => go(t.route)}
              aria-current={active ? 'page' : undefined}
              className={cx('relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-0.5 text-[0.7rem] font-semibold transition-colors', active ? 'text-accent' : 'text-muted')}
            >
              <span className={cx('grid h-7 w-14 place-items-center rounded-full transition-[background,transform] duration-300 ease-out-soft', active && 'bg-accent-soft')}>
                <t.icon className="size-[20px]" strokeWidth={active ? 2.3 : 2} />
              </span>
              {t.label}
              {t.label === 'Settings' && running > 0 && <span className="tabular absolute top-1.5 right-[calc(50%-22px)] grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.62rem] leading-4 text-accent-ink">{running}</span>}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

/** First run on the phone: what it is, then connect to the computer (or skip). */
export function MobileOnboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0)
  const sync = usePhoneSync()
  const finish = () => {
    void api.settings.set({ key: 'onboarding.done', value: true })
    onDone()
  }
  return (
    <div className="fade-in fixed inset-0 z-[90] flex flex-col overflow-y-auto bg-bg px-6 pt-[max(48px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      {step === 0 ? (
        <div className="pop-in flex flex-1 flex-col">
          <div className="flex-1" />
          <Logo size={64} />
          <h1 className="mt-8 text-[2.1rem] leading-[1.08] font-semibold tracking-[-0.03em]">Studywise, in your pocket.</h1>
          <p className="mt-4 text-[1.05rem] leading-relaxed text-muted">
            Your courses, flashcards and notes from Studywise on your computer, on your phone. Study offline; your progress syncs back whenever the two can see each other.
          </p>
          <div className="flex-1" />
          <div className="mt-10 flex flex-col gap-2">
            <Button variant="primary" size="lg" onClick={() => setStep(1)}>
              Connect to my computer <ArrowRight className="size-4" />
            </Button>
            <Button variant="ghost" size="lg" onClick={finish}>
              Not now
            </Button>
          </div>
        </div>
      ) : (
        <div className="pop-in flex flex-1 flex-col gap-4">
          <MobileSyncTab />
          <div className="flex-1" />
          <Button variant={sync?.paired ? 'primary' : 'ghost'} size="lg" onClick={finish}>
            {sync?.paired ? 'Start studying' : 'Skip for now'}
          </Button>
        </div>
      )}
    </div>
  )
}
