// Merging several published copies of the same week (.studyweek files) into
// one, for the marketplace: everyone's topics, levels, questions, flashcards,
// recall cards and files, with repeats taken out (see @shared/weekMerge for
// how topics and sections are matched). Nothing is generated.
//
// The fullest copy (most topics written) is the base: its topics keep their
// order and their sections stay where they are; what only the others have is
// added after.

import { createHash, randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import type { WeekFingerprint } from '@shared/fingerprint'
import { cardKey, matchTopics, mergeLevels, mergePlan, remapContent, type MergeTopic } from '@shared/weekMerge'
import type { OutlineTopic, TopicContent } from '@shared/course'
import type { WeekJson } from './weekShare'

type Row = Record<string, unknown>

interface Source {
  json: WeekJson
  /** The week's files by their path in the zip (files/…). */
  files: Map<string, Buffer>
}

const parse = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string') return (text as T) ?? fallback
  try {
    return (JSON.parse(text) as T) ?? fallback
  } catch {
    return fallback
  }
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export async function loadWeekZip(buf: Buffer): Promise<Source> {
  const zip = await JSZip.loadAsync(buf)
  const entry = zip.file('week.json')
  if (!entry) throw new Error('One of the copies isn’t a Studywise week.')
  const json = JSON.parse(await entry.async('string')) as WeekJson
  if (json.app !== 'studywise-courses' || json.kind !== 'week') throw new Error('One of the copies isn’t a Studywise week.')
  const files = new Map<string, Buffer>()
  for (const f of json.files) {
    const e = zip.file(`files/${String(f.path)}`)
    if (e) files.set(String(f.path), await e.async('nodebuffer'))
  }
  return { json, files }
}

/** A topic row's written levels: the shown one and every other version. */
function topicLevels(row: Row): { level: string; contents: Record<string, TopicContent> } {
  const level = String(row.level || 'standard')
  const contents: Record<string, TopicContent> = {}
  const shown = parse<TopicContent | null>(row.content, null)
  if (shown) contents[level] = shown
  for (const [l, v] of Object.entries(parse<Record<string, { content?: TopicContent }>>(row.versions, {}))) if (v?.content && !contents[l]) contents[l] = v.content
  return { level, contents }
}

interface Merged {
  id: string
  row: Row
  topic: MergeTopic
  level: string
  writtenWith: Record<string, unknown>
}

/** MinHash signatures merge by taking the smaller number at each place: the signature of all the text together. */
function mergeFingerprints(fps: (WeekFingerprint | undefined)[]): WeekFingerprint | undefined {
  const have = fps.filter((f): f is WeekFingerprint => !!f)
  if (!have.length) return undefined
  const v = have[0].v
  const sigs = have.filter((f) => f.v === v && f.sig).map((f) => f.sig!)
  const sig = sigs.length && sigs.every((s) => s.length === sigs[0].length) ? sigs[0].map((_, i) => Math.min(...sigs.map((s) => s[i]))) : (sigs[0] ?? null)
  return { v, sig, hashes: [...new Set(have.flatMap((f) => f.hashes))] }
}

/**
 * Merges copies of one week into one .studyweek. Order doesn't matter: the
 * copy with the most written topics becomes the base.
 */
export async function mergeWeekZips(bufs: Buffer[]): Promise<{ bytes: Buffer; json: WeekJson }> {
  if (bufs.length < 2) throw new Error('Pick at least two copies to merge.')
  const written = (s: Source) => s.json.topics.filter((t) => t.status === 'ready').length
  const sources = (await Promise.all(bufs.map(loadWeekZip))).sort((a, b) => written(b) - written(a) || b.json.topics.length - a.json.topics.length)
  const base = sources[0].json

  const ids = new Set<string>()
  /** A row's own id, or a new one if another copy already used it (the same week published twice). */
  const own = (id: unknown) => {
    let s = typeof id === 'string' && id ? id : randomUUID()
    if (ids.has(s.toLowerCase())) s = randomUUID()
    ids.add(s.toLowerCase())
    return s
  }

  const files: Row[] = []
  const zipFiles = new Map<string, Buffer>()
  const fileByHash = new Map<string, Row>()
  const names = new Set<string>()
  const cards: Row[] = []
  const cardByKey = new Map<string, Row[]>()
  const topics: Merged[] = []
  // The week number topic keys use (w3t1): the base copy's.
  const weekNo = Number(String(base.topics[0]?.key ?? '').match(/^w(\d+)t/)?.[1] ?? Number(base.week.position ?? 0) + 1)

  for (const src of sources) {
    // Files: the same bytes are the same file, whatever it's called.
    const fileId = new Map<string, string>()
    const fileName = new Map<string, string>()
    for (const f of src.json.files) {
      const data = src.files.get(String(f.path))
      const hash = data ? sha(data) : `missing:${String(f.id)}`
      const have = fileByHash.get(hash)
      if (have) {
        fileId.set(String(f.id), String(have.id))
        fileName.set(String(f.name), String(have.name))
        continue
      }
      const orig = String(f.name)
      const dot = orig.lastIndexOf('.')
      let name = orig
      for (let n = 2; names.has(name.toLowerCase()); n++) name = dot > 0 ? `${orig.slice(0, dot)} (${n})${orig.slice(dot)}` : `${orig} (${n})`
      names.add(name.toLowerCase())
      const row = { ...f, id: own(f.id), name, path: `files/${name}`, position: files.length }
      files.push(row)
      fileByHash.set(hash, row)
      if (data) zipFiles.set(String(row.path), data)
      fileId.set(String(f.id), String(row.id))
      fileName.set(orig, name)
    }

    // Recall cards: one with the same front from another copy is already there. Each card there
    // stands for at most one of this copy's, and two of this copy's own are never folded together,
    // so the merge always has at least as many cards as every copy.
    const cardId = new Map<string, string>()
    const addedCards: Row[] = []
    const before = new Map(cardByKey)
    const used = new Set<string>()
    for (const c of src.json.cards) {
      const k = cardKey(String(c.front ?? ''))
      const have = k ? before.get(k)?.find((x) => !used.has(String(x.id))) : undefined
      if (have) {
        used.add(String(have.id))
        cardId.set(String(c.id), String(have.id))
        continue
      }
      const row = { ...c, id: own(c.id) }
      cards.push(row)
      addedCards.push(row)
      if (k) cardByKey.set(k, [...(cardByKey.get(k) ?? []), row])
      cardId.set(String(c.id), String(row.id))
    }

    // Topics: matched ones merge, the rest are added.
    const theirs = [...src.json.topics]
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((row) => {
        const { level, contents } = topicLevels(row)
        const remapped = Object.fromEntries(Object.entries(contents).map(([l, c]) => [l, remapContent(c, fileId, cardId)]))
        const plan = parse<OutlineTopic | null>(row.plan, null)
        if (plan) plan.sources = (plan.sources ?? []).map((s) => ({ ...s, file: fileName.get(s.file) ?? s.file }))
        const title = Object.values(remapped)[0]?.title ?? plan?.title ?? String(row.key)
        return { row, level, topic: { title, plan, contents: remapped } as MergeTopic, writtenWith: parse<Record<string, unknown>>(row.written_with, {}) }
      })
    const matches = matchTopics(
      topics.map((t) => t.topic),
      theirs.map((t) => t.topic)
    )
    const topicId = new Map<string, string>()
    theirs.forEach((t, j) => {
      const m = matches.get(j)
      if (m !== undefined) {
        const into = topics[m]
        into.topic = {
          title: into.topic.title,
          plan: into.topic.plan && t.topic.plan ? mergePlan(into.topic.plan, t.topic.plan) : (into.topic.plan ?? t.topic.plan),
          contents: mergeLevels(into.topic.contents, t.topic.contents)
        }
        into.writtenWith = { ...t.writtenWith, ...into.writtenWith }
        if (!into.topic.contents[into.level]) into.level = t.level
        topicId.set(String(t.row.id), into.id)
      } else {
        const id = own(t.row.id)
        topics.push({ id, row: t.row, topic: t.topic, level: t.level, writtenWith: t.writtenWith })
        topicId.set(String(t.row.id), id)
      }
    })
    // This copy's recall cards belong to the topic theirs merged into.
    for (const c of addedCards) {
      const source = parse<{ ref?: string } | null>(c.source, null)
      if (source?.ref && topicId.has(source.ref)) c.source = JSON.stringify({ ...source, ref: topicId.get(source.ref) })
    }
  }

  const now = new Date().toISOString()
  const topicRows: Row[] = topics.map((t, i) => {
    const key = `w${weekNo}t${i + 1}`
    const levels = Object.keys(t.topic.contents)
    const level = t.topic.contents[t.level] ? t.level : (levels.includes('standard') ? 'standard' : levels[0]) ?? t.level
    const shown = t.topic.contents[level] ?? null
    const versions = Object.fromEntries(levels.filter((l) => l !== level).map((l) => [l, { content: t.topic.contents[l], progress: {} }]))
    const plan = t.topic.plan ? { ...t.topic.plan, id: key } : null
    return {
      ...t.row,
      id: t.id,
      key,
      position: i,
      plan: plan ? JSON.stringify(plan) : t.row.plan,
      status: shown ? 'ready' : t.row.status === 'writing' ? 'planned' : t.row.status,
      error: shown ? null : (t.row.error ?? null),
      level,
      content: shown ? JSON.stringify(shown) : null,
      versions: JSON.stringify(versions),
      written_with: JSON.stringify(t.writtenWith),
      progress: '{}',
      note_id: null,
      updated_at: now
    }
  })

  const json: WeekJson = {
    ...base,
    exportedAt: now,
    week: { ...base.week, status: topicRows.length ? 'ready' : base.week.status },
    files,
    topics: topicRows,
    cards,
    fingerprint: mergeFingerprints(sources.map((s) => s.json.fingerprint))
  }
  const zip = new JSZip()
  zip.file('week.json', JSON.stringify(json), { compression: 'DEFLATE' })
  // As in weekZip: a file row's path is relative to its course folder (files/…), and the zip keeps it under files/.
  for (const [path, data] of zipFiles) zip.file(`files/${path}`, data)
  return { bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }), json }
}
