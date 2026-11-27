import { useEffect, useRef, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import { X, Send, Save, Layers, Sparkles, Baby, Telescope, Lightbulb, Workflow, CircleHelp, Copy, ArrowLeft, NotebookPen } from 'lucide-react'
import { chooseDialog } from '../lib/dialogs'
import { useStore, toast } from '../lib/store'
import { api, streamCall, errorText } from '../lib/api'
import { useCommands } from '../lib/commands'
import { Markdown } from './Markdown'
import { VoiceButton } from './VoiceButton'
import { useReadAloud } from '../lib/voice'
import { Button, Dots, Textarea, cx, Kbd, usePresence } from './ui'

export interface ExplainCtx {
  cardId?: string | null
  noteId?: string | null
  selection?: string | null
  question?: string | null
  userAnswer?: string | null
  expectedAnswer?: string | null
  deckId?: string | null
}
export interface ExplainOpen {
  ctx: ExplainCtx
  title?: string
  mode?: string
  /** Run a custom action instead of the default explanation. */
  action?: { id: string; name: string }
}

interface Msg {
  role: 'user' | 'assistant'
  label?: string
  content: string
  streaming?: boolean
  error?: boolean
}

const QUICK = [
  { mode: 'simpler', label: 'Simpler', icon: Baby, cmd: 'ai.simpler' },
  { mode: 'deeper', label: 'Go deeper', icon: Telescope, cmd: 'ai.deeper' },
  { mode: 'example', label: 'Give an example', icon: Lightbulb, cmd: 'ai.example' },
  { mode: 'diagram', label: 'Show a diagram', icon: Workflow, cmd: 'ai.diagram' },
  { mode: 'why_wrong', label: 'Why is my answer wrong', icon: CircleHelp, cmd: 'ai.whyWrong' }
]

export function ExplainPanel() {
  const open = useStore((s) => s.explain)
  const { mounted, closing } = usePresence(!!open, 200)
  // Keep showing the last explanation while the panel slides away.
  const last = useRef(open)
  if (open) last.current = open
  if (!mounted || !last.current) return null
  return <Panel open={last.current} closing={closing} />
}

function Panel({ open, closing }: { open: ExplainOpen; closing: boolean }) {
  const close = () => useStore.getState().openExplain(null)
  const openGenCards = useStore((s) => s.openGenCards)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState('')
  const explanationId = useRef<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const runToken = useRef(0)

  // Voice mode reads each explanation out once it's finished.
  const lastAt = msgs.length - 1
  const last = msgs[lastAt]
  const lastDone = !!last && last.role === 'assistant' && !last.streaming && !last.error && !!last.content
  useReadAloud(lastDone ? last.content : null, `explain:${lastAt}`, lastDone)

  const append = (m: Msg) => setMsgs((cur) => [...cur, m])
  const updateLast = (patch: Partial<Msg>) => setMsgs((cur) => cur.map((m, i) => (i === cur.length - 1 ? { ...m, ...patch } : m)))

  const runMode = async (mode: string, label: string) => {
    if (!open) return
    const token = ++runToken.current
    setBusy(true)
    append({ role: 'assistant', label, content: '', streaming: true })
    try {
      const r = await streamCall(
        (streamId) => api.explain.run({ ctx: open.ctx, mode, explanationId: explanationId.current, streamId }),
        (full) => token === runToken.current && updateLast({ content: full })
      )
      if (token !== runToken.current) return
      explanationId.current = r.explanationId
      updateLast({ content: r.text, streaming: false })
    } catch (e) {
      if (token === runToken.current) updateLast({ content: errorText(e), streaming: false, error: true })
    } finally {
      if (token === runToken.current) setBusy(false)
    }
  }

  const runAction = async (action: { id: string; name: string }) => {
    if (!open) return
    const token = ++runToken.current
    setBusy(true)
    append({ role: 'assistant', label: action.name, content: '', streaming: true })
    try {
      const r = await streamCall(
        (streamId) => api.actions.run({ actionId: action.id, ctx: open.ctx, streamId }),
        (full) => token === runToken.current && updateLast({ content: full })
      )
      if (token !== runToken.current) return
      if (r.kind === 'cards') {
        updateLast({ content: `Made ${r.cards.length} card${r.cards.length === 1 ? '' : 's'}. Review them in the preview.`, streaming: false })
        useStore.getState().openPreview({ cards: r.cards, deckId: open.ctx.deckId ?? null, presetName: action.name })
      } else updateLast({ content: r.text, streaming: false })
    } catch (e) {
      if (token === runToken.current) updateLast({ content: errorText(e), streaming: false, error: true })
    } finally {
      if (token === runToken.current) setBusy(false)
    }
  }

  // Only run when asked: a plain "Explain" open waits for a button press.
  // Opening with a specific request (a quick mode or a custom action) runs it.
  useEffect(() => {
    explanationId.current = null
    setMsgs([])
    setInput('')
    if (!open) return
    if (open.action) void runAction(open.action)
    else if (open.mode && open.mode !== 'explain') void runMode(open.mode, QUICK.find((q) => q.mode === open.mode)?.label ?? 'Explain')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    if (busy) return
    setInput('')
    if (!explanationId.current) {
      append({ role: 'user', content: text })
      return void runMode(text, '')
    }
    append({ role: 'user', content: text })
    append({ role: 'assistant', content: '', streaming: true })
    setBusy(true)
    const token = ++runToken.current
    try {
      const r = await streamCall(
        (streamId) => api.explain.chat({ explanationId: explanationId.current!, message: text, streamId }),
        (full) => token === runToken.current && updateLast({ content: full })
      )
      updateLast({ content: r.text, streaming: false })
    } catch (e) {
      updateLast({ content: errorText(e), streaming: false, error: true })
    } finally {
      setBusy(false)
    }
  }

  const lastText = [...msgs].reverse().find((m) => m.role === 'assistant' && !m.streaming && !m.error)?.content ?? ''
  const save = async () => {
    if (!open?.ctx.cardId || !lastText) return
    await api.explain.saveToCard({ cardId: open.ctx.cardId, text: lastText })
    toast('Saved to the card’s explanation', 'good')
    useStore.getState().bump()
  }
  const makeCards = () => {
    if (!lastText) return
    openGenCards({ text: lastText, deckId: open?.ctx.deckId ?? null })
  }

  /** The whole conversation as a note: your questions, then each answer under its own heading. */
  const saveToNotes = async () => {
    const done = msgs.filter((m) => !m.streaming && !m.error && m.content.trim())
    if (!done.some((m) => m.role === 'assistant')) return
    const SAVED = 'Saved explanations'
    const folders = await api.folders.list({ kind: 'note' })
    const savedFolder = folders.find((f) => f.name === SAVED)
    const choice = await chooseDialog(
      'Save to notes',
      [
        { value: savedFolder?.id ?? 'new', label: SAVED },
        ...folders.filter((f) => f.id !== savedFolder?.id).map((f) => ({ value: f.id, label: f.name })),
        { value: 'none', label: 'No folder' }
      ],
      { label: 'Folder', confirmText: 'Save' }
    )
    if (choice === null) return
    try {
      const folderId = choice === 'new' ? (await api.folders.create({ name: SAVED, kind: 'note' })).id : choice === 'none' ? null : choice
      const title = open.title ?? 'Explanation'
      const context = open.ctx.selection ?? open.ctx.question
      const body = done
        .map((m) => (m.role === 'user' ? `**Q:** ${m.content.trim()}` : `${m.label ? `## ${m.label}\n\n` : ''}${m.content.trim()}`))
        .join('\n\n')
      const content = `${context ? `> ${context.trim().split('\n').slice(0, 6).join('\n> ')}\n\n` : ''}${body}\n`
      const note = await api.notes.create({ title, content, folder_id: folderId })
      toast('Saved to your notes', 'good', { label: 'Open', run: () => (close(), useStore.getState().go({ name: 'notes', id: note.id })) })
      useStore.getState().bump()
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }

  // Esc goes back to what you were doing.
  useEffect(() => {
    if (closing) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[data-modal]') && (e.preventDefault(), e.stopPropagation(), close())
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closing])

  useCommands(
    !closing
      ? {
          'ai.simpler': () => !busy && runMode('simpler', 'Simpler'),
          'ai.deeper': () => !busy && runMode('deeper', 'Go deeper'),
          'ai.example': () => !busy && runMode('example', 'Give an example'),
          'ai.diagram': () => !busy && runMode('diagram', 'Show a diagram'),
          'ai.whyWrong': () => !busy && runMode('why_wrong', 'Why is my answer wrong'),
          'ai.explain': () => !busy && runMode('explain', 'Explain'),
          'ai.saveExplanation': open.ctx.cardId ? save : null
        }
      : {},
    [open, closing, busy, lastText]
  )

  return (
    <aside className={cx('fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-line bg-bg shadow-2xl sm:w-[460px] sm:rounded-l-2xl', closing ? 'slide-out-right pointer-events-none' : 'slide-in-right')}>
      <div className="drag flex items-center justify-between gap-2 px-5 pt-5 pb-3">
        <Button variant="ghost" size="sm" onClick={close} className="no-drag -ml-2 shrink-0" title="Back (esc)">
          <ArrowLeft className="size-4" /> Back
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[0.75rem] font-semibold text-accent">
            <Sparkles className="size-3.5" /> {open.action ? open.action.name : 'Explain'}
          </div>
          <h2 className="truncate text-[1.1rem] font-semibold">{open.title ?? 'This card'}</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={close} aria-label="Close">
          <X className="size-5" />
        </Button>
      </div>

      <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-5 pb-4">
        {msgs.length === 0 && !open.action && (
          <div className="fade-in flex flex-col items-start gap-3 pt-2">
            {(open.ctx.selection || open.ctx.question) && (
              <blockquote className="line-clamp-6 border-l-2 border-line pl-3 text-[0.92rem] text-muted">{open.ctx.selection ?? open.ctx.question}</blockquote>
            )}
            <p className="text-[0.92rem] text-muted">Nothing is generated until you ask. Pick one of the options below, or type a question.</p>
            <Button variant="primary" onClick={() => runMode('explain', 'Explain')} kbd="ai.explain">
              Explain
            </Button>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="pop-in ml-10 rounded-xl rounded-br-sm bg-accent px-4 py-2.5 text-accent-ink">
              {m.content}
            </div>
          ) : (
            <div key={i} className={cx('pop-in rounded-xl border border-line bg-surface p-4', m.error && 'border-bad/40 bg-bad-soft')}>
              {m.label && <div className="mb-2 text-[0.72rem] font-semibold text-muted">{m.label}</div>}
              {m.content ? <Markdown streaming={m.streaming}>{m.content}</Markdown> : <Dots />}
              {!m.streaming && !m.error && m.content && <VoiceButton text={m.content} voiceKey={`explain:${i}`} className="mt-2 -ml-2.5" />}
              {!m.streaming && !m.error && m.content && (
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(m.content)
                    toast('Copied', 'good')
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-[0.8rem] text-muted hover:text-ink"
                >
                  <Copy className="size-3.5" /> Copy
                </button>
              )}
            </div>
          )
        )}
      </div>

      <div className="border-t border-line bg-surface/60 px-4 pt-3 pb-4">
        {!open.action && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {QUICK.filter((q) => q.mode !== 'why_wrong' || open.ctx.userAnswer || open.ctx.cardId).map((q) => (
              <button
                key={q.mode}
                disabled={busy}
                onClick={() => runMode(q.mode, q.label)}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[0.82rem] font-semibold transition-[transform,background] duration-300 hover:bg-accent-soft active:scale-95 disabled:opacity-40"
                title={keyLabel(`⌥${QUICK.indexOf(q) + 1}`)}
              >
                <q.icon className="size-3.5" /> {q.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={explanationId.current ? 'Ask a follow-up…' : 'Ask about this card…'}
            className="max-h-36 min-h-10 resize-none"
          />
          <Button variant="primary" size="icon" onClick={send} disabled={busy || !input.trim()} aria-label="Send">
            <Send className="size-4" />
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {open.ctx.cardId && (
            <Button size="sm" variant="soft" onClick={save} disabled={!lastText}>
              Save to card
            </Button>
          )}
          <Button size="sm" variant="soft" onClick={saveToNotes} disabled={!lastText}>
            <NotebookPen className="size-4" /> Save to notes
          </Button>
          <Button size="sm" variant="soft" onClick={makeCards} disabled={!lastText}>
            Make cards from this
          </Button>
          <span className="desktop-only ml-auto hidden text-[0.75rem] text-muted sm:inline">
            <Kbd>{keyLabel("⌥1")}</Kbd>–<Kbd>{keyLabel("⌥5")}</Kbd> quick asks
          </span>
        </div>
      </div>
    </aside>
  )
}
