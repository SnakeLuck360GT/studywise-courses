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
  FolderOpen,
  FilePlus,
  MoreHorizontal,
  Pencil,
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
import { folderPath, folderTree, withSubfolders } from '../lib/collapsed'
import { useCommands, runCommand } from '../lib/commands'
import { askText, confirmDialog, chooseDialog } from '../lib/dialogs'
import { Markdown } from '../components/Markdown'
import { Button, Dots, Empty, Input, Menu, MenuItem, Select, Segmented, cx, Pill } from '../components/ui'

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

// Notes are a file tree: folders open in place with their notes right under
// them (the way Finder or Obsidian shows them), and a folder you pick shows its
// notes and folders on the right until you open one.
const OPEN_KEY = 'sw.noteTreeOpen'
let lastFolder: string | null = null
const NOTE_DRAG = 'application/x-studywise-note'

function readOpen(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Folder ids from the top down to this one. */
function chainTo(folders: Folder[], id: string | null): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: string[] = []
  for (let f = id ? byId.get(id) : undefined; f && out.length < 20; f = f.parent_id ? byId.get(f.parent_id) : undefined) out.unshift(f.id)
  return out
}

/** Focus a folder's row in the tree (its name). */
const focusFolder = (root: HTMLElement | null, id: string | null) => root?.querySelector<HTMLElement>(`[data-folder="${id}"] [data-name]`)?.focus()

const noteMeta = (n: NoteMeta) => [n.module, n.type, n.week && `Week ${n.week}`].filter(Boolean).join(' · ')

