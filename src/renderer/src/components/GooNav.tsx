import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { keyLabel, IS_MAC } from '@shared/keymap'
import { Search, Plus, ArrowLeft } from 'lucide-react'
import { useStore, type Route } from '../lib/store'
import { cx, Kbd } from './ui'
import { runCommand } from '../lib/commands'
import { UsageMeter } from './UsageMeter'
import { OfflineButton } from './Offline'

// Top navigation. Hovering a link sends three soft blobs after it at slightly
// different speeds; an SVG goo filter (in index.html) melts them together.

const LINKS: { label: string; route: Route; match: Route['name'][]; key: string }[] = [
  { label: 'Home', route: { name: 'home' }, match: ['home'], key: '⌘1' },
  { label: 'Courses', route: { name: 'courses' }, match: ['courses', 'course', 'week', 'topic', 'weektest'], key: 'g c' },
  { label: 'Decks', route: { name: 'decks' }, match: ['decks', 'deck', 'flashcards', 'learn'], key: '⌘2' },
  { label: 'Notes', route: { name: 'notes' }, match: ['notes'], key: '⌘3' },
  { label: 'Marketplace', route: { name: 'market' }, match: ['market'], key: 'g k' },
  { label: 'Settings', route: { name: 'settings' }, match: ['settings'], key: '⌘,' }
]

const P = 24

