import { app, BrowserWindow, Notification, protocol, session, shell, net, nativeTheme } from 'electron'
import { join, extname, normalize, sep } from 'node:path'
import { recoverInterrupted, backfillNotes, organizeCourseDecks, organizeCourseNotes, fixTopicCardCounts, refreshDormancy } from './services/course'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { initPaths, paths } from './paths'
import { openDb } from './db'
import { backupOnUpgrade } from './upgradeBackup'
import { seedPresets } from './ai/presets'
import { aiQueue } from './ai'
import { detectClaude, setOverridePath } from './ai/claudePath'
import { registerIpc, broadcast, setAfterCall, refreshPlanUsage, runHandler } from './ipc'
import { configureSyncServer, startSyncServer, stopSyncServer } from './sync/server'
import { configureLink, startLinkSync, stopLinkSync } from './sync/link'
import { configureCloud, startCloudSync, stopCloudSync } from './sync/cloud'
import { buildMenu } from './menu'
import { loadWindowState, trackWindowState } from './windowState'
import { onJobEvent, runningJobCount, setUsageProbe } from './jobs'
import { activeProvider } from './ai/models'
import { isMock } from './ai'
import { startUpdateChecks, buildId } from './updater'
import * as repo from './db/repo'
import { SUPPORTED_SOURCE_EXT } from './files'

// Files the app accepts from Open With / the command line: sources plus Anki packages.
const OPENABLE_EXT = [...SUPPORTED_SOURCE_EXT, '.apkg', '.colpkg', '.studyweek']
import { startUsageTracking, onUsage } from './usage'

// ---- logging to ~/Library/Application Support/Studywise/logs/main.log ----
function setupLogging(): void {
  const file = join(paths.logs, 'main.log')
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      try {
        appendFileSync(file, `${new Date().toISOString()} [${level}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`)
      } catch {
        /* ignore */
      }
    }
  }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'studywise-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

let mainWindow: BrowserWindow | null = null
const IS_MAC = process.platform === 'darwin'

/** Windows draws its own min/max/close buttons over our nav bar; match its colours. */
function overlayColors(): Electron.TitleBarOverlayOptions {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: dark ? '#0b0e14' : '#ffffff', symbolColor: dark ? '#e8ecf3' : '#0e1420', height: 56 }
}
const pendingFiles: string[] = []
let rendererReady = false

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

// Single instance: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock()
process.stderr.write(`[studywise] single instance lock: ${gotLock ? 'acquired' : 'held by another instance'} (${app.getPath('userData')})\n`)
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const files = argv.filter((a) => OPENABLE_EXT.includes(extname(a).toLowerCase()))
    if (files.length) openFiles(files)
    showWindow()
  })
}

// Files dropped on the Dock icon or opened with "Open with Studywise".
app.on('open-file', (e, file) => {
  e.preventDefault()
  openFiles([file])
})

function openFiles(files: string[]): void {
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sw:event', { type: 'open-files', paths: files })
    showWindow()
  } else pendingFiles.push(...files)
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

function sendMenu(action: string): void {
  showWindow()
  const send = () => mainWindow?.webContents.send('sw:event', { type: 'menu', action })
  if (rendererReady) send()
  else mainWindow?.webContents.once('did-finish-load', () => setTimeout(send, 300))
}

