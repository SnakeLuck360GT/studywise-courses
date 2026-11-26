import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Back and forward: the mouse's side buttons, the nav's buttons, Alt+arrows, and the
// system's command (Windows app-command) not doubling up with the mouse event.

let app: ElectronApplication
let win: Page
let dir: string

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-e2e-history-'))
  const env = { ...process.env, AI_MOCK: '1', STUDYWISE_DATA_DIR: dir } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.'], env })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

const heading = () => win.getByRole('heading', { level: 1 })
/** A press of the mouse's back (3) or forward (4) button, as the window sees it. */
const side = (button: 3 | 4) =>
  win.evaluate((b) => {
    const opts = { button: b, bubbles: true, cancelable: true }
    document.body.dispatchEvent(new MouseEvent('mousedown', opts))
    document.body.dispatchEvent(new MouseEvent('mouseup', opts))
  }, button)
/** What the main process sends for Windows' app-command. */
const system = (dir: 'back' | 'forward') => app.evaluate(({ BrowserWindow }, d) => BrowserWindow.getAllWindows()[0].webContents.send('sw:event', { type: 'nav', dir: d }), dir)

test('mouse side buttons, nav buttons and Alt+arrows move through history', async () => {
  await expect(win.getByRole('heading', { name: 'Welcome to Studywise.' })).toBeVisible()
  for (let i = 0; i < 4; i++) {
    await win.getByRole('button', { name: /^(Continue|Skip for now)$/ }).click()
    await win.waitForTimeout(300)
  }
  await win.getByRole('button', { name: 'Start', exact: true }).click()

  const nav = win.getByRole('navigation')
  await nav.getByRole('link', { name: 'Decks' }).or(nav.getByRole('button', { name: 'Decks' })).first().click()
  await expect(heading()).toHaveText('Decks')
  await nav.getByRole('link', { name: 'Settings' }).or(nav.getByRole('button', { name: 'Settings' })).first().click()
  await expect(heading()).toHaveText('Settings')

  // Mouse back → Decks, mouse forward → Settings.
  await side(3)
  await expect(heading()).toHaveText('Decks')
  await side(4)
  await expect(heading()).toHaveText('Settings')

  // The nav's back and forward buttons.
  await win.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(heading()).toHaveText('Decks')
  await win.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(heading()).toHaveText('Settings')
  await expect(win.getByRole('button', { name: 'Forward', exact: true })).toBeDisabled()

  // Alt+← / Alt+→.
  await win.keyboard.press('Alt+ArrowLeft')
  await expect(heading()).toHaveText('Decks')
  await win.keyboard.press('Alt+ArrowRight')
  await expect(heading()).toHaveText('Settings')

  // One press seen both as a mouse event and as the system's command moves once.
  await side(3)
  await system('back')
  await expect(heading()).toHaveText('Decks')
  await win.waitForTimeout(200)
  await expect(heading()).toHaveText('Decks')
  expect(await win.getByRole('button', { name: 'Back', exact: true }).isEnabled()).toBe(true)

  // The system's command on its own still works (a mouse that only sends that).
  await system('forward')
  await expect(heading()).toHaveText('Settings')
})
