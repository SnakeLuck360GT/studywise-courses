import { z } from 'zod'
import { getDb, uid, now, json } from '../db'
import * as repo from '../db/repo'
import { runAI } from '../ai'
import { defaultPreset } from '../ai/presets'
import { isOffline } from '../offline'
import { OFFLINE_SKIPPED_TYPES } from '@shared/offline'
import { cardBlanks } from '@shared/blanks'
import { shuffleOptions } from '@shared/course'
import { markInCode, markFillBlankExact, fillBlankFromAi, verdictFor } from '@shared/marking'
import { ratingForVerdict } from '@shared/sm2'
import {
  QuestionPayloads,
  segmentsToPrompt,
  type LearnQuestion,
  type LearnAnswer,
  type Mark,
  type AiQuestionItem,
  type FreeAnswerMark
} from '@shared/questions'
import {
  QUESTION_TYPES,
  DEFAULT_THRESHOLDS,
  LearnSettings as LearnSettingsSchema,
  type Card,
  type QuestionType,
  type LearnSettings,
  type Thresholds,
  type ReviewState
} from '@shared/types'

export const BATCH_SIZE = 8
type AiType = AiQuestionItem['type']
const AI_TYPES: AiType[] = ['read_understand', 'multiple_choice', 'free_answer', 'true_false', 'choice_blank']

export type PlanItem = { type: QuestionType; card_id: string; card_ids: string[] }

interface Session {
  id: string
  deckId: string
  plan: PlanItem[]
  batches: Map<number, Promise<LearnQuestion[]>>
}
const sessions = new Map<string, Session>()

export function defaultLearnSettings(): LearnSettings {
  return LearnSettingsSchema.parse({ types: Object.fromEntries(QUESTION_TYPES.map((t) => [t, true])), sessionLength: 20, shuffle: true })
}

export function settingsFor(deckId: string): LearnSettings {
  const d = repo.getDeck(deckId)
  const base = defaultLearnSettings()
  const s = d.learn_settings ?? base
  return { ...base, ...s, types: { ...base.types, ...s.types } }
}

export function thresholdsFor(deckId: string | null): Thresholds {
  const global = repo.getSetting<Thresholds>('thresholds', DEFAULT_THRESHOLDS)
  if (!deckId) return global
  try {
    return repo.getDeck(deckId).thresholds ?? global
  } catch {
    return global
  }
}

function shuffle<T>(arr: T[], rand = Math.random): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Which single-card types fit this card. */
export function typesForCard(card: Card, enabled: QuestionType[]): QuestionType[] {
  const blanks = cardBlanks(card)
  return enabled.filter((t) => {
    if (t === 'match_pairs' || t === 'categorize') return false
    if (t === 'fill_blank' || t === 'choice_blank') return !!blanks
    if (t === 'true_false' || t === 'multiple_choice') return card.back.trim().length > 0
    return true
  })
}

/** Build the question plan: one question per card, with group questions mixed in. */
export function planSession(cards: Card[], settings: LearnSettings, rand = Math.random): PlanItem[] {
  const enabled = QUESTION_TYPES.filter((t) => settings.types[t] !== false)
  if (enabled.length === 0) throw new Error('Turn on at least one question type.')
  const ordered = settings.shuffle ? shuffle(cards, rand) : cards
  const picked = ordered.slice(0, settings.sessionLength)
  const plan: PlanItem[] = []
  const counts = new Map<QuestionType, number>()
  for (const c of picked) {
    const options = typesForCard(c, enabled)
    if (options.length === 0) {
      // Card can't take any enabled single type (e.g. only fill-blank on, card has no blanks).
      if (enabled.includes('read_understand')) plan.push({ type: 'read_understand', card_id: c.id, card_ids: [c.id] })
      continue
    }
    // Balance types: prefer the least-used option, random tie-break.
    const min = Math.min(...options.map((o) => counts.get(o) ?? 0))
    const least = options.filter((o) => (counts.get(o) ?? 0) === min)
    const t = least[Math.floor(rand() * least.length)]
    counts.set(t, (counts.get(t) ?? 0) + 1)
    plan.push({ type: t, card_id: c.id, card_ids: [c.id] })
  }
  const groupTypes = enabled.filter((t) => t === 'match_pairs' || t === 'categorize')
  if (groupTypes.length > 0 && cards.length >= 4) {
    const slots = Math.max(1, Math.floor(plan.length / 6))
    for (let i = 0; i < slots; i++) {
      const t = groupTypes[i % groupTypes.length]
      const need = t === 'match_pairs' ? Math.min(6, Math.max(4, Math.min(cards.length, 4 + Math.floor(rand() * 3)))) : Math.min(9, cards.length)
      if (t === 'categorize' && cards.length < 4) continue
      const group = shuffle(cards, rand).slice(0, need)
      const at = Math.min(plan.length, (i + 1) * 6 - 1)
      plan.splice(at, 0, { type: t, card_id: group[0].id, card_ids: group.map((c) => c.id) })
    }
  }
  if (plan.length === 0) throw new Error('No cards can be turned into the selected question types.')
  return plan
}

