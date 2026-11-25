import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import {
  Plus,
  FileText,
  Folder as FolderIcon,
  ChevronRight,
  FolderPlus,
  Search,
  Sparkles,
  Eye,
  Columns2,
  PenLine,
  Trash2,
  Layers,
  MessageCircleQuestion,
  Wand2,
  Minimize2,
  Maximize2,
  AlignLeft,
  Brain,
  Download,
  Upload,
  Check,
  Copy,
  X,
  Link2,
  ListOrdered
} from 'lucide-react'
import type { Note, Folder, CustomAction } from '@shared/types'
import { NOTE_TYPES } from '@shared/types'
import { useStore, toast } from '../lib/store'
import { IS_MOBILE } from '../lib/platform'
import { api, onEvent, streamCall, errorText } from '../lib/api'
import { folderPath, folderTree, groupByFolderTree, useCollapsedFolders, withSubfolders, type TreeGroup } from '../lib/collapsed'
import { useCommands, runCommand } from '../lib/commands'
import { askText, confirmDialog, chooseDialog } from '../lib/dialogs'
import { Markdown } from '../components/Markdown'
import { Button, Dots, Empty, Input, Menu, MenuItem, Select, Segmented, cx, Pill } from '../components/ui'
import { RailItem } from './Decks'

type NoteMeta = Omit<Note, 'content'>
type View = 'edit' | 'split' | 'preview'

// A writing-friendly editor: proportional font, headings as headings, quiet markup.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.45em', fontWeight: '600', letterSpacing: '-0.02em' },
  { tag: t.heading2, fontSize: '1.2em', fontWeight: '600', letterSpacing: '-0.015em' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'color-mix(in oklab, var(--muted) 70%, transparent)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.88em', color: 'var(--accent)' },
  { tag: t.list, color: 'var(--ink)' },
  { tag: t.quote, color: 'var(--muted)' }
])
const cmTheme = EditorView.theme({
  '&': { color: 'var(--ink)' },
  '.cm-scroller': { fontFamily: 'var(--font-sans) !important', lineHeight: '1.7 !important' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 2px' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' }
})