function createWindow(): void {
  const state = loadWindowState()
  rendererReady = false
  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: 'Studywise',
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: overlayColors(), icon: join(__dirname, '../../resources/icon.png') }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0e14' : '#f8f9fb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  })
  if (state.maximized) mainWindow.maximize()
  // No traffic lights in fullscreen, so the nav can drop its left inset.
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('sw:event', { type: 'fullscreen', on: true }))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('sw:event', { type: 'fullscreen', on: false }))
  // Windows: the mouse's back/forward buttons (and keyboard media keys) move through history.
  mainWindow.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') mainWindow?.webContents.send('sw:event', { type: 'menu', action: 'go.back' })
    if (cmd === 'browser-forward') mainWindow?.webContents.send('sw:event', { type: 'menu', action: 'go.forward' })
  })
  trackWindowState(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  // No navigation away from the app and no popups; https links open in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = isDev ? url.startsWith(process.env.ELECTRON_RENDERER_URL!) : url.startsWith('file://')
    if (!allowed) {
      e.preventDefault()
      if (/^https:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true
    if (pendingFiles.length) {
      const files = pendingFiles.splice(0)
      setTimeout(() => mainWindow?.webContents.send('sw:event', { type: 'open-files', paths: files }), 500)
    }
  })

  if (isDev) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

function updateBadge(): void {
  try {
    const n = repo.totalDueToday()
    app.dock?.setBadge(n > 0 ? String(n) : '')
  } catch {
    /* db not ready */
  }
}

function setupCsp(): void {
  const csp = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: studywise-file:",
    "font-src 'self' data:",
    isDev ? "connect-src 'self' ws: http://localhost:*" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'"
  ].join('; ')
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  // No remote content at all: block any http(s) request that isn't the dev server.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    const ok = isDev && details.url.startsWith(process.env.ELECTRON_RENDERER_URL!.replace(/\/$/, ''))
    cb({ cancel: !ok && !details.url.startsWith('http://localhost') })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write' || permission === 'notifications'))
}

