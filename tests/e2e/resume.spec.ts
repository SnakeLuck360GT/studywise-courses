import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Quit partway through a Learn session → the app opens on the home page with Continue → back in Learn.

let app: ElectronApplication
let win: Page
let dir: string

async function launch() {
  const env = { ...process.env, AI_MOCK: '1', STUDYWISE_DATA_DIR: dir } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.'], env })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-e2e-resume-'))
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('quitting mid-session opens on home with Continue', async () => {
  await expect(win.getByRole('heading', { name: 'Welcome to Studywise.' })).toBeVisible()
  for (let i = 0; i < 4; i++) {
    await win.getByRole('button', { name: /^(Continue|Skip for now)$/ }).click()
    await win.waitForTimeout(300)
  }
  await win.getByRole('button', { name: 'Start', exact: true }).click()

  await win.getByRole('button', { name: /New deck/ }).first().click()
  await win.locator('[data-modal] input').fill('Optics')
  await win.locator('[data-modal]').getByRole('button', { name: 'Create' }).click()
  await expect(win.getByRole('heading', { level: 1 })).toHaveText('Optics')
  for (const [front, back] of [
    ['Speed of light?', '3 × 10⁸ m/s'],
    ['Unit of frequency?', 'hertz'],
    ['What does a lens do?', 'It **refracts** light']
  ]) {
    await win.getByRole('button', { name: /^Add card/ }).first().click()
    const areas = win.locator('[data-modal] textarea')
    await areas.nth(0).fill(front)
    await areas.nth(1).fill(back)
    await win.locator('[data-modal]').getByRole('button', { name: 'Add card' }).click()
    await expect(win.locator('[data-modal]')).toHaveCount(0)
  }

  // Start Learn, and quit while the first question is up.
  await win.getByRole('button', { name: /^Learn/ }).first().click()
  await expect(win.locator('main [data-qtype]').first()).toBeVisible({ timeout: 15000 })
  await win.waitForTimeout(800)
  await app.close()

  // Relaunch: the home page (not the deck you were on), offering to carry on.
  await launch()
  await expect(win.getByText('Pick up where you left off · Learn')).toBeVisible({ timeout: 15000 })
  await expect(win.getByText('Optics', { exact: true }).first()).toBeVisible()
  await expect(win.getByRole('heading', { level: 1 })).toContainText(/due/)
  await win.getByRole('button', { name: /^Continue/ }).click()
  await expect(win.locator('main [data-qtype]').first()).toBeVisible({ timeout: 15000 })

  // Dismissing it forgets the session.
  await win.getByRole('button', { name: 'Home' }).first().click()
  await win.getByRole('button', { name: 'Dismiss' }).click()
  await expect(win.getByText(/Pick up where you left off/)).toHaveCount(0)
})
