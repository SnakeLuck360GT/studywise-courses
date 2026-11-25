export const TASKS = [
  'generate_notes',
  'generate_cards',
  'fix_cards',
  'make_questions',
  'make_categorize',
  'explain',
  'explain_chat',
  'feedback_wrong',
  'feedback_right',
  'mark_free_answer',
  'mark_fill_blank',
  'hint',
  'note_simplify',
  'note_shorten',
  'note_fix_formatting',
  'note_expand',
  'custom_action',
  'course_outline',
  'course_topic',
  'course_mark',
  'course_trim',
  'course_update',
  'course_extend',
  'course_week_test'
] as const
export type TaskId = (typeof TASKS)[number]

export interface TaskInfo {
  id: TaskId
  label: string
  defaultModel: 'haiku' | 'sonnet' | 'opus'
  /** Output modes a preset of this task may use. */
  modes: ('json' | 'markdown' | 'studysmarter_text')[]
  variables: string[]
  streams: boolean
  long: boolean
}

const CARD_VARS = ['front', 'back', 'required_points', 'deck_name', 'level', 'language', 'instructions']

export const TASK_INFO: Record<TaskId, TaskInfo> = {
  generate_notes: {
    id: 'generate_notes',
    label: 'Generate notes',
    defaultModel: 'opus',
    modes: ['markdown'],
    variables: ['title', 'module', 'type', 'week', 'level', 'language', 'instructions', 'source_text', 'length', 'part_info'],
    streams: true,
    long: true
  },
  generate_cards: {
    id: 'generate_cards',
    label: 'Generate flashcards',
    defaultModel: 'sonnet',
    modes: ['studysmarter_text', 'json'],
    variables: ['deck_name', 'instructions', 'source_text', 'count', 'format', 'card_type', 'language', 'level', 'part_info'],
    streams: false,
    long: true
  },
  fix_cards: {
    id: 'fix_cards',
    label: 'Fix / regenerate a card',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['front', 'back', 'problem', 'deck_name', 'instructions', 'source_text'],
    streams: false,
    long: false
  },
  make_questions: {
    id: 'make_questions',
    label: 'Make Learn questions',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['cards', 'deck_name', 'language', 'level', 'instructions'],
    streams: false,
    long: false
  },
  make_categorize: {
    id: 'make_categorize',
    label: 'Make Categorize question',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['cards', 'deck_name', 'instructions'],
    streams: false,
    long: false
  },
  explain: {
    id: 'explain',
    label: 'Explain',
    defaultModel: 'sonnet',
    modes: ['markdown'],
    variables: [...CARD_VARS, 'question', 'user_answer', 'source_text', 'mode'],
    streams: true,
    long: false
  },
  explain_chat: {
    id: 'explain_chat',
    label: 'Explain follow-up chat',
    defaultModel: 'sonnet',
    modes: ['markdown'],
    variables: [...CARD_VARS, 'question', 'user_answer', 'source_text', 'history'],
    streams: true,
    long: false
  },
  feedback_wrong: {
    id: 'feedback_wrong',
    label: 'Feedback (wrong / partial)',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: [...CARD_VARS, 'question', 'expected_answer', 'user_answer', 'type'],
    streams: false,
    long: false
  },
  feedback_right: {
    id: 'feedback_right',
    label: 'Feedback (right)',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: [...CARD_VARS, 'question', 'expected_answer', 'user_answer', 'type'],
    streams: false,
    long: false
  },
  mark_free_answer: {
    id: 'mark_free_answer',
    label: 'Mark free answer',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: [...CARD_VARS, 'question', 'expected_answer', 'user_answer'],
    streams: false,
    long: false
  },
  mark_fill_blank: {
    id: 'mark_fill_blank',
    label: 'Mark fill in the blank',
    defaultModel: 'haiku',
    modes: ['json'],
    variables: ['front', 'back', 'question', 'expected_answer', 'user_answer', 'language'],
    streams: false,
    long: false
  },
  hint: {
    id: 'hint',
    label: 'Hint',
    defaultModel: 'haiku',
    modes: ['json'],
    variables: [...CARD_VARS, 'question', 'type', 'previous_hints'],
    streams: false,
    long: false
  },
  note_simplify: {
    id: 'note_simplify',
    label: 'Note: Simplify',
    defaultModel: 'haiku',
    modes: ['markdown'],
    variables: ['source_text', 'title', 'instructions'],
    streams: true,
    long: false
  },
  note_shorten: {
    id: 'note_shorten',
    label: 'Note: Shorten',
    defaultModel: 'haiku',
    modes: ['markdown'],
    variables: ['source_text', 'title', 'instructions'],
    streams: true,
    long: false
  },
  note_fix_formatting: {
    id: 'note_fix_formatting',
    label: 'Note: Fix formatting',
    defaultModel: 'haiku',
    modes: ['markdown'],
    variables: ['source_text', 'title', 'instructions'],
    streams: true,
    long: false
  },
  note_expand: {
    id: 'note_expand',
    label: 'Note: Expand',
    defaultModel: 'sonnet',
    modes: ['markdown'],
    variables: ['source_text', 'title', 'instructions'],
    streams: true,
    long: false
  },
  custom_action: {
    id: 'custom_action',
    label: 'Custom actions',
    defaultModel: 'sonnet',
    modes: ['markdown', 'json'],
    variables: [...CARD_VARS, 'question', 'expected_answer', 'user_answer', 'source_text'],
    streams: true,
    long: false
  },
  course_outline: {
    id: 'course_outline',
    label: 'Course: plan topics',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['module', 'level', 'files', 'source_text', 'part_info', 'instructions'],
    streams: false,
    long: true
  },
  course_topic: {
    id: 'course_topic',
    label: 'Course: write a topic',
    defaultModel: 'opus',
    modes: ['json'],
    variables: ['module', 'level', 'outline', 'topic_id', 'topic_title', 'source_text', 'part_info', 'instructions'],
    streams: false,
    long: true
  },
  course_mark: {
    id: 'course_mark',
    label: 'Course: mark an explain answer',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['module', 'level', 'question', 'marks', 'model', 'points', 'answer'],
    streams: false,
    long: false
  },
  course_trim: {
    id: 'course_trim',
    label: 'Course: trim recall cards',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['module', 'level', 'cards', 'instructions'],
    streams: false,
    long: false
  },
  course_update: {
    id: 'course_update',
    label: 'Course: work new notes into a week',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['module', 'level', 'week', 'topics', 'files', 'source_text', 'instructions'],
    streams: false,
    long: true
  },
  course_extend: {
    id: 'course_extend',
    label: 'Course: write new sections for a topic',
    defaultModel: 'opus',
    modes: ['json'],
    variables: ['module', 'level', 'topic_title', 'existing', 'new_sections', 'source_text', 'part_info', 'instructions'],
    streams: false,
    long: true
  },
  course_week_test: {
    id: 'course_week_test',
    label: 'Course: write an end-of-week test',
    defaultModel: 'sonnet',
    modes: ['json'],
    variables: ['module', 'level', 'week', 'topics', 'files', 'difficulty', 'count', 'source_text', 'instructions'],
    streams: false,
    long: true
  }
}

export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/** Ollama's `think` option: off, or a level (non-gpt-oss models treat any level as on). */
export const OLLAMA_EFFORT_LEVELS = ['off', 'low', 'medium', 'high'] as const
/** Deck override keys for Ollama rows are prefixed so both providers' overrides can coexist. */
export const ollamaKey = (task: string) => `ollama:${task}`

export const ALL_VARIABLES = [
  'front',
  'back',
  'required_points',
  'question',
  'expected_answer',
  'user_answer',
  'source_text',
  'instructions',
  'deck_name',
  'title',
  'module',
  'type',
  'week',
  'level',
  'language'
]