/** The deck's settings with the types offline mode can't ask turned off. */
export function offlineSettings(settings: LearnSettings): LearnSettings {
  const types = { ...settings.types }
  for (const t of OFFLINE_SKIPPED_TYPES) types[t] = false
  if (!QUESTION_TYPES.some((t) => types[t] !== false))
    throw new Error('This deck only asks free-answer or sorting questions, which need AI. Turn on another question type in Learn settings, or turn off offline mode.')
  return { ...settings, types }
}

export function startSession(deckId: string, cardIds?: string[]): { sessionId: string; total: number; settings: LearnSettings } {
  const settings = isOffline() ? offlineSettings(settingsFor(deckId)) : settingsFor(deckId)
  let cards = repo.listCards(deckId)
  if (cardIds?.length) cards = cards.filter((c) => cardIds.includes(c.id))
  if (cards.length === 0) throw new Error('This deck has no cards yet.')
  // Due and weak cards first when not shuffling the whole deck.
  const due = new Set(repo.dueCards(deckId).map((c) => c.id))
  if (cards.length > settings.sessionLength) cards = [...cards.filter((c) => due.has(c.id)), ...cards.filter((c) => !due.has(c.id))]
  const plan = planSession(cards, { ...settings, shuffle: settings.shuffle })
  const id = uid()
  getDb().prepare('INSERT INTO learn_sessions (id, deck_id, settings, started_at) VALUES (?, ?, ?, ?)').run(id, deckId, JSON.stringify(settings), now())
  sessions.set(id, { id, deckId, plan, batches: new Map() })
  return { sessionId: id, total: plan.length, settings }
}

export function endSession(sessionId: string): { answered: number; correct: number; partial: number; wrong: number } {
  const rows = getDb().prepare('SELECT verdict, overridden FROM answer_attempts WHERE session_id = ?').all(sessionId) as { verdict: string; overridden: number }[]
  const stats = {
    answered: rows.length,
    correct: rows.filter((r) => r.verdict === 'correct').length,
    partial: rows.filter((r) => r.verdict === 'partial').length,
    wrong: rows.filter((r) => r.verdict === 'wrong').length
  }
  getDb().prepare('UPDATE learn_sessions SET ended_at = ?, stats = ? WHERE id = ?').run(now(), JSON.stringify(stats), sessionId)
  sessions.delete(sessionId)
  return stats
}

/** Get questions [batch*8, batch*8+8). Generation is shared, so prefetching twice is free. */
export function getBatch(sessionId: string, batch: number): Promise<LearnQuestion[]> {
  const s = sessions.get(sessionId)
  if (!s) return Promise.reject(new Error('Learn session expired. Start again.'))
  const items = s.plan.slice(batch * BATCH_SIZE, batch * BATCH_SIZE + BATCH_SIZE)
  if (items.length === 0) return Promise.resolve([])
  let p = s.batches.get(batch)
  if (!p) {
    p = buildQuestions(s.deckId, items)
    s.batches.set(batch, p)
    p.catch(() => s.batches.delete(batch))
  }
  return p
}

function cachedPayload(cardId: string, type: string, presetId: string, version: number): unknown | null {
  const r = getDb()
    .prepare('SELECT payload FROM question_cache WHERE card_id = ? AND qtype = ? AND preset_id = ? AND preset_version = ?')
    .get(cardId, type, presetId, version) as { payload: string } | undefined
  return r ? json(r.payload, null) : null
}
function cachePayload(cardId: string, type: string, presetId: string, version: number, payload: unknown): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO question_cache VALUES (?, ?, ?, ?, ?, ?)')
    .run(cardId, type, presetId, version, JSON.stringify(payload), now())
}

const stripPoints = (s: string) => s.replace(/\s*\(\d+\)\s*$/, '').trim()
const firstLine = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s+/, '').trim())
    .filter(Boolean)
    .join('; ')