app.whenReady().then(async () => {
  // Packaged builds get the icon from the bundle; in dev, swap out Electron's.
  if (!app.isPackaged && IS_MAC) {
    try {
      app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
    } catch {
      /* icon missing */
    }
  }
  initPaths()
  setupLogging()
  if (!IS_MAC) {
    // Windows passes "Open with" files on the command line.
    pendingFiles.push(...process.argv.slice(1).filter((a) => OPENABLE_EXT.includes(extname(a).toLowerCase())))
    nativeTheme.on('updated', () => mainWindow?.setTitleBarOverlay?.(overlayColors()))
  }
  app.setAboutPanelOptions({
    applicationName: 'Studywise Courses',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    credits: 'AI features run through your own Claude Code login.'
  })
  try {
    // A copy run from git also counts a new commit (an update or a pull) as an upgrade.
    const version = buildId(app.getVersion())
    const saved = backupOnUpgrade(paths.db, paths.backups, paths.lastVersion, version)
    if (saved) console.log(`[upgrade] now ${version}; database copied to ${saved}`)
  } catch (e) {
    console.error('[upgrade] backup before upgrade failed:', e)
  }
  openDb(paths.db)
  seedPresets()
  recoverInterrupted()
  try {
    repo.moveSyncedSettings()
  } catch (e) {
    console.error('[sync] moving synced settings failed:', e)
  }
  try {
    organizeCourseDecks()
  } catch (e) {
    console.error('[courses] organising decks failed:', e)
  }
  try {
    organizeCourseNotes()
  } catch (e) {
    console.error('[courses] organising notes failed:', e)
  }
  try {
    const n = fixTopicCardCounts()
    if (n) console.log(`[courses] added the (n) point count to ${n} topic card${n === 1 ? '' : 's'}`)
  } catch (e) {
    console.error('[courses] fixing card point counts failed:', e)
  }
  try {
    const n = refreshDormancy()
    if (n) console.log(`[courses] ${n} topic card${n === 1 ? '' : 's'} now wait for (or joined) review based on what you've studied`)
  } catch (e) {
    console.error('[courses] updating which cards are studied failed:', e)
  }
  void backfillNotes().catch(() => {})
  aiQueue.setLimit(repo.getSetting<number>('ai.concurrency', 3))
  setOverridePath(repo.getSetting<string | null>('claude.overridePath', null))
  const theme = repo.getSetting<'system' | 'light' | 'dark'>('ui.theme', 'system')
  nativeTheme.themeSource = theme

  protocol.handle('studywise-file', (req) => {
    const u = new URL(req.url)
    const rel = normalize(decodeURIComponent(`${u.hostname}${u.pathname}`))
    const full = join(paths.userData, rel)
    if (!full.startsWith(paths.attachments + sep) && !(full.startsWith(paths.courses + sep) && full.endsWith('.png'))) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(full).toString())
  })

  setupCsp()
  startUsageTracking()
  onUsage((usage) => broadcast({ type: 'usage', usage }))
  registerIpc()
  setAfterCall((channel) => {
    if (/^(cards|learn|decks|courses)\./.test(channel)) updateBadge()
    if (channel === 'settings.set') nativeTheme.themeSource = repo.getSetting<'system' | 'light' | 'dark'>('ui.theme', 'system')
  })
  buildMenu(sendMenu)

  // Phone sync: phones run AI and other desktop-only work through the same handlers.
  configureSyncServer({
    rpc: runHandler,
    onSynced: (received) => {
      broadcast({ type: 'sync', received })
      if (received) updateBadge()
    }
  })
  if (repo.getSetting<boolean>('sync.enabled', false)) void startSyncServer()
  app.on('before-quit', () => void stopSyncServer())

  // Linked to another computer: sync with it in the background.
  configureLink({
    onStatus: (status) => broadcast({ type: 'link', status }),
    onReceived: (received) => {
      broadcast({ type: 'sync', received })
      updateBadge()
    }
  })
  startLinkSync()
  app.on('before-quit', () => stopLinkSync())

  // Syncing and backing up through the cloud (the marketplace server), when it's on.
  configureCloud({
    onStatus: (status) => broadcast({ type: 'cloud', status }),
    onReceived: (received) => {
      broadcast({ type: 'sync', received })
      updateBadge()
    }
  })
  startCloudSync()
  app.on('before-quit', () => stopCloudSync())

  onJobEvent((ev) => {
    if (ev.type === 'delta') {
      broadcast({ type: 'job:delta', jobId: ev.jobId, text: ev.text })
      return
    }
    broadcast({ type: 'job', job: ev.job })
    const j = ev.job
    if (!IS_MAC && j.finishedAt && runningJobCount() === 0 && BrowserWindow.getAllWindows().length === 0) app.quit()
    if ((j.status === 'done' || j.status === 'error') && j.finishedAt) {
      const focused = BrowserWindow.getFocusedWindow()
      if (!focused && Notification.isSupported()) {
        const n = new Notification({
          title: j.status === 'done' ? 'Studywise: finished' : 'Studywise: failed',
          body: j.status === 'done' ? `${j.title} is ready.` : `${j.title}: ${j.error ?? 'something went wrong'}`
        })
        n.on('click', () => {
          showWindow()
          mainWindow?.webContents.send('sw:event', { type: 'menu', action: 'go.jobs' })
        })
        n.show()
      }
      updateBadge()
    }
  })

  createWindow()
  updateBadge()
  startUpdateChecks((status) => broadcast({ type: 'update', status }))
  // Jobs measure how much of the 5-hour limit they used (Claude only).
  setUsageProbe({
    enabled: () => activeProvider() === 'claude' && !isMock(),
    onReading: (fn) => onUsage((u) => u.fiveHour && fn(u.fiveHour.utilization)),
    refresh: async () => (await refreshPlanUsage())?.fiveHour?.utilization ?? null
  })
  setInterval(updateBadge, 60_000)

  // Find claude on the login-shell PATH (Finder-launched apps don't get it).
  void detectClaude().then((s) => {
    broadcast({ type: 'claude:status', status: s })
    console.log('[claude]', s.path, s.version, s.loggedIn ? 'logged in' : 'not logged in')
  })

  app.on('activate', () => showWindow())
  app.on('browser-window-focus', updateBadge)
})

// Mac: keep running in the Dock when the window closes, so jobs keep going.
// Elsewhere: quit, unless a job is still running (then quit when it ends).
app.on('window-all-closed', () => {
  if (IS_MAC) return
  if (runningJobCount() === 0) app.quit()
})
