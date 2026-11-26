import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, basename, dirname, normalize, sep } from 'node:path'
import JSZip from 'jszip'
import { exportObsidian, exportNotion } from '@shared/noteFormats'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import * as repo from './db/repo'
import * as presets from './ai/presets'
import * as models from './ai/models'
import { runAI, renderPrompt, friendlyError, aiQueue, isMock } from './ai'
import { detectClaude, getClaudeStatus, setOverridePath } from './ai/claudePath'
import * as ollama from './ai/ollama'
import * as anki from './anki'
import { startJob, cancelJob, listJobs, clearFinishedJobs, getJob } from './jobs'
import * as gen from './services/generate'
import * as learn from './services/learn'
import * as updates from './updater'
import * as explain from './services/explain'
import * as course from './services/course'
import * as noteOrder from './services/noteOrder'
import * as weekShare from './services/weekShare'
import * as market from './services/market'
import { CARD_CUTS, COURSE_FOCUSES, CourseQuestion, NOTE_LEVELS, WEEK_TEST_LEVELS } from '@shared/course'
import * as io from './importexport'
import { backupLibrary, restoreLibrary } from './backup'
import * as library from './library'
import { paths } from './paths'
import { getUsage } from './usage'
import * as syncServer from './sync/server'
import * as syncLink from './sync/link'
import * as syncCloud from './sync/cloud'
import {
  CardInput,
  CardFormat,
  CardKind,
  McOption,
  CardSource,
  ModelChoice,
  AiProvider,
  LearnSettings,
  Thresholds,
  CustomAction,
  OutputMode
} from '@shared/types'
import { TASKS, TASK_INFO, type TaskId } from '@shared/tasks'
import { validateCards } from '@shared/ssText'
import type { LearnQuestion, LearnAnswer } from '@shared/questions'

// ---------------------------------------------------------------------------
// Handler helper: every IPC payload goes through a zod schema.

interface Ctx {
  sender: WebContents
  stream: (streamId: string | undefined) => ((t: string) => void) | undefined
}
// In = what callers send (zod input type), P = what the handler gets after parsing.
interface Handler<In, P, O> {
  input: z.ZodType<P>
  fn: (input: P, ctx: Ctx) => Promise<O> | O
  _in?: In
}
function h<S extends z.ZodType, O>(input: S, fn: (input: z.output<S>, ctx: Ctx) => Promise<O> | O): Handler<z.input<S>, z.output<S>, O> {
  return { input: input as unknown as z.ZodType<z.output<S>>, fn }
}
const none = z.undefined().or(z.null()).or(z.object({}).strict()).optional()
const id = z.string().min(1)
/** Marketplace courses to download, each into one of your courses (null: a new one). */
const addCourses = z.object({
  targets: z.array(z.object({ marketCourseId: id, courseId: z.string().nullable() })).min(1).max(500),
  mode: z.enum(['all', 'missing']),
  onlyMine: z.boolean().optional(),
  /** Levels of detail to download (quick, standard, deep, simple); every level when missing. */
  levels: z.array(z.enum(NOTE_LEVELS)).min(1).optional()
})
const streamId = z.string().optional()

const CardPatch = CardInput.partial().extend({
  format: CardFormat.optional(),
  kind: CardKind.optional(),
  options: z.array(McOption).optional(),
  source: CardSource.nullable().optional()
})

const ExplainCtx = z.object({
  cardId: z.string().nullable().optional(),
  noteId: z.string().nullable().optional(),
  selection: z.string().nullable().optional(),
  question: z.string().nullable().optional(),
  userAnswer: z.string().nullable().optional(),
  expectedAnswer: z.string().nullable().optional(),
  deckId: z.string().nullable().optional()
})

// Learn questions/answers are produced by us; validate the outer shape.
const LearnQuestionSchema = z.object({
  id: z.string(),
  type: z.enum(['read_understand', 'multiple_choice', 'free_answer', 'true_false', 'match_pairs', 'categorize', 'fill_blank', 'choice_blank']),
  card_id: z.string(),
  card_ids: z.array(z.string()),
  payload: z.record(z.string(), z.unknown()),
  cached: z.boolean()
}) as unknown as z.ZodType<LearnQuestion>
const LearnAnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read_understand') }),
  z.object({ type: z.literal('multiple_choice'), index: z.number().int() }),
  z.object({ type: z.literal('true_false'), value: z.boolean() }),
  z.object({ type: z.literal('free_answer'), text: z.string().max(20000) }),
  z.object({ type: z.literal('match_pairs'), mapping: z.record(z.string(), z.number()) }),
  z.object({ type: z.literal('categorize'), assignments: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal('fill_blank'), values: z.array(z.string()) }),
  z.object({ type: z.literal('choice_blank'), values: z.array(z.string()) })
]) as unknown as z.ZodType<LearnAnswer>

const PreviewCardSchema = z.object({
  key: z.string().optional(),
  format: CardFormat.default('term_definition'),
  kind: CardKind.default('regular'),
  front: z.string(),
  back: z.string(),
  language: z.string().nullable().optional(),
  options: z.array(McOption).default([]),
  cloze_answers: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  hints: z.array(z.string()).default([]),
  explanation: z.string().default(''),
  source: CardSource.nullable().optional(),
  required_points: z.number().nullable().optional()
})