export function matchPairsFor(cards: Card[]): LearnQuestion {
  const pairs = cards.map((c) => ({
    left: stripPoints(c.front).slice(0, 120),
    right: firstLine(c.back.replace(/\*\*/g, '')).slice(0, 140) || c.back.slice(0, 140),
    card_id: c.id
  }))
  return { id: uid(), type: 'match_pairs', card_id: cards[0].id, card_ids: cards.map((c) => c.id), payload: { pairs }, cached: false }
}

/** Fallback question when the AI fails for a card: free answer on the card itself. */
function fallbackQuestion(card: Card): LearnQuestion {
  return {
    id: uid(),
    type: 'free_answer',
    card_id: card.id,
    card_ids: [card.id],
    payload: { question: card.front, expected_answer: card.back || card.front },
    cached: false
  }
}

function fromAiItem(item: AiQuestionItem, card: Card): LearnQuestion | null {
  const base = { id: uid(), card_id: card.id, card_ids: [card.id], cached: false }
  switch (item.type) {
    case 'read_understand': {
      const p = QuestionPayloads.read_understand.safeParse({ title: item.title ?? '', explanation: item.explanation ?? '' })
      return p.success ? { ...base, type: 'read_understand', payload: p.data } : null
    }
    case 'multiple_choice': {
      const p = QuestionPayloads.multiple_choice.safeParse({ question: item.question, options: item.options, correct_index: item.correct_index })
      if (!p.success) return null
      // Shuffle so the right answer's position gives nothing away.
      const s = shuffleOptions(p.data.options, p.data.correct_index)
      return { ...base, type: 'multiple_choice', payload: { ...p.data, options: s.options, correct_index: s.answer } }
    }
    case 'free_answer': {
      const p = QuestionPayloads.free_answer.safeParse({ question: item.question || card.front, expected_answer: item.expected_answer })
      return p.success ? { ...base, type: 'free_answer', payload: p.data } : null
    }
    case 'true_false': {
      const p = QuestionPayloads.true_false.safeParse({ statement: item.statement, is_true: item.is_true, correction: item.correction ?? '' })
      return p.success ? { ...base, type: 'true_false', payload: p.data } : null
    }
    case 'choice_blank': {
      const blanks = cardBlanks(card)
      if (!blanks) return null
      const choices = blanks.answers.map((ans, i) => {
        const d = (item.distractors?.[i] ?? []).filter((x) => x && x.trim().toLowerCase() !== ans.trim().toLowerCase()).slice(0, 3)
        return shuffle([ans, ...d])
      })
      if (choices.some((c) => c.length < 2)) return null
      return {
        ...base,
        type: 'choice_blank',
        payload: { prompt: blanks.source === 'bold' ? stripPoints(card.front) : '', segments: blanks.segments, answers: blanks.answers, choices }
      }
    }
  }
}

function fillBlankFor(card: Card): LearnQuestion | null {
  const b = cardBlanks(card)
  if (!b) return null
  return {
    id: uid(),
    type: 'fill_blank',
    card_id: card.id,
    card_ids: [card.id],
    payload: { prompt: b.source === 'bold' ? stripPoints(card.front) : '', segments: b.segments, answers: b.answers },
    cached: false
  }
}

async function categorizeFor(deckId: string, cards: Card[]): Promise<LearnQuestion | null> {
  const r = await runAI<{ categories: string[]; items: { text: string; category: string; card_id?: string | null }[] }>({
    task: 'make_categorize',
    deckId,
    vars: { cards: JSON.stringify(cards.map((c) => ({ card_id: c.id, front: c.front, back: c.back }))) }
  })
  const cats = r.data.categories
  const items = r.data.items.filter((i) => cats.includes(i.category)).map((i) => ({ text: i.text, category: i.category, card_id: i.card_id ?? undefined }))
  const p = QuestionPayloads.categorize.safeParse({ categories: cats, items: shuffle(items) })
  if (!p.success) return null
  return { id: uid(), type: 'categorize', card_id: cards[0].id, card_ids: cards.map((c) => c.id), payload: p.data, cached: false }
}

/** A question the AI made earlier, with its answers in new places. */
function cachedQuestion(type: QuestionType, card: Card, raw: unknown): LearnQuestion | null {
  if (!raw) return null
  const p = QuestionPayloads[type].safeParse(raw)
  if (!p.success) return null
  // Answers go in new places every time a cached question comes back.
  let payload: unknown = p.data
  if (type === 'choice_blank') {
    const cb = p.data as z.infer<typeof QuestionPayloads.choice_blank>
    payload = { ...cb, choices: cb.choices.map((c) => shuffle(c)) }
  } else if (type === 'multiple_choice') {
    const mc = p.data as z.infer<typeof QuestionPayloads.multiple_choice>
    const s = shuffleOptions(mc.options, mc.correct_index)
    payload = { ...mc, options: s.options, correct_index: s.answer }
  }
  return { id: uid(), type, card_id: card.id, card_ids: [card.id], payload, cached: true } as LearnQuestion
}

