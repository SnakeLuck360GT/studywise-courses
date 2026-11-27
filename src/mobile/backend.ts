// window.studywise for the phone app. Same channels as the desktop (see
// @shared/channels); each one either runs here on the phone's own copy of the
// library (studying, reviews, notes, decks, course progress) or is sent to the
// paired computer (AI, files, anything that needs the desktop).

import { CHANNELS } from '@shared/channels'
import type { AiStatus, ClaudeStatus } from '@shared/types'
import type { UpdateStatus } from '@shared/update'
import type { MobileApi } from '@shared/mobile'
import { validateCards } from '@shared/ssText'
import * as repo from '../main/db/repo'
import { getDb } from '../main/db'
import { wipeDb } from './db'
import * as course from '../main/services/course'
import * as learn from '../main/services/learn'
import * as phone from './phoneSync'
import { idb } from './idb'
import { isOffline, OfflineError } from '../main/offline'
import type { LearnAnswer, LearnQuestion } from '@shared/questions'
import type { WeekTrack } from '@shared/course'

type Fn = (input: never) => unknown
type In = Record<string, never>

const listeners = new Set<(ev: unknown) => void>()
export const emit = (ev: unknown) => listeners.forEach((l) => l(ev))
phone.setEventSink(emit)

const APP_VERSION = __APP_VERSION__
/** Which phone app this is: Android, iPhone/iPad, or the page in a browser. */
const PLATFORM: MobileApi['platform'] = (() => {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform(): boolean; getPlatform(): string } }).Capacitor
  if (!cap?.isNativePlatform()) return 'web'
  return cap.getPlatform() === 'ios' ? 'ios' : 'android'
})()

const noUpdates: UpdateStatus = { supported: false, kind: 'git', version: null, ready: false, downloadUrl: null, behind: 0, ahead: 0, dirty: false, branch: null, changes: [], state: 'idle', stage: null, error: null, checkedAt: null }
const claudeHere: ClaudeStatus = { path: 'computer', version: null, loggedIn: true, authMethod: null, error: null, overridePath: null, mock: true }
const aiHere: AiStatus = { provider: 'claude', ollama: { baseUrl: '', cloud: false, hasKey: false, keyFromEnv: false, ready: true, defaultModel: '', saved: [] } }

const remoteOr = async <T>(channel: string, input: unknown, fallback: T): Promise<T> => (phone.isOnline() ? phone.remote<T>(channel, input).catch(() => fallback) : fallback)

