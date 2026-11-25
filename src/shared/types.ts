import { z } from 'zod'

export const CardFormat = z.enum(['term_definition', 'question_answer', 'vocabulary'])
export type CardFormat = z.infer<typeof CardFormat>
export const CardKind = z.enum(['regular', 'multiple_choice', 'cloze'])
export type CardKind = z.infer<typeof CardKind>

export const McOption = z.object({ text: z.string(), correct: z.boolean() })
export type McOption = z.infer<typeof McOption>

export const CardSource = z.object({
  type: z.enum(['file', 'note', 'topic', 'text', 'import', 'explain']),
  ref: z.string().optional(),
  noteId: z.string().optional(),
  section: z.string().optional(),
  page: z.string().optional()
})
export type CardSource = z.infer<typeof CardSource>

export const CardInput = z.object({
  deck_id: z.string(),
  format: CardFormat.default('term_definition'),
  kind: CardKind.default('regular'),
  front: z.string().default(''),
  back: z.string().default(''),
  language: z.string().nullable().default(null),
  options: z.array(McOption).default([]),
  cloze_answers: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  hints: z.array(z.string()).default([]),
  explanation: z.string().default(''),
  source: CardSource.nullable().default(null),
  required_points: z.number().int().nullable().default(null)
})
export type CardInput = z.input<typeof CardInput>

export const Card = CardInput.extend({
  id: z.string(),
  position: z.number(),
  created_at: z.string(),
  updated_at: z.string()
})
export type Card = z.infer<typeof Card>

export const AiProvider = z.enum(['claude', 'ollama'])
export type AiProvider = z.infer<typeof AiProvider>

/** provider is only set on one-off choices (e.g. a Test run); stored tables are per provider. */
export const ModelChoice = z.object({ model: z.string(), effort: z.string().nullable().default(null), provider: AiProvider.optional() })
export type ModelChoice = z.infer<typeof ModelChoice>

export interface OllamaModel {
  name: string
  capabilities: string[]
  size: number
  modified_at: string | null
}

export interface OllamaStatus {
  baseUrl: string
  /** Talking to ollama.com directly (needs an API key). */
  cloud: boolean
  hasKey: boolean
  /** The key came from the OLLAMA_API_KEY environment variable. */
  keyFromEnv: boolean
  ready: boolean
  defaultModel: string
  /** Models the user starred, shown first in every model picker. */
  saved: string[]
}

export interface AiStatus {
  provider: AiProvider
  ollama: OllamaStatus
}

export const QUESTION_TYPES = [
  'read_understand',
  'multiple_choice',
  'free_answer',
  'true_false',
  'match_pairs',
  'categorize',
  'fill_blank',
  'choice_blank'
] as const
export const QuestionType = z.enum(QUESTION_TYPES)
export type QuestionType = z.infer<typeof QuestionType>
export const QUESTION_LABELS: Record<QuestionType, string> = {
  read_understand: 'Read & understand',
  multiple_choice: 'Multiple choice',
  free_answer: 'Free answer',
  true_false: 'True or false',
  match_pairs: 'Match pairs',
  categorize: 'Categorize',
  fill_blank: 'Fill in the blank',
  choice_blank: 'Choice blank'
}

export const LearnSettings = z.object({
  types: z.record(z.string(), z.boolean()).default({}),
  sessionLength: z.number().int().min(1).max(500).default(20),
  shuffle: z.boolean().default(true)
})
export type LearnSettings = z.infer<typeof LearnSettings>

export const Thresholds = z.object({ correct: z.number().min(0).max(10), partial: z.number().min(0).max(10) })
export type Thresholds = z.infer<typeof Thresholds>
export const DEFAULT_THRESHOLDS: Thresholds = { correct: 8, partial: 4 }

export const Deck = z.object({
  id: z.string(),
  folder_id: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  extra_instructions: z.string(),
  model_overrides: z.record(z.string(), ModelChoice),
  learn_settings: LearnSettings.nullable(),
  thresholds: Thresholds.nullable(),
  created_at: z.string(),
  updated_at: z.string()
})
export type Deck = z.infer<typeof Deck>

export const Folder = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().nullable(),
  kind: z.enum(['deck', 'note']),
  created_at: z.string()
})
export type Folder = z.infer<typeof Folder>

export const NOTE_TYPES = ['Reading', 'Lecture', 'Lab', 'Tutorial'] as const
export const NoteType = z.enum(NOTE_TYPES)
export const Note = z.object({
  id: z.string(),
  folder_id: z.string().nullable(),
  title: z.string(),
  module: z.string(),
  type: z.string(),
  week: z.string(),
  content: z.string(),
  deck_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  /** Place in its folder, in revision order; null for notes made before ordering (listed after the ordered ones). */
  position: z.number().nullable().default(null)
})
export type Note = z.infer<typeof Note>

export const OutputMode = z.enum(['json', 'markdown', 'studysmarter_text'])
export type OutputMode = z.infer<typeof OutputMode>

export const Preset = z.object({
  id: z.string(),
  task: z.string(),
  name: z.string(),
  builtin_key: z.string().nullable(),
  output_mode: OutputMode,
  system: z.string(),
  user_template: z.string(),
  version: z.number().int(),
  is_default: z.boolean(),
  updated_at: z.string()
})
export type Preset = z.infer<typeof Preset>