// ---------- offline: questions made without AI ----------

/** The newest question the AI made for this card and type, from any version of the prompt (the phone has none). */
function anyCachedPayload(cardId: string, type: string): unknown | null {
  try {
    const r = getDb().prepare('SELECT payload FROM question_cache WHERE card_id = ? AND qtype = ? ORDER BY created_at DESC LIMIT 1').get(cardId, type) as { payload: string } | undefined
    return r ? json(r.payload, null) : null
  } catch {
    return null
  }
}

/** A card's answer as one plain line for an option: no bold, no images. */
const plainAnswer = (s: string) =>
  firstLine(s.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/!\[\[[^\]]*\]\]/g, '').replace(/\*\*/g, ''))
    .replace(/\s+/g, ' ')
    .slice(0, 220)
    .trim()
const sameText = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ')

/** Up to n of `pool` that differ from `answer`, picked at random from the ones closest to it in length (so the right one doesn't stand out). */
function distractors(answer: string, pool: string[], n: number, avoid: string[] = []): string[] {
  const seen: string[] = []
  for (const p of pool) if (p && !sameText(p, answer) && !avoid.some((a) => sameText(a, p)) && !seen.some((s) => sameText(s, p))) seen.push(p)
  const near = seen.sort((x, y) => Math.abs(x.length - answer.length) - Math.abs(y.length - answer.length)).slice(0, Math.max(n * 3, 8))
  return shuffle(near).slice(0, n)
}

/** Multiple choice from the card's own options, topped up with other cards' answers in the deck. */
export function localMultipleChoice(card: Card, pool: Card[]): LearnQuestion | null {
  const question = stripPoints(card.front) || card.front.trim()
  if (!question) return null
  const right = card.options.filter((o) => o.correct && o.text.trim())
  const answer = right.length === 1 ? right[0].text.trim() : plainAnswer(card.back)
  if (!answer) return null
  const own = right.length === 1 ? shuffle(card.options.filter((o) => !o.correct && o.text.trim()).map((o) => o.text.trim())).slice(0, 3) : []
  const others = pool.filter((c) => c.id !== card.id).map((c) => plainAnswer(c.back))
  const wrong = [...own, ...distractors(answer, others, 3 - own.length, own)]
  if (wrong.length < 3) return null
  const s = shuffleOptions([answer, ...wrong], 0)
  return { id: uid(), type: 'multiple_choice', card_id: card.id, card_ids: [card.id], payload: { question, options: s.options, correct_index: s.answer }, cached: false }
}

/** Choose-the-word blanks, with wrong choices taken from the other cards' blanks in the deck. */
export function localChoiceBlank(card: Card, pool: Card[]): LearnQuestion | null {
  const b = cardBlanks(card)
  if (!b) return null
  const words = pool.filter((c) => c.id !== card.id).flatMap((c) => cardBlanks(c)?.answers ?? [])
  const choices = b.answers.map((ans) => shuffle([ans, ...distractors(ans, words, 3, b.answers)]))
  if (choices.some((c) => c.length < 2)) return null
  return {
    id: uid(),
    type: 'choice_blank',
    card_id: card.id,
    card_ids: [card.id],
    payload: { prompt: b.source === 'bold' ? stripPoints(card.front) : '', segments: b.segments, answers: b.answers, choices },
    cached: false
  }
}

function localRead(card: Card): LearnQuestion {
  return {
    id: uid(),
    type: 'read_understand',
    card_id: card.id,
    card_ids: [card.id],
    payload: { title: stripPoints(card.front), explanation: card.back.trim() || card.front.trim() || '(empty card)' },
    cached: false
  }
}

/**
 * Offline: every question is made here. Questions the AI made earlier are used
 * when they're marked in code; otherwise multiple choice and choice blanks are
 * built from the deck's own answers. Free answers and sorting are never asked
 * (a session started online that has them gets one of these instead), and a
 * card nothing fits is shown to read.
 */
