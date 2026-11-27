// Voice mode: ElevenLabs reads a topic's notes cards (and explanations you ask
// for) aloud while you go through a week. Questions are never read out.

export interface VoiceModel {
  id: string
  label: string
  /** Understands audio tags ([excited], [pause], …), so auto-tagging is worth doing. */
  tags: boolean
}

export const VOICE_MODELS: VoiceModel[] = [
  { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo (fast, audio tags)', tags: true },
  { id: 'eleven_v4', label: 'Eleven v4 (most expressive, audio tags)', tags: true },
  { id: 'eleven_v3', label: 'Eleven v3 (audio tags)', tags: true },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 (cheapest, no tags)', tags: false }
]
export const DEFAULT_VOICE_MODEL = 'eleven_v4_turbo'
/** "George", one of ElevenLabs' default voices: every account has it. */
export const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
export const DEFAULT_VOICE_PROMPT =
  'A warm, encouraging tutor: clear and calm, a little upbeat at a new idea, slower and more serious at definitions, warnings and common mistakes. Not over the top.'

export const modelHasTags = (id: string): boolean => VOICE_MODELS.find((m) => m.id === id)?.tags ?? false

/** Settings keys (the API key is kept encrypted as secret.elevenlabs and never reaches the page). */
export const VOICE_SETTINGS = {
  enabled: 'voice.enabled',
  autoplay: 'voice.autoplay',
  voiceId: 'voice.voiceId',
  model: 'voice.model',
  autoTag: 'voice.autoTag',
  prompt: 'voice.prompt'
} as const

export interface VoiceStatus {
  hasKey: boolean
  /** Voice mode switched on in Settings. */
  enabled: boolean
  /** Each card plays by itself as it opens (otherwise it waits for the speaker button). */
  autoplay: boolean
  voiceId: string
  model: string
  autoTag: boolean
  prompt: string
  /** On, with a key: notes get read out. */
  ready: boolean
}

export interface VoiceOption {
  id: string
  name: string
  category: string
  description: string
}

/**
 * Markdown notes as something to say out loud: no symbols, code or formulas
 * read character by character. Code and display maths are mentioned, not read.
 */
export function speakableText(md: string): string {
  return (
    md
      .replace(/\r\n?/g, '\n')
      // Code blocks (mermaid diagrams too) and display maths: say they're there.
      .replace(/```[\s\S]*?(```|$)/g, (m) => (/^```\s*mermaid/i.test(m) ? '\n(There’s a diagram on screen.)\n' : '\n(There’s a code example on screen.)\n'))
      .replace(/\$\$[\s\S]*?\$\$/g, '\n(There’s a formula on screen.)\n')
      .replace(/\\\[[\s\S]*?\\\]/g, '\n(There’s a formula on screen.)\n')
      // Inline maths: the letters and numbers, without the LaTeX.
      .replace(/\$([^$\n]+)\$/g, (_m, x: string) => x.replace(/\\(text|mathrm|mathbf|operatorname)\{([^}]*)\}/g, '$2').replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}_^\\]/g, ' '))
      // Images go; links keep their text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      // Tables: cells read as a list; the --- row goes.
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
      .replace(/^\s*\|(.*)\|\s*$/gm, (_m, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '.')
      // Headings end like a sentence, so there's a pause after them.
      .replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_m, h: string) => (/[.!?:]$/.test(h) ? h : `${h}.`))
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*([-*_]\s*){3,}$/gm, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** Longest piece sent to ElevenLabs at once: well under every model's limit. */
export const VOICE_CHUNK = 2000
/** The first piece is short, so the audio starts quickly; the rest are fetched while it plays. */
export const VOICE_FIRST_CHUNK = 400

/**
 * The text split into pieces at paragraph, then sentence, then word breaks:
 * the first at most `first` characters, the rest at most `max`.
 */
export function voiceChunks(text: string, max = VOICE_CHUNK, first = VOICE_FIRST_CHUNK): string[] {
  // Every sentence (or word, in a sentence too long to keep whole), with what goes before it.
  const units: { text: string; sep: string }[] = []
  const unitMax = Math.min(max, first)
  for (const para of text.split(/\n{2,}/)) {
    let sep = '\n\n'
    for (const sentence of para.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [para]) {
      const t = sentence.trim()
      if (!t) continue
      if (t.length <= unitMax) units.push({ text: t, sep })
      else t.split(/\s+/).forEach((w, i) => units.push({ text: w, sep: i ? ' ' : sep }))
      sep = ' '
    }
  }
  const out: string[] = []
  let cur = ''
  for (const u of units) {
    const limit = out.length ? max : first
    if (cur && cur.length + u.sep.length + u.text.length > limit) {
      out.push(cur)
      cur = ''
    }
    cur = cur ? cur + u.sep + u.text : u.text
  }
  if (cur) out.push(cur)
  return out
}

/** Audio tags out: what's left is what gets said. */
export const withoutTags = (s: string): string => s.replace(/\[[^\]\n]{1,40}\]/g, ' ').replace(/\s+/g, ' ').trim()

const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/**
 * Whether Claude only added tags: the same words in the same order. Anything
 * else (reworded, cut short, an added preamble) and the plain text is read instead.
 */
export function onlyTagsAdded(original: string, tagged: string): boolean {
  const a = wordsOf(withoutTags(original))
  const b = wordsOf(withoutTags(tagged))
  if (!a.length) return false
  if (a.length !== b.length) return false
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++
  return same / a.length >= 0.97
}
