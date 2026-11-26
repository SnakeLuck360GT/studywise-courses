import { useStore } from './store'

// Back and forward from the mouse's side buttons (and, on a Mac, a trackpad
// swipe). Windows sends some mice's side buttons to the app as a command
// (main process 'app-command') as well as a mouse event, others only as a mouse
// event: both come through here, and one press never moves twice.

type Dir = 'back' | 'forward'
type Source = 'mouse' | 'system'

let last: { dir: Dir; source: Source; at: number } | null = null

/** Go back or forward, unless the same press already did from the other source. */
export function historyNav(dir: Dir, source: Source): void {
  const now = Date.now()
  if (last && last.dir === dir && last.source !== source && now - last.at < 600) return
  last = { dir, source, at: now }
  // A dialog stays where it is: the page under it shouldn't change.
  if (document.querySelector('[data-modal]')) return
  if (dir === 'back') useStore.getState().goBack()
  else useStore.getState().goForward()
}

const BACK = 3
const FORWARD = 4

/** Listen for the mouse's back and forward buttons. Returns a function that stops listening. */
export function installMouseHistoryNav(): () => void {
  const swallow = (e: MouseEvent) => {
    if (e.button === BACK || e.button === FORWARD) e.preventDefault()
  }
  const onUp = (e: MouseEvent) => {
    if (e.button !== BACK && e.button !== FORWARD) return
    e.preventDefault()
    historyNav(e.button === BACK ? 'back' : 'forward', 'mouse')
  }
  window.addEventListener('mousedown', swallow)
  window.addEventListener('auxclick', swallow)
  window.addEventListener('mouseup', onUp)
  return () => {
    window.removeEventListener('mousedown', swallow)
    window.removeEventListener('auxclick', swallow)
    window.removeEventListener('mouseup', onUp)
  }
}