function buildOffline(deckId: string, items: PlanItem[], cards: Map<string, Card>): LearnQuestion[] {
  let pool: Card[] | null = null
  const deck = () => (pool ??= repo.listCards(deckId))
  return items
    .map((item): LearnQuestion | null => {
      const card = cards.get(item.card_id)
      if (!card) return null
      const group = item.card_ids.map((id) => cards.get(id)).filter((c): c is Card => !!c)
      if (item.type === 'match_pairs') return matchPairsFor(group)
      if (item.type === 'categorize') return group.length >= 2 ? matchPairsFor(group.slice(0, 6)) : localRead(card)
      const fromCache = item.type === 'free_answer' || item.type === 'fill_blank' ? null : cachedQuestion(item.type, card, anyCachedPayload(card.id, item.type))
      if (fromCache) return fromCache
      const tries: (() => LearnQuestion | null)[] =
        item.type === 'fill_blank'
          ? [() => fillBlankFor(card)]
          : item.type === 'choice_blank'
            ? [() => localChoiceBlank(card, deck()), () => fillBlankFor(card)]
            : item.type === 'read_understand'
              ? []
              : [() => localMultipleChoice(card, deck()), () => fillBlankFor(card)]
      for (const t of tries) {
        const q = t()
        if (q) return q
      }
      return localRead(card)
    })
    .filter((q): q is LearnQuestion => !!q)
}

export async function buildQuestions(deckId: string, items: PlanItem[], opts: { noCache?: boolean } = {}): Promise<LearnQuestion[]> {
  const allIds = [...new Set(items.flatMap((i) => i.card_ids))]
  const cards = new Map(repo.getCards(allIds).map((c) => [c.id, c]))
  if (isOffline()) return buildOffline(deckId, items, cards)
  const preset = defaultPreset('make_questions')
  const out = new Map<number, LearnQuestion>()
  const needAi: { idx: number; item: PlanItem; card: Card }[] = []
  const groupJobs: Promise<void>[] = []

  items.forEach((item, idx) => {
    const card = cards.get(item.card_id)
    if (!card) return
    if (item.type === 'match_pairs') {
      out.set(idx, matchPairsFor(item.card_ids.map((id) => cards.get(id)).filter((c): c is Card => !!c)))
      return
    }
    if (item.type === 'categorize') {
      const group = item.card_ids.map((id) => cards.get(id)).filter((c): c is Card => !!c)
      groupJobs.push(
        categorizeFor(deckId, group)
          .then((q) => {
            out.set(idx, q ?? matchPairsFor(group.slice(0, 6)))
          })
          .catch(() => {
            out.set(idx, matchPairsFor(group.slice(0, 6)))
          })
      )
      return
    }
    if (item.type === 'fill_blank') {
      out.set(idx, fillBlankFor(card) ?? fallbackQuestion(card))
      return
    }
    if (!opts.noCache) {
      const cached = cachedQuestion(item.type, card, cachedPayload(card.id, item.type, preset.id, preset.version))
      if (cached) {
        out.set(idx, cached)
        return
      }
    }
    needAi.push({ idx, item, card })
  })

  if (needAi.length > 0) {
    const payload = needAi.map(({ item, card }) => ({
      card_id: card.id,
      type: item.type,
      front: card.front,
      back: card.back,
      ...(item.type === 'choice_blank' ? { blanks: cardBlanks(card)?.answers ?? [] } : {}),
      ...(card.options.length ? { options: card.options } : {})
    }))
    try {
      const r = await runAI<{ questions: AiQuestionItem[] }>({ task: 'make_questions', deckId, vars: { cards: JSON.stringify(payload, null, 1) } })
      const byCard = new Map(r.data.questions.map((q) => [`${q.card_id}:${q.type}`, q]))
      for (const { idx, item, card } of needAi) {
        const ai = byCard.get(`${card.id}:${item.type}`) ?? r.data.questions.find((q) => q.card_id === card.id)
        const q = ai && AI_TYPES.includes(ai.type) ? fromAiItem({ ...ai, type: item.type as AiType }, card) : null
        if (q) cachePayload(card.id, q.type, preset.id, preset.version, q.payload)
        out.set(idx, q ?? fallbackQuestion(card))
      }
    } catch (e) {
      // Never leave the user waiting on a broken batch: fall back to free-answer questions.
      console.error('[learn] question batch failed', e)
      for (const { idx, card } of needAi) out.set(idx, fallbackQuestion(card))
    }
  }
  await Promise.all(groupJobs)
  return items.map((_, idx) => out.get(idx)).filter((q): q is LearnQuestion => !!q)
}

