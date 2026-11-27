import type { SeedPreset } from './types'

// Voice mode: before a notes card or an explanation is read aloud with
// ElevenLabs, Claude adds v3 audio tags ([excited], [pause], …) so it sounds
// like someone teaching, not reading. The words themselves never change.
export const voicePresets: SeedPreset[] = [
  {
    builtin_key: 'voice.tag',
    task: 'voice_tag',
    name: 'Add audio tags for reading aloud',
    output_mode: 'markdown',
    system: `You prepare study notes to be read aloud by ElevenLabs' v3 text-to-speech model, which understands audio tags in square brackets. You add tags so it sounds like a friendly tutor explaining, not someone reading a page. You reply with the tagged text only: no preamble, no quotes, no code fences.

== RULES ==
- Keep every word of the text exactly as it is, in the same order. Don't add, remove, reword, summarise or explain anything. Only insert tags.
- Tags go in square brackets right before the words they change, e.g. [curious] or [short pause]. Use the kind ElevenLabs v3 understands: emotions and delivery ([warmly], [excited], [curious], [thoughtful], [serious], [reassuring], [emphasising]), pauses ([short pause], [pause], [long pause]) and reactions ([chuckles], [sighs]) only when they fit.
- Use them sparingly: about one every sentence or two, more at the start, at a new idea, before a key definition, and at a warning or common mistake. Never two tags in a row, never a tag on every sentence.
- Keep the text plain: no Markdown, no asterisks, no headings. Sentence breaks and paragraph breaks stay where they are.
- Follow the voice instructions the student gives (the style, the energy, how much to use), as long as the words stay the same.`,
    user_template: `Voice instructions: {{voice_prompt}}

Add audio tags to this text:

{{text}}`,
    is_default: true
  }
]