export function Notes({ noteId }: { noteId: string | null }) {
  const go = useStore((s) => s.go)
  const version = useStore((s) => s.version)
  const rail = useStore((s) => s.rail)
  const jobs = useStore((s) => s.jobs)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderId, setFolderId] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const load = useCallback(() => {
    void api.notes.list().then(setNotes)
    void api.folders.list({ kind: 'note' }).then(setFolders)
  }, [])
  useEffect(load, [load, version])

  // A folder shows its own notes and the ones in folders inside it.
  const inFolder = useMemo(() => (folderId ? withSubfolders(folders, folderId) : null), [folders, folderId])
  const shown = useMemo(
    () => notes.filter((n) => (!inFolder || (n.folder_id && inFolder.has(n.folder_id))) && `${n.title} ${n.module}`.toLowerCase().includes(q.toLowerCase())),
    [notes, inFolder, q]
  )
  const tree = useMemo(() => folderTree(folders), [folders])
  const countIn = (id: string) => {
    const ids = withSubfolders(folders, id)
    return notes.filter((n) => n.folder_id && ids.has(n.folder_id)).length
  }
  // Notes are listed under their folders (nested), which collapse. A filter shows every match.
  const { isCollapsed, toggle } = useCollapsedFolders()
  const groups: TreeGroup<NoteMeta>[] = useMemo(() => {
    const scope = inFolder ? folders.filter((f) => inFolder.has(f.id)) : folders
    return scope.length ? groupByFolderTree(shown, scope) : [{ folder: null, items: shown, depth: 0, ancestors: [], total: shown.length }]
  }, [inFolder, folders, shown])
  const holdsActive = (g: TreeGroup<NoteMeta>) => g.items.some((n) => n.id === noteId)
  const isShown = (g: TreeGroup<NoteMeta>) => !!q || holdsActive(g) || g.ancestors.every((a) => !isCollapsed(a))
  const isOpen = (g: TreeGroup<NoteMeta>) => isShown(g) && (!g.folder || !!q || !isCollapsed(g.folder.id) || holdsActive(g))
  const visible = groups.flatMap((g) => (isOpen(g) ? g.items : []))
  const idx = visible.findIndex((n) => n.id === noteId)
  const writing = jobs.find((j) => j.status === 'running' && j.meta?.noteId === noteId)

  useCommands(
    {
      'go.nextDeck': () => visible[idx + 1] && go({ name: 'notes', id: visible[idx + 1].id }),
      'go.prevDeck': () => idx > 0 && go({ name: 'notes', id: visible[idx - 1].id }),
      'io.importNotes': async () => {
        const ids = await api.io.importNotes({ folderId })
        if (ids.length) {
          toast(`Imported ${ids.length} note${ids.length === 1 ? '' : 's'}`, 'good')
          load()
          go({ name: 'notes', id: ids[0] })
        }
      }
    },
    [visible, idx, folderId]
  )

  const noteRow = (n: NoteMeta, depth: number | null) => (
    <button
      key={n.id}
      onClick={() => go({ name: 'notes', id: n.id })}
      className={cx('flex flex-col rounded-lg py-2 pr-3 text-left transition-colors duration-200', n.id === noteId ? 'bg-accent-soft' : 'hover:bg-surface-2')}
      style={{ paddingLeft: depth === null ? 12 : 36 + depth * 16 }}
    >
      <span className="flex items-center gap-1.5 truncate font-semibold">
        {jobs.some((j) => j.status === 'running' && j.meta?.noteId === n.id) && <span className="pulse-dot size-2 shrink-0 rounded-full bg-accent" />}
        <span className="truncate">{n.title}</span>
      </span>
      <span className="truncate text-[0.78rem] text-muted">{[n.module, n.type, n.week && `Week ${n.week}`].filter(Boolean).join(' · ') || new Date(n.updated_at).toLocaleDateString()}</span>
    </button>
  )

  return (
    <div className="flex h-full">
      {/* Narrow screens (and the phone): the list fills the screen until a note is open. */}
      <aside
        className={cx(
          'flex shrink-0 flex-col overflow-hidden border-r border-line transition-[width,opacity] duration-500 ease-out-soft',
          rail ? 'w-[290px] opacity-100' : 'w-0 opacity-0',
          noteId ? 'max-md:hidden' : 'max-md:w-full max-md:border-r-0 max-md:opacity-100'
        )}
      >
        <div className="flex w-[290px] flex-col gap-2 p-4 pb-2 max-md:w-full">
          <div className="flex gap-2">
            <Button variant="primary" size="sm" className="flex-1 justify-center" onClick={() => runCommand('note.new')}>
              New note
            </Button>
            <Button size="sm" onClick={() => runCommand('gen.notes')} title={keyLabel("Generate notes with AI (⇧⌘G)")}>
              AI
            </Button>
            <Button size="icon" variant="ghost" className="desktop-only" onClick={() => runCommand('io.importNotes')} title={keyLabel("Import Markdown / Notion (⌥⌘I)")}>
              <Upload className="size-4" />
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter notes…" className="h-9 pl-9 text-[0.9rem]" />
          </div>
        </div>
        <div className="flex w-[290px] flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-4 max-md:w-full">
          <div className="mt-1 mb-1 flex items-center justify-between px-2 text-[0.72rem] font-semibold text-muted">
            Folders
            <button
              onClick={async () => {
                const name = await askText('New notes folder', { label: 'Folder name' })
                if (name) await api.folders.create({ name, kind: 'note' }).then(load)
              }}
              className="rounded-full p-1 hover:bg-surface-2"
            >
              <FolderPlus className="size-4" />
            </button>
          </div>
          <RailItem active={!folderId} onClick={() => setFolderId(null)} label="All notes" count={notes.length} />
          {tree.map(({ folder: f, depth }) => (
            <RailItem
              key={f.id}
              active={folderId === f.id}
              onClick={() => setFolderId(f.id)}
              label={f.name}
              depth={depth}
              count={countIn(f.id)}
              onAddChild={async () => {
                const name = await askText(`New folder in “${f.name}”`, { label: 'Folder name' })
                if (name) await api.folders.create({ name, kind: 'note', parent_id: f.id }).then(load)
              }}
              onRename={async () => {
                const name = await askText('Rename folder', { initial: f.name })
                if (name) await api.folders.rename({ id: f.id, name }).then(load)
              }}
              onDelete={async () => {
                const inside = withSubfolders(folders, f.id).size - 1
                if (await confirmDialog(`Delete folder “${f.name}”?`, inside ? `The ${inside} folder${inside === 1 ? '' : 's'} inside it go too. Notes are kept.` : 'Notes inside are kept.', { danger: true })) {
                  await api.folders.delete({ id: f.id })
                  setFolderId(null)
                  load()
                }
              }}
            />
          ))}
          <div className="mx-2 my-2 border-t border-line" />
          {notes.length > 1 && (
            <div className="mb-1 flex items-center justify-between px-2 text-[0.72rem] font-semibold text-muted">
              Notes
              <button
                onClick={async () => {
                  const scope = folderId ? folders.find((f) => f.id === folderId)?.name : null
                  try {
                    const r = await api.notes.revisionOrder({ folderId })
                    load()
                    toast(`${scope ? `${scope}: ` : ''}${r.ordered} note${r.ordered === 1 ? '' : 's'} in revision order (by week, then lecture or topic)`, 'good')
                  } catch (e) {
                    toast(errorText(e), 'bad')
                  }
                }}
                className="flex items-center gap-1 rounded-full px-2 py-1 font-medium hover:bg-surface-2 hover:text-ink"
                title={folderId ? 'Put the notes in this folder (and its folders) in revision order: by week, then lecture or topic' : 'Put every folder’s notes in revision order: by week, then lecture or topic'}
              >
                <ListOrdered className="size-3.5" /> Revision order
              </button>
            </div>
          )}
          <div className="stagger flex flex-col gap-0.5">
            {groups.filter(isShown).map((g) => {
              const open = isOpen(g)
              return (
                <div key={g.folder?.id ?? 'loose'} className="flex flex-col gap-0.5">
                  {g.folder && (
                    <button
                      onClick={() => toggle(g.folder!.id)}
                      aria-expanded={open}
                      className="flex items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[0.86rem] font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                      style={{ paddingLeft: 8 + g.depth * 16 }}
                    >
                      <ChevronRight className={cx('size-3.5 shrink-0 transition-transform duration-200', open && 'rotate-90')} />
                      <FolderIcon className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{g.folder.name}</span>
                      <span className="text-[0.78rem] font-normal">{g.total}</span>
                    </button>
                  )}
                  {open && g.items.map((n) => noteRow(n, g.folder ? g.depth : null))}
                </div>
              )
            })}
          </div>
        </div>
      </aside>
      <div className={cx('min-w-0 flex-1 overflow-y-auto', !noteId && 'max-md:hidden')}>
        {noteId ? (
          <NoteEditor key={noteId} id={noteId} writingJobId={writing?.id ?? null} folders={folders} onChanged={load} />
        ) : (
          <div className="mx-auto max-w-xl p-8">
            <Empty title={notes.length ? 'Pick a note' : 'No notes yet'}>
              Write notes by hand, import Markdown or a Notion export, or drop a PDF to have AI write structured notes in your style.
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button variant="primary" onClick={() => runCommand('gen.notes')}>
                  Generate with AI
                </Button>
                <Button onClick={() => runCommand('note.new')}>New note</Button>
              </div>
            </Empty>
          </div>
        )}
      </div>
    </div>
  )
}

