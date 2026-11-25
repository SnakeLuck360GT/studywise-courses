import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, extname } from 'node:path'
import { z } from 'zod'
import { runAI } from '../ai'
import { defaultPreset, getPreset, getPresetByKey } from '../ai/presets'
import { prepareSources, pdfPageCount, extractText, type SourceChunk } from '../files'
import type { JobContext } from '../jobs'
import { simpleTracker } from './liveProgress'
import * as repo from '../db/repo'
import { placeNote } from './noteOrder'
import { parseStudySmarterText, validateCards, dedupeCards, normalizeQuestion, type CardWarning } from '@shared/ssText'
import type { GeneratedCard } from '@shared/questions'
import type { CardFormat, CardSource } from '@shared/types'
import type { CardInput as CardInputSchema } from '@shared/types'

export const SourceSpec = z.object({
  files: z.array(z.string()).default([]),
  topic: z.string().default(''),
  text: z.string().default(''),
  noteIds: z.array(z.string()).default([])
})
export type SourceSpec = z.infer<typeof SourceSpec>

export const GenerateNotesInput = z.object({
  sources: SourceSpec,
  presetId: z.string().optional(),
  title: z.string().default(''),
  module: z.string().default(''),
  type: z.string().default(''),
  week: z.string().default(''),
  length: z.enum(['short', 'medium', 'long']).default('medium'),
  level: z.string().default(''),
  instructions: z.string().default(''),
  folderId: z.string().nullable().optional(),
  deckId: z.string().nullable().optional()
})
export type GenerateNotesInput = z.infer<typeof GenerateNotesInput>

export const GenerateCardsInput = z.object({
  sources: SourceSpec,
  deckId: z.string().nullable().optional(),
  presetId: z.string().optional(),
  format: z.enum(['term_definition', 'question_answer', 'vocabulary']).default('term_definition'),
  cardType: z.enum(['regular', 'multiple_choice']).default('regular'),
  language: z.string().default(''),
  instructions: z.string().default(''),
  count: z.number().int().min(1).max(500).nullable().default(null)
})
export type GenerateCardsInput = z.infer<typeof GenerateCardsInput>

type CardOut = z.output<typeof CardInputSchema>
export interface PreviewCard extends Omit<CardOut, 'deck_id'> {
  key: string
  front: string
  back: string
}

export interface CardsPreview {
  cards: PreviewCard[]
  warnings: CardWarning[]
  presetName: string
  outputMode: string
  rounds: number
}

const LENGTH_TEXT = {
  short: 'Keep the notes short: only the essentials.',
  medium: '',
  long: 'Make the notes detailed: walk through every example and add tables where they help.'
}

function noteText(id: string, label: string): string {
  const n = repo.getNote(id)
  return `# ${label}: ${n.title}\n\n${n.content}`
}