export const PresetVersion = z.object({
  preset_id: z.string(),
  version: z.number().int(),
  system: z.string(),
  user_template: z.string(),
  created_at: z.string()
})
export type PresetVersion = z.infer<typeof PresetVersion>

export const ACTION_PLACEMENTS = ['card', 'note_selection', 'learn_question', 'after_answer'] as const
export const CustomAction = z.object({
  id: z.string(),
  name: z.string().min(1),
  icon: z.string().default('sparkles'),
  prompt: z.string(),
  model: z.string().default('sonnet'),
  output: z.enum(['markdown', 'cards']).default('markdown'),
  placements: z.array(z.enum(ACTION_PLACEMENTS)).default(['card']),
  builtin_key: z.string().nullable().default(null),
  position: z.number().default(0)
})
export type CustomAction = z.infer<typeof CustomAction>

export const ReviewState = z.object({
  card_id: z.string(),
  ease: z.number(),
  interval: z.number(),
  repetitions: z.number(),
  lapses: z.number(),
  due: z.string(),
  last_reviewed: z.string().nullable(),
  difficulty: z.number().default(0.6),
  sr_state: z.number().int().default(0),
  good_count: z.number().int().default(0)
})
export type ReviewState = z.infer<typeof ReviewState>

export const Rating = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
export type Rating = z.infer<typeof Rating>

export const AiCall = z.object({
  id: z.number(),
  task: z.string(),
  preset_name: z.string().nullable(),
  preset_version: z.number().nullable(),
  model: z.string(),
  duration_ms: z.number(),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cost_usd: z.number().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
  created_at: z.string()
})
export type AiCall = z.infer<typeof AiCall>

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
export interface JobInfo {
  id: string
  kind: 'generate_notes' | 'generate_cards' | 'course_outline' | 'course_topic' | 'course_update' | 'other'
  title: string
  status: JobStatus
  progress: string
  createdAt: string
  finishedAt: string | null
  error: string | null
  result: unknown
  meta: Record<string, unknown>
  /** 0–1 while running, when the job can tell; null otherwise. */
  percent: number | null
  live: JobLive | null
  /** How much of the Claude plan's 5-hour limit the job used. Missing when it can't be measured (Ollama, no AI calls). */
  planUsage?: JobPlanUsage
}

export interface JobPlanUsage {
  /** 5-hour utilization (0–1) just before the job's first AI call. */
  before: number | null
  /** Percentage points of the 5-hour limit used, 0–1 (0.04 = 4%). Null until measured, or if it couldn't be. */
  used: number | null
  /** Other jobs ran at the same time, so `used` includes theirs too. */
  shared: boolean
  /** Waiting for the fresh reading after the job. */
  measuring: boolean
}

/** What Claude is doing right now, for the progress panel. */
export interface JobLive {
  stage: string
  /** Recent steps, oldest first. */
  log: string[]
  /** Claude Code's running estimate; the thinking text itself isn't available. */
  thinkingTokens: number
  thinking: boolean
  /** The part being written right now. */
  preview: { heading: string; text: string } | null
}

export interface ClaudeStatus {
  path: string | null
  version: string | null
  loggedIn: boolean
  authMethod: string | null
  error: string | null
  overridePath: string | null
  mock: boolean
}

export interface UsageWindow {
  utilization: number // 0..1
  resetsAt: number | null // unix seconds
  status: string
}
export interface UsageLimits {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  status: string
  updatedAt: string
}

/** "about 4% of your 5-hour limit", or null when there's nothing to show yet. Readings are whole percents. */
export function planUsageText(pu: JobPlanUsage | undefined, short = false): string | null {
  if (!pu || pu.measuring || pu.used === null) return null
  const pct = Math.round(pu.used * 100)
  const amount = pct < 1 ? 'under 1%' : `about ${pct}%`
  return short ? `${amount} of 5h limit` : `${amount} of your 5-hour limit${pu.shared ? ' (shared with other jobs running at the same time)' : ''}`
}

// ---------------------------------------------------------------------------
// Phone sync

export interface SyncDevice {
  id: string
  name: string
  lastSync: string | null
  address: string | null
}

/** The desktop's side: the server phones sync with. */
export interface SyncStatus {
  enabled: boolean
  running: boolean
  port: number
  /** This computer's local network addresses. */
  addresses: string[]
  name: string
  deviceId: string
  /** The code a phone types to pair, while pairing is open. */
  pairCode: string | null
  pairExpires: string | null
  devices: SyncDevice[]
  error: string | null
}

/** What the home page shows about your studying (see repo.homeStats). */
export interface HomeStats {
  /** Seconds studied, across every synced device. */
  time: { today: number; week: number; month: number; total: number; dailyAverage: number }
  /** Seconds per day for the last 7 days, oldest first. */
  days: { date: string; seconds: number }[]
  /** Days in a row with any studying or reviews, counting back from today (or yesterday). */
  streak: number
  bestDay: { date: string; seconds: number } | null
  cards: { reviewedToday: number; reviewedWeek: number; total: number; known: number; retention: number | null }
  topics: { done: number; total: number; written: number; answered: number; correct: number; tests: number; testAverage: number | null }
  courses: number
}
