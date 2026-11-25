// Arrow keys move between the buttons and links on screen: ↓ goes to the
// nearest one below, → to the nearest one to the right, and so on, and Enter
// or Space presses it. Pages that use the arrows themselves (flashcards, the
// deck list, menus, text boxes) keep them: this only runs when nothing else
// handled the key.

const FOCUSABLE = 'button:not([disabled]), a[href], [role="button"], [role="treeitem"] > button, summary, [tabindex]:not([tabindex="-1"])'
const DIRS = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0]
} as const
type Dir = keyof typeof DIRS

function isTyping(el: Element | null): boolean {
  if (!el) return false
  const h = el as HTMLElement
  if (h.isContentEditable || h.closest?.('.cm-editor')) return true
  if (h.tagName === 'TEXTAREA' || h.tagName === 'SELECT') return true
  if (h.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit'].includes((h as HTMLInputElement).type)
  return false
}

function visible(el: HTMLElement): boolean {
  if (el.closest('[inert], [aria-hidden="true"]')) return false
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return false
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
    // Off screen but inside a scrolling list: still reachable (it scrolls into view).
    const scroller = el.closest('.overflow-y-auto, .overflow-auto')
    if (!scroller) return false
  }
  // Hidden, see-through (an ancestor too, like a closed menu panel) or not clickable: skip it.
  if (
    !el.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true
    })
  )
    return false
  return getComputedStyle(el).pointerEvents !== 'none'
}

/** Where to look: inside an open dialog if there is one, else the whole window. */
function scope(): ParentNode {
  const modals = document.querySelectorAll('[data-modal]')
  return modals.length ? modals[modals.length - 1] : document
}

/**
 * The best candidate in a direction: it has to be that way from the current
 * element; nearer wins, and lined up (overlapping across the direction of
 * travel) beats off to the side.
 */
function pick(from: DOMRect, dir: Dir, list: HTMLElement[], current: Element | null, sameLine = true): HTMLElement | null {
  const [dx, dy] = DIRS[dir]
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of list) {
    if (el === current || el.contains(current) || current?.contains(el)) continue
    const r = el.getBoundingClientRect()
    // Distance along the direction, edge to edge; must be ahead of us.
    const along = dx ? (dx > 0 ? r.left - from.right : from.left - r.right) : dy > 0 ? r.top - from.bottom : from.top - r.bottom
    const centreAhead = dx ? (r.left + r.right) / 2 - (from.left + from.right) / 2 : (r.top + r.bottom) / 2 - (from.top + from.bottom) / 2
    if (along < -4 || Math.sign(centreAhead) !== (dx || dy)) continue
    // Distance across it: 0 when the two overlap.
    const across = dx ? Math.max(0, r.top - from.bottom, from.top - r.bottom) : Math.max(0, r.left - from.right, from.left - r.right)
    // Sideways only goes to something on the same line (more or less): not up to the top bar from a list row.
    if (dx && sameLine && across > Math.max(from.height, 24)) continue
    const score = Math.max(0, along) + across * 3 + (across > 0 ? 40 : 0)
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  return best
}

export function startArrowNav(): void {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (!(e.key in DIRS)) return
    const active = document.activeElement as HTMLElement | null
    if (isTyping(active)) return
    // Lists and menus that handle their own arrows mark themselves.
    if (active?.closest('[data-own-arrows]')) return
    const list = [...scope().querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible)
    if (!list.length) return
    const hasFocus = active && active !== document.body && list.includes(active)
    let next: HTMLElement | null
    if (!hasFocus) {
      // Nothing picked yet: start at the top left of the page (below the top bar for ↓).
      const main = list.filter((el) => el.closest('main') || el.closest('[data-modal]'))
      const pool = main.length ? main : list
      next = pool.reduce((a, b) => {
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return rb.top < ra.top - 4 || (Math.abs(rb.top - ra.top) <= 4 && rb.left < ra.left) ? b : a
      })
    } else {
      const from = active!.getBoundingClientRect()
      next = pick(from, e.key as Dir, list, active)
      // Nothing on the same line (say, from the page across to a shorter sidebar): the nearest that way, but not up into the top bar.
      if (!next && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const inHeader = !!active!.closest('header')
        next = pick(from, e.key as Dir, inHeader ? list : list.filter((el) => !el.closest('header')), active, false)
      }
    }
    if (!next) return
    e.preventDefault()
    next.focus({ preventScroll: true })
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