/** Channels answered on the phone. Anything not listed goes to the computer. */
const local: Record<string, Fn> = {
  'app.info': () => ({ version: APP_VERSION, name: 'Studywise', userData: 'On this phone', electron: '', mock: false, platform: PLATFORM }),
  'app.openExternal': (i: { url: string }) => {
    if (!/^https:\/\//.test(i.url)) throw new Error('Only https links can be opened')
    window.open(i.url, '_blank')
    return true
  },
  'app.saveAttachment': (i: { name: string; data: Uint8Array }) => phone.saveAttachment(i.name, i.data),
  'app.pickFiles': () => [],
  'app.showDataFolder': () => true,
  'updates.status': () => noUpdates,
  'updates.check': () => noUpdates,

  'settings.all': () => Object.fromEntries(Object.entries(repo.allSettings()).filter(([k]) => !k.startsWith('secret.') && !k.startsWith('phone.'))),
  'settings.set': (i: { key: string; value: unknown }) => {
    if (!/^[\w.]+$/.test(i.key) || i.key.startsWith('secret.') || i.key.startsWith('phone.')) throw new Error('reserved key')
    repo.setSetting(i.key, i.value)
    return true
  },

  'claude.status': () => claudeHere,
  'claude.recheck': () => claudeHere,
  'ai.status': () => aiHere,
  'ai.limits': () => remoteOr('ai.limits', undefined, null),
  'jobs.list': () => remoteOr('jobs.list', undefined, []),
  'actions.list': () => remoteOr('actions.list', undefined, []),
  'explain.history': (i: unknown) => remoteOr('explain.history', i, []),

  'folders.list': (i?: { kind?: 'deck' | 'note' }) => repo.listFolders(i?.kind),
  'folders.create': (i: { name: string; kind: 'deck' | 'note'; parent_id?: string | null }) => repo.createFolder(i.name, i.kind, i.parent_id ?? null),
  'folders.rename': (i: { id: string; name: string }) => repo.renameFolder(i.id, i.name),
  'folders.delete': (i: { id: string }) => repo.deleteFolder(i.id),

  'decks.list': () => repo.listDecks(),
  'decks.get': (i: { id: string }) => repo.getDeck(i.id),
  'decks.create': (i: { name: string; folder_id?: string | null; description?: string }) => repo.createDeck(i),
  'decks.update': (i: { id: string; patch: Parameters<typeof repo.updateDeck>[1] }) => repo.updateDeck(i.id, i.patch),
  'decks.delete': (i: { id: string }) => repo.deleteDeck(i.id),
  'decks.stats': (i: { id: string }) => repo.deckStats(i.id),
  'decks.overview': () => repo.overview(),
  'decks.due': (i: { id: string }) => repo.dueCards(i.id),

  'cards.list': (i: { deckId: string }) => repo.listCards(i.deckId),
  'cards.get': (i: { id: string }) => repo.getCard(i.id),
  'cards.create': (i: { cards: Parameters<typeof repo.createCards>[0] }) => repo.createCards(i.cards),
  'cards.update': (i: { id: string; patch: Parameters<typeof repo.updateCard>[1] }) => repo.updateCard(i.id, i.patch),
  'cards.delete': (i: { ids: string[] }) => repo.deleteCards(i.ids),
  'cards.move': (i: { ids: string[]; deckId: string }) => repo.moveCards(i.ids, i.deckId),
  'cards.search': (i: { q: string; deckId?: string }) => repo.searchCards(i.q, i.deckId),
  'cards.review': (i: { cardId: string; rating: 1 | 2 | 3 | 4 }) => repo.applyReview(i.cardId, i.rating, 'flashcard'),
  'cards.reviewState': (i: { cardId: string }) => repo.getReviewState(i.cardId),
  'cards.restoreReview': (i: { cardId: string; state: Parameters<typeof repo.writeReviewState>[0] | null }) => {
    const d = getDb()
    if (i.state) repo.writeReviewState({ difficulty: 0.6, sr_state: 0, good_count: 0, ...(i.state as object), card_id: i.cardId } as Parameters<typeof repo.writeReviewState>[0])
    else d.prepare('DELETE FROM review_state WHERE card_id = ?').run(i.cardId)
    d.prepare("DELETE FROM review_log WHERE id = (SELECT MAX(id) FROM review_log WHERE card_id = ? AND source = 'flashcard')").run(i.cardId)
    return true
  },
  'cards.validate': (i: { cards: { front: string; back: string }[] }) => validateCards(i.cards),

  'notes.list': () => repo.listNotes(),
  'notes.get': (i: { id: string }) => repo.getNote(i.id),
  'notes.create': (i: Parameters<typeof repo.createNote>[0]) => repo.createNote(i),
  'notes.update': (i: { id: string; patch: Parameters<typeof repo.updateNote>[1] }) => repo.updateNote(i.id, i.patch),
  'notes.delete': (i: { id: string }) => repo.deleteNote(i.id),
  'notes.linkDeck': (i: { noteId: string; deckId: string; linked: boolean }) => repo.linkNoteDeck(i.noteId, i.deckId, i.linked),
  'notes.forDeck': (i: { deckId: string }) => repo.notesForDeck(i.deckId),

  'gen.save': (i: { deckId: string; cards: (Parameters<typeof repo.createCards>[0][number] & { key?: string })[] }) =>
    repo.createCards(i.cards.map(({ key: _k, ...c }) => ({ ...c, deck_id: i.deckId, required_points: c.required_points ?? null, source: c.source ?? null, language: c.language ?? null }))).length,

  'courses.list': () => course.listCourses(),
  'courses.get': (i: { id: string }) => course.getCourse(i.id),
  'courses.renameWeek': (i: { weekId: string; label: string }) => course.renameWeek(i.weekId, i.label),
  'courses.topic': (i: { id: string }) => course.getTopic(i.id),
  'courses.rateCard': (i: { topicId: string; front: string; cardId?: string; rating: 1 | 2 | 3 | 4 }) => course.rateTopicCard(i.topicId, i.front, i.rating, i.cardId),
  'courses.setWeekRecall': (i: { weekId: string; on: boolean }) => course.setWeekRecall(i.weekId, i.on),
  'courses.setWeekTrack': ({ weekId, ...t }: { weekId: string } & WeekTrack) => course.setWeekTrack(weekId, t),
  'courses.tracker': () => course.tracker(),
  'courses.reviewCards': (i: { deckIds: string[] }) => course.reviewCards(i.deckIds),
  'courses.setExamDate': (i: { courseId: string; date: string | null }) => course.setExamDate(i.courseId, i.date),
  'courses.setLevel': (i: { topicId: string; level: Parameters<typeof course.setTopicLevel>[1] }) => course.setTopicLevel(i.topicId, i.level),
  'courses.setNote': (i: { courseId: string; note: string }) => course.setCourseNote(i.courseId, i.note),
  'courses.setFocus': (i: { courseId: string; focus: Parameters<typeof course.setCourseFocus>[1] }) => course.setCourseFocus(i.courseId, i.focus),
  'courses.weekTestScore': (i: { weekId: string; score: number; total: number }) => course.saveWeekTestScore(i.weekId, i.score, i.total),
  'courses.deleteWeekTest': (i: { weekId: string }) => course.deleteWeekTest(i.weekId),
  'stats.home': () => repo.homeStats(),
  'stats.addTime': (i: { seconds: number }) => repo.addStudyTime(Math.max(0, Math.min(600, i.seconds))),
  'courses.figure': (i: { fileId: string; page: number }) => phone.figureUrl(i.fileId, i.page),
  'courses.progress': (i: { topicId: string; progress: Parameters<typeof course.saveProgress>[1] }) => course.saveProgress(i.topicId, i.progress),
  'courses.resetProgress': (i: { topicId: string }) => course.resetTopicProgress(i.topicId),
  'courses.recall': (i: { courseId: string; excludeTopicId: string; exclude?: string[] }) => course.recallCard(i.courseId, i.excludeTopicId, i.exclude ?? []),
  'courses.recallReview': (i: { cardId: string; knew: boolean }) => course.recallReview(i.cardId, i.knew),
  'courses.saveNote': (i: { topicId: string }) => course.syncTopicNote(i.topicId),
  'courses.rename': (i: { id: string; name: string }) => course.renameCourse(i.id, i.name),
  'courses.due': (i: { courseId: string }) => course.dueCards(i.courseId),
  'courses.deckSettings': (i: { courseId: string }) => course.courseDeckSettings(i.courseId),

  'learn.settings': (i: { deckId: string }) => learn.settingsFor(i.deckId),
  'learn.saveSettings': (i: { deckId: string; settings: NonNullable<Parameters<typeof repo.updateDeck>[1]['learn_settings']> }) => repo.updateDeck(i.deckId, { learn_settings: i.settings }).learn_settings,
  'learn.texts': (i: { question: Parameters<typeof learn.questionText>[0]; answer?: Parameters<typeof learn.answerText>[1] }) => ({
    question: learn.questionText(i.question),
    expected: learn.expectedText(i.question),
    answer: i.answer ? learn.answerText(i.question, i.answer) : null
  }),

  'explain.saveToCard': (i: { cardId: string; text: string }) => repo.updateCard(i.cardId, { explanation: i.text }),

  // The phone isn't a sync server.
  'sync.status': () => {
    throw new Error('Phone sync is in Settings → Sync on the phone.')
  }
}

/** Errors that say plainly what's going on when the computer is needed. */
const NEEDS: Record<string, string> = {
  'io.': 'Importing and exporting files is done in Studywise on your computer.',
  'app.backup': 'Back up from Studywise on your computer.',
  'app.restore': 'Restore from Studywise on your computer.'
}

/**
 * Offline mode on the phone: Learn runs here on the phone's copy (offline
 * questions are made and marked without AI), so it works with no computer.
 */
const offlineLocal: Record<string, Fn> = {
  'learn.start': (i: { deckId: string; cardIds?: string[] }) => learn.startSession(i.deckId, i.cardIds),
  'learn.batch': (i: { sessionId: string; batch: number }) => learn.getBatch(i.sessionId, i.batch),
  'learn.submit': (i: { sessionId: string | null; deckId: string; question: LearnQuestion; answer: LearnAnswer; retry?: boolean }) =>
    learn.submitAnswer(i.sessionId, i.deckId, i.question, i.answer, i.retry),
  'learn.override': (i: { attemptId: string }) => learn.overrideAttempt(i.attemptId),
  'learn.undoOverride': (i: { attemptId: string }) => learn.undoOverride(i.attemptId),
  'learn.hint': (i: { cardId: string; question: LearnQuestion; index: number; previous: string[] }) => learn.hintFor(i.cardId, i.question, i.index, i.previous),
  'learn.regenerate': (i: { deckId: string; question: LearnQuestion }) => learn.regenerateQuestion(i.deckId, i.question),
  'learn.end': (i: { sessionId: string }) => learn.endSession(i.sessionId)
}

/** Requests that would have the computer call the AI; offline they stop here. */
const AI_CHANNELS = new Set([
  'notes.ai',
  'notes.quiz',
  'gen.notes',
  'gen.cards',
  'gen.fixCard',
  'courses.plan',
  'courses.writeWeekTest',
  'courses.addNotes',
  'courses.write',
  'courses.mark',
  'courses.suggestTrim',
  // Merging needs Claude to combine the copies.
  'courses.mergeWeeks',
  'courses.mergeCourses',
  'market.merge',
  // Doing a task plans and writes a week.
  'market.startTask',
  'learn.feedback',
  'explain.run',
  'explain.chat',
  'actions.run',
  'presets.testRun',
  'models.test'
])

async function call(channel: string, input: unknown): Promise<unknown> {
  if (isOffline()) {
    const off = offlineLocal[channel]
    if (off) return await (off as (i: unknown) => unknown)(input)
    if (AI_CHANNELS.has(channel)) throw new OfflineError()
  }
  const fn = local[channel]
  if (fn) return await (fn as (i: unknown) => unknown)(input)
  for (const [prefix, msg] of Object.entries(NEEDS)) if (channel.startsWith(prefix)) throw new Error(msg)
  return phone.remote(channel, input)
}

export function installBackend(): void {
  const api: Record<string, Record<string, (input?: unknown) => Promise<unknown>>> = {}
  for (const ch of CHANNELS) {
    const [domain, method] = ch.split('.')
    api[domain] ??= {}
    api[domain][method] = (input?: unknown) => call(ch, input)
  }
  ;(window as unknown as { studywise: unknown }).studywise = {
    ...api,
    on: (cb: (ev: unknown) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    pathForFile: () => ''
  }
  const mobileApi: MobileApi = {
    platform: PLATFORM,
    sync: {
      status: async () => phone.status(),
      pair: (i) => phone.pair(i.address, i.code),
      unpair: () => phone.unpair(),
      now: () => phone.syncNow(),
      useCloud: (i) => phone.useCloud(i),
      stopCloud: () => phone.stopCloud(),
      onStatus: (cb) => phone.onStatus(cb)
    },
    resetLibrary: async () => {
      await wipeDb()
      await idb.clear('files')
      location.reload()
    },
    fileUrl: (url) => phone.fileUrl(url)
  }
  window.studywiseMobile = mobileApi
}
