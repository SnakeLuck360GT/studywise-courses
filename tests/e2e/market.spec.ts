import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

// The marketplace against a fake server: add one week, download the missing
// ones into the remembered course, the "already have it" checks, and weeks
// listed by week number either way.

let app: ElectronApplication
let win: Page
let dir: string
let server: Server
let url: string

/** A shared week with nothing in it yet, as the server hands it out. */
async function studyweek(label: string): Promise<Buffer> {
  const zip = new JSZip()
  const week = { id: `00000000-0000-4000-8000-${label.replace(/\D/g, '').padStart(12, '0')}`, course_id: '00000000-0000-4000-8000-ffffffffffff', label, status: 'empty', position: 0 }
  zip.file('week.json', JSON.stringify({ app: 'studywise-courses', kind: 'week', format: 1, exportedAt: new Date().toISOString(), course: { name: 'Fake 101', module: '', level: '' }, week, files: [], topics: [], cards: [] }))
  return zip.generateAsync({ type: 'nodebuffer' })
}

const week = (id: string, label: string) => ({
  id, courseId: 'mc', label, number: 1, author: 'alex', topics: [{ title: `${label} topic`, goal: '', sections: [], levels: [] }], topicCount: 1, writtenCount: 0,
  cardCount: 0, files: [], size: 1000, plannedWith: null, writtenWith: [], downloads: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01', mine: false
})
const course = {
  id: 'mc', name: 'Fake 101', module: '', level: '', authors: ['alex'], weekCount: 3, topicCount: 3, cardCount: 0, models: [], downloads: 0,
  updatedAt: '2026-01-01', mine: false, weeks: [week('r1', 'Week 1'), week('r2', 'Week 2'), week('r5', 'Week 5')]
}

test.beforeAll(async () => {
  const files: Record<string, Buffer> = { r1: await studyweek('Week 1'), r2: await studyweek('Week 2'), r5: await studyweek('Week 5') }
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0]
    const file = path.match(/^\/api\/weeks\/(\w+)\/file$/)?.[1]
    const send = (body: unknown) => res.end(JSON.stringify(body))
    if (path === '/api/app/me') return send({ user: { name: 'me' } })
    if (path === '/api/courses') return send({ courses: [course] })
    if (path === '/api/courses/mc') return send({ course })
    if (path === '/api/similar') return send({ matches: [] })
    if (path === '/api/mine') return send({ weeks: [] })
    if (file && files[file]) return res.end(files[file])
    res.statusCode = 404
    send({ error: 'not found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  dir = mkdtempSync(join(tmpdir(), 'sw-e2e-market-'))
  const env = { ...process.env, AI_MOCK: '1', STUDYWISE_DATA_DIR: dir } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.'], env })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
})

test.afterAll(async () => {
  await app?.close()
  server?.close()
  rmSync(dir, { recursive: true, force: true })
})

const main = () => win.locator('main')
const modal = () => win.locator('[data-modal]')
/** A week's row on the marketplace course page. */
const row = (label: string) => main().locator('div.rounded-xl.border').filter({ hasText: new RegExp(`^${label}\\s*by`) })
const toCourses = () => main().getByRole('button', { name: 'Courses', exact: true }).click()

test('download a marketplace course into the remembered course, weeks in order', async () => {
  await expect(win.getByRole('heading', { name: 'Welcome to Studywise.' })).toBeVisible()
  for (let i = 0; i < 4; i++) {
    await win.getByRole('button', { name: /^(Continue|Skip for now)$/ }).click()
    await win.waitForTimeout(300)
  }
  await win.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(modal()).toHaveCount(0)

  // Connect to the fake marketplace.
  expect(await win.evaluate(([u]) => (globalThis as unknown as { studywise: { market: { configure: (i: { url: string; key: string }) => Promise<{ user: string }> } } }).studywise.market.configure({ url: u, key: 'swm_e2e' }), [url])).toEqual({ user: 'me' })

  // Courses → Marketplace → the course.
  await win.getByText('Courses', { exact: true }).first().click()
  await main().getByRole('button', { name: /Marketplace/ }).click()
  await main().getByRole('heading', { name: 'Fake 101' }).click()
  await expect(win.getByRole('heading', { level: 1 })).toHaveText('Fake 101')

  // Week 5 first, on its own: nowhere remembered yet, so it asks which course.
  await row('Week 5').getByRole('button', { name: 'Add to my courses' }).click()
  await expect(modal()).toContainText('Add “Week 5” from Fake 101')
  await modal().getByRole('button', { name: 'Add week' }).click()
  await expect(win.getByText(/Added Week 5/)).toBeVisible()
  await expect(win.getByRole('heading', { level: 1 })).toHaveText('Fake 101')
  await expect(main().locator('li')).toHaveCount(1)

  // Back to the marketplace course: Week 5 shows you have it.
  await toCourses()
  await main().getByRole('button', { name: /Marketplace/ }).click()
  await main().getByRole('heading', { name: 'Fake 101' }).click()
  await expect(row('Week 5').getByText('In Fake 101')).toBeVisible()
  await expect(row('Week 5').getByRole('button', { name: 'Add again' })).toBeVisible()

  // Download missing: straight to the remembered course, with Somewhere else… on offer.
  await main().getByRole('button', { name: 'Download missing weeks' }).click()
  await expect(modal()).toContainText('Download 2 weeks?')
  await expect(modal()).toContainText('Into Fake 101: Week 1, Week 2.')
  await expect(modal()).toContainText('1 week you already have is left out.')
  await expect(modal().getByRole('button', { name: 'Somewhere else…' })).toBeVisible()
  await modal().getByRole('button', { name: 'Download 2 weeks' }).click()
  await expect(win.getByText(/Added 2 weeks from the marketplace/)).toBeVisible({ timeout: 20_000 })
  for (const w of ['Week 1', 'Week 2', 'Week 5']) await expect(row(w).getByText('In Fake 101')).toBeVisible()

  // Adding one you have asks first.
  await row('Week 1').getByRole('button', { name: 'Add again' }).click()
  await expect(modal()).toContainText('You already have this week: Week 1 in Fake 101')
  await modal().getByRole('button', { name: 'Cancel' }).click()
  await expect(modal()).toHaveCount(0)

  // Nothing missing now, from the page or from the card's menu.
  await main().getByRole('button', { name: 'Download missing weeks' }).click()
  await expect(win.getByText('You already have all 3 of those weeks in Fake 101.')).toBeVisible()
  await main().getByRole('button', { name: 'Marketplace', exact: true }).click()
  await main().getByRole('button', { name: 'Download Fake 101' }).click()
  await win.getByRole('button', { name: 'Download all weeks…' }).click()
  await expect(win.getByText('You already have all 3 of those weeks in Fake 101.').last()).toBeVisible()
  await expect(win.getByRole('heading', { level: 1 })).toHaveText('Marketplace')

  // Your course: Week 5 was added first, but the weeks are in order, either way round.
  await toCourses()
  await main().getByText('Fake 101', { exact: true }).first().click()
  const labels = main().locator('li span.font-semibold')
  await expect(labels).toHaveText(['Week 1', 'Week 2', 'Week 5'])
  await main().getByRole('button', { name: 'Latest week first' }).click()
  await expect(labels).toHaveText(['Week 5', 'Week 2', 'Week 1'])
  // Remembered after leaving the page.
  await toCourses()
  await main().getByText('Fake 101', { exact: true }).first().click()
  await expect(labels).toHaveText(['Week 5', 'Week 2', 'Week 1'])
})