export function GooNav() {
  const route = useStore((s) => s.route)
  const go = useStore((s) => s.go)
  const jobs = useStore((s) => s.jobs)
  const running = jobs.filter((j) => j.status === 'running').length
  const canGoBack = useStore((s) => s.back.length > 0)
  const navRef = useRef<HTMLElement>(null)
  const brandRef = useRef<HTMLDivElement>(null)
  const linksRef = useRef<HTMLDivElement>(null)
  const toolsRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const blobs = useRef<(HTMLDivElement | null)[]>([])
  const [hovering, setHovering] = useState(false)
  const [open, setOpen] = useState(false)
  // Where the links go: centred in the window, nudged into the free gap, beside the logo without its
  // name (compact), or folded into the menu.
  const [fit, setFit] = useState<{ left: number | null; collapsed: boolean; compact: boolean }>({ left: null, collapsed: false, compact: false })
  const brandTextRef = useRef<HTMLSpanElement>(null)
  /** The app's name beside the logo, with its gap: the room hiding it makes. */
  const brandTextW = useRef(0)
  const activeIdx = LINKS.findIndex((l) => l.match.includes(route.name))

  const place = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const x = el.offsetLeft
    const y = el.offsetTop
    const w = el.offsetWidth
    const h = el.offsetHeight
    const set = (b: HTMLDivElement | null, bw: number, bh: number, top: number) => {
      if (!b) return
      b.style.left = `${P + x + (w - bw) / 2}px`
      b.style.top = `${top}px`
      b.style.width = `${bw}px`
      b.style.height = `${bh}px`
    }
    set(blobs.current[0], w, h, P + y)
    set(blobs.current[1], h, h, P + y)
    set(blobs.current[2], h * 0.8, h * 0.8, P + y + h * 0.1)
  }, [])

  const placeActive = useCallback(() => {
    const el = linksRef.current?.querySelectorAll<HTMLElement>(':scope > button')[activeIdx]
    place(el ?? null)
  }, [activeIdx, place])

  useLayoutEffect(() => {
    if (!hovering) placeActive()
  }, [hovering, placeActive])

  // Lay the links out against what's actually beside them. The usage meter, the
  // Windows caption buttons and text zoom all change how much room there is, so
  // a fixed breakpoint either overlaps or collapses too early.
  useLayoutEffect(() => {
    const nav = navRef.current
    const brand = brandRef.current
    const links = linksRef.current
    const tools = toolsRef.current
    if (!nav || !brand || !links || !tools) return
    const GAP = 16
    const measure = () => {
      const box = nav.getBoundingClientRect()
      // The app's name is measured while it shows; once hidden, the width it had is used.
      const text = brandTextRef.current
      const shown = !!text && text.offsetWidth > 0
      if (shown) brandTextW.current = text.offsetWidth + 8
      const brandRight = brand.getBoundingClientRect().right - box.left + GAP
      const leftCompact = brandRight - (shown ? brandTextW.current : 0)
      const leftFull = leftCompact + brandTextW.current
      // The menu button only shows when collapsed; measure as if it weren't there.
      const menuW = menuBtnRef.current?.offsetWidth ? menuBtnRef.current.offsetWidth + 12 : 0
      const rightEdge = tools.getBoundingClientRect().left - box.left + menuW - GAP
      const w = links.offsetWidth
      const centred = box.width / 2 - w / 2
      const placeAt = (leftEdge: number, compact: boolean): { left: number | null; collapsed: boolean; compact: boolean } | null =>
        centred >= leftEdge && centred + w <= rightEdge
          ? { left: null, collapsed: false, compact }
          : rightEdge - leftEdge >= w
            ? { left: Math.round(leftEdge + (rightEdge - leftEdge - w) / 2), collapsed: false, compact }
            : null
      // With the app's name if there's room; then without it, before folding the links into the menu.
      const next = placeAt(leftFull, false) ?? placeAt(leftCompact, true) ?? { left: null, collapsed: true, compact: false }
      setFit((f) => (f.left === next.left && f.collapsed === next.collapsed && f.compact === next.compact ? f : next))
      if (!next.collapsed) setOpen(false)
      placeActive()
    }
    measure()
    const ro = new ResizeObserver(measure)
    for (const el of [nav, brand, links, tools]) ro.observe(el)
    return () => ro.disconnect()
  }, [placeActive])

  // Windows convention: Alt+← / Alt+→ go back and forward.
  useEffect(() => {
    if (IS_MAC) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        useStore.getState().goBack()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        useStore.getState().goForward()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const navTo = (r: Route) => {
    // Courses goes back to where you were in it (mid-topic, say), like a tab.
    if (r.name === 'courses') useStore.getState().goCourses()
    else go(r)
    setOpen(false)
  }

  return (
    <header className={cx('drag relative z-30 shrink-0 border-b border-line bg-nav backdrop-blur-xl', open && 'is-open')}>
      <nav ref={navRef} className="nav-inset relative flex h-[var(--nav-h)] items-center gap-3 pr-3 sm:pr-4">
        <div ref={brandRef} className="flex shrink-0 items-center gap-3">
        {/* On Windows the caption buttons are on the right, so the left corner
            (where macOS has its traffic lights) holds the back button. */}
        {!IS_MAC && (
          <button
            onClick={() => useStore.getState().goBack()}
            disabled={!canGoBack}
            aria-label="Back"
            title="Back (Alt+←)"
            className="no-drag -mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-[background,color,transform] duration-200 hover:bg-surface-2 hover:text-ink active:scale-95 disabled:pointer-events-none disabled:opacity-35"
          >
            <ArrowLeft className="size-[18px]" />
          </button>
        )}
        <button onClick={() => navTo({ name: 'home' })} className="no-drag flex items-center gap-2 pr-2">
          <Logo />
          <span ref={brandTextRef} className={cx('hidden text-[0.95rem] font-semibold tracking-[-0.01em] whitespace-nowrap', !fit.compact && 'sm:inline')}>
            Studywise Courses
          </span>
        </button>
        </div>

        <div
          className={cx('pointer-events-none absolute inset-y-0 flex items-center transition-[left,transform] duration-300 ease-out-soft', fit.collapsed && 'invisible')}
          style={fit.left === null ? { left: '50%', transform: 'translateX(-50%)' } : { left: fit.left, transform: 'none' }}
          aria-hidden={fit.collapsed || undefined}
        >
          <div ref={linksRef} className={cx('goo-links no-drag', !fit.collapsed && 'pointer-events-auto')} onMouseLeave={() => setHovering(false)}>
            <div className="goo-layer" aria-hidden="true">
              {['a', 'b', 'c'].map((k, i) => (
                <div key={k} ref={(el) => void (blobs.current[i] = el)} className={cx('goo-blob', hovering ? 'is-on' : activeIdx >= 0 && 'is-rest')} data-blob={k} />
              ))}
            </div>
            {LINKS.map((l) => (
              <button
                key={l.label}
                onMouseEnter={(e) => {
                  setHovering(true)
                  place(e.currentTarget)
                }}
                onFocus={(e) => {
                  setHovering(true)
                  place(e.currentTarget)
                }}
                onBlur={() => setHovering(false)}
                onClick={() => navTo(l.route)}
                tabIndex={fit.collapsed ? -1 : undefined}
                aria-current={l.match.includes(route.name) ? 'page' : undefined}
              >
                {l.label}
                {l.label === 'Settings' && running > 0 && <span className="tabular ml-1.5 inline-grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.68rem] leading-4 text-accent-ink">{running}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1" />

        <div ref={toolsRef} className="flex shrink-0 items-center gap-3">
        <OfflineButton />
        <UsageMeter />
        <button
          onClick={() => runCommand('palette')}
          className="no-drag hidden h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[0.85rem] text-muted transition-colors hover:text-ink sm:flex"
        >
          <Search className="size-3.5" />
          <span className="hidden xl:inline">Search</span>
          <Kbd>{keyLabel("⌘K")}</Kbd>
        </button>
        <button
          onClick={() => runCommand('gen.cards')}
          className="no-drag inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[0.85rem] font-medium text-accent-ink transition-[filter,transform] duration-200 hover:brightness-110 active:scale-[0.98]"
          title={keyLabel("Generate flashcards with AI (⌘G)")}
        >
          <Plus className="size-4" />
          <span className="hidden sm:inline">Generate</span>
        </button>
        {fit.collapsed && (
          <button ref={menuBtnRef} className="menu-btn no-drag" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <span className="menu-bar menu-bar-1" />
            <span className="menu-bar menu-bar-2" />
          </button>
        )}
        </div>
      </nav>
      <div className={cx('menu-panel no-drag', !fit.collapsed && 'hidden')}>
        {LINKS.map((l) => (
          <button key={l.label} onClick={() => navTo(l.route)}>
            {l.label}
            <Kbd className="text-muted">{l.key}</Kbd>
          </button>
        ))}
        <button onClick={() => (setOpen(false), runCommand('palette'))}>
          Commands
          <Kbd className="text-muted">{keyLabel("⌘K")}</Kbd>
        </button>
      </div>
    </header>
  )
}

export function Logo({ size = 24 }: { size?: number }) {
  // Same drawing as build/icon.svg, cropped to the squircle.
  return (
    <svg viewBox="100 100 824 824" width={size} height={size} aria-hidden="true">
      <rect x="100" y="100" width="824" height="824" rx="186" fill="#2f5bea" />
      <g transform="translate(27 12)">
        <rect x="372" y="272" width="280" height="384" rx="40" fill="#8eacff" transform="rotate(-20 512 760)" />
        <rect x="372" y="272" width="280" height="384" rx="40" fill="#c4d3ff" transform="rotate(-4 512 760)" />
        <rect x="372" y="272" width="280" height="384" rx="40" fill="#ffffff" transform="rotate(12 512 760)" />
      </g>
    </svg>
  )
}