/** Pick the note heading whose words best match a card. */
export function bestSection(noteContent: string, text: string): string | undefined {
  const headings = noteContent.split('\n').filter((l) => /^#{1,4}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '').trim())
  if (headings.length === 0) return undefined
  const sections = new Map<string, string>()
  let cur = headings[0]
  for (const line of noteContent.split('\n')) {
    if (/^#{1,4}\s/.test(line)) cur = line.replace(/^#+\s*/, '').trim()
    sections.set(cur, (sections.get(cur) ?? '') + ' ' + line)
  }
  const words = new Set(normalizeQuestion(text).split(' ').filter((w) => w.length > 3))
  let best: string | undefined
  let bestScore = 0
  for (const [h, body] of sections) {
    const bw = normalizeQuestion(h + ' ' + body).split(' ')
    const score = bw.filter((w) => words.has(w)).length / Math.sqrt(bw.length + 1)
    if (score > bestScore) {
      bestScore = score
      best = h
    }
  }
  return best
}

// ---------------- notes ----------------

export async function generateNotes(input: GenerateNotesInput, ctx: JobContext): Promise<{ noteId: string }> {
  const s = input.sources
  const multi = s.files.length + s.noteIds.length > 1
  const preset = input.presetId ? getPreset(input.presetId) : multi ? (getPresetByKey('notes.linking_texts') ?? defaultPreset('generate_notes')) : defaultPreset('generate_notes')
  const linking = preset.builtin_key === 'notes.linking_texts' || /linking/i.test(preset.name)
  const title =
    input.title || (s.files[0] ? basename(s.files[0], extname(s.files[0])) : s.noteIds[0] ? repo.getNote(s.noteIds[0]).title : s.topic || 'New note')
  const note = repo.createNote({ title: linking && !input.title ? `Linking all ${title} texts` : title, module: input.module, type: input.type, week: input.week, folder_id: input.folderId ?? null })
  // In revision order in its folder (by week, then lecture), not newest first.
  placeNote(note.id)
  if (input.deckId) repo.linkNoteDeck(note.id, input.deckId, true)
  ctx.meta({ noteId: note.id })
  ctx.progress('Preparing sources…')
  const work = mkdtempSync(join(tmpdir(), 'studywise-src-'))
  const instructions = [input.instructions, LENGTH_TEXT[input.length], input.level ? `Pitch it at ${input.level} level.` : ''].filter(Boolean).join('\n')
  const baseVars = { title, module: input.module, type: input.type, week: input.week, level: input.level, length: input.length, instructions }
  let content = ''
  const push = (t: string) => {
    content += t
    ctx.delta(t)
  }
  try {
    if (linking) {
      // All texts go into one call so they can be compared.
      const texts: string[] = []
      const files: string[] = []
      let i = 1
      for (const f of s.files) {
        const label = `T${i++}`
        const pages = extname(f).toLowerCase() === '.pdf' ? await pdfPageCount(f).catch(() => 999) : 999
        if (extname(f).toLowerCase() === '.pdf' && pages <= 30) {
          files.push(f)
          texts.push(`${label} is the file ${basename(f)}.`)
        } else texts.push(`# ${label}: ${basename(f)}\n\n${await extractText(f)}`)
      }
      for (const id of s.noteIds) texts.push(noteText(id, `T${i++}`))
      if (s.text) texts.push(`# T${i++}: pasted text\n\n${s.text}`)
      ctx.progress(`Linking ${i - 1} texts…`)
      const r = await runAI<string>({ task: 'generate_notes', presetId: preset.id, vars: { ...baseVars, source_text: texts.join('\n\n---\n\n') }, files, deckId: input.deckId, signal: ctx.signal, onDelta: push, onEvent: ctx.live ? simpleTracker(ctx.live, 0.05, 0.98, `Linking ${i - 1} texts…`) : undefined })
      if (!content) push(r.text)
    } else {
      let chunks: SourceChunk[] = []
      if (s.files.length) chunks = await prepareSources(s.files, work)
      for (const id of s.noteIds) chunks.push({ text: noteText(id, 'Note'), label: repo.getNote(id).title })
      if (s.text) chunks.push(...(await import('../files')).textChunks(s.text, 'pasted text'))
      if (chunks.length === 0 && s.topic) chunks.push({ text: `Topic: ${s.topic}`, label: s.topic, partInfo: `There is no source document. Write the notes on the topic "${s.topic}" from your own knowledge, accurately, at the right level.` })
      if (chunks.length === 0) throw new Error('Add a file, a topic, some text or a note to generate from.')
      const live = ctx.live ?? (() => {})
      for (const [i, c] of chunks.entries()) {
        const stage = chunks.length > 1 ? `Writing part ${i + 1} of ${chunks.length} (${c.label})…` : `Writing notes from ${c.label}…`
        ctx.progress(stage)
        live({ stage, percent: i / chunks.length })
        const cont =
          i > 0
            ? `\nThis continues an existing note. Don't repeat the title, the opening "What is...?" section, or sections already written. Headings so far: ${content
                .split('\n')
                .filter((l) => l.startsWith('#'))
                .slice(-15)
                .join(' | ')}`
            : ''
        // One end-of-note summary for the whole note, not one per part.
        const ending =
          chunks.length > 1
            ? i < chunks.length - 1
              ? 'More parts follow, so leave out any end-of-note summary for now.'
              : 'This is the last part. If my notes style ends with a summary, it covers the whole note, including the earlier parts listed above.'
            : ''
        if (i > 0) push('\n\n')
        let got = ''
        const r = await runAI<string>({
          task: 'generate_notes',
          presetId: preset.id,
          vars: { ...baseVars, source_text: c.text ?? '', part_info: [c.partInfo, cont, ending].filter(Boolean).join('\n') },
          files: c.file ? [c.file] : undefined,
          deckId: input.deckId,
          signal: ctx.signal,
          onEvent: simpleTracker(live, i / chunks.length, (i + 1) / chunks.length, stage),
          onDelta: (t) => {
            got += t
            push(t)
          }
        })
        if (!got) push(r.text)
        repo.updateNote(note.id, { content: cleanMarkdown(content) })
      }
    }
    repo.updateNote(note.id, { content: cleanMarkdown(content) })
    return { noteId: note.id }
  } catch (e) {
    if (content.trim()) repo.updateNote(note.id, { content: cleanMarkdown(content) })
    else if (ctx.signal.aborted) repo.deleteNote(note.id)
    throw e
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Remove an outer ```markdown fence if the model wrapped everything. */
export function cleanMarkdown(s: string): string {
  const m = s.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  return (m ? m[1] : s).trim() + '\n'
}

// ---------------- cards ----------------

let keySeq = 0
const nextKey = () => `c${Date.now().toString(36)}${(keySeq++).toString(36)}`

export function fromGenerated(g: GeneratedCard, format: CardFormat, source: CardSource | null): PreviewCard {
  const opts = (g.options ?? []).filter((o) => o.text.trim())
  const isMc = opts.length >= 2 && opts.some((o) => o.correct)
  return {
    key: nextKey(),
    format,
    kind: isMc ? 'multiple_choice' : 'regular',
    front: g.front.trim(),
    back: g.back.trim() || (isMc ? opts.find((o) => o.correct)!.text : ''),
    language: g.language ?? null,
    options: isMc ? opts : [],
    cloze_answers: [],
    tags: g.tags ?? [],
    hints: g.hints ?? [],
    explanation: '',
    source,
    required_points: null
  }
}

function sourceFor(chunk: SourceChunk & { noteId?: string }): CardSource {
  if (chunk.noteId) return { type: 'note', noteId: chunk.noteId, ref: chunk.label }
  if (chunk.file) return { type: 'file', ref: chunk.label, page: chunk.label.match(/pages (.*)$/)?.[1] }
  return { type: 'text', ref: chunk.label }
}

export async function generateCards(input: GenerateCardsInput, ctx: JobContext): Promise<CardsPreview> {
  const preset = input.presetId ? getPreset(input.presetId) : defaultPreset('generate_cards')
  const s = input.sources
  const work = mkdtempSync(join(tmpdir(), 'studywise-src-'))
  try {
    ctx.progress('Preparing sources…')
    const chunks: (SourceChunk & { noteId?: string })[] = s.files.length ? await prepareSources(s.files, work) : []
    for (const id of s.noteIds) {
      const n = repo.getNote(id)
      chunks.push({ text: `# ${n.title}\n\n${n.content}`, label: n.title, noteId: id })
    }
    if (s.text) chunks.push(...(await import('../files')).textChunks(s.text, 'pasted text'))
    if (chunks.length === 0 && s.topic) chunks.push({ text: `Topic: ${s.topic}`, label: s.topic, partInfo: `There are no notes attached. Make the flashcards about the topic "${s.topic}" from your own accurate knowledge.` })
    if (chunks.length === 0) throw new Error('Add a file, a topic, some text or a note to generate from.')

    const countText = input.count ? `Make about ${Math.max(1, Math.round(input.count / chunks.length))} cards${chunks.length > 1 ? ' from this part' : ''}.` : 'Choose the number of cards needed to cover everything.'
    const langText = input.format === 'vocabulary' ? `Second language: ${input.language || 'English'}` : ''
    const vars = {
      format: input.format,
      card_type: input.cardType,
      language: langText,
      count: input.count ?? 'auto',
      instructions: [input.instructions, preset.output_mode === 'studysmarter_text' ? countText : '', input.format === 'vocabulary' && preset.output_mode === 'studysmarter_text' ? `These are vocabulary cards: the question is the word, the answer is its ${input.language || 'English'} translation.` : '', input.cardType === 'multiple_choice' && preset.output_mode === 'studysmarter_text' ? 'Make every card a multiple-choice question: put the 4 options in the question and the correct option as the answer.' : '']
        .filter(Boolean)
        .join('\n')
    }

    let all: PreviewCard[] = []
    let rounds = 0
    const live = ctx.live ?? (() => {})
    for (const [ci, chunk] of chunks.entries()) {
      const label = chunks.length > 1 ? `Part ${ci + 1}/${chunks.length}: ` : ''
      ctx.progress(`${label}reading ${chunk.label}… (${all.length} cards so far)`)
      live({ stage: `${label}reading ${chunk.label}… (${all.length} cards so far)`, percent: ci / chunks.length })
      const tracker = simpleTracker(live, ci / chunks.length, (ci + 1) / chunks.length, `${label}writing cards from ${chunk.label}… (${all.length} so far)`)
      const source = sourceFor(chunk)
      const noteContent = chunk.noteId ? repo.getNote(chunk.noteId).content : null
      const withSection = (c: PreviewCard): PreviewCard =>
        noteContent && c.source?.type === 'note' ? { ...c, source: { ...c.source, section: bestSection(noteContent, `${c.front} ${c.back}`) } } : c

      if (preset.output_mode === 'json') {
        const r = await runAI<{ cards: GeneratedCard[] }>({
          task: 'generate_cards',
          presetId: preset.id,
          vars: { ...vars, source_text: chunk.text ?? '', part_info: chunk.partInfo ?? '' },
          files: chunk.file ? [chunk.file] : undefined,
          deckId: input.deckId,
          signal: ctx.signal,
          onEvent: tracker
        })
        rounds++
        all = all.concat(dedupeCards(all, r.data.cards.map((g) => withSection(fromGenerated(g, input.format, source)))))
        continue
      }

      // studysmarter_text: parse, and auto-continue in the same session if cut off.
      const chunkDir = mkdtempSync(join(work, 'session-'))
      let r = await runAI<string>({
        task: 'generate_cards',
        presetId: preset.id,
        vars: { ...vars, source_text: chunk.text ?? '', part_info: chunk.partInfo ?? '' },
        files: chunk.file ? [chunk.file] : undefined,
        deckId: input.deckId,
        signal: ctx.signal,
        onEvent: tracker,
        persistSession: true,
        workDir: chunkDir
      })
      rounds++
      for (let round = 0; ; round++) {
        const parsed = parseStudySmarterText(r.text, { detectTruncation: true })
        const fresh = parsed.cards.map(
          (p): PreviewCard =>
            withSection({
              key: nextKey(),
              format: input.format,
              kind: p.kind,
              front: p.front,
              back: p.back,
              language: input.format === 'vocabulary' ? input.language || null : null,
              options: [],
              cloze_answers: p.cloze_answers,
              tags: [],
              hints: [],
              explanation: '',
              source,
              required_points: p.required_points
            })
        )
        const added = dedupeCards(all, fresh)
        all = all.concat(added)
        const cutOff = r.truncated || parsed.truncatedTail !== null
        ctx.progress(`${label}${all.length} cards so far…`)
        if (!cutOff || round >= 9 || !r.sessionId) break
        if (round > 0 && added.length === 0) break // model is repeating itself
        ctx.progress(`${label}${all.length} cards so far… continuing (${round + 2}/10)`)
        r = await runAI<string>({ task: 'generate_cards', presetId: preset.id, resume: r.sessionId, rawPrompt: 'continue', workDir: chunkDir, persistSession: true, deckId: input.deckId, signal: ctx.signal })
        rounds++
      }
    }
    ctx.progress(`${all.length} cards ready`)
    return { cards: all, warnings: validateCards(all), presetName: preset.name, outputMode: preset.output_mode, rounds }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export async function fixCard(input: { front: string; back: string; problem: string; deckId?: string | null; regenerate?: boolean; format?: CardFormat }): Promise<PreviewCard> {
  const problem = input.regenerate
    ? 'Rewrite this card from scratch so it tests the same fact in a clearer way, following the style rules.'
    : input.problem || 'Check the card follows the rules and fix anything wrong.'
  const r = await runAI<{ cards: GeneratedCard[] }>({ task: 'fix_cards', vars: { front: input.front, back: input.back, problem }, deckId: input.deckId })
  const g = r.data.cards[0]
  if (!g) throw new Error('Claude returned no card')
  const parsed = parseStudySmarterText(`${g.front}/#*#/${g.back}`).cards[0]
  const base = fromGenerated(g, input.format ?? 'question_answer', null)
  return { ...base, kind: parsed?.kind === 'cloze' ? 'cloze' : base.kind, cloze_answers: parsed?.cloze_answers ?? [], required_points: parsed?.required_points ?? null }
}

export function revalidate(cards: { front: string; back: string }[]): CardWarning[] {
  return validateCards(cards)
}