function edited(iso: string): string {
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days < 1 && new Date().toDateString() === d.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' })
  return d.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

export function Notes({ noteId }: { noteId: string | null }) {
  const go = useStore((s) => s.go)
  const version = useStore((s) => s.version)
  const rail = useStore((s) => s.rail)
  const jobs = useStore((s) => s.jobs)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [loaded, setLoaded] = useState(false)
  // The folder picked in the tree: shown on the right when no note is open, and where new notes go.
  // Remembered while the app is open, so coming back to Notes shows the same folder.
  const [folderId, setFolderState] = useState<string | null>(() => lastFolder)
  const setFolderId = useCallback((id: string | null) => setFolderState((lastFolder = id)), [])
  const pane = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [open, setOpenSet] = useState(readOpen)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    void Promise.all([api.notes.list(), api.folders.list({ kind: 'note' })]).then(([n, f]) => {
      setNotes(n)
      setFolders(f)
      setLoaded(true)
    })
  }, [])
  useEffect(load, [load, version])

  const setOpen = useCallback((update: (s: Set<string>) => Set<string>) => {
    setOpenSet((prev) => {
      const next = update(new Set(prev))
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...next]))
      } catch {
        /* storage unavailable: still works for this session */
      }
      return next
    })
  }, [])
  const toggle = (id: string) => setOpen((s) => (s.delete(id) ? s : s.add(id)))
  const expand = (ids: string[]) => ids.length && setOpen((s) => (ids.forEach((id) => s.add(id)), s))

  // Opening a note opens the folders it's in and makes its folder the current one.
  const activeFolder = notes.find((n) => n.id === noteId)?.folder_id
  useEffect(() => {
    if (!noteId || activeFolder === undefined) return
    setFolderId(activeFolder)
    expand(chainTo(folders, activeFolder))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, activeFolder, folders.length])
  // …scrolls the tree to it, wherever it is, and starts the note at its top.
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 })
    const sel = noteId ? `[data-note="${noteId}"]` : folderId ? `[data-folder="${folderId}"]` : null
    if (!sel) return
    const t = setTimeout(() => list.current?.querySelector(sel)?.scrollIntoView({ block: 'nearest' }), 60)
    return () => clearTimeout(t)
  }, [noteId, folderId, loaded])
  // A deleted folder isn't current any more.
  useEffect(() => {
    if (folderId && loaded && !folders.some((f) => f.id === folderId)) setFolderId(null)
  }, [folders, folderId, loaded])

  const kids = useMemo(() => {
    const ids = new Set(folders.map((f) => f.id))
    const m = new Map<string | null, Folder[]>()
    for (const f of folders) {
      const p = f.parent_id && ids.has(f.parent_id) ? f.parent_id : null
      m.set(p, [...(m.get(p) ?? []), f])
    }
    for (const l of m.values())
      l.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      )
    return m
  }, [folders])
  const notesIn = useMemo(() => {
    const ids = new Set(folders.map((f) => f.id))
    const m = new Map<string | null, NoteMeta[]>()
    for (const n of notes) {
      const k = n.folder_id && ids.has(n.folder_id) ? n.folder_id : null
      m.set(k, [...(m.get(k) ?? []), n])
    }
    return m
  }, [notes, folders])
  const countIn = (id: string) => [...withSubfolders(folders, id)].reduce((n, f) => n + (notesIn.get(f)?.length ?? 0), 0)

  const query = q.trim().toLowerCase()
  const matches = useMemo(() => (query ? notes.filter((n) => `${n.title} ${n.module} ${n.type} ${n.week}`.toLowerCase().includes(query)) : []), [notes, query])
  // Notes in the order the tree shows them, for next/previous note.
  const visible = useMemo(() => {
    if (query) return matches
    const out: NoteMeta[] = []
    const walk = (parent: string | null) => {
      for (const f of kids.get(parent) ?? []) if (open.has(f.id)) walk(f.id)
      out.push(...(notesIn.get(parent) ?? []))
    }
    walk(null)
    return out
  }, [query, matches, kids, notesIn, open])
  const idx = visible.findIndex((n) => n.id === noteId)
  const writing = jobs.find((j) => j.status === 'running' && j.meta?.noteId === noteId)

  const newNote = async (folder: string | null = folderId) => {
    const n = await api.notes.create({ title: 'Untitled', folder_id: folder })
    load()
    go({ name: 'notes', id: n.id })
  }
  const newFolder = async (parent: string | null) => {
    const p = parent ? folders.find((f) => f.id === parent) : null
    const name = await askText(p ? `New folder in “${p.name}”` : 'New notes folder', { label: 'Folder name', confirmText: 'Create' })
    if (!name) return
    await api.folders.create({ name, kind: 'note', parent_id: parent })
    if (parent) expand([parent])
    load()
  }
  const renameFolder = async (f: Folder) => {
    const name = await askText('Rename folder', { initial: f.name })
    if (name) await api.folders.rename({ id: f.id, name }).then(load)
  }
  const deleteFolder = async (f: Folder) => {
    const inside = withSubfolders(folders, f.id).size - 1
    if (await confirmDialog(`Delete folder “${f.name}”?`, inside ? `The ${inside} folder${inside === 1 ? '' : 's'} inside it go too. Notes are kept.` : 'Notes inside are kept.', { danger: true })) {
      await api.folders.delete({ id: f.id })
      if (folderId && withSubfolders(folders, f.id).has(folderId)) setFolderId(null)
      load()
    }
  }
  const revisionOrder = async (scope: string | null) => {
    const name = scope ? folders.find((f) => f.id === scope)?.name : null
    try {
      const r = await api.notes.revisionOrder({ folderId: scope })
      load()
      toast(`${name ? `${name}: ` : ''}${r.ordered} note${r.ordered === 1 ? '' : 's'} in revision order (by week, then lecture or topic)`, 'good')
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const moveNote = async (id: string, to: string | null) => {
    const n = notes.find((x) => x.id === id)
    if (!n || (n.folder_id ?? null) === to) return
    await api.notes.update({ id, patch: { folder_id: to } })
    if (to) expand(chainTo(folders, to))
    load()
    toast(`Moved “${n.title}” to ${to ? folders.find((f) => f.id === to)?.name : 'All notes'}`, 'good')
  }
  // Picking a folder in the tree opens it and shows it on the right (closing the note there).
  const pickFolder = (id: string | null) => {
    setFolderId(id)
    if (id) expand(chainTo(folders, id))
    if (noteId) go({ name: 'notes', id: null })
  }

  useCommands(
    {
      'go.nextDeck': () => visible[idx + 1] && go({ name: 'notes', id: visible[idx + 1].id }),
      'go.prevDeck': () => idx > 0 && go({ name: 'notes', id: visible[idx - 1].id }),
      'note.new': () => void newNote(),
      'folder.new': () => void newFolder(folderId),
      'io.importNotes': async () => {
        const ids = await api.io.importNotes({ folderId })
        if (ids.length) {
          toast(`Imported ${ids.length} note${ids.length === 1 ? '' : 's'}`, 'good')
          load()
          go({ name: 'notes', id: ids[0] })
        }
      }
    },
    [visible, idx, folderId, folders, notes]
  )

  // Dropping a dragged note on a folder (or on All notes) moves it there.
  const dropTarget = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(NOTE_DRAG)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropOn(target ?? 'root')
    },
    onDragLeave: () => setDropOn((d) => (d === (target ?? 'root') ? null : d)),
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(NOTE_DRAG)
      setDropOn(null)
      if (id) {
        e.preventDefault()
        void moveNote(id, target)
      }
    }
  })

  const noteRow = (n: NoteMeta, depth: number, path?: string) => {
    const active = n.id === noteId
    const running = jobs.some((j) => j.status === 'running' && j.meta?.noteId === n.id)
    return (
      <button
        key={n.id}
        data-note={n.id}
        draggable={!IS_MOBILE}
        onDragStart={(e) => {
          e.dataTransfer.setData(NOTE_DRAG, n.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => setDropOn(null)}
        onClick={() => go({ name: 'notes', id: n.id })}
        onKeyDown={(e) => {
          // ← goes up to the note's folder in the tree.
          if (e.key === 'ArrowLeft' && n.folder_id && !query) {
            e.preventDefault()
            focusFolder(list.current, n.folder_id)
          }
        }}
        title={[n.title, noteMeta(n)].filter(Boolean).join('\n')}
        className={cx(
          'flex min-h-8 w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[0.9rem] transition-colors duration-150',
          active ? 'bg-accent-soft font-semibold text-ink' : 'text-ink/85 hover:bg-surface-2'
        )}
        style={{ paddingLeft: 10 + depth * 14 + 18 }}
      >
        {running ? <span className="pulse-dot mx-[3px] size-2 shrink-0 rounded-full bg-accent" /> : <FileText className={cx('size-3.5 shrink-0', active ? 'text-accent' : 'text-muted')} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{n.title || 'Untitled'}</span>
          {path && <span className="block truncate text-[0.76rem] font-normal text-muted">{path}</span>}
        </span>
      </button>
    )
  }

  const folderNode = (f: Folder, depth: number): React.ReactNode => {
    const isOpen = open.has(f.id)
    const current = folderId === f.id && !noteId
    const subs = kids.get(f.id) ?? []
    const own = notesIn.get(f.id) ?? []
    return (
      <div key={f.id} role="treeitem" aria-expanded={isOpen}>
        <div
          {...dropTarget(f.id)}
          data-folder={f.id}
          className={cx(
            'group flex min-h-8 items-center rounded-lg transition-colors duration-150',
            dropOn === f.id ? 'bg-accent-soft ring-2 ring-accent/40' : current ? 'bg-accent-soft' : 'hover:bg-surface-2'
          )}
        >
          <button
            onClick={() => toggle(f.id)}
            aria-label={isOpen ? `Close ${f.name}` : `Open ${f.name}`}
            className="grid h-8 w-6 shrink-0 place-items-center text-muted hover:text-ink"
            style={{ marginLeft: 4 + depth * 14 }}
          >
            <ChevronRight className={cx('size-3.5 transition-transform duration-200', isOpen && 'rotate-90')} />
          </button>
          <button
            data-name
            onClick={() => {
              if (folderId === f.id && !noteId) toggle(f.id)
              else pickFolder(f.id)
            }}
            onKeyDown={(e) => {
              // → opens a closed folder; ← closes an open one, or goes up to the folder it's in.
              if (e.key === 'ArrowRight' && !isOpen) {
                e.preventDefault()
                toggle(f.id)
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                if (isOpen) toggle(f.id)
                else if (f.parent_id) focusFolder(list.current, f.parent_id)
              }
            }}
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-[0.9rem] font-medium"
          >
            {isOpen ? <FolderOpen className="size-4 shrink-0 text-accent" /> : <FolderIcon className="size-4 shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
          </button>
          <span className={cx('pr-2 text-[0.76rem] text-muted tabular-nums', !IS_MOBILE && 'group-hover:hidden')}>{countIn(f.id) || ''}</span>
          <span className={cx('items-center pr-1', IS_MOBILE ? 'flex' : 'hidden group-hover:flex')}>
            <button onClick={() => void newNote(f.id)} className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink" title={`New note in ${f.name}`} aria-label={`New note in ${f.name}`}>
              <Plus className="size-3.5" />
            </button>
            <Menu
              trigger={(t) => (
                <button onClick={t} className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink" aria-label={`${f.name} menu`}>
                  <MoreHorizontal className="size-3.5" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem icon={<FilePlus className="size-4" />} onClick={() => (close(), void newNote(f.id))}>
                    New note here
                  </MenuItem>
                  <MenuItem icon={<FolderPlus className="size-4" />} onClick={() => (close(), void newFolder(f.id))}>
                    New folder inside
                  </MenuItem>
                  <MenuItem icon={<ListOrdered className="size-4" />} onClick={() => (close(), void revisionOrder(f.id))}>
                    Put in revision order
                  </MenuItem>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), void renameFolder(f))}>
                    Rename
                  </MenuItem>
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), void deleteFolder(f))}>
                    Delete folder
                  </MenuItem>
                </>
              )}
            </Menu>
          </span>
        </div>
        {isOpen && (
          <div role="group" className="relative">
            <span className="pointer-events-none absolute top-0 bottom-1 w-px bg-line" style={{ left: 4 + depth * 14 + 12 }} />
            {subs.map((s) => folderNode(s, depth + 1))}
            {own.map((n) => noteRow(n, depth + 1))}
            {!subs.length && !own.length && (
              <div className="py-1.5 text-[0.82rem] text-muted" style={{ paddingLeft: 10 + (depth + 1) * 14 + 18 }}>
                Empty.{' '}
                <button onClick={() => void newNote(f.id)} className="text-accent hover:underline">
                  New note
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const tops = kids.get(null) ?? []
  const loose = notesIn.get(null) ?? []

  return (
    <div className="flex h-full">
      {/* Narrow screens (and the phone): the tree fills the screen until a note is open. */}
      <aside
        className={cx(
          'flex shrink-0 flex-col overflow-hidden border-r border-line transition-[width,opacity] duration-500 ease-out-soft',
          rail ? 'w-[300px] opacity-100' : 'w-0 opacity-0',
          noteId ? 'max-md:hidden' : 'max-md:w-full max-md:border-r-0 max-md:opacity-100'
        )}
      >
        <div className="flex w-[300px] flex-col gap-2 p-4 pb-2 max-md:w-full">
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              className="flex-1 justify-center"
              onClick={() => void newNote()}
              title={folderId ? `New note in ${folders.find((f) => f.id === folderId)?.name}` : 'New note'}
            >
              <Plus className="size-4" /> New note
            </Button>
            <Button size="sm" onClick={() => runCommand('gen.notes')} title={keyLabel('Generate notes with AI (⇧⌘G)')}>
              <Sparkles className="size-4" /> AI
            </Button>
            <Button size="icon" variant="ghost" className="desktop-only" onClick={() => runCommand('io.importNotes')} title={keyLabel('Import Markdown / Notion (⌥⌘I)')}>
              <Upload className="size-4" />
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} placeholder="Search notes…" className="h-9 pl-9 text-[0.9rem]" />
            {q && (
              <button onClick={() => setQ('')} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-ink" aria-label="Clear search">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <div ref={list} role="tree" className="flex w-[300px] flex-1 flex-col overflow-y-auto px-2 pb-6 max-md:w-full">
          {query ? (
            <>
              <div className="px-2.5 pt-1 pb-1.5 text-[0.75rem] font-semibold text-muted">{matches.length ? `${matches.length} note${matches.length === 1 ? '' : 's'}` : 'No notes match'}</div>
              {matches.map((n) => noteRow(n, -1, n.folder_id ? folderPath(folders, n.folder_id) : undefined))}
            </>
          ) : (
            <>
              <div
                {...dropTarget(null)}
                className={cx(
                  'group mb-1 flex min-h-8 items-center rounded-lg transition-colors',
                  dropOn === 'root' ? 'bg-accent-soft ring-2 ring-accent/40' : !folderId && !noteId ? 'bg-accent-soft' : 'hover:bg-surface-2'
                )}
              >
                <button onClick={() => pickFolder(null)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left text-[0.9rem] font-medium">
                  <Layers className="size-4 shrink-0 text-muted" />
                  <span className="flex-1">All notes</span>
                  <span className="pr-1 text-[0.76rem] text-muted tabular-nums">{notes.length || ''}</span>
                </button>
                <button onClick={() => void newFolder(null)} className="rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink" title="New folder" aria-label="New folder">
                  <FolderPlus className="size-4" />
                </button>
                {notes.length > 1 && (
                  <button
                    onClick={() => void revisionOrder(null)}
                    className="mr-1 rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink"
                    title="Put every folder’s notes in revision order: by week, then lecture or topic"
                    aria-label="Revision order"
                  >
                    <ListOrdered className="size-4" />
                  </button>
                )}
              </div>
              <div className="stagger flex flex-col">
                {tops.map((f) => folderNode(f, 0))}
                {loose.map((n) => noteRow(n, -1))}
              </div>
              {loaded && !folders.length && !notes.length && <p className="px-3 py-4 text-[0.85rem] text-muted">No notes or folders yet.</p>}
            </>
          )}
        </div>
      </aside>
      <div ref={pane} className={cx('min-w-0 flex-1 overflow-y-auto', !noteId && 'max-md:hidden')}>
        {noteId ? (
          <NoteEditor key={noteId} id={noteId} writingJobId={writing?.id ?? null} folders={folders} onChanged={load} onOpenFolder={pickFolder} />
        ) : loaded && !notes.length && !folders.length ? (
          <div className="mx-auto max-w-xl p-8">
            <Empty title="No notes yet">
              Write notes by hand, import Markdown or a Notion export, or drop a PDF to have AI write structured notes in your style.
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button variant="primary" onClick={() => runCommand('gen.notes')}>
                  Generate with AI
                </Button>
                <Button onClick={() => void newNote()}>New note</Button>
              </div>
            </Empty>
          </div>
        ) : loaded ? (
          <FolderView
            folder={folders.find((f) => f.id === folderId) ?? null}
            folders={folders}
            subfolders={kids.get(folderId) ?? []}
            notes={folderId ? (notesIn.get(folderId) ?? []) : [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12)}
            countIn={countIn}
            onOpenFolder={pickFolder}
            onNewNote={() => void newNote()}
            onNewFolder={() => void newFolder(folderId)}
            onRevisionOrder={() => void revisionOrder(folderId)}
            onRename={(f) => void renameFolder(f)}
            onDelete={(f) => void deleteFolder(f)}
          />
        ) : null}
      </div>
    </div>
  )
}

/** "All notes › Physics › Week 2", each part opening that folder. */
function Crumbs({ folders, id, onOpenFolder, here }: { folders: Folder[]; id: string | null; onOpenFolder: (id: string | null) => void; here?: boolean }) {
  const chain = chainTo(folders, id)
  const byId = new Map(folders.map((f) => [f.id, f]))
  const parts: { id: string | null; name: string }[] = [{ id: null, name: 'All notes' }, ...chain.map((c) => ({ id: c, name: byId.get(c)?.name ?? '' }))]
  // On a folder's own page the last part is where you are, not a link.
  const links = here ? parts.slice(0, -1) : parts
  if (!links.length) return null
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1 text-[0.82rem] text-muted">
      {links.map((p, i) => (
        <span key={p.id ?? 'all'} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 shrink-0" />}
          <button onClick={() => onOpenFolder(p.id)} className="truncate rounded px-1 hover:bg-surface-2 hover:text-ink">
            {p.name}
          </button>
        </span>
      ))}
    </nav>
  )
}

function FolderView({
  folder,
  folders,
  subfolders,
  notes,
  countIn,
  onOpenFolder,
  onNewNote,
  onNewFolder,
  onRevisionOrder,
  onRename,
  onDelete
}: {
  folder: Folder | null
  folders: Folder[]
  subfolders: Folder[]
  notes: NoteMeta[]
  countIn: (id: string) => number
  onOpenFolder: (id: string | null) => void
  onNewNote: () => void
  onNewFolder: () => void
  onRevisionOrder: () => void
  onRename: (f: Folder) => void
  onDelete: (f: Folder) => void
}) {
  const go = useStore((s) => s.go)
  const total = folder ? countIn(folder.id) : null
  return (
    <div className="mx-auto w-full max-w-[920px] px-[clamp(16px,4vw,48px)] py-8">
      {folder && <Crumbs folders={folders} id={folder.id} onOpenFolder={onOpenFolder} here />}
      <div className="mt-1 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2.5 truncate text-[clamp(1.4rem,2.4vw,1.8rem)] font-semibold tracking-[-0.02em]">
            {folder ? <FolderOpen className="size-6 shrink-0 text-accent" /> : <Layers className="size-6 shrink-0 text-accent" />}
            <span className="truncate">{folder ? folder.name : 'All notes'}</span>
          </h1>
          <p className="mt-1 text-[0.88rem] text-muted">
            {folder
              ? [total ? `${total} note${total === 1 ? '' : 's'}` : 'No notes yet', subfolders.length && `${subfolders.length} folder${subfolders.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
              : 'Pick a folder or a note on the left, or carry on where you left off.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={onNewNote}>
            <Plus className="size-4" /> New note
          </Button>
          <Button size="sm" onClick={onNewFolder}>
            <FolderPlus className="size-4" /> {folder ? 'Folder inside' : 'New folder'}
          </Button>
          {folder && (
            <Menu
              trigger={(t) => (
                <Button size="icon" variant="ghost" onClick={t} aria-label="Folder menu">
                  <MoreHorizontal className="size-4" />
                </Button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem icon={<ListOrdered className="size-4" />} onClick={() => (close(), onRevisionOrder())}>
                    Put in revision order
                  </MenuItem>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => (close(), onRename(folder))}>
                    Rename
                  </MenuItem>
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={() => (close(), onDelete(folder))}>
                    Delete folder
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
      </div>

      {subfolders.length > 0 && (
        <section className="mt-7">
          <h2 className="mb-2.5 text-[0.78rem] font-semibold text-muted">Folders</h2>
          <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2.5">
            {subfolders.map((f) => {
              const n = countIn(f.id)
              return (
                <button
                  key={f.id}
                  onClick={() => onOpenFolder(f.id)}
                  title={f.name}
                  className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
                >
                  <FolderIcon className="size-5 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 font-semibold leading-snug">{f.name}</span>
                    <span className="block text-[0.8rem] text-muted">{n ? `${n} note${n === 1 ? '' : 's'}` : 'Empty'}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      <section className="mt-7">
        <h2 className="mb-2.5 text-[0.78rem] font-semibold text-muted">{folder ? (notes.length ? 'Notes' : '') : 'Recently edited'}</h2>
        {notes.length ? (
          <div className="stagger flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
            {notes.map((n, i) => (
              <button
                key={n.id}
                onClick={() => go({ name: 'notes', id: n.id })}
                className={cx('flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2', i > 0 && 'border-t border-line')}
              >
                <FileText className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{n.title || 'Untitled'}</span>
                  {(() => {
                    const sub = [!folder && n.folder_id ? folderPath(folders, n.folder_id) : null, noteMeta(n)].filter(Boolean).join(' · ')
                    return sub && <span className="block truncate text-[0.8rem] text-muted">{sub}</span>
                  })()}
                </span>
                <span className="shrink-0 text-[0.8rem] text-muted">{edited(n.updated_at)}</span>
              </button>
            ))}
          </div>
        ) : (
          folder &&
          !subfolders.length && (
            <Empty icon={<FolderOpen className="size-6" />} title="This folder is empty">
              Make a note here, or drag notes onto the folder in the list to move them in.
              <div className="mt-4 flex justify-center gap-2">
                <Button variant="primary" onClick={onNewNote}>
                  New note
                </Button>
                <Button onClick={() => runCommand('gen.notes')}>Generate with AI</Button>
              </div>
            </Empty>
          )
        )}
      </section>
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

function NoteEditor({ id, writingJobId, folders, onChanged, onOpenFolder }: { id: string; writingJobId: string | null; folders: Folder[]; onChanged: () => void; onOpenFolder: (id: string | null) => void }) {
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
      <div className="sticky top-0 z-10 border-b border-line bg-bg/90 px-[clamp(16px,3vw,40px)] pt-4 pb-3 backdrop-blur">
        <div className="-ml-1 mb-1 flex items-center">
          <Crumbs folders={folders} id={note.folder_id} onOpenFolder={onOpenFolder} />
        </div>
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