export async function regenerateQuestion(deckId: string, q: Pick<LearnQuestion, 'type' | 'card_id' | 'card_ids'>): Promise<LearnQuestion> {
  // Offline, the AI's question stays cached for later: this only makes another one here.
  if (!isOffline()) getDb().prepare('DELETE FROM question_cache WHERE card_id = ? AND qtype = ?').run(q.card_id, q.type)
  const [nq] = await buildQuestions(deckId, [{ type: q.type, card_id: q.card_id, card_ids: q.card_ids }], { noCache: true })
  if (!nq) throw new Error('Could not regenerate this question')
  return nq
}

// ---------- marking ----------

export function questionText(q: LearnQuestion): string {
  switch (q.type) {
    case 'read_understand':
      return q.payload.title
    case 'multiple_choice':
      return `${q.payload.question}\n${q.payload.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join('\n')}`
    case 'free_answer':
      return q.payload.question
    case 'true_false':
      return `True or false: ${q.payload.statement}`
    case 'match_pairs':
      return 'Match each term with its definition'
    case 'categorize':
      return `Sort into: ${q.payload.categories.join(', ')}`
    case 'fill_blank':
    case 'choice_blank':
      return [q.payload.prompt, segmentsToPrompt(q.payload.segments)].filter(Boolean).join('\n')
  }
}

export function expectedText(q: LearnQuestion): string {
  switch (q.type) {
    case 'read_understand':
      return ''
    case 'multiple_choice':
      return q.payload.options[q.payload.correct_index]
    case 'free_answer':
      return q.payload.expected_answer
    case 'true_false':
      return q.payload.is_true ? 'True' : `False. ${q.payload.correction}`
    case 'match_pairs':
      return q.payload.pairs.map((p) => `${p.left} → ${p.right}`).join('\n')
    case 'categorize':
      return q.payload.items.map((i) => `${i.text} → ${i.category}`).join('\n')
    case 'fill_blank':
    case 'choice_blank':
      return q.payload.answers.join(' | ')
  }
}

export function answerText(q: LearnQuestion, a: LearnAnswer): string {
  switch (a.type) {
    case 'read_understand':
      return 'Got it'
    case 'multiple_choice':
      return q.type === 'multiple_choice' ? (q.payload.options[a.index] ?? '') : ''
    case 'true_false':
      return a.value ? 'True' : 'False'
    case 'free_answer':
      return a.text
    case 'match_pairs':
      return q.type === 'match_pairs' ? q.payload.pairs.map((p, i) => `${p.left} → ${q.payload.pairs[a.mapping[i]]?.right ?? '(none)'}`).join('\n') : ''
    case 'categorize':
      return q.type === 'categorize' ? q.payload.items.map((it, i) => `${it.text} → ${a.assignments[i] ?? '(none)'}`).join('\n') : ''
    case 'fill_blank':
    case 'choice_blank':
      return a.values.join(' | ')
  }
}

export async function markAnswer(deckId: string, q: LearnQuestion, a: LearnAnswer): Promise<Mark> {
  const t = thresholdsFor(deckId)
  const code = markInCode(q, a, t)
  if (code) return code
  const card = repo.getCard(q.card_id)
  if (q.type === 'free_answer' && a.type === 'free_answer') {
    if (!a.text.trim()) return { score: 0, verdict: 'wrong', detail: { short_feedback: 'No answer given.' }, by: 'code' }
    if (isOffline()) throw new Error('Written answers are marked by AI, so offline mode can’t mark this one. Skip it, or turn off offline mode.')
    const r = await runAI<FreeAnswerMark>({
      task: 'mark_free_answer',
      deckId,
      vars: {
        front: card.front,
        back: card.back,
        required_points: card.required_points ?? 'not specified',
        question: q.payload.question,
        expected_answer: q.payload.expected_answer,
        user_answer: a.text
      }
    })
    const score = Math.max(0, Math.min(10, r.data.score))
    return {
      score,
      verdict: verdictFor(score, t),
      detail: { points_found: r.data.points_found, points_missing: r.data.points_missing, short_feedback: r.data.short_feedback },
      by: 'ai'
    }
  }
  if (q.type === 'fill_blank' && a.type === 'fill_blank') {
    const exact = markFillBlankExact(a.values, q.payload.answers)
    if (exact.mark) return exact.mark
    // Offline only exact answers count; "I was right" is there for the ones that mean the same.
    if (isOffline()) return { ...fillBlankFromAi(exact.blanks), by: 'code' }
    const r = await runAI<{ blanks: { correct: boolean }[] }>({
      task: 'mark_fill_blank',
      deckId,
      vars: {
        front: card.front,
        back: card.back,
        question: segmentsToPrompt(q.payload.segments),
        expected_answer: q.payload.answers.join(' | '),
        user_answer: a.values.join(' | ')
      }
    })
    // Code-matched blanks stay right; the AI only judges the rest.
    const blanks = q.payload.answers.map((_, i) => exact.blanks[i] || !!r.data.blanks[i]?.correct)
    return fillBlankFromAi(blanks)
  }
  throw new Error(`Can't mark ${q.type}`)
}

