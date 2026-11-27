import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { speakableText, voiceChunks, onlyTagsAdded, withoutTags, DEFAULT_VOICE_ID, DEFAULT_VOICE_MODEL } from '../../src/shared/voice'

describe('voice text', () => {
  it('turns Markdown notes into something to say', () => {
    const md = [
      '## Work function',
      'The **work function** $\\phi$ is the *minimum* energy, see [the slides](https://x.y).',
      '- photons below it: no electrons',
      '1. Shine light',
      '```python\nprint(1)\n```',
      '$$E = hf - \\phi$$',
      '![diagram](a.png)',
      '| Metal | φ |\n|---|---|\n| Zinc | 4.3 eV |'
    ].join('\n\n')
    const s = speakableText(md)
    expect(s).toContain('Work function.')
    expect(s).toContain('The work function')
    expect(s).toContain('minimum energy, see the slides.')
    expect(s).toContain('photons below it: no electrons')
    expect(s).toContain('There’s a code example on screen.')
    expect(s).toContain('There’s a formula on screen.')
    expect(s).toContain('Zinc, 4.3 eV.')
    expect(s).not.toMatch(/[*#$`|]|print\(1\)|a\.png|https/)
  })

  it('splits long text at paragraphs, then sentences, never over the limit', () => {
    const para = 'A sentence that goes on for a while. '.repeat(30).trim()
    const chunks = voiceChunks(`${para}\n\nShort one.\n\n${para}`, 500)
    expect(chunks.every((c) => c.length <= 500)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(`${para} Short one. ${para}`.replace(/\s+/g, ' '))
    expect(voiceChunks('Hi.\n\nThere.', 500)).toEqual(['Hi.\n\nThere.'])
    expect(voiceChunks('   ')).toEqual([])
  })

  it('only accepts tagged text with the same words', () => {
    const t = 'Light knocks electrons out of a metal. Only above the threshold frequency.'
    expect(onlyTagsAdded(t, '[curious] Light knocks electrons out of a metal. [short pause] Only above the threshold frequency.')).toBe(true)
    expect(onlyTagsAdded(t, 'Sure! Here it is: [curious] Light knocks electrons out of a metal. Only above the threshold frequency.')).toBe(false)
    expect(onlyTagsAdded(t, '[curious] Light knocks electrons out.')).toBe(false)
    expect(withoutTags('[warmly] Hello [pause] there')).toBe('Hello there')
  })
})

// ---------------------------------------------------------------------------
// The service, against a fake ElevenLabs.

let dir: string
let voice: typeof import('../../src/main/services/voice')
let closeDb: () => void
let calls: { url: string; init?: RequestInit }[] = []
let reply: (url: string) => Response

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-voice-'))
  process.env.STUDYWISE_DATA_DIR = dir
  const db = await import('../../src/main/db')
  closeDb = db.closeDb
  db.openDb(join(dir, 't.db'))
  const { seedPresets } = await import('../../src/main/ai/presets')
  seedPresets()
  voice = await import('../../src/main/services/voice')
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return reply(url)
  })
})
afterAll(() => {
  vi.unstubAllGlobals()
  closeDb?.()
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  calls = []
  reply = () => new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
})

describe('voice service (fake ElevenLabs)', () => {
  it('starts off, with v4 Turbo, the default voice and auto-tag on', () => {
    expect(voice.voiceStatus()).toMatchObject({ hasKey: false, enabled: false, autoplay: true, ready: false, model: DEFAULT_VOICE_MODEL, voiceId: DEFAULT_VOICE_ID, autoTag: true })
    expect(DEFAULT_VOICE_MODEL).toBe('eleven_v4_turbo')
    expect(voice.setVoiceConfig({ autoplay: false }).autoplay).toBe(false)
    expect(voice.setVoiceConfig({ autoplay: true }).autoplay).toBe(true)
  })

  it('needs a key, then reads text out with the chosen voice and model, auto-tagged, and caches it', async () => {
    await expect(voice.speak('Hello there.')).rejects.toThrow(/API key/)
    voice.setVoiceConfig({ apiKey: 'sk_test', enabled: true, voiceId: 'abc123XYZ', model: 'eleven_v4' })
    expect(voice.voiceStatus()).toMatchObject({ hasKey: true, ready: true, voiceId: 'abc123XYZ', model: 'eleven_v4' })

    const r = await voice.speak('Light knocks electrons out of a metal.')
    expect(r.audio).toBe(`data:audio/mpeg;base64,${Buffer.from('ID3fake-mp3').toString('base64')}`)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc123XYZ?output_format=mp3_44100_128')
    expect((calls[0].init?.headers as Record<string, string>)['xi-api-key']).toBe('sk_test')
    // The mock AI adds a [warmly] tag without changing the words.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: '[warmly] Light knocks electrons out of a metal.', model_id: 'eleven_v4' })

    // Heard before: straight from the cache, no request.
    expect((await voice.speak('Light knocks electrons out of a metal.')).audio).toBe(r.audio)
    expect(calls).toHaveLength(1)
  })

  it('sends plain text with auto-tag off or a model without tags', async () => {
    voice.setVoiceConfig({ autoTag: false, model: 'eleven_v4_turbo' })
    await voice.speak('No tags here.')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'No tags here.', model_id: 'eleven_v4_turbo' })
    voice.setVoiceConfig({ autoTag: true, model: 'eleven_flash_v2_5' })
    await voice.speak('Flash has no tags.')
    expect(JSON.parse(String(calls[1].init?.body)).text).toBe('Flash has no tags.')
  })

  it('says plainly what went wrong', async () => {
    reply = () => new Response(JSON.stringify({ detail: { message: 'Invalid API key' } }), { status: 401 })
    await expect(voice.speak('Something new.')).rejects.toThrow(/didn’t accept your API key: Invalid API key/)
    reply = () => new Response('{}', { status: 404 })
    await expect(voice.speak('Something else.')).rejects.toThrow(/no voice with the ID abc123XYZ/)
    expect(() => voice.setVoiceConfig({ voiceId: 'not a voice!' })).toThrow(/voice ID/)
    expect(() => voice.setVoiceConfig({ model: 'eleven_v9' })).toThrow(/Unknown/)
  })

  it('lists your voices by name', async () => {
    reply = () => new Response(JSON.stringify({ voices: [{ voice_id: 'b', name: 'Zed', category: 'premade', labels: { accent: 'british' } }, { voice_id: 'a', name: 'Amy', category: 'cloned', description: 'Me' }] }))
    expect(await voice.listVoices()).toEqual([
      { id: 'a', name: 'Amy', category: 'cloned', description: 'Me' },
      { id: 'b', name: 'Zed', category: 'premade', description: 'british' }
    ])
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/voices')
  })
})
