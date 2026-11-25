import { z } from 'zod'
import {
  AiQuestionBatch,
  AiCategorize,
  FreeAnswerMark,
  FillBlankMark,
  FeedbackWrong,
  FeedbackRight,
  HintOut,
  GeneratedCards
} from '@shared/questions'
import type { TaskId } from '@shared/tasks'
import { CourseOutline, AiTopic, CourseMarkOut, CourseTrimOut, CourseUpdate, CourseExtendOut, CourseDedupeOut, AiWeekTest } from '@shared/course'

/** Output schemas for json presets. These live in code and are always appended,
 * so editing a prompt can change behaviour but never break parsing. */
export const TASK_SCHEMAS: Partial<Record<TaskId, z.ZodType>> = {
  generate_cards: GeneratedCards,
  fix_cards: GeneratedCards,
  make_questions: AiQuestionBatch,
  make_categorize: AiCategorize,
  mark_free_answer: FreeAnswerMark,
  mark_fill_blank: FillBlankMark,
  feedback_wrong: FeedbackWrong,
  feedback_right: FeedbackRight,
  hint: HintOut,
  custom_action: GeneratedCards,
  course_outline: CourseOutline,
  course_topic: AiTopic,
  course_mark: CourseMarkOut,
  course_trim: CourseTrimOut,
  course_update: CourseUpdate,
  course_extend: CourseExtendOut,
  course_dedupe: CourseDedupeOut,
  course_week_test: AiWeekTest
}

export function schemaFor(task: TaskId): z.ZodType {
  const s = TASK_SCHEMAS[task]
  if (!s) throw new Error(`Task ${task} has no JSON schema`)
  return s
}

export function jsonSchemaFor(task: TaskId): Record<string, unknown> {
  const js = z.toJSONSchema(schemaFor(task), { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete js.$schema
  // Discriminated unions come out as oneOf; anyOf is more widely supported and
  // means the same here, since each branch has its own "type" constant.
  return JSON.parse(JSON.stringify(js).replace(/"oneOf":/g, '"anyOf":')) as Record<string, unknown>
}

export function formatInstructions(task: TaskId): string {
  return `\n\nOUTPUT FORMAT\nRespond with a single JSON object that matches this JSON Schema exactly. No prose, no code fences.\n${JSON.stringify(jsonSchemaFor(task))}`
}

/** Pull the first JSON object/array out of a text reply. */
export function extractJson(text: string): unknown {
  const t = text.trim()
  try {
    return JSON.parse(t)
  } catch {
    /* fall through */
  }
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {
      /* fall through */
    }
  }
  const start = t.search(/[[{]/)
  if (start === -1) throw new Error('No JSON found in reply')
  const open = t[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < t.length; i++) {
    const ch = t[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return JSON.parse(t.slice(start, i + 1))
    }
  }
  throw new Error('Unterminated JSON in reply')
}