/**
 * Mark an answer and update the schedule. A retry (a missed question asked
 * again later in the session) is marked the same way but leaves the schedule
 * alone, since the first answer already counted, and stays out of the
 * session's stats.
 */
export async function submitAnswer(sessionId: string | null, deckId: string, q: LearnQuestion, a: LearnAnswer, retry = false): Promise<{ attemptId: string; mark: Mark }> {
  const mark = await markAnswer(deckId, q, a)
  const prev: Record<string, ReviewState | null> = {}
  // SM-2: group questions update each card by its own item result.
  if (q.type !== 'read_understand' && !retry) {
    if (q.type === 'match_pairs' || q.type === 'categorize') {
      const wrong = new Set((mark.detail?.wrongItems ?? []).map((i) => (q.type === 'match_pairs' ? q.payload.pairs[i]?.card_id : q.payload.items[i]?.card_id)))
      for (const id of q.card_ids) {
        prev[id] = repo.getReviewState(id)
        repo.applyReview(id, wrong.has(id) ? 1 : 3, 'learn')
      }
    } else {
      prev[q.card_id] = repo.getReviewState(q.card_id)
      repo.applyReview(q.card_id, ratingForVerdict(mark.verdict), 'learn')
    }
  }
  const id = uid()
  getDb()
    .prepare(
      `INSERT INTO answer_attempts (id, session_id, card_id, qtype, question, answer, score, verdict, mark, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, retry ? null : sessionId, q.card_id, q.type, JSON.stringify(q), JSON.stringify(a), mark.score, mark.verdict, JSON.stringify({ ...mark, prev, retry }), now())
  return { attemptId: id, mark }
}

/** "I was right": record the override and redo SM-2 as Good. */
export function overrideAttempt(attemptId: string): Mark {
  const row = getDb().prepare('SELECT * FROM answer_attempts WHERE id = ?').get(attemptId) as { mark: string; card_id: string; qtype: string } | undefined
  if (!row) throw new Error('Answer not found')
  const m = json<OverrideMark>(row.mark, { score: 0, verdict: 'wrong', by: 'code' })
  const d = getDb()
  const cur = d.prepare('SELECT score, verdict, overridden FROM answer_attempts WHERE id = ?').get(attemptId) as { score: number; verdict: Mark['verdict']; overridden: number }
  if (cur.overridden) return { ...stripOverride(m), score: 10, verdict: 'correct' }
  d.transaction(() => {
    // What the schedule looked like after the first marking, so "undo" can put it back.
    const after: Record<string, ReviewState | null> = {}
    for (const [cardId, state] of Object.entries(m.prev ?? {})) {
      after[cardId] = repo.getReviewState(cardId)
      if (state) repo.writeReviewState({ ...state, card_id: cardId })
      else d.prepare('DELETE FROM review_state WHERE card_id = ?').run(cardId)
      repo.applyReview(cardId, 3, 'learn')
    }
    const saved: OverrideMark = { ...m, undo: { score: cur.score, verdict: cur.verdict, states: after } }
    d.prepare("UPDATE answer_attempts SET overridden = 1, verdict = 'correct', score = 10, mark = ? WHERE id = ?").run(JSON.stringify(saved), attemptId)
  })()
  return { ...stripOverride(m), score: 10, verdict: 'correct' }
}

type OverrideMark = Mark & { prev?: Record<string, ReviewState | null>; undo?: { score: number; verdict: Mark['verdict']; states: Record<string, ReviewState | null> } }
const stripOverride = ({ undo: _u, ...m }: OverrideMark): Mark => m

/** Take back "I was right": the answer's first mark and the schedule it gave come back. */
export function undoOverride(attemptId: string): Mark {
  const row = getDb().prepare('SELECT mark, overridden FROM answer_attempts WHERE id = ?').get(attemptId) as { mark: string; overridden: number } | undefined
  if (!row) throw new Error('Answer not found')
  const m = json<OverrideMark>(row.mark, { score: 0, verdict: 'wrong', by: 'code' })
  if (!row.overridden || !m.undo) throw new Error('That answer wasn’t marked as right by you')
  const { undo, ...rest } = m
  const d = getDb()
  d.transaction(() => {
    for (const [cardId, state] of Object.entries(undo.states)) {
      if (state) repo.writeReviewState({ ...state, card_id: cardId })
      else d.prepare('DELETE FROM review_state WHERE card_id = ?').run(cardId)
      // The review the override added goes too.
      d.prepare("DELETE FROM review_log WHERE id = (SELECT MAX(id) FROM review_log WHERE card_id = ? AND source = 'learn')").run(cardId)
    }
    d.prepare('UPDATE answer_attempts SET overridden = 0, verdict = ?, score = ?, mark = ? WHERE id = ?').run(undo.verdict, undo.score, JSON.stringify(rest), attemptId)
  })()
  return { ...stripOverride(rest), score: undo.score, verdict: undo.verdict }
}

export function getAttempt(id: string): { q: LearnQuestion; a: LearnAnswer; mark: Mark; deckId: string; feedback: unknown } {
  const row = getDb()
    .prepare('SELECT a.*, c.deck_id FROM answer_attempts a JOIN cards c ON c.id = a.card_id WHERE a.id = ?')
    .get(id) as { question: string; answer: string; mark: string; deck_id: string; feedback: string | null; verdict: string; score: number }
  if (!row) throw new Error('Answer not found')
  const mark = json<Mark>(row.mark, { score: row.score, verdict: row.verdict as Mark['verdict'], by: 'code' })
  return { q: json(row.question, null as unknown as LearnQuestion), a: json(row.answer, null as unknown as LearnAnswer), mark: { ...mark, verdict: row.verdict as Mark['verdict'], score: row.score }, deckId: row.deck_id, feedback: json(row.feedback, null) }
}

export async function feedbackFor(attemptId: string): Promise<{ kind: 'right'; takeaways: string[]; pro_tip: string } | { kind: 'wrong'; why_wrong: string; takeaways: string[]; how_to_remember: string }> {
  const at = getAttempt(attemptId)
  if (at.feedback) return at.feedback as never
  const card = repo.getCard(at.q.card_id)
  const vars = {
    front: card.front,
    back: card.back,
    required_points: card.required_points ?? '',
    question: questionText(at.q),
    expected_answer: expectedText(at.q),
    user_answer: answerText(at.q, at.a),
    type: at.q.type
  }
  let fb: Awaited<ReturnType<typeof feedbackFor>>
  if (at.mark.verdict === 'correct') {
    const r = await runAI<{ takeaways: string[]; pro_tip: string }>({ task: 'feedback_right', deckId: at.deckId, vars })
    fb = { kind: 'right', ...r.data }
  } else {
    const r = await runAI<{ why_wrong: string; takeaways: string[]; how_to_remember: string }>({ task: 'feedback_wrong', deckId: at.deckId, vars })
    fb = { kind: 'wrong', ...r.data }
  }
  getDb().prepare('UPDATE answer_attempts SET feedback = ? WHERE id = ?').run(JSON.stringify(fb), attemptId)
  return fb
}

/** Up to 2 escalating hints; the card's stored hints come first. */
export async function hintFor(cardId: string, q: LearnQuestion, index: number, previous: string[]): Promise<{ hint: string; source: 'card' | 'ai' }> {
  if (index > 1) throw new Error('No more hints for this question')
  const card = repo.getCard(cardId)
  if (card.hints[index]) return { hint: card.hints[index], source: 'card' }
  if (isOffline()) throw new Error(index ? 'That’s the only hint this card has. Offline mode doesn’t ask the AI for more.' : 'This card has no hints. Offline mode doesn’t ask the AI for one.')
  const r = await runAI<{ hint: string }>({
    task: 'hint',
    deckId: card.deck_id,
    vars: {
      front: card.front,
      back: card.back,
      question: questionText(q),
      type: q.type,
      previous_hints: previous.length ? previous.map((h) => `- ${h}`).join('\n') : '(none)'
    }
  })
  return { hint: r.data.hint, source: 'ai' }
}

export function lastAnswerFor(cardId: string): string | null {
  const row = getDb().prepare('SELECT question, answer FROM answer_attempts WHERE card_id = ? ORDER BY created_at DESC LIMIT 1').get(cardId) as
    | { question: string; answer: string }
    | undefined
  if (!row) return null
  try {
    return answerText(JSON.parse(row.question), JSON.parse(row.answer))
  } catch {
    return null
  }
}
