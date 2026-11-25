import type { TaskId } from '@shared/tasks'

// Deterministic fake output for every task (AI_MOCK=1). Kept close to the real
// shapes so the UI and tests exercise the same parsing paths.

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
}

interface MockCard {
  card_id: string
  type: string
  front: string
  back: string
  blanks?: string[]
}

function parseCards(v: unknown): MockCard[] {
  try {
    const arr = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(arr) ? (arr as MockCard[]) : []
  } catch {
    return []
  }
}

const firstLine = (s: string) => String(s ?? '').split('\n').find((l) => l.trim())?.replace(/^[-*]\s*/, '').trim() ?? ''

export function mockResponse(task: TaskId, mode: string, vars: Record<string, unknown>, prompt: string): { text: string; structured: unknown } {
  const v = (k: string) => String(vars[k] ?? '')
  // Tests: a first reply in the wrong shape, so the repair step runs.
  if (vars.mock_bad_json && !prompt.includes('<reply>')) return { text: JSON.stringify({ wrong_shape: true, padding: 'x'.repeat(300) }), structured: null }
  switch (task) {
    case 'generate_notes': {
      const title = v('title') || 'the topic'
      const src = v('source_text').slice(0, 200).replace(/\s+/g, ' ')
      const text = `## What is ${title}?\nbasically the main idea in one line\n\n## The 3 important terms:\n**Term one:**\n- a simple definition\n\n**Term two:**\n- another simple definition\n\n| Term | Simple meaning |\n|---|---|\n| $E = hf$ | energy of a photon |\n\n\`\`\`mermaid\nflowchart LR\n  A[Source] --> B[Notes]\n\`\`\`\n\nRemember: ${src ? 'the source starts with ' + src.slice(0, 60) : 'everything here is examinable'}\n`
      return { text, structured: null }
    }
    case 'generate_cards': {
      if (mode === 'json') {
        const n = Math.max(1, Math.min(20, Number(vars.count) || 3))
        const cards = Array.from({ length: n }, (_, i) => ({
          front: `Mock question ${i + 1}`,
          back: `the **answer** ${i + 1}`,
          options:
            v('card_type') === 'multiple_choice'
              ? [
                  { text: `answer ${i + 1}`, correct: true },
                  { text: 'wrong a', correct: false },
                  { text: 'wrong b', correct: false },
                  { text: 'wrong c', correct: false }
                ]
              : null,
          tags: ['mock'],
          hints: null,
          language: null
        }))
        return { text: JSON.stringify({ cards }), structured: { cards } }
      }
      if (prompt.trim() === 'continue') {
        return { text: '```\nWhat is mock continuation?/#*#/the second part\n#\nName the 2 mock things (2)/#*#/- first thing\n\n- second thing\n```', structured: null }
      }
      const text =
        '```\nWhat is the work function?/#*#/the minimum energy needed to remove an electron from the surface of a metal\n#\nExplain why a threshold frequency exists (2)/#*#/- below the threshold frequency, photons have less energy than the work function\n\n- so they do not have enough energy to remove an electron\n#\nEach electron can only absorb _________/#*#/one photon of energy\n```'
      return { text, structured: null }
    }
    case 'fix_cards': {
      const front = v('front').replace(/\s*\(\d+\)\s*$/, '')
      const bullets = v('back')
        .split('\n')
        .filter((l) => /^\s*-\s+/.test(l))
      const fixedFront = bullets.length > 1 ? `${front} (${bullets.length})` : front
      const cards = [{ front: fixedFront || 'Fixed question', back: v('back') || 'fixed answer', options: null, tags: null, hints: null, language: null }]
      return { text: JSON.stringify({ cards }), structured: { cards } }
    }
    case 'make_questions': {
      const cards = parseCards(vars.cards)
      const questions = cards.map((c) => {
        const h = hash(c.card_id)
        const answer = firstLine(c.back) || 'the answer'
        const base = {
          card_id: c.card_id,
          type: c.type,
          title: null,
          explanation: null,
          question: null,
          options: null,
          correct_index: null,
          expected_answer: null,
          statement: null,
          is_true: null,
          correction: null,
          distractors: null
        }
        switch (c.type) {
          case 'read_understand':
            return { ...base, title: firstLine(c.front).slice(0, 60), explanation: `**${firstLine(c.front)}**\n\nThe key idea: ${answer}.` }
          case 'multiple_choice': {
            const idx = h % 4
            const opts = ['a decoy option', 'another decoy', 'a third decoy']
            opts.splice(idx, 0, answer)
            return { ...base, question: c.front, options: opts, correct_index: idx }
          }
          case 'free_answer':
            return { ...base, question: c.front, expected_answer: c.back }
          case 'true_false': {
            const isTrue = h % 2 === 0
            return { ...base, statement: isTrue ? `${firstLine(c.front)} → ${answer}` : `${firstLine(c.front)} → not ${answer}`, is_true: isTrue, correction: isTrue ? '' : answer }
          }
          case 'choice_blank':
            return { ...base, distractors: (c.blanks ?? []).map((b, i) => [`${b}x`, `option ${i + 1}a`, `option ${i + 1}b`]) }
          default:
            return base
        }
      })
      return { text: JSON.stringify({ questions }), structured: { questions } }
    }
    case 'make_categorize': {
      const cards = parseCards(vars.cards)
      const items = cards.slice(0, 9).map((c, i) => ({ text: firstLine(c.front).slice(0, 60) || `Item ${i + 1}`, category: i % 2 === 0 ? 'Group A' : 'Group B', card_id: c.card_id }))
      while (items.length < 6) items.push({ text: `Extra item ${items.length + 1}`, category: items.length % 2 === 0 ? 'Group A' : 'Group B', card_id: cards[0]?.card_id ?? '' })
      const out = { categories: ['Group A', 'Group B'], items }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'mark_free_answer': {
      const exp = new Set(words(v('expected_answer') || v('back')))
      const got = words(v('user_answer'))
      const hit = got.filter((w) => exp.has(w))
      const ratio = exp.size ? new Set(hit).size / exp.size : 0
      const score = Math.round(Math.min(10, ratio * 10 * 1.4))
      const verdict = score >= 8 ? 'correct' : score >= 4 ? 'partial' : 'wrong'
      const out = {
        score,
        verdict,
        points_found: [...new Set(hit)].slice(0, 5),
        points_missing: [...exp].filter((w) => !hit.includes(w)).slice(0, 5),
        short_feedback: verdict === 'correct' ? 'You covered the key points.' : 'You missed some of the key points.'
      }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'mark_fill_blank': {
      const exp = v('expected_answer').split(' | ')
      const got = v('user_answer').split(' | ')
      const blanks = exp.map((e, i) => ({ correct: (got[i] ?? '').trim().toLowerCase().slice(0, 3) === e.trim().toLowerCase().slice(0, 3) && !!got[i]?.trim() }))
      return { text: JSON.stringify({ blanks }), structured: { blanks } }
    }
    case 'feedback_wrong': {
      const out = {
        why_wrong: `Your answer "${v('user_answer').slice(0, 80)}" doesn't match the key idea.`,
        takeaways: ['Focus on the definition', 'Link it to an example'],
        how_to_remember: 'Picture it as a story with three steps.'
      }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'feedback_right': {
      const out = { takeaways: ['You know the core idea', 'Keep linking it to examples'], pro_tip: 'Try explaining it out loud in one sentence.' }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'hint': {
      const n = (v('previous_hints').match(/\n/g) ?? []).length
      const out = { hint: n === 0 ? 'Think about what the question is really asking.' : 'Think about the first step of the process.' }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'custom_action': {
      if (mode === 'json') {
        const cards = [{ front: 'Mock action card', back: 'mock **answer**', options: null, tags: ['mock'], hints: null, language: null }]
        return { text: JSON.stringify({ cards }), structured: { cards } }
      }
      return { text: `### Mock action\n\nHere is a mock response about: ${firstLine(v('front')) || firstLine(v('source_text')) || 'this'}.`, structured: null }
    }
    case 'explain':
    case 'explain_chat':
      return {
        text: `**${firstLine(v('front')) || 'This concept'}** — explained.\n\n- the core idea: ${firstLine(v('back')) || 'see the card'}\n- an example makes it concrete\n\n$$E = hf$$\n\n${/diagram/i.test(v('mode')) ? '```mermaid\nflowchart LR\n  Q[Question] --> A[Answer]\n```\n' : ''}`,
        structured: null
      }
    case 'note_simplify':
    case 'note_shorten':
    case 'note_fix_formatting':
    case 'note_expand':
      return { text: `${v('source_text').trim()}\n\n- (${task.replace('note_', '')}d by mock)`, structured: null }
    case 'course_outline': {
      const file = v('files').split(',')[0]?.replace(/\s*\(\d+ pages\)\s*$/, '').trim() || 'source.pdf'
      const titles = ['What the photoelectric effect is', 'Work function and threshold frequency', 'Why classical physics fails']
      const out = {
        course: v('module') || 'Mock course',
        topics: titles.map((title, i) => ({
          id: `t${i + 1}`,
          title,
          goal: `After this you can explain ${title.toLowerCase()}.`,
          sections: ['What is it?', 'Key terms:', 'X vs Y:'],
          sources: [{ file, where: `pages ${i * 4 + 1}–${i * 4 + 4}` }],
          needs: i ? [`t${i}`] : [],
          stressed: i === 0 ? ['Electrons are emitted instantly'] : [],
          minutes: 12
        }))
      }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'course_topic': {
      const attached = prompt.match(/current working directory: ([^\n]+?)\. Read/)?.[1]?.split(', ')[0] ?? ''
      const title = v('topic_title') || 'Mock topic'
      const h = (x: Record<string, unknown>) => ({ hint: 'Look back at the notes you just read.', why: 'Because that is what the notes say, basically.', ...x })
      const out = {
        id: v('topic_id'),
        title,
        goal: `After this you can explain ${title.toLowerCase()}.`,
        sections: [
          {
            heading: `What is ${title.toLowerCase()}?`,
            notes: `This is the main idea in one plain sentence. Sounds good, right?\n\n**Photoelectron:**\n- this is an electron knocked out of a metal by light\n\nRemember: electrons come out instantly, with no delay.`,
            figure: null,
            questions: [
              h({ type: 'mcq', q: 'What is a photoelectron?', options: ['An electron knocked out by light', 'A photon inside a metal', 'A proton freed by heat', 'An ion made by sound'], answer: 0 }),
              h({ type: 'true_false', q: 'Electrons come out after a short delay.', answer: false }),
              h({ type: 'match', q: 'Match each term to its meaning.', pairs: [{ term: 'Photon', meaning: 'A packet of light' }, { term: 'Photoelectron', meaning: 'An electron freed by light' }, { term: 'Metal', meaning: 'Where the electrons start' }] })
            ]
          },
          {
            heading: 'Key terms:',
            notes: `| Term | Simple meaning |\n|---|---|\n| Work function | energy needed to free an electron |\n| Threshold frequency | lowest frequency that works |\n\nImagine a vending machine that only takes £1 coins: lots of 50p coins won't do it.`,
            figure: attached ? { file: attached, page: 2, caption: 'Look at how the current only starts above the threshold.' } : null,
            questions: [
              h({ type: 'fill_blank', text: 'The [[work function|work-function]] is the energy needed to free an electron.' }),
              h({ type: 'wrong_word', text: 'The threshold frequency is the highest frequency that frees electrons.', wrong: 'highest', correct: 'lowest' }),
              h({ type: 'order', q: 'Put the steps in order.', items: ['Light hits the metal', 'A photon gives its energy to one electron', 'The electron escapes if the energy beats the work function'] })
            ]
          },
          {
            heading: 'Wave vs particle:',
            notes: `Wave model: brighter light should eventually free electrons.\nParticle model: only the frequency matters.\n\nThe trade off is that: neither model alone explains everything.`,
            figure: null,
            questions: [
              h({ type: 'sort', q: 'Which model predicts each?', buckets: ['Wave', 'Particle'], items: [{ item: 'Delay at low brightness', bucket: 'Wave' }, { item: 'Threshold frequency', bucket: 'Particle' }, { item: 'Instant emission', bucket: 'Particle' }, { item: 'Any frequency works', bucket: 'Wave' }] }),
              h({ type: 'explain', q: 'Why does brighter red light still not free electrons?', model: 'Each photon of red light has too little energy, and one photon frees one electron, so more photons does not help.', points: ['each photon has too little energy', 'one photon frees one electron', 'brightness only adds more photons'] })
            ]
          }
        ],
        check: [
          h({ type: 'true_false', q: 'Doubling the brightness doubles the energy of each photoelectron.', answer: false }),
          h({ type: 'mcq', q: 'A metal has a high work function. What do you need?', options: ['Higher frequency light', 'Brighter light', 'Longer exposure', 'A warmer metal'], answer: 0 }),
          h({ type: 'explain', q: 'Explain what the threshold frequency is.', model: 'The lowest frequency of light that can free electrons from a metal.', points: ['lowest frequency', 'frees electrons', 'depends on the metal'] })
        ],
        cards: [
          { front: 'What is a photoelectron?', back: 'An electron knocked out of a metal by light', section: 1 },
          { front: 'What is the work function?', back: 'The minimum energy needed to free an electron from a metal', section: 2 },
          { front: 'What is the threshold frequency?', back: 'The lowest light frequency that frees electrons', section: 2 },
          { front: 'Does brighter light give faster photoelectrons?', back: '- No\n- brighter light means more photons, not more energy per photon', section: 3 }
        ]
      }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'course_trim': {
      // Suggests the cards that test an example or a company, like the real thing would.
      const lines = v('cards').split('\n').filter((l) => /^\d+\./.test(l))
      const remove = lines.filter((l) => /example|compan|imagine/i.test(l)).map((l) => ({ n: Number(l.match(/^(\d+)\./)![1]), reason: 'an example, not examinable' }))
      // Cutting down: every other remaining card goes too.
      if (/CUT DOWN TO KEY CONTENT/.test(v('instructions')) || /CUT DOWN TO KEY CONTENT/.test(prompt)) {
        const gone = new Set(remove.map((r) => r.n))
        lines
          .map((l) => Number(l.match(/^(\d+)\./)![1]))
          .filter((n) => !gone.has(n))
          .forEach((n, i) => i % 2 === 1 && remove.push({ n, reason: 'minor detail' }))
      }
      const out = { remove }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'course_dedupe': {
      // Pairs questions that use the same words in any order, keeping the longer, like the real thing would for a reworded repeat.
      const same: { group: number; a: number; b: number; keep: 'a' | 'b' }[] = []
      for (const block of v('groups').split(/^### Group /m).slice(1)) {
        const group = Number(block.match(/^(\d+)/)?.[1])
        const side = (tag: string) => [...block.matchAll(new RegExp(`^${tag}(\\d+)\\. (.*)$`, 'gm'))].map((m) => ({ n: Number(m[1]), text: m[2] }))
        const key = (t: string) => (JSON.parse(t).q ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean).sort().join(' ')
        const used = new Set<number>()
        for (const b of side('B')) {
          const a = side('A').find((x) => !used.has(x.n) && key(x.text) === key(b.text))
          if (a) {
            used.add(a.n)
            same.push({ group, a: a.n, b: b.n, keep: b.text.length > a.text.length ? 'b' : 'a' })
          }
        }
      }
      const out = { same }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'course_week_test': {
      const topics = v('topics')
        .split('\n')
        .map((l) => l.match(/^-\s*([^:(]+)/)?.[1]?.trim())
        .filter((t): t is string => !!t)
      const n = Math.max(1, Math.min(25, Number(v('count')) || 10))
      const hard = /^Hard/.test(v('difficulty'))
      const out = {
        questions: Array.from({ length: n }, (_, i) => ({
          type: 'mcq',
          q: `${hard ? 'A metal is lit with light just above its threshold frequency. ' : ''}Question ${i + 1}: what frees an electron from a metal?`,
          options: ['One photon with enough energy', 'Lots of dim photons together', 'Heating the metal slowly', 'A stronger magnetic field'],
          answer: 0,
          hint: 'Think about one photon and one electron.',
          why: 'One photon gives all its energy to one electron, so only the photon’s energy matters.',
          topic: topics[i % Math.max(1, topics.length)] ?? ''
        }))
      }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'course_update': {
      const ids = [...v('topics').matchAll(/"id": "([^"]+)"/g)].map((m) => m[1])
      const file = v('files').split(',')[0]?.replace(/\s*\(\d+ pages\)\s*$/, '').trim() || 'notes.txt'
      const out = {
        summary: 'Added a section on stopping voltage, and a new topic on photon momentum.',
        updates: ids.length ? [{ topic: ids[0], sections: ['What is stopping voltage?'], sources: [{ file, where: '' }], stressed: ['Stopping voltage measures the fastest electrons'] }] : [],
        topics: [{ id: 'n1', title: 'Photon momentum', goal: 'After this you can explain photon momentum.', sections: ['What is photon momentum?', 'Momentum vs energy:'], sources: [{ file, where: '' }], needs: ids.slice(0, 1), stressed: [], minutes: 8 }]
      }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'course_extend': {
      const h = (x: Record<string, unknown>) => ({ hint: 'Look back at the new notes.', why: 'Because that is what the new notes say.', ...x })
      const heading = v('new_sections').split('\n')[0]?.replace(/^-\s*/, '').trim() || 'New section'
      const out = {
        sections: [
          {
            heading,
            notes: 'Remember the work function from earlier? The **stopping voltage** is the voltage that just stops the fastest photoelectrons.\n\n- this tells you their maximum kinetic energy',
            figure: null,
            questions: [
              h({ type: 'true_false', q: 'The stopping voltage stops the fastest photoelectrons.', answer: true }),
              h({ type: 'mcq', q: 'What does the stopping voltage tell you?', options: ['Their maximum kinetic energy', 'The number of photons', 'The colour of the metal', 'The work function only'], answer: 0 })
            ]
          }
        ],
        check: [h({ type: 'explain', q: 'What does the stopping voltage measure?', model: 'The voltage that just stops the fastest photoelectrons, which gives their maximum kinetic energy.', points: ['stops the fastest photoelectrons', 'gives maximum kinetic energy'] })],
        cards: [{ front: 'What is the stopping voltage?', back: 'The voltage that just stops the fastest photoelectrons.', section: 1 }]
      }
      return { text: JSON.stringify(out), structured: out }
    }
    case 'course_mark': {
      const exp = new Set(words(v('model')))
      const got = new Set(words(v('answer')).filter((w) => exp.has(w)))
      const score = Math.round(Math.min(10, (exp.size ? got.size / exp.size : 0) * 14))
      const points = v('points').split('\n').map((p) => p.replace(/^-\s*/, '').trim()).filter(Boolean)
      const hit = points.filter((p) => words(p).some((w) => got.has(w)))
      const out = {
        score: points.length ? Math.round((hit.length / points.length) * 10) : score,
        marks: hit.length,
        got: hit,
        missed: points.filter((p) => !hit.includes(p)),
        wrong: '',
        feedback: score >= 8 ? 'Nice, you nailed the main idea.' : 'You got part of it. Have another look at the key points you missed.'
      }
      return { text: JSON.stringify(out), structured: out }
    }
  }
}

/** Fake live events: reads, a bit of thinking, then the output in chunks. */
export async function mockLive(text: string, files: string[], onEvent: (e: import('./cli').AiLiveEvent) => void, signal?: AbortSignal): Promise<void> {
  // AI_MOCK_SLOW=20 stretches this out, for screenshots of the progress panel.
  const slow = Number(process.env.AI_MOCK_SLOW) || 1
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * slow))
  for (const f of files) {
    onEvent({ kind: 'tool', name: 'Read' })
    onEvent({ kind: 'read', file: f.split(/[\\/]/).pop() ?? f })
    await wait(120)
  }
  onEvent({ kind: 'thinking' })
  for (let t = 1; t <= 5; t++) {
    onEvent({ kind: 'thinking', tokens: t * 420 })
    await wait(90)
  }
  onEvent({ kind: 'tool', name: 'StructuredOutput' })
  for (const c of text.match(/[\s\S]{1,160}/g) ?? []) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { kind: 'cancelled' })
    onEvent({ kind: 'output', text: c })
    await wait(25)
  }
}

export async function mockStream(text: string, onDelta?: (t: string) => void, signal?: AbortSignal): Promise<void> {
  if (!onDelta) return
  const chunks = text.match(/[\s\S]{1,24}/g) ?? []
  for (const c of chunks) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { kind: 'cancelled' })
    onDelta(c)
    await new Promise((r) => setTimeout(r, 4))
  }
}