async function pickFiles(win: BrowserWindow | null, filters: Electron.FileFilter[], multi = true): Promise<string[]> {
  const opts: Electron.OpenDialogOptions = { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? [] : r.filePaths
}
async function pickSave(win: BrowserWindow | null, defaultPath: string, filters: Electron.FileFilter[]): Promise<string | null> {
  const opts: Electron.SaveDialogOptions = { defaultPath, filters }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  return r.canceled || !r.filePath ? null : r.filePath
}
const winOf = (ctx: Ctx) => BrowserWindow.fromWebContents(ctx.sender)
const safeName = (s: string) => s.replace(/[/\\:*?"<>|]+/g, '-').trim() || 'export'

function saveImportedImage(name: string, data: Buffer): string {
  mkdirSync(paths.attachments, { recursive: true })
  const fname = `${randomUUID()}${extname(name).toLowerCase() || '.png'}`
  writeFileSync(join(paths.attachments, fname), data)
  return `studywise-file://attachments/${fname}`
}

/** Anki package → decks. With intoDeckId everything goes into that deck; otherwise
 * one deck per Anki deck (in a folder named after the file when there are several). */
async function importAnki(file: string, intoDeckId: string | null): Promise<{ deckIds: string[]; cards: number; skipped: number }> {
  const pkg = await anki.readAnkiPackage(file, { keepSchedule: repo.getSetting<boolean>('anki.keepSchedule', true), saveImage: saveImportedImage })
  if (!pkg.decks.length) throw new Error(`No cards found in ${basename(file)}${pkg.skipped ? ` (${pkg.skipped} couldn’t be converted)` : ''}`)
  const folder = !intoDeckId && pkg.decks.length > 1 ? repo.createFolder(anki.ankiStem(file), 'deck') : null
  const deckIds: string[] = []
  let total = 0
  for (const d of pkg.decks) {
    const deckId = intoDeckId ?? repo.createDeck({ name: d.name, folder_id: folder?.id ?? null }).id
    if (!deckIds.includes(deckId)) deckIds.push(deckId)
    const created = repo.createCards(d.cards.map((c) => ({ ...c.input, deck_id: deckId })))
    created.forEach((card, i) => {
      const s = d.cards[i].schedule
      if (s) repo.writeReviewState({ ...s, card_id: card.id })
    })
    total += created.length
  }
  if (pkg.skipped) console.warn(`[anki] ${basename(file)}: skipped ${pkg.skipped} cards that couldn't be converted`)
  return { deckIds, cards: total, skipped: pkg.skipped }
}

const CARD_EXTENSIONS = ['txt', 'xlsx', 'csv', 'json', 'apkg', 'colpkg']

async function importCardsFromFile(file: string, deckId: string): Promise<number> {
  const ext = extname(file).toLowerCase()
  if (anki.isAnkiFile(file)) return (await importAnki(file, deckId)).cards
  let cards: z.input<typeof CardInput>[]
  if (ext === '.xlsx') cards = await io.cardsFromXlsx(file, deckId)
  else if (ext === '.csv') cards = io.cardsFromCsv(readFileSync(file, 'utf8'), deckId)
  else if (ext === '.json') {
    const j = io.DeckJson.parse(JSON.parse(readFileSync(file, 'utf8')))
    cards = j.cards.map((c) => ({ ...c, deck_id: deckId }))
  } else cards = io.cardsFromStudySmarterText(readFileSync(file, 'utf8'), deckId)
  return repo.createCards(cards).length
}

// ---------------------------------------------------------------------------

export const handlers = {
  updates: {
    status: h(none, () => updates.updateStatus()),
    check: h(none, () => updates.checkForUpdate()),
    apply: h(none, () => updates.applyUpdate())
  },
  app: {
    info: h(none, () => ({
      version: app.getVersion(),
      name: app.getName(),
      userData: paths.userData,
      electron: process.versions.electron,
      mock: isMock(),
      platform: process.platform
    })),
    showDataFolder: h(none, () => shell.openPath(paths.userData).then(() => true)),
    openExternal: h(z.object({ url: z.string().url() }), ({ url }) => {
      if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened')
      return shell.openExternal(url).then(() => true)
    }),
    backup: h(none, async (_i, ctx) => {
      const file = await pickSave(winOf(ctx), `Studywise backup ${new Date().toISOString().slice(0, 10)}.zip`, [{ name: 'Zip', extensions: ['zip'] }])
      if (!file) return null
      await backupLibrary(file)
      return file
    }),
    restore: h(none, async (_i, ctx) => {
      const [file] = await pickFiles(winOf(ctx), [{ name: 'Studywise backup', extensions: ['zip'] }], false)
      if (!file) return false
      const win = winOf(ctx)
      const ok = await dialog.showMessageBox(win!, {
        type: 'warning',
        buttons: ['Restore and Relaunch', 'Cancel'],
        defaultId: 1,
        message: 'Replace your whole library with this backup?',
        detail: 'Your current decks, notes and settings will be replaced. Studywise will relaunch.'
      })
      if (ok.response !== 0) return false
      await restoreLibrary(file)
      app.relaunch()
      app.exit(0)
      return true
    }),
    saveAttachment: h(z.object({ name: z.string(), data: z.instanceof(Uint8Array) }), ({ name, data }) => {
      mkdirSync(paths.attachments, { recursive: true })
      const fname = `${randomUUID()}${extname(name).toLowerCase() || '.png'}`
      writeFileSync(join(paths.attachments, fname), data)
      return `studywise-file://attachments/${fname}`
    }),
    pickFiles: h(z.object({ kind: z.enum(['sources', 'cards', 'notes', 'course']) }), ({ kind }, ctx) => {
      const filters: Record<string, Electron.FileFilter[]> = {
        sources: [{ name: 'Documents', extensions: ['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown'] }],
        course: [{ name: 'Slides, transcripts and readings', extensions: course.COURSE_SOURCE_EXT.map((e) => e.slice(1)) }],
        cards: [{ name: 'Cards', extensions: CARD_EXTENSIONS }],
        notes: [{ name: 'Notes', extensions: ['md', 'markdown', 'txt', 'zip', 'pdf'] }]
      }
      return pickFiles(winOf(ctx), filters[kind])
    })
  },

  settings: {
    // secret.* (the Ollama key) never goes to the page.
    all: h(none, () => Object.fromEntries(Object.entries(repo.allSettings()).filter(([k]) => !k.startsWith('secret.')))),
    set: h(z.object({ key: z.string().regex(/^[\w.]+$/).refine((k) => !k.startsWith('secret.'), 'reserved key'), value: z.unknown() }), ({ key, value }) => {
      repo.setSetting(key, value)
      if (key === 'ai.concurrency') aiQueue.setLimit(Number(value) || 3)
      return true
    })
  },

  claude: {
    status: h(none, () => getClaudeStatus()),
    recheck: h(none, () => detectClaude({ force: true })),
    choose: h(none, async (_i, ctx) => {
      const [file] = await pickFiles(winOf(ctx), [], false)
      if (!file) return getClaudeStatus()
      repo.setSetting('claude.overridePath', file)
      setOverridePath(file)
      return detectClaude()
    }),
    clearOverride: h(none, () => {
      repo.setSetting('claude.overridePath', null)
      setOverridePath(null)
      return detectClaude()
    })
  },

  folders: {
    list: h(z.object({ kind: z.enum(['deck', 'note']).optional() }).optional(), (i) => repo.listFolders(i?.kind)),
    create: h(z.object({ name: z.string().min(1), kind: z.enum(['deck', 'note']), parent_id: z.string().nullable().optional() }), (i) => repo.createFolder(i.name, i.kind, i.parent_id ?? null)),
    rename: h(z.object({ id, name: z.string().min(1) }), (i) => repo.renameFolder(i.id, i.name)),
    delete: h(z.object({ id }), (i) => repo.deleteFolder(i.id))
  },

  decks: {
    list: h(none, () => repo.listDecks()),
    get: h(z.object({ id }), (i) => repo.getDeck(i.id)),
    create: h(z.object({ name: z.string().min(1), folder_id: z.string().nullable().optional(), description: z.string().optional() }), (i) => repo.createDeck(i)),
    update: h(
      z.object({
        id,
        patch: z.object({
          name: z.string().min(1).optional(),
          folder_id: z.string().nullable().optional(),
          description: z.string().optional(),
          extra_instructions: z.string().optional(),
          model_overrides: z.record(z.string(), ModelChoice).optional(),
          learn_settings: LearnSettings.nullable().optional(),
          thresholds: Thresholds.nullable().optional()
        })
      }),
      (i) => repo.updateDeck(i.id, i.patch)
    ),
    delete: h(z.object({ id }), (i) => repo.deleteDeck(i.id)),
    stats: h(z.object({ id }), (i) => repo.deckStats(i.id)),
    overview: h(none, () => repo.overview()),
    due: h(z.object({ id }), (i) => repo.dueCards(i.id))
  },

  cards: {
    list: h(z.object({ deckId: id }), (i) => repo.listCards(i.deckId)),
    get: h(z.object({ id }), (i) => repo.getCard(i.id)),
    create: h(z.object({ cards: z.array(CardInput).max(5000) }), (i) => repo.createCards(i.cards)),
    update: h(z.object({ id, patch: CardPatch }), (i) => repo.updateCard(i.id, i.patch)),
    delete: h(z.object({ ids: z.array(id) }), (i) => repo.deleteCards(i.ids)),
    move: h(z.object({ ids: z.array(id), deckId: id }), (i) => repo.moveCards(i.ids, i.deckId)),
    search: h(z.object({ q: z.string(), deckId: z.string().optional() }), (i) => repo.searchCards(i.q, i.deckId)),
    review: h(z.object({ cardId: id, rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }), (i) => repo.applyReview(i.cardId, i.rating, 'flashcard')),
    reviewState: h(z.object({ cardId: id }), (i) => repo.getReviewState(i.cardId)),
    restoreReview: h(
      z.object({
        cardId: id,
        state: z
          .object({ ease: z.number(), interval: z.number(), repetitions: z.number(), lapses: z.number(), due: z.string(), last_reviewed: z.string().nullable(), difficulty: z.number().optional(), sr_state: z.number().optional(), good_count: z.number().optional() })
          .nullable()
      }),
      async (i) => {
        const { getDb } = await import('./db')
        const d = getDb()
        if (i.state) repo.writeReviewState({ difficulty: 0.6, sr_state: 0, good_count: 0, ...i.state, card_id: i.cardId })
        else d.prepare('DELETE FROM review_state WHERE card_id = ?').run(i.cardId)
        d.prepare("DELETE FROM review_log WHERE id = (SELECT MAX(id) FROM review_log WHERE card_id = ? AND source = 'flashcard')").run(i.cardId)
        return true
      }
    ),
    validate: h(z.object({ cards: z.array(z.object({ front: z.string(), back: z.string() })) }), (i) => validateCards(i.cards))
  },

  notes: {
    list: h(none, () => repo.listNotes()),
    get: h(z.object({ id }), (i) => repo.getNote(i.id)),
    create: h(
      z.object({ title: z.string().optional(), module: z.string().optional(), type: z.string().optional(), week: z.string().optional(), content: z.string().optional(), folder_id: z.string().nullable().optional() }),
      (i) => repo.createNote(i)
    ),
    update: h(
      z.object({
        id,
        patch: z.object({ title: z.string().optional(), module: z.string().optional(), type: z.string().optional(), week: z.string().optional(), content: z.string().optional(), folder_id: z.string().nullable().optional() })
      }),
      (i) => {
        const before = repo.getNote(i.id).folder_id
        const n = repo.updateNote(i.id, i.patch)
        // Moved to another folder: its place there, in revision order.
        if (i.patch.folder_id !== undefined && i.patch.folder_id !== before && n.position !== null) noteOrder.placeNote(i.id)
        return n
      }
    ),
    delete: h(z.object({ id }), (i) => repo.deleteNote(i.id)),
    linkDeck: h(z.object({ noteId: id, deckId: id, linked: z.boolean() }), (i) => repo.linkNoteDeck(i.noteId, i.deckId, i.linked)),
    forDeck: h(z.object({ deckId: id }), (i) => repo.notesForDeck(i.deckId)),
    /** Put a folder's notes (and the folders inside it), or every note, in revision order. */
    revisionOrder: h(z.object({ folderId: z.string().nullable().default(null) }), (i) => ({ ordered: noteOrder.putInRevisionOrder(i.folderId) })),
    ai: h(
      z.object({ kind: z.enum(['simplify', 'shorten', 'fix_formatting', 'expand']), text: z.string().min(1), noteId: z.string().nullable(), streamId }),
      (i, ctx) => explain.noteAction(i.kind, i.text, i.noteId, ctx.stream(i.streamId) ?? (() => {}))
    ),
    /** "Quiz me on this": make a few cards from the selection into a quiz deck. */
    quiz: h(z.object({ noteId: id, text: z.string().min(1) }), async (i) => {
      const note = repo.getNote(i.noteId)
      const name = `Quiz: ${note.title}`
      const deck = repo.listDecks().find((d) => d.name === name) ?? repo.createDeck({ name })
      repo.linkNoteDeck(note.id, deck.id, true)
      const job = await gen.generateCards(
        { sources: { files: [], topic: '', text: i.text, noteIds: [] }, deckId: deck.id, presetId: presets.getPresetByKey('cards.standard')?.id, format: 'question_answer', cardType: 'regular', language: '', instructions: 'Make 3–6 cards that test the key ideas.', count: 5 },
        { signal: new AbortController().signal, progress: () => {}, delta: () => {}, meta: () => {} }
      )
      const created = repo.createCards(job.cards.map(({ key: _k, ...c }) => ({ ...c, deck_id: deck.id, source: { type: 'note' as const, noteId: note.id, section: gen.bestSection(note.content, i.text) } })))
      return { deckId: deck.id, cardIds: created.map((c) => c.id) }
    })
  },

  gen: {
    notes: h(gen.GenerateNotesInput, (i) =>
      startJob('generate_notes', `Notes: ${i.title || i.sources.topic || (i.sources.files[0] ? basename(i.sources.files[0]) : 'from notes')}`, (ctx) => gen.generateNotes(i, ctx))
    ),
    cards: h(gen.GenerateCardsInput, (i) =>
      startJob('generate_cards', `Flashcards: ${i.sources.topic || (i.sources.files[0] ? basename(i.sources.files[0]) : i.sources.noteIds.length ? 'from notes' : 'from text')}`, (ctx) => gen.generateCards(i, ctx))
    ),
    fixCard: h(z.object({ front: z.string(), back: z.string(), problem: z.string().default(''), deckId: z.string().nullable().optional(), regenerate: z.boolean().optional(), format: CardFormat.optional() }), (i) => gen.fixCard(i)),
    save: h(z.object({ deckId: id, cards: z.array(PreviewCardSchema).max(5000) }), (i) =>
      repo.createCards(i.cards.map(({ key: _k, ...c }) => ({ ...c, deck_id: i.deckId, required_points: c.required_points ?? null, source: c.source ?? null, language: c.language ?? null }))).length
    )
  },

  courses: {
    list: h(none, () => course.listCourses()),
    get: h(z.object({ id }), (i) => course.getCourse(i.id)),
    // Files are only added here; planning waits until you say so (courses.plan).
    // Public unless made private: private courses and weeks never go on the marketplace.
    create: h(
      z.object({
        name: z.string().min(1).max(200),
        level: z.string().max(200).default(''),
        weekLabel: z.string().max(100).default(''),
        files: z.array(z.string()).max(200).default([]),
        note: z.string().max(4000).default(''),
        focus: z.array(z.enum(COURSE_FOCUSES)).max(COURSE_FOCUSES.length).default([]),
        private: z.boolean().default(false),
        weekPrivate: z.boolean().optional()
      }),
      async (i) => {
      const c = course.createCourse(i)
      if (i.note.trim()) course.setCourseNote(c.id, i.note)
      if (i.focus.length) course.setCourseFocus(c.id, i.focus)
      const w = course.addWeek(c.id, i.weekLabel, { private: i.weekPrivate })
      if (i.files.length) await course.addFiles(w.id, i.files)
      return { ...course.getCourse(c.id), firstWeekId: w.id }
      }
    ),
    /** No `private`: the week is like its course. */
    addWeek: h(z.object({ courseId: id, label: z.string().max(100).default(''), files: z.array(z.string()).max(200).default([]), private: z.boolean().optional() }), async (i) => {
      const w = course.addWeek(i.courseId, i.label, { private: i.private })
      if (i.files.length) await course.addFiles(w.id, i.files)
      return w
    }),
    renameWeek: h(z.object({ weekId: id, label: z.string().min(1).max(100) }), (i) => course.renameWeek(i.weekId, i.label)),
    deleteWeek: h(z.object({ weekId: id }), (i) => course.deleteWeek(i.weekId)),
    /** Merge duplicate weeks of a course into one (nothing generated or cut; the AI only spots repeated questions); the others are removed. */
    mergeWeeks: h(z.object({ weekId: id, otherIds: z.array(id).min(1).max(30) }), async (i) => {
      // The AI checks for questions that ask the same thing; without AI it merges as before.
      const r = await course.mergeWeeksChecked(i.weekId, i.otherIds)
      market.recordWeeksMerged(i.weekId, i.otherIds)
      return r
    }),
    addFiles: h(z.object({ weekId: id, files: z.array(z.string()).min(1).max(200) }), (i) => course.addFiles(i.weekId, i.files)),
    removeFile: h(z.object({ fileId: id }), (i) => course.removeFile(i.fileId)),
    // Opens the course's copy of a file in its default app, or shows it in Explorer/Finder.
    openFile: h(z.object({ fileId: id, reveal: z.boolean().default(false) }), async (i) => {
      const p = course.courseFilePath(i.fileId)
      if (i.reveal) shell.showItemInFolder(p)
      else {
        const err = await shell.openPath(p)
        if (err) throw new Error(err)
      }
      return true
    }),
    /** Plan a week's topics; `test`: also write an end-of-week test at that difficulty, once the topics are planned. */
    plan: h(z.object({ weekId: id, instructions: z.string().max(4000).default(''), test: z.enum(WEEK_TEST_LEVELS).nullable().default(null) }), (i) => {
      const c = course.getCourse(course.getCourseIdForWeek(i.weekId))
      const w = c.weeks.find((x) => x.id === i.weekId)!
      return startJob('course_outline', `Plan: ${c.name} · ${w.label}`, async (ctx) => {
        const r: { topics: number; test?: number; testError?: string } = await course.planWeek(i.weekId, ctx, i.instructions)
        if (!i.test) return r
        // The topics are in either way: a test that doesn't work out is reported, not a failed plan.
        try {
          r.test = (await course.writeWeekTest(i.weekId, ctx, i.test)).questions
        } catch (e) {
          if (ctx.signal.aborted) throw e
          r.testError = (e as Error).message
        }
        return r
      })
    }),
    /** Write (or write again) a week's end-of-week test: multiple choice, at a difficulty. */
    writeWeekTest: h(z.object({ weekId: id, difficulty: z.enum(WEEK_TEST_LEVELS), instructions: z.string().max(4000).default('') }), (i) => {
      const c = course.getCourse(course.getCourseIdForWeek(i.weekId))
      const w = c.weeks.find((x) => x.id === i.weekId)!
      return startJob('course_week_test', `Test: ${c.name} · ${w.label}`, (ctx) => course.writeWeekTest(i.weekId, ctx, i.difficulty, i.instructions))
    }),
    /** Save a go at a week's test (the last score, and the best). */
    weekTestScore: h(z.object({ weekId: id, score: z.number().min(0), total: z.number().int().min(1) }), (i) => course.saveWeekTestScore(i.weekId, i.score, i.total)),
    deleteWeekTest: h(z.object({ weekId: id }), (i) => course.deleteWeekTest(i.weekId)),
    /**
     * Add new notes to a planned week: files, and/or text you paste (saved as a
     * file in the week). Claude works what's new into the week's topics.
     */
    addNotes: h(z.object({ weekId: id, files: z.array(z.string()).max(200).default([]), text: z.string().max(500_000).default(''), instructions: z.string().max(4000).default('') }), async (i) => {
      const cid = course.getCourseIdForWeek(i.weekId)
      const c = course.getCourse(cid)
      const w = c.weeks.find((x) => x.id === i.weekId)!
      const paths = [...i.files]
      if (i.text.trim()) {
        const dir = mkdtempSync(join(tmpdir(), 'studywise-notes-'))
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')
        const file = join(dir, `Notes added ${stamp}.md`)
        writeFileSync(file, i.text)
        paths.push(file)
      }
      if (!paths.length) throw new Error('Paste some notes or add a file first.')
      const before = new Set(course.listFiles(cid).filter((f) => f.week_id === i.weekId).map((f) => f.id))
      const fresh = (await course.addFiles(i.weekId, paths)).filter((f) => !before.has(f.id)).map((f) => f.id)
      if (!fresh.length) throw new Error('None of those files can be added to a week.')
      return startJob('course_update', `Add notes: ${c.name} · ${w.label}`, (ctx) =>
        // Done or not, the week may be ready to publish again (Settings → Marketplace → automatically).
        course.addNotesToWeek(i.weekId, fresh, ctx, i.instructions).finally(() => market.queueAutoPublish(i.weekId))
      )
    }),
    /** Write topics at one or more levels of detail (all levels are kept). No levels: write the level shown again. */
    /** keepShown: written topics keep showing their current notes; the new levels go alongside (a quick review, say). */
    write: h(z.object({ topicIds: z.array(id).min(1).max(200), instructions: z.string().max(4000).default(''), levels: z.array(z.enum(NOTE_LEVELS)).max(NOTE_LEVELS.length).default([]), keepShown: z.boolean().default(false) }), (i) => {
      const topics = i.topicIds.map((tid) => course.getTopic(tid)).filter((t) => t.status !== 'writing')
      return topics.map((t) =>
        startJob('course_topic', `Topic: ${t.plan.title}`, (ctx) =>
          // Done or not, the week may be ready to publish (Settings → Marketplace → automatically).
          course.writeTopic(t.id, ctx, i.instructions, i.levels, i.keepShown).finally(() => market.queueAutoPublish(t.week_id))
        )
      )
    }),
    /** Show a topic at another level of detail it's written at. */
    setLevel: h(z.object({ topicId: id, level: z.enum(NOTE_LEVELS) }), (i) => course.setTopicLevel(i.topicId, i.level)),
    /** Your note to the AI about the course, put into every prompt for it. */
    setNote: h(z.object({ courseId: id, note: z.string().max(4000) }), (i) => course.setCourseNote(i.courseId, i.note)),
    /** What kind of course it is (theory, practical/coding, formula/method heavy): every prompt tailors to it. */
    setFocus: h(z.object({ courseId: id, focus: z.array(z.enum(COURSE_FOCUSES)).max(COURSE_FOCUSES.length) }), (i) => course.setCourseFocus(i.courseId, i.focus)),
    topic: h(z.object({ id }), (i) => course.getTopic(i.id)),
    rateCard: h(z.object({ topicId: id, front: z.string().min(1), cardId: z.string().optional(), rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]) }), (i) =>
      course.rateTopicCard(i.topicId, i.front, i.rating, i.cardId)
    ),
    figure: h(z.object({ fileId: id, page: z.number().int().min(1) }), (i) => course.figureUrl(i.fileId, i.page)),
    progress: h(
      z.object({
        topicId: id,
        progress: z.object({
          section: z.number().int().min(0),
          done: z.boolean(),
          answered: z.number().int().min(0),
          correct: z.number().min(0),
          checkScore: z.number().nullable(),
          checkTotal: z.number().nullable(),
          lastStudied: z.string().nullable(),
          step: z.object({ kind: z.enum(['notes', 'cards', 'q']), section: z.number().int().min(0), index: z.number().int().min(0).optional() }).nullable().optional()
        })
      }),
      (i) => course.saveProgress(i.topicId, i.progress)
    ),
    resetProgress: h(z.object({ topicId: id }), (i) => course.resetTopicProgress(i.topicId)),
    mark: h(z.object({ courseId: id, question: CourseQuestion, answer: z.string().max(20000), topicId: z.string().optional() }), (i) => {
      if (i.question.type !== 'explain') throw new Error('Only explain questions are marked by Claude')
      return course.markExplain(i.courseId, i.question, i.answer, i.topicId)
    }),
    recall: h(z.object({ courseId: id, excludeTopicId: id, exclude: z.array(z.string()).max(500).default([]) }), (i) => course.recallCard(i.courseId, i.excludeTopicId, i.exclude)),
    recallReview: h(z.object({ cardId: id, knew: z.boolean() }), (i) => course.recallReview(i.cardId, i.knew)),
    saveNote: h(z.object({ topicId: id }), (i) => course.syncTopicNote(i.topicId)),
    rename: h(z.object({ id, name: z.string().min(1).max(200) }), (i) => course.renameCourse(i.id, i.name)),
    due: h(z.object({ courseId: id }), (i) => course.dueCards(i.courseId)),
    deckSettings: h(z.object({ courseId: id }), (i) => course.courseDeckSettings(i.courseId)),
    setDeckSettings: h(
      z.object({ courseId: id, extra_instructions: z.string().max(10000), model_overrides: z.record(z.string(), ModelChoice), thresholds: Thresholds.nullable() }),
      (i) => course.setCourseDeckSettings(i.courseId, { extra_instructions: i.extra_instructions, model_overrides: i.model_overrides, thresholds: i.thresholds })
    ),
    delete: h(z.object({ id, keepDeck: z.boolean().default(false) }), (i) => course.deleteCourse(i.id, i.keepDeck)),
    /** One week as a .studyweek file to send to someone. */
    exportWeek: h(z.object({ weekId: id }), async (i, ctx) => {
      const c = course.getCourse(course.getCourseIdForWeek(i.weekId))
      const w = c.weeks.find((x) => x.id === i.weekId)!
      const file = await pickSave(winOf(ctx), weekShare.weekFileName(c.name, w.label), [{ name: 'Shared Studywise week', extensions: [weekShare.WEEK_EXT] }])
      if (!file) return null
      return { file, ...(await weekShare.exportWeek(i.weekId, file)) }
    }),
    /** Pick a shared week (unless given) and say what's in it. */
    previewWeek: h(z.object({ file: z.string().optional() }).optional(), async (i, ctx) => {
      const [file] = i?.file ? [i.file] : await pickFiles(winOf(ctx), [{ name: 'Shared Studywise week', extensions: [weekShare.WEEK_EXT] }], false)
      if (!file) return null
      return { file, ...(await weekShare.previewWeek(file)) }
    }),
    /** Add a shared week to one of your courses, or to a new course. `market`: it's that marketplace week (to remember you have it). */
    importWeek: h(
      z.object({
        file: z.string().min(1),
        courseId: z.string().nullable(),
        weekId: z.string().optional(),
        market: z.object({ id, mine: z.boolean(), courseId: z.string().optional() }).optional(),
        /** Levels of detail to bring in (every level when missing). */
        levels: z.array(z.enum(NOTE_LEVELS)).min(1).optional()
      }),
      async (i) => {
        const r = await weekShare.importWeek(i.file, i.weekId ? { weekId: i.weekId } : i.courseId ? { courseId: i.courseId } : { newCourse: true }, { levels: i.levels })
        if (i.market) market.recordAdded(i.market.id, r.weekId, i.market.mine, i.market.courseId)
        return r
      }
    ),
    /** Which of a week's (or a topic's) recall cards aren't worth keeping. Only card text is sent. */
    /** `cut`: also cut the cards down to the key content, by that much. */
    suggestTrim: h(z.union([z.object({ weekId: id, topicId: z.string().optional(), cut: z.enum(CARD_CUTS).optional() }), z.object({ courseId: id, cut: z.enum(CARD_CUTS).optional() })]), (i) => course.suggestTrim(i)),
    /** Remove recall cards you picked, from the deck and from their topics. */
    removeCards: h(z.object({ cardIds: z.array(id).max(2000) }), (i) => course.removeTopicCards(i.cardIds)),
    /** Turn a week's recall on or off (its cards stay). */
    setWeekRecall: h(z.object({ weekId: id, on: z.boolean() }), (i) => course.setWeekRecall(i.weekId, i.on)),
    /** Public or private on the marketplace. Going private takes down what's published. */
    setVisibility: h(z.object({ courseId: id, private: z.boolean() }), (i) => market.setCourseVisibility(i.courseId, i.private)),
    setWeekVisibility: h(z.object({ weekId: id, private: z.boolean() }), (i) => market.setWeekVisibility(i.weekId, i.private)),
    /** Set or clear a course's exam date (YYYY-MM-DD). */
    setExamDate: h(z.object({ courseId: id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }), (i) => course.setExamDate(i.courseId, i.date))
  },

  /** The course marketplace (a separate site): browse, publish, add, and the "already made" check. */
  market: {
    status: h(none, () => market.marketStatus()),
    configure: h(z.object({ url: z.string().max(500), key: z.string().max(500).nullable().optional() }), (i) => market.configure(i)),
    disconnect: h(none, () => market.disconnect()),
    test: h(none, () => market.test()),
    courses: h(z.object({ q: z.string().max(200).optional(), sort: z.enum(['recent', 'popular']).optional() }).optional(), (i) => market.listCourses(i ?? {})),
    course: h(z.object({ id }), (i) => market.getCourse(i.id)),
    mine: h(none, () => market.mine()),
    published: h(none, () => market.publishedWeeks()),
    /** Marketplace weeks you already have here (added or published from here), by marketplace week id. */
    copies: h(none, () => market.copies()),
    /** Which of your courses each marketplace course's weeks go into (remembered), by marketplace course id. */
    linkedCourses: h(z.object({ ids: z.array(id).max(500) }), (i) => market.linkedCourses(i.ids)),
    publish: h(z.object({ weekId: id }), (i) => market.publish(i.weekId)),
    /** Weeks that can be published (every course's, or one course's), and which are new, changed or already up to date. */
    publishable: h(z.object({ courseId: z.string().optional() }).optional(), (i) => market.publishPlan(i?.courseId)),
    /** Publish the new and changed ones as a job (it can take a while with slides to upload). Up-to-date weeks aren't uploaded again. */
    publishAll: h(z.object({ courseId: z.string().optional() }).optional(), async (i) => {
      const weeks = (await market.publishPlan(i?.courseId)).filter((w) => w.state !== 'same')
      if (!weeks.length) throw new Error('Everything is already on the marketplace and up to date.')
      const title = i?.courseId ? `Publish ${weeks[0].course}` : `Publish ${weeks.length} week${weeks.length === 1 ? '' : 's'}`
      return startJob('other', title, (ctx) => market.publishMany(weeks, ctx))
    }),
    remove: h(z.object({ id }), (i) => market.remove(i.id)),
    report: h(z.object({ id, reason: z.enum(['wrong', 'copyright', 'spam', 'offensive', 'other']), note: z.string().max(1000).default('') }), (i) => market.report(i.id, i.reason, i.note)),
    announcement: h(none, () => market.announcement()),
    /** Merge several people's copies of the same week into one for everyone (a job: it downloads each copy). */
    merge: h(z.object({ ids: z.array(id).min(2).max(30), label: z.string().max(200) }), (i) => startJob('other', `Merge ${i.label}`, (ctx) => market.mergeRemote(i.ids, ctx))),
    /** Download a published week; returns a .studyweek file to preview and import. */
    download: h(z.object({ id }), async (i) => {
      const file = await market.download(i.id)
      return { file, ...(await weekShare.previewWeek(file)) }
    }),
    similar: h(z.object({ weekId: id }), (i) => market.similar(i.weekId)),
    /** What downloading these courses (all their weeks, or the ones you don't have) would add, and where. */
    planAdd: h(addCourses, (i) => market.planAdds(i.targets, i.mode, !!i.onlyMine)),
    /** Download them as a job. */
    addMany: h(addCourses, async (i) => {
      const plans = await market.planAdds(i.targets, i.mode, !!i.onlyMine)
      const n = plans.reduce((s, p) => s + p.items.length, 0)
      if (!n) throw new Error('You already have every one of those weeks.')
      const title = plans.length === 1 ? `Download ${plans[0].name}` : `Download ${n} weeks`
      return startJob('other', title, (ctx) => market.addPlanned(plans, ctx, i.levels))
    })
  },
  stats: {
    /** Time studied, topics and card stats for the home page. */
    home: h(none, () => repo.homeStats()),
    /** Seconds spent studying since the last call (sent every minute or so while you study). */
    addTime: h(z.object({ seconds: z.number().min(0).max(600) }), (i) => repo.addStudyTime(i.seconds))
  },

  sync: {
    status: h(none, () => syncServer.syncStatus()),
    setEnabled: h(z.object({ enabled: z.boolean() }), (i) => syncServer.setSyncEnabled(i.enabled)),
    pairCode: h(none, () => syncServer.newPairCode()),
    unpair: h(z.object({ id }), (i) => syncServer.unpair(i.id)),
    // This computer syncing with another computer.
    linkStatus: h(none, () => syncLink.linkStatus()),
    link: h(z.object({ address: z.string().min(1).max(200), code: z.string().min(1).max(20) }), (i) => syncLink.link(i.address, i.code)),
    unlink: h(none, () => syncLink.unlink()),
    linkNow: h(none, () => syncLink.syncNow()),
    // Syncing and backing up through the cloud (the marketplace server).
    cloudStatus: h(none, () => syncCloud.cloudStatus()),
    cloudSet: h(z.object({ on: z.boolean() }), (i) => syncCloud.setCloud(i.on)),
    cloudNow: h(none, () => syncCloud.syncNow()),
    cloudInfo: h(none, () => syncCloud.cloudInfo()),
    cloudDelete: h(none, () => syncCloud.deleteCloudCopy()),
    /** For a paired phone (through /rpc): the cloud's address and key, so it syncs through the cloud too. */
    cloudCredentials: h(none, () => syncCloud.cloudCredentials())
  },

  jobs: {
    list: h(none, () => listJobs()),
    get: h(z.object({ id }), (i) => getJob(i.id)),
    cancel: h(z.object({ id }), (i) => cancelJob(i.id)),
    cancelAll: h(none, () => listJobs().forEach((j) => j.status === 'running' && cancelJob(j.id))),
    clear: h(none, () => clearFinishedJobs())
  },

  learn: {
    settings: h(z.object({ deckId: id }), (i) => learn.settingsFor(i.deckId)),
    saveSettings: h(z.object({ deckId: id, settings: LearnSettings }), (i) => repo.updateDeck(i.deckId, { learn_settings: i.settings }).learn_settings),
    start: h(z.object({ deckId: id, cardIds: z.array(z.string()).optional() }), (i) => learn.startSession(i.deckId, i.cardIds)),
    batch: h(z.object({ sessionId: id, batch: z.number().int().min(0) }), (i) => learn.getBatch(i.sessionId, i.batch)),
    submit: h(z.object({ sessionId: z.string().nullable(), deckId: id, question: LearnQuestionSchema, answer: LearnAnswerSchema, retry: z.boolean().optional() }), (i) => learn.submitAnswer(i.sessionId, i.deckId, i.question, i.answer, i.retry)),
    override: h(z.object({ attemptId: id }), (i) => learn.overrideAttempt(i.attemptId)),
    undoOverride: h(z.object({ attemptId: id }), (i) => learn.undoOverride(i.attemptId)),
    feedback: h(z.object({ attemptId: id }), (i) => learn.feedbackFor(i.attemptId)),
    hint: h(z.object({ cardId: id, question: LearnQuestionSchema, index: z.number().int().min(0).max(1), previous: z.array(z.string()) }), (i) => learn.hintFor(i.cardId, i.question, i.index, i.previous)),
    regenerate: h(z.object({ deckId: id, question: LearnQuestionSchema }), (i) => learn.regenerateQuestion(i.deckId, i.question)),
    end: h(z.object({ sessionId: id }), (i) => learn.endSession(i.sessionId)),
    texts: h(z.object({ question: LearnQuestionSchema, answer: LearnAnswerSchema.optional() }), (i) => ({
      question: learn.questionText(i.question),
      expected: learn.expectedText(i.question),
      answer: i.answer ? learn.answerText(i.question, i.answer) : null
    }))
  },

  explain: {
    run: h(z.object({ ctx: ExplainCtx, mode: z.string(), explanationId: z.string().nullable(), streamId }), (i, c) => explain.explain(i.ctx, i.mode, i.explanationId, c.stream(i.streamId) ?? (() => {}))),
    chat: h(z.object({ explanationId: id, message: z.string().min(1), streamId }), (i, c) => explain.chat(i.explanationId, i.message, c.stream(i.streamId) ?? (() => {}))),
    history: h(z.object({ cardId: id }), (i) => explain.historyForCard(i.cardId)),
    saveToCard: h(z.object({ cardId: id, text: z.string() }), (i) => repo.updateCard(i.cardId, { explanation: i.text }))
  },

  actions: {
    list: h(none, () => presets.listActions()),
    save: h(CustomAction.partial().extend({ name: z.string().min(1), prompt: z.string().min(1) }), (i) => presets.saveAction(i)),
    delete: h(z.object({ id }), (i) => presets.deleteAction(i.id)),
    run: h(z.object({ actionId: id, ctx: ExplainCtx, streamId }), (i, c) => explain.runAction(i.actionId, i.ctx, c.stream(i.streamId) ?? (() => {})))
  },

  presets: {
    tasks: h(none, () => TASKS.map((t) => TASK_INFO[t])),
    list: h(z.object({ task: z.string().optional() }).optional(), (i) => presets.listPresets(i?.task)),
    get: h(z.object({ id }), (i) => presets.getPreset(i.id)),
    update: h(z.object({ id, patch: z.object({ name: z.string().optional(), system: z.string().optional(), user_template: z.string().optional(), output_mode: OutputMode.optional() }) }), (i) =>
      presets.updatePreset(i.id, i.patch)
    ),
    duplicate: h(z.object({ id, name: z.string().optional() }), (i) => presets.duplicatePreset(i.id, i.name)),
    setDefault: h(z.object({ id }), (i) => presets.setDefaultPreset(i.id)),
    delete: h(z.object({ id }), (i) => presets.deletePreset(i.id)),
    reset: h(z.object({ id }), (i) => presets.resetPreset(i.id)),
    versions: h(z.object({ id }), (i) => presets.presetVersions(i.id)),
    preview: h(
      z.object({ id, vars: z.record(z.string(), z.unknown()), override: z.object({ system: z.string(), user_template: z.string(), output_mode: OutputMode }).optional() }),
      (i) => {
        const p = presets.getPreset(i.id)
        const r = renderPrompt({ task: p.task as TaskId, presetId: p.id, vars: i.vars, presetOverride: i.override })
        return { system: r.system, prompt: r.prompt, mode: r.mode, model: r.model }
      }
    ),
    testRun: h(
      z.object({ id, vars: z.record(z.string(), z.unknown()), override: z.object({ system: z.string(), user_template: z.string(), output_mode: OutputMode }).optional(), streamId }),
      async (i, c) => {
        const p = presets.getPreset(i.id)
        const started = Date.now()
        try {
          const r = await runAI({ task: p.task as TaskId, presetId: p.id, vars: i.vars, presetOverride: i.override, onDelta: c.stream(i.streamId) })
          return { ok: true, raw: r.text, parsed: r.data, ms: Date.now() - started, model: r.model }
        } catch (e) {
          return { ok: false, raw: '', parsed: null, error: friendlyError(e), ms: Date.now() - started, model: null }
        }
      }
    ),
    exportFile: h(none, async (_i, ctx) => {
      const file = await pickSave(winOf(ctx), 'studywise-presets.json', [{ name: 'JSON', extensions: ['json'] }])
      if (!file) return null
      writeFileSync(file, JSON.stringify(presets.exportPresets(), null, 2))
      return file
    }),
    importFile: h(none, async (_i, ctx) => {
      const [file] = await pickFiles(winOf(ctx), [{ name: 'JSON', extensions: ['json'] }], false)
      if (!file) return null
      return presets.importPresets(JSON.parse(readFileSync(file, 'utf8')))
    })
  },

  models: {
    get: h(z.object({ provider: AiProvider.optional() }).optional(), (i) => models.globalModels(i?.provider)),
    set: h(z.object({ task: z.enum(TASKS), choice: ModelChoice, provider: AiProvider.optional() }), (i) => models.setGlobalModel(i.task, i.choice, i.provider)),
    reset: h(z.object({ provider: AiProvider.optional() }).optional(), (i) => models.resetGlobalModels(i?.provider)),
    test: h(z.object({ model: z.string().min(1), effort: z.string().nullable().optional(), provider: AiProvider.optional() }), async (i) => {
      const started = Date.now()
      try {
        const provider = i.provider ?? models.activeProvider()
        const r = await runAI<string>({ task: 'note_simplify', vars: { source_text: 'Reply with exactly: ok', title: 'test', instructions: 'Reply with the single word ok.' }, model: { model: i.model, effort: i.effort ?? null, provider } })
        return { ok: true, reply: r.text.slice(0, 200), ms: Date.now() - started }
      } catch (e) {
        return { ok: false, reply: friendlyError(e), ms: Date.now() - started }
      }
    })
  },

  ollama: {
    status: h(none, () => ollama.ollamaStatus()),
    /** apiKey: a string sets it, null removes it, undefined leaves it alone. */
    setConfig: h(z.object({ baseUrl: z.string().max(500).optional(), apiKey: z.string().max(500).nullable().optional(), numCtx: z.number().int().min(2048).max(1_048_576).optional() }), (i) => {
      if (i.baseUrl !== undefined) {
        const url = i.baseUrl.trim() || ollama.OLLAMA_CLOUD_URL
        if (!/^https?:\/\/[^\s/]+/i.test(url)) throw new Error('The Ollama address should start with http:// or https://')
        repo.setSetting('ollama.baseUrl', url)
      }
      if (i.apiKey !== undefined) ollama.setOllamaKey(i.apiKey)
      if (i.numCtx !== undefined) repo.setSetting('ollama.numCtx', i.numCtx)
      return ollama.ollamaStatus()
    }),
    models: h(z.object({ refresh: z.boolean().optional() }).optional(), (i) => ollama.listOllamaModels(!!i?.refresh)),
    /** Star or unstar a model. Starred models are listed first everywhere. */
    saveModel: h(z.object({ model: z.string().min(1).max(200), saved: z.boolean() }), (i) => {
      const cur = repo.getSetting<string[]>('ollama.savedModels', []).filter((m) => m !== i.model)
      repo.setSetting('ollama.savedModels', i.saved ? [...cur, i.model] : cur)
      return ollama.ollamaStatus()
    }),
    setDefault: h(z.object({ model: z.string().max(200) }), (i) => {
      repo.setSetting('ollama.defaultModel', i.model.trim())
      return ollama.ollamaStatus()
    })
  },

  ai: {
    status: h(none, () => ({ provider: models.activeProvider(), ollama: ollama.ollamaStatus() })),
    setProvider: h(z.object({ provider: AiProvider }), (i) => {
      models.setActiveProvider(i.provider)
      return { provider: models.activeProvider(), ollama: ollama.ollamaStatus() }
    }),
    calls: h(z.object({ limit: z.number().int().min(1).max(2000).optional() }).optional(), (i) => repo.listAiCalls(i?.limit ?? 300)),
    summary: h(none, () => repo.aiUsageSummary()),
    queue: h(none, () => ({ running: aiQueue.running, waiting: aiQueue.waiting })),
    limits: h(none, () => getUsage()),
    /** One tiny Haiku call, just to get fresh plan-usage numbers. */
    refreshLimits: h(none, () => refreshPlanUsage())
  },

  io: {
    importCards: h(z.object({ deckId: id, files: z.array(z.string()).optional() }), async (i, ctx) => {
      const files = i.files?.length ? i.files : await pickFiles(winOf(ctx), [{ name: 'Cards', extensions: CARD_EXTENSIONS }])
      let n = 0
      for (const f of files) n += await importCardsFromFile(f, i.deckId)
      return n
    }),
    importDeck: h(z.object({ files: z.array(z.string()).max(200).optional() }).optional(), async (i, ctx) => {
      const files = i?.files?.length ? i.files : await pickFiles(winOf(ctx), [{ name: 'Cards (StudySmarter, Anki, CSV, JSON)', extensions: CARD_EXTENSIONS }])
      const created: string[] = []
      for (const f of files) {
        if (anki.isAnkiFile(f)) {
          created.push(...(await importAnki(f, null)).deckIds)
          continue
        }
        let name = basename(f, extname(f))
        if (extname(f).toLowerCase() === '.json') {
          try {
            name = io.DeckJson.parse(JSON.parse(readFileSync(f, 'utf8'))).name
          } catch {
            /* keep file name */
          }
        }
        const deck = repo.createDeck({ name })
        await importCardsFromFile(f, deck.id)
        created.push(deck.id)
      }
      return created
    }),
    exportDeck: h(z.object({ deckId: id, format: z.enum(['txt', 'xlsx', 'json', 'csv']) }), async (i, ctx) => {
      const deck = repo.getDeck(i.deckId)
      const cards = repo.listCards(i.deckId)
      const file = await pickSave(winOf(ctx), `${safeName(deck.name)}.${i.format}`, [{ name: i.format.toUpperCase(), extensions: [i.format] }])
      if (!file) return null
      if (i.format === 'txt') io.writeText(file, io.cardsToStudySmarterText(cards))
      else if (i.format === 'xlsx') writeFileSync(file, await io.cardsToXlsx(cards))
      else if (i.format === 'json') io.writeText(file, io.deckToJson(deck, cards))
      else io.writeText(file, io.cardsToCsv(cards))
      return file
    }),
    importNotes: h(z.object({ files: z.array(z.string()).optional(), folderId: z.string().nullable().optional() }).optional(), async (i, ctx) => {
      const files = i?.files?.length ? i.files : await pickFiles(winOf(ctx), [{ name: 'Notes', extensions: ['md', 'markdown', 'txt', 'zip'] }])
      const ids: string[] = []
      for (const f of files) for (const n of await io.notesFromFile(f, paths.attachments)) ids.push(repo.createNote({ ...n, folder_id: i?.folderId ?? null }).id)
      return ids
    }),
    /** Everything in one .studywise file for another computer; progress only if asked. */
    exportLibrary: h(z.object({ includeProgress: z.boolean().default(false) }), async (i, ctx) => {
      const file = await pickSave(winOf(ctx), library.libraryFileName(), [{ name: 'Studywise library', extensions: [library.LIBRARY_EXT] }])
      if (!file) return null
      return { file, ...(await library.exportLibrary(file, { includeProgress: i.includeProgress })) }
    }),
    /** Adds a .studywise file's contents to this library (nothing is replaced). */
    importLibrary: h(z.object({ files: z.array(z.string()).max(20).optional() }).optional(), async (i, ctx) => {
      const [file] = i?.files?.length ? i.files : await pickFiles(winOf(ctx), [{ name: 'Studywise library', extensions: [library.LIBRARY_EXT] }], false)
      if (!file) return null
      return library.importLibrary(file)
    }),
    /**
     * One note as Markdown for Obsidian (frontmatter, native syntax, images next
     * to it in attachments/) or Notion (a .zip with the note and its images when
     * there are any, ready for Notion's Markdown import; a plain .md otherwise).
     */
    exportNote: h(z.object({ noteId: id, format: z.enum(['obsidian', 'notion']).default('obsidian') }), async (i, ctx) => {
      const n = repo.getNote(i.noteId)
      const out = i.format === 'notion' ? exportNotion(n) : exportObsidian(n)
      const zipped = i.format === 'notion' && out.files.length > 0
      const file = await pickSave(winOf(ctx), `${safeName(n.title)}.${zipped ? 'zip' : 'md'}`, zipped ? [{ name: 'Zip for Notion import', extensions: ['zip'] }] : [{ name: 'Markdown', extensions: ['md'] }])
      if (!file) return null
      // The app's image URLs point into its data folder.
      const local = (url: string) => {
        const full = join(paths.userData, normalize(decodeURIComponent(url.replace(/^studywise-file:\/\//, ''))))
        return full.startsWith(paths.userData + sep) && existsSync(full) ? full : null
      }
      const fileData = (f: (typeof out.files)[number]) => (f.text !== null ? Buffer.from(f.text) : f.source && local(f.source) ? readFileSync(local(f.source)!) : null)
      if (zipped) {
        const zip = new JSZip()
        zip.file(`${safeName(n.title)}.md`, out.markdown)
        for (const f of out.files) {
          const data = fileData(f)
          if (data) zip.file(f.path, data)
        }
        writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }))
      } else {
        io.writeText(file, out.markdown)
        for (const f of out.files) {
          const data = fileData(f)
          if (!data) continue
          mkdirSync(join(dirname(file), dirname(f.path)), { recursive: true })
          writeFileSync(join(dirname(file), f.path), data)
        }
      }
      return file
    })
  }
} as const

// ---------------------------------------------------------------------------
// Types for the renderer

type HandlerFn<T> = T extends Handler<infer I, infer _P, infer O> ? (undefined extends I ? (input?: I) => Promise<Awaited<O>> : (input: I) => Promise<Awaited<O>>) : never
export type StudywiseApi = { [D in keyof typeof handlers]: { [M in keyof (typeof handlers)[D]]: HandlerFn<(typeof handlers)[D][M]> } }

export function channelList(): string[] {
  return Object.entries(handlers).flatMap(([d, ms]) => Object.keys(ms).map((m) => `${d}.${m}`))
}

let afterCall: ((channel: string) => void) | null = null
export function setAfterCall(fn: (channel: string) => void): void {
  afterCall = fn
}

/**
 * Runs one handler for a paired phone (see sync/server). Streamed text goes to
 * `stream`; there's no window, so handlers that open dialogs are blocked there.
 */
export async function runHandler(channel: string, payload: unknown, stream: (streamId: string, text: string) => void): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const [domain, method] = channel.split('.')
  const handler = (handlers as unknown as Record<string, Record<string, Handler<unknown, unknown, unknown>>>)[domain]?.[method]
  if (!handler) return { ok: false, error: `Unknown request ${channel}` }
  const parsed = handler.input.safeParse(payload)
  if (!parsed.success) return { ok: false, error: `Invalid request to ${channel}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }
  const sender = { isDestroyed: () => true, send: () => {} } as unknown as WebContents
  try {
    const data = await handler.fn(parsed.data, { sender, stream: (sid) => (sid ? (text: string) => stream(sid, text) : undefined) })
    afterCall?.(channel)
    return { ok: true, data }
  } catch (e) {
    console.error(`[sync rpc] ${channel} failed:`, e)
    return { ok: false, error: friendlyError(e) }
  }
}

export function registerIpc(): void {
  for (const [domain, methods] of Object.entries(handlers)) {
    for (const [method, handler] of Object.entries(methods as Record<string, Handler<unknown, unknown, unknown>>)) {
      const channel = `sw:${domain}.${method}`
      ipcMain.handle(channel, async (event, payload) => {
        const parsed = handler.input.safeParse(payload)
        if (!parsed.success) {
          return { ok: false, error: `Invalid request to ${domain}.${method}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` }
        }
        const sender = event.sender
        const ctx: Ctx = {
          sender,
          stream: (sid) => (sid ? (text: string) => !sender.isDestroyed() && sender.send('sw:event', { type: 'ai:delta', streamId: sid, text }) : undefined)
        }
        try {
          const data = await handler.fn(parsed.data, ctx)
          afterCall?.(`${domain}.${method}`)
          return { ok: true, data }
        } catch (e) {
          console.error(`[ipc] ${domain}.${method} failed:`, e)
          return { ok: false, error: friendlyError(e) }
        }
      })
    }
  }
}

let pinging: Promise<ReturnType<typeof getUsage>> | null = null
/** One tiny Haiku call, just to get fresh plan-usage numbers. Calls made while one is running share it. */
export function refreshPlanUsage(): Promise<ReturnType<typeof getUsage>> {
  if (models.activeProvider() !== 'claude') return Promise.resolve(getUsage())
  pinging ??= runAI({ task: 'hint', vars: { front: 'ping', back: 'pong', question: 'ping', type: 'free_answer', previous_hints: '(none)' }, model: { model: 'haiku', effort: null } })
    .then(() => getUsage())
    .finally(() => (pinging = null))
  return pinging
}

export function broadcast(payload: unknown): void {
  syncServer.recordEvent(payload)
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('sw:event', payload)
}
