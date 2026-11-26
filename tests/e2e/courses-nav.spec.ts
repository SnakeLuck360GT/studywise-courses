import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'

// The Courses tab always opens the Courses page (not the course you were last in), and a
// topic you left partway through shows Continue there (and on the home page).

let app: ElectronApplication
let win: Page
let dir: string

/** A shared week with one written topic of three sections. */
async function studyweek(): Promise<Buffer> {
  const courseId = randomUUID()
  const weekId = randomUUID()
  const headings = ['Photons carry energy', 'The work function', 'Threshold frequency']
  const content = {
    title: 'Light as particles',
    goal: 'Why light behaves like particles',
    sections: headings.map((heading) => ({ heading, notes: `Notes about ${heading.toLowerCase()}.`, figure: null, questions: [] })),
    check: []
  }
  const plan = { id: 'w1t1', title: content.title, goal: content.goal, sections: headings, needs: [], sources: [] }
  const week = { id: weekId, course_id: courseId, position: 0, label: 'Week 1', status: 'ready', error: null, outline: null }
  const topic = { id: randomUUID(), course_id: courseId, week_id: weekId, key: 'w1t1', position: 0, plan: JSON.stringify(plan), status: 'ready', error: null, content: JSON.stringify(content), level: 'standard', versions: '{}', progress: '{}', written_with: '{}' }
  const zip = new JSZip()
  zip.file('week.json', JSON.stringify({ app: 'studywise-courses', kind: 'week', format: 1, exportedAt: new Date().toISOString(), course: { name: 'Optics 101', module: '', level: '' }, week, files: [], topics: [topic], cards: [] }))
  return zip.generateAsync({ type: 'nodebuffer' })
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-e2e-coursesnav-'))
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

test('Courses tab opens the Courses page, with Continue for a topic left partway', async () => {
  await expect(win.getByRole('heading', { name: 'Welcome to Studywise.' })).toBeVisible()
  for (let i = 0; i < 4; i++) {
    await win.getByRole('button', { name: /^(Continue|Skip for now)$/ }).click()
    await win.waitForTimeout(300)
  }
  await win.getByRole('button', { name: 'Start', exact: true }).click()

  const file = join(dir, 'optics.studyweek')
  writeFileSync(file, await studyweek())
  await win.evaluate((f) => (globalThis as unknown as { studywise: { courses: { importWeek: (i: { file: string; courseId: null }) => Promise<unknown> } } }).studywise.courses.importWeek({ file: f, courseId: null }), file)

  const nav = win.getByRole('navigation')
  const coursesTab = () => nav.getByRole('link', { name: 'Courses', exact: true }).or(nav.getByRole('button', { name: 'Courses', exact: true })).first()
  const heading = () => win.getByRole('heading', { level: 1 })
  await coursesTab().click()
  await expect(heading()).toHaveText('Courses')
  // Nothing left partway yet.
  await expect(win.getByText('Pick up where you left off')).toHaveCount(0)

  // Into the course, its week and the topic; on to the second section.
  await win.getByText('Optics 101').first().click()
  await expect(heading()).toHaveText('Optics 101')
  await win.getByText('Light as particles').first().click()
  await expect(win.getByText('Photons carry energy').first()).toBeVisible({ timeout: 10000 })
  await win.keyboard.press('Enter')
  await expect(win.getByText('The work function').first()).toBeVisible()
  await win.waitForTimeout(800)

  // The Courses tab: the Courses page, not the topic, with Continue.
  await coursesTab().click()
  await expect(heading()).toHaveText('Courses')
  const card = win.locator('section', { hasText: 'Pick up where you left off' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Light as particles')
  await expect(card).toContainText('Section 2 of 3')

  // From inside a course too, the tab goes to the list.
  await win.getByText('Optics 101').first().click()
  await expect(heading()).toHaveText('Optics 101')
  await coursesTab().click()
  await expect(heading()).toHaveText('Courses')

  // Continue goes back to the section you were on.
  await card.getByRole('button', { name: /Continue/ }).click()
  await expect(win.getByText('The work function').first()).toBeVisible()
  await expect(win.getByRole('heading', { level: 1, name: 'Courses', exact: true })).toHaveCount(0)

  // The home page offers it too.
  await nav.getByRole('link', { name: 'Home', exact: true }).or(nav.getByRole('button', { name: 'Home', exact: true })).first().click()
  await expect(win.locator('section', { hasText: 'Pick up where you left off' })).toContainText('Light as particles')

  // Dismissing it on Courses forgets it everywhere.
  await coursesTab().click()
  await win.locator('section', { hasText: 'Pick up where you left off' }).getByRole('button', { name: 'Dismiss' }).click()
  await expect(win.getByText('Pick up where you left off')).toHaveCount(0)
  await nav.getByRole('link', { name: 'Home', exact: true }).or(nav.getByRole('button', { name: 'Home', exact: true })).first().click()
  await win.waitForTimeout(500)
  await expect(win.getByText('Pick up where you left off')).toHaveCount(0)
})
