// node scripts/course-shots.mjs [outDir]
// Builds a mock course (AI_MOCK) and screenshots each step of learning a topic.
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const out = process.argv[2] ?? 'docs/screenshots/course'
mkdirSync(out, { recursive: true })
const dir = mkdtempSync(join(tmpdir(), 'sw-course-shots-'))
const env = { ...process.env, AI_MOCK: '1', STUDYWISE_DATA_DIR: dir }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: ['.'], env })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await win.waitForTimeout(800)
await win.evaluate(() => window.studywise.settings.set({ key: 'onboarding.done', value: true }))
await win.reload()
await win.setViewportSize({ width: 1280, height: 860 })
await win.waitForTimeout(1000)

const transcript = join(dir, 'lecture-1-transcript.txt')
writeFileSync(transcript, 'Right, can everyone hear me? Good. So today, the photoelectric effect. This is important, it will come up in the exam.')
const pdf = resolve('tests/fixtures/photoelectric-lecture.pdf')

let n = 0
const shot = async (name) => {
  await win.waitForTimeout(450)
  await win.screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${name}.png`) })
}

// New course dialog, filled in.
await win.locator('.goo-links button', { hasText: 'Courses' }).click()
await win.waitForTimeout(400)
await shot('courses-empty')
await win.locator('main').getByRole('button', { name: /New course/ }).first().click()
await win.locator('[data-modal] input').first().fill('Quantum Physics 1')
await shot('new-course')
await win.keyboard.press('Escape')

const course = await win.evaluate(([a, b]) => window.studywise.courses.create({ name: 'Quantum Physics 1', level: 'first-year physics undergraduate', weekLabel: 'Week 1', files: [a, b] }), [pdf, transcript])
await win.waitForTimeout(1500)
await win.evaluate(([id, a]) => window.studywise.courses.addWeek({ courseId: id, label: 'Week 2', files: [a] }), [course.id, pdf])
await win.evaluate((id) => window.studywise.courses.addWeek({ courseId: id, label: 'Week 3' }), course.id)
await win.waitForTimeout(1500)
// Weeks with files are planned into topics (a job; the mock AI is quick).
const planned = await win.evaluate((id) => window.studywise.courses.get({ id }), course.id)
for (const w of planned.weeks.slice(0, 2)) await win.evaluate((weekId) => window.studywise.courses.plan({ weekId }), w.id)
for (let i = 0; i < 40; i++) {
  const c = await win.evaluate((id) => window.studywise.courses.get({ id }), course.id)
  if (c.weeks.slice(0, 2).every((w) => w.topics.length)) break
  await win.waitForTimeout(300)
}
const full = await win.evaluate((id) => window.studywise.courses.get({ id }), course.id)
const c1 = { topics: full.weeks.flatMap((w) => w.topics) }
await win.evaluate((ids) => window.studywise.courses.write({ topicIds: ids }), c1.topics.slice(0, 2).map((t) => t.id))
await win.waitForTimeout(2500)
await win.reload()
await win.waitForTimeout(800)
await win.locator('.goo-links button', { hasText: 'Courses' }).click()
await win.waitForTimeout(500)
await shot('courses-list')
await win.locator('main h3', { hasText: 'Quantum Physics 1' }).click()
await win.waitForTimeout(600)
await shot('course-page')
await win.locator('main').evaluate((m) => m.closest('.overflow-y-auto')?.scrollTo(0, 99999))
await shot('course-page-bottom')
await win.getByRole('button', { name: /Add next week/ }).click()
await shot('add-week')
await win.keyboard.press('Escape')
await win.locator('main').evaluate((m) => m.closest('.overflow-y-auto')?.scrollTo(0, 0))

// Learn topic 2 first so topic 1 can pull recall cards from it later.
const t = c1.topics[1]
await win.evaluate((id) => window.studywise.courses.progress({ topicId: id, progress: { section: 1, done: false, answered: 0, correct: 0, checkScore: null, checkTotal: null, lastStudied: null } }), c1.topics[0].id)
// Topics are on the week page.
await win.locator('main', { hasText: 'Week 1' }).getByText('Week 1', { exact: true }).first().click()
await win.waitForTimeout(600)
await shot('week-page')
await win.locator('main').getByRole('button', { name: /^Start$/ }).first().click()
await win.waitForTimeout(700)

const types = []
try {
for (let step = 0; step < 60; step++) {
  await win.waitForTimeout(500)
  const body = await win.locator('main').innerText()
  if (/Topic done/.test(body)) break
  const pill = await win.locator('main .pop-in').first().innerText().catch(() => '')
  if (/Got it/.test(body) && !/Match each/.test(body)) {
    await shot(`notes-${step}`)
    await win.getByRole('button', { name: /Got it/ }).click()
    continue
  }
  if (/Key terms[\s\S]{0,20}?\d+ of \d+ done/.test(body)) {
    // Red, yellow, green: each card is learnt after two greens.
    if (await win.getByRole('button', { name: /Show answer/ }).count()) {
      await shot(`cards-${step}`)
      await win.getByRole('button', { name: /Show answer/ }).click()
      await shot(`cards-${step}-flipped`)
    }
    await win.keyboard.press('3')
    continue
  }
  if (/Start the test/.test(body)) {
    await shot('check-intro')
    await win.getByRole('button', { name: /Start the test/ }).click()
    continue
  }
  if (/Quick recall/.test(body)) {
    await shot('recall')
    await win.getByRole('button', { name: /Show answer/ }).click()
    await win.getByRole('button', { name: /Knew it/ }).click()
    continue
  }
  const label = pill.split('\n')[0]
  types.push(label)
  // Answer something, then capture the marked state.
  if (/Multiple choice/.test(label)) await win.keyboard.press('1')
  else if (/True or false/.test(label)) await win.keyboard.press('f')
  else if (/Fill in the blank/.test(label)) {
    await win.locator('main input').first().fill('work function')
    await win.keyboard.press('Enter')
  } else if (/Spot the wrong word/.test(label)) {
    await shot('wrong-word')
    await win.getByRole('button', { name: 'highest', exact: true }).click()
  } else if (/Put in order/.test(label)) {
    await shot('order')
    await win.getByRole('button', { name: /Check order/ }).click()
  } else if (/Match up/.test(label)) {
    await shot('match')
    const left = win.locator('main [data-match="terms"] button')
    const right = win.locator('main [data-match="meanings"] button')
    const rc = await right.count()
    for (let i = 0; i < rc; i++) {
      await left.nth(i).click()
      await right.nth(i).click()
      if (i === rc - 2) await shot('match-joined')
    }
    await win.getByRole('button', { name: /Check matches/ }).click()
  } else if (/Sort/.test(label)) {
    await shot('sort')
    const chips = win.locator('main .bg-surface-2 > [draggable="true"]')
    for (let k = 0; k < 12 && (await chips.count()) > 0; k++) {
      await chips.first().click()
      await win.keyboard.press('1')
    }
    await win.getByRole('button', { name: /^Check$/ }).click()
  } else if (/own words/.test(label)) {
    await win.locator('main textarea').fill('Each photon has too little energy, and one photon frees one electron')
    await win.getByRole('button', { name: /Check answer/ }).click()
  }
  await win.locator('main').getByRole('button', { name: /^Continue/ }).waitFor({ timeout: 8000 })
  await shot(`marked-${label.toLowerCase().replace(/\W+/g, '-')}`)
  await win.locator('main').getByRole('button', { name: /^Continue/ }).click()
}
} catch (e) {
  await shot('FAILED')
  console.log(String(e).slice(0, 300))
}
await shot('summary')
// Back to the week page (the topic test may still be going: Save & exit).
const back = win.getByRole('button', { name: /Back to (course|week)|Save & exit/ }).first()
if (await back.count()) await back.click()
await win.waitForTimeout(600)
await shot('week-after')

// Dark mode, one notes screen.
await win.evaluate(() => window.studywise.settings.set({ key: 'ui.theme', value: 'dark' }))
await win.evaluate(() => document.documentElement.classList.add('dark'))
const start = win.locator('main').getByRole('button', { name: /^(Start|Continue)$/ }).first()
if (await start.count()) {
  await start.click()
  await win.waitForTimeout(700)
  await shot('dark-notes')
}

console.log(JSON.stringify({ types, errors }, null, 1))
await app.close()
