import { useEffect, useState } from 'react'
import { Check, Scissors } from 'lucide-react'
import { CARD_CUTS, CARD_CUT_INFO, type CardCut } from '@shared/course'
import { api, errorText } from '../lib/api'
import { toast, useStore } from '../lib/store'
import { Markdown } from './Markdown'
import { Button, Dots, Modal, cx } from './ui'

type Suggestion = Awaited<ReturnType<typeof api.courses.suggestTrim>>['remove'][number]

/**
 * Trim a week's (or a topic's) recall cards: Claude suggests the ones that
 * aren't worth keeping for the exam (only the card text is sent), and you pick
 * which to delete. Nothing goes until you confirm.
 *
 * With `cut` (Cut down flashcards), you first pick how far to cut: a little,
 * to the key content, or to the essentials, and Claude suggests that many more.
 * `cards` is how many there are, to show roughly how many each level keeps.
 */
export function TrimCardsModal({
  weekId,
  topicId,
  courseId,
  title,
  cut: cutting = false,
  cards = 0,
  onClose
}: {
  weekId?: string
  topicId?: string
  courseId?: string
  title: string
  cut?: boolean
  cards?: number
  onClose: () => void
}) {
  const [result, setResult] = useState<{ total: number; remove: Suggestion[] } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Cutting down: how far, picked before anything is sent.
  const [level, setLevel] = useState<CardCut>('medium')
  const [cut, setCut] = useState<CardCut | null>(null)
  const choosing = cutting && !cut

  useEffect(() => {
    if (choosing) return
    let alive = true
    const c = cut ?? undefined
    api.courses
      .suggestTrim(courseId ? { courseId, cut: c } : { weekId: weekId!, topicId, cut: c })
      .then((r) => {
        if (!alive) return
        setResult(r)
        setPicked(new Set(r.remove.map((s) => s.cardId)))
      })
      .catch((e) => alive && setFailed(errorText(e)))
    return () => {
      alive = false
    }
  }, [weekId, topicId, courseId, choosing, cut])

  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const remove = async () => {
    setBusy(true)
    try {
      const n = await api.courses.removeCards({ cardIds: [...picked] })
      toast(`Removed ${n} card${n === 1 ? '' : 's'}`, 'good')
      useStore.getState().bump()
      onClose()
    } catch (e) {
      toast(errorText(e), 'bad')
      setBusy(false)
    }
  }

  const suggestions = result?.remove ?? []
  return (
    <Modal
      open
      onClose={onClose}
      title={cutting ? `Cut down flashcards: ${title}` : `Trim recall cards: ${title}`}
      wide
      footer={
        choosing ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setCut(level)}>
              <Scissors className="size-4" /> Suggest cards to cut
            </Button>
          </>
        ) : result && suggestions.length ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Keep them all
            </Button>
            <Button variant="danger" loading={busy} disabled={!picked.size} onClick={remove}>
              <Scissors className="size-4" /> Remove {picked.size} card{picked.size === 1 ? '' : 's'}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {choosing ? (
        <div className="flex flex-col gap-3">
          <p className="text-[0.92rem] text-muted">
            Keep only the key content. Claude reads the card text (no slides, so it’s cheap) and suggests which to cut; you see the list and untick any you want to keep before anything goes.
          </p>
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="How far to cut">
            {CARD_CUTS.map((l) => {
              const on = level === l
              return (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setLevel(l)}
                  className={cx('flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors', on ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-[color-mix(in_oklab,var(--ink)_22%,transparent)]')}
                >
                  <span className={cx('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border', on ? 'border-accent bg-accent text-accent-ink' : 'border-line')}>{on && <Check className="size-3.5" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="font-semibold">{CARD_CUT_INFO[l].label}</span>
                    {cards > 0 && <span className="ml-1.5 text-[0.8rem] text-muted">· keeps about {Math.max(1, Math.round(cards * CARD_CUT_INFO[l].keep))} of {cards}</span>}
                    <span className="block text-[0.86rem] text-muted">{CARD_CUT_INFO[l].about}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : failed ? (
        <p className="text-bad">{failed}</p>
      ) : !result ? (
        <div className="flex flex-col gap-2 py-6 text-center text-muted">
          <div className="flex items-center justify-center gap-2">
            {cut ? 'Working out the key content' : 'Checking which cards are worth keeping'} <Dots />
          </div>
          <p className="text-[0.85rem]">Only the cards’ text is sent, no slides, so this is cheap{courseId ? '. A whole course takes a minute or so.' : '.'}</p>
        </div>
      ) : !suggestions.length ? (
        <p className="py-6 text-center text-muted">
          {cut ? `All ${result.total} card${result.total === 1 ? ' is' : 's are'} key content. Nothing to cut.` : `All ${result.total} card${result.total === 1 ? ' looks' : 's look'} worth keeping for the exam. Nothing to trim.`}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[0.92rem] text-muted">
            {cut
              ? `Cutting ${suggestions.length} of ${result.total} cards leaves ${result.total - suggestions.length}, the key content.`
              : `${suggestions.length} of ${result.total} cards aren’t pure content worth keeping.`}{' '}
            Untick any you want to keep. Removing a card also takes it out of its topic’s flashcards and your spaced review.
          </p>
          <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
            {suggestions.map((s) => {
              const on = picked.has(s.cardId)
              return (
                <button
                  key={s.cardId}
                  onClick={() => toggle(s.cardId)}
                  className={cx('flex items-start gap-3 rounded-xl border p-3 text-left transition-colors', on ? 'border-bad/40 bg-bad-soft/50' : 'border-line bg-surface opacity-70')}
                >
                  <span className={cx('mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border', on ? 'border-bad bg-bad text-white' : 'border-line')}>{on && <Check className="size-3.5" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.78rem] text-muted">
                      <span className="font-semibold">{s.topicTitle}</span>
                      {s.reason && <span>· {s.reason}</span>}
                    </span>
                    <Markdown className="font-semibold">{s.front}</Markdown>
                    <Markdown className="text-[0.9rem] text-muted">{s.back}</Markdown>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Modal>
  )
}