interface Suggestion {
  kind: string
  from: number
  to: number
  text: string
  streaming: boolean
}

function NoteEditor({ id, writingJobId, folders, onChanged }: { id: string; writingJobId: string | null; folders: Folder[]; onChanged: () => void }) {
  const go = useStore((s) => s.go)
  const openExplain = useStore((s) => s.openExplain)
  const [note, setNote] = useState<Note | null>(null)
  const [content, setContent] = useState('')
  // On the phone a note opens to read; side by side doesn't fit.
  const [view, setView] = useState<View>(() => (IS_MOBILE ? 'preview' : (localStorage.getItem('sw.noteView') as View) || 'split'))
  const [saved, setSaved] = useState(true)
  const [streamText, setStreamText] = useState('')
  const [sel, setSel] = useState<{ from: number; to: number; text: string; top: number; left: number } | null>(null)
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [actions, setActions] = useState<CustomAction[]>([])
  const [decks, setDecks] = useState<{ id: string; name: string }[]>([])
  const cm = useRef<ReactCodeMirrorRef>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef({ content: '' })

  const load = useCallback(async () => {
    const n = await api.notes.get({ id })
    setNote(n)
    setContent(n.content)
    latest.current.content = n.content
  }, [id])
  useEffect(() => {
    void load()
    void api.actions.list().then((a) => setActions(a.filter((x) => x.placements.includes('note_selection'))))
    void api.decks.list().then(setDecks)
  }, [load])
  useEffect(() => void (!IS_MOBILE && localStorage.setItem('sw.noteView', view)), [view])

  // Live text while AI writes this note.
  useEffect(() => {
    if (!writingJobId) return
    setStreamText('')
    const off = onEvent((ev) => {
      if (ev.type === 'job:delta' && ev.jobId === writingJobId) setStreamText((t) => t + ev.text)
      if (ev.type === 'job' && ev.job.id === writingJobId && ev.job.status !== 'running') {
        setStreamText('')
        void load()
      }
    })
    return off
  }, [writingJobId, load])

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    await api.notes.update({ id, patch: { content: latest.current.content } })
    setSaved(true)
  }, [id])
  useEffect(() => () => void (saveTimer.current && flush()), [flush])
  const exportAs = async (format: 'obsidian' | 'notion') => {
    try {
      await flush()
      const f = await api.io.exportNote({ noteId: id, format })
      if (f) toast(format === 'notion' && f.endsWith('.zip') ? 'Exported. In Notion: Import → Markdown, and pick the .zip.' : `Exported for ${format === 'notion' ? 'Notion' : 'Obsidian'}`, 'good')
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }

  const onEdit = (v: string) => {
    setContent(v)
    latest.current.content = v
    setSaved(false)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flush(), 700)
  }
  const patchMeta = async (p: Partial<Pick<Note, 'title' | 'module' | 'type' | 'week' | 'folder_id'>>) => {
    setNote((n) => (n ? { ...n, ...p } : n))
    await api.notes.update({ id, patch: p })
    onChanged()
  }

  const selection = (): { from: number; to: number; text: string } | null => {
    const v = cm.current?.view
    if (!v) return null
    const r = v.state.selection.main
    if (r.empty) return null
    return { from: r.from, to: r.to, text: v.state.sliceDoc(r.from, r.to) }
  }

  const runQuick = async (kind: 'simplify' | 'shorten' | 'fix_formatting' | 'expand') => {
    const s = selection() ?? (kind === 'fix_formatting' ? { from: 0, to: content.length, text: content } : null)
    if (!s || !s.text.trim()) return toast('Select some text first', 'info')
    setSel(null)
    setSuggestion({ kind, from: s.from, to: s.to, text: '', streaming: true })
    try {
      const out = await streamCall(
        (streamId) => api.notes.ai({ kind, text: s.text, noteId: id, streamId }),
        (full) => setSuggestion((cur) => (cur ? { ...cur, text: full } : cur))
      )
      setSuggestion((cur) => (cur ? { ...cur, text: out, streaming: false } : cur))
    } catch (e) {
      setSuggestion(null)
      toast(errorText(e), 'bad')
    }
  }
  const applySuggestion = (mode: 'replace' | 'below') => {
    const v = cm.current?.view
    if (!v || !suggestion) return
    if (mode === 'replace') v.dispatch({ changes: { from: suggestion.from, to: suggestion.to, insert: suggestion.text.trim() } })
    else v.dispatch({ changes: { from: suggestion.to, insert: `\n\n${suggestion.text.trim()}\n` } })
    setSuggestion(null)
  }
  const explainSel = () => {
    const s = selection()
    if (!s) return toast('Select some text first', 'info')
    openExplain({ ctx: { noteId: id, selection: s.text }, title: s.text.slice(0, 60) })
  }
  const cardsFromSel = () => {
    const s = selection()
    if (!s) return toast('Select some text first', 'info')
    useStore.getState().openGenCards({ text: s.text, deckId: note?.deck_ids[0] ?? null })
  }
  const quizSel = async () => {
    const s = selection()
    if (!s) return toast('Select some text first', 'info')
    toast('Making a quick quiz…', 'info')
    try {
      const r = await api.notes.quiz({ noteId: id, text: s.text })
      go({ name: 'learn', deckId: r.deckId, cardIds: r.cardIds })
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const cardsFromNote = () => useStore.getState().openGenCards({ noteIds: [id], deckId: note?.deck_ids[0] ?? null })

  useCommands(
    {
      'note.save': () => void flush().then(() => toast('Saved', 'good')),
      'view.preview': () => setView((v) => (v === 'preview' ? 'edit' : v === 'edit' ? 'split' : 'preview')),
      'ai.simplify': () => runQuick('simplify'),
      'ai.expand': () => runQuick('expand'),
      'ai.shorten': () => runQuick('shorten'),
      'ai.fixFormatting': () => runQuick('fix_formatting'),
      'ai.cardsFromSelection': cardsFromSel,
      'ai.quizSelection': quizSel,
      'ai.cardsFromNote': cardsFromNote,
      'ai.explain': () => (selection() ? explainSel() : openExplain({ ctx: { noteId: id, selection: content.slice(0, 4000) }, title: note?.title })),
      'io.exportNote': async () => {
        const format = await chooseDialog('Export note', [{ value: 'obsidian', label: 'Obsidian (Markdown with properties, images in attachments/)' }, { value: 'notion', label: 'Notion (Markdown, or a .zip with images, for Notion’s import)' }], { confirmText: 'Export' })
        if (format) await exportAs(format as 'obsidian' | 'notion')
      },
      'item.rename': async () => {
        const t = await askText('Rename note', { initial: note?.title })
        if (t) await patchMeta({ title: t })
      }
    },
    [content, note, suggestion]
  )

  const onPaste = async (e: React.ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    const url = await api.app.saveAttachment({ name: file.name || 'pasted.png', data: new Uint8Array(await file.arrayBuffer()) })
    cm.current?.view?.dispatch(cm.current.view.state.replaceSelection(`![${file.name || 'image'}](${url})`))
  }

  if (!note) return <div className="p-8"><div className="skeleton h-10 w-1/2" /></div>
  const streaming = !!writingJobId
  const shownContent = streaming ? content + (content && streamText ? '\n\n' : '') + streamText : content
  const linkedDecks = decks.filter((d) => note.deck_ids.includes(d.id))

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-line bg-bg/90 px-[clamp(16px,3vw,40px)] pt-5 pb-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note.title}
            onChange={(e) => setNote({ ...note, title: e.target.value })}
            onBlur={(e) => patchMeta({ title: e.target.value || 'Untitled' })}
            className="min-w-[200px] flex-1 bg-transparent text-[clamp(1.35rem,2.2vw,1.7rem)] font-semibold tracking-[-0.02em] outline-none"
          />
          <span className={cx('text-[0.8rem] text-muted transition-opacity', saved && 'opacity-60')}>{streaming ? <span className="flex items-center gap-1.5 text-accent"><Sparkles className="size-3.5" /> AI is writing <Dots /></span> : saved ? 'Saved' : 'Editing…'}</span>
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'edit', label: <PenLine className="size-4" /> },
              ...(IS_MOBILE ? [] : [{ value: 'split' as const, label: <Columns2 className="size-4" /> }]),
              { value: 'preview', label: <Eye className="size-4" /> }
            ]}
          />
          <Button size="sm" variant="primary" onClick={cardsFromNote} title={keyLabel("Generate flashcards from this note (⇧⌥⌘G)")}>
            Make flashcards
          </Button>
          <Menu
            trigger={(t) => (
              <Button size="icon" variant="ghost" onClick={t} aria-label="Note menu">
                <Wand2 className="size-4" />
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuItem kbd="ai.fixFormatting" onClick={() => (close(), runQuick('fix_formatting'))}>
                  Fix formatting (whole note)
                </MenuItem>
                <MenuItem kbd="ai.explain" onClick={() => (close(), runCommand('ai.explain'))}>
                  Explain this note
                </MenuItem>
                <MenuItem desktopOnly kbd="io.exportNote" onClick={() => (close(), void exportAs('obsidian'))}>
                  Export for Obsidian
                </MenuItem>
                <MenuItem desktopOnly onClick={() => (close(), void exportAs('notion'))}>Export for Notion</MenuItem>
                <MenuItem
                  onClick={async () => {
                    close()
                    const v = await chooseDialog('Move to folder', [{ value: '', label: 'No folder' }, ...folderTree(folders).map(({ folder: f }) => ({ value: f.id, label: folderPath(folders, f.id) }))], { initial: note.folder_id ?? '' })
                    if (v !== null) await patchMeta({ folder_id: v || null })
                  }}
                >
                  Move to folder
                </MenuItem>
                <MenuItem
                  danger
                  onClick={async () => {
                    close()
                    if (await confirmDialog(`Delete “${note.title}”?`, undefined, { danger: true, confirmText: 'Delete' })) {
                      await api.notes.delete({ id })
                      onChanged()
                      go({ name: 'notes', id: null })
                    }
                  }}
                >
                  Delete note
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.85rem]">
          <input value={note.module} onChange={(e) => setNote({ ...note, module: e.target.value })} onBlur={(e) => patchMeta({ module: e.target.value })} placeholder="Module" className="h-8 w-32 rounded-md bg-surface-2 px-2.5 outline-none focus:ring-2 focus:ring-accent/30" />
          <Select value={note.type} onChange={(e) => patchMeta({ type: e.target.value })} className="h-8 w-32 rounded-md border-0 bg-surface-2 text-[0.85rem]">
            <option value="">Type</option>
            {NOTE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
          <input value={note.week} onChange={(e) => setNote({ ...note, week: e.target.value })} onBlur={(e) => patchMeta({ week: e.target.value })} placeholder="Week" className="h-8 w-20 rounded-md bg-surface-2 px-2.5 outline-none focus:ring-2 focus:ring-accent/30" />
          <span className="mx-1 h-4 w-px bg-line" />
          <Link2 className="size-3.5 text-muted" />
          {linkedDecks.map((d) => (
            <button key={d.id} onClick={() => go({ name: 'deck', id: d.id })}>
              <Pill tone="accent">{d.name}</Pill>
            </button>
          ))}
          <Menu
            align="left"
            trigger={(t) => (
              <button onClick={t} className="rounded-full px-2 py-0.5 text-muted hover:bg-surface-2 hover:text-ink">
                {linkedDecks.length ? 'Edit links' : 'Link to deck'}
              </button>
            )}
          >
            {() => (
              <div className="max-h-64 overflow-y-auto">
                {decks.length === 0 && <div className="p-3 text-muted">No decks yet</div>}
                {decks.map((d) => {
                  const on = note.deck_ids.includes(d.id)
                  return (
                    <MenuItem
                      key={d.id}
                      icon={on ? <Check className="size-4 text-accent" /> : <span className="size-4" />}
                      onClick={async () => {
                        await api.notes.linkDeck({ noteId: id, deckId: d.id, linked: !on })
                        setNote({ ...note, deck_ids: on ? note.deck_ids.filter((x) => x !== d.id) : [...note.deck_ids, d.id] })
                      }}
                    >
                      {d.name}
                    </MenuItem>
                  )
                })}
              </div>
            )}
          </Menu>
        </div>
      </div>

      <div className={cx('grid flex-1 gap-0', view === 'split' ? 'lg:grid-cols-2' : 'grid-cols-1')}>
        {view !== 'preview' && !streaming && (
          <div ref={wrap} className="relative min-w-0 border-line px-[clamp(16px,3vw,40px)] py-4 lg:border-r" onPaste={onPaste}>
            <CodeMirror
              ref={cm}
              value={content}
              onChange={onEdit}
              extensions={[markdown({ base: markdownLanguage }), syntaxHighlighting(mdHighlight), EditorView.lineWrapping, cmTheme]}
              basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: true, autocompletion: false }}
              theme="none"
              placeholder="Start writing… Markdown, $maths$ and ```mermaid diagrams all work."
              onUpdate={(u) => {
                if (!u.selectionSet && !u.focusChanged) return
                const r = u.state.selection.main
                if (r.empty || !u.view.hasFocus) return setSel(null)
                const coords = u.view.coordsAtPos(r.from)
                const box = wrap.current?.getBoundingClientRect()
                if (!coords || !box) return
                setSel({ from: r.from, to: r.to, text: u.state.sliceDoc(r.from, r.to), top: coords.top - box.top - 52, left: Math.max(8, Math.min(coords.left - box.left, box.width - 420)) })
              }}
            />
            {sel && !suggestion && (
              <div className="pop-in absolute z-20 flex flex-wrap items-center gap-0.5 rounded-full border border-line bg-surface p-1 shadow-xl" style={{ top: Math.max(0, sel.top), left: sel.left }} onMouseDown={(e) => e.preventDefault()}>
                <ToolBtn label="Explain" onClick={explainSel} />
                <ToolBtn label="Simplify" onClick={() => runQuick('simplify')} k="⌥⌘1" />
                <ToolBtn label="Expand" onClick={() => runQuick('expand')} k="⌥⌘2" />
                <ToolBtn label="Shorten" onClick={() => runQuick('shorten')} k="⌥⌘3" />
                <ToolBtn label="Flashcards" onClick={cardsFromSel} k="⌥⌘G" />
                <ToolBtn label="Quiz me" onClick={quizSel} k="⌥⌘Q" />
                {actions.map((a) => (
                  <ToolBtn key={a.id} label={a.name} onClick={() => openExplain({ ctx: { noteId: id, selection: sel.text }, title: sel.text.slice(0, 60), action: { id: a.id, name: a.name } })} />
                ))}
              </div>
            )}
          </div>
        )}
        {(view !== 'edit' || streaming) && (
          <div className="min-w-0 px-[clamp(16px,3vw,48px)] py-6">
            <article className="mx-auto max-w-[760px]">
              {shownContent.trim() ? <Markdown streaming={streaming}>{shownContent}</Markdown> : <div className="text-muted">{streaming ? <Dots /> : 'Nothing here yet.'}</div>}
            </article>
          </div>
        )}
      </div>

      {suggestion && (
        <div className="pop-in fixed right-4 bottom-4 left-4 z-30 mx-auto max-w-[720px] rounded-xl border border-line bg-surface shadow-2xl">
          <div className="flex items-center justify-between px-5 pt-4">
            <span className="flex items-center gap-2 text-[0.78rem] font-semibold text-accent">
              <Sparkles className="size-3.5" /> {suggestion.kind.replace('_', ' ')}
            </span>
            <button onClick={() => setSuggestion(null)} className="text-muted hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
          <div className="max-h-[42vh] overflow-y-auto px-5 py-3">{suggestion.text ? <Markdown streaming={suggestion.streaming}>{suggestion.text}</Markdown> : <Dots />}</div>
          <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
            <Button size="sm" variant="primary" disabled={suggestion.streaming} onClick={() => applySuggestion('replace')}>
              Replace selection
            </Button>
            <Button size="sm" disabled={suggestion.streaming} onClick={() => applySuggestion('below')}>
              Insert below
            </Button>
            <Button size="sm" variant="ghost" disabled={suggestion.streaming} onClick={() => (navigator.clipboard.writeText(suggestion.text), toast('Copied', 'good'))}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSuggestion(null)}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ToolBtn({ icon, label, onClick, k }: { icon?: React.ReactNode; label: string; onClick: () => void; k?: string }) {
  return (
    <button onClick={onClick} title={k ? `${label} (${keyLabel(k)})` : label} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[0.82rem] font-semibold transition-colors hover:bg-accent-soft">
      {icon}
      {label}
    </button>
  )
}
