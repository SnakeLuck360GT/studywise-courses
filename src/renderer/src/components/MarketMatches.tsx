import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { Check, Download, Sparkles, Users } from 'lucide-react'
import type { MarketCopy, MarketMatch } from '@shared/market'
import { modelLabel } from '@shared/market'
import { copyText, marketCopies, matchPercent, modelsText, weekSummary } from '../lib/market'
import { Button, Modal, Pill } from './ui'

// Before planning a week: someone has already published a week made from the
// same slides. Use theirs (no tokens), plan it yourself anyway, or stop.

type Answer = { use: string; mine: boolean; courseId: string } | 'plan' | null
interface Ask {
  label: string
  matches: MarketMatch[]
  /** About to plan it (with its files), or just added it. */
  planning: boolean
  resolve: (a: Answer) => void
}

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }))

/** Resolves to the published week to use, 'plan' to plan it yourself, or null to do neither. */
export function askAboutMatches(label: string, matches: MarketMatch[], opts: { planning?: boolean } = {}): Promise<Answer> {
  return new Promise((resolve) => useAsk.setState({ ask: { label, matches, planning: opts.planning ?? true, resolve } }))
}

export function MarketMatchesHost() {
  const ask = useAsk((s) => s.ask)
  // Which of them you already have here (added before, or published from here).
  const [copies, setCopies] = useState<Record<string, MarketCopy>>({})
  useEffect(() => {
    if (ask) void marketCopies().then(setCopies)
  }, [ask])
  const done = (a: Answer) => {
    ask?.resolve(a)
    useAsk.setState({ ask: null })
  }
  return (
    <Modal
      open={!!ask}
      onClose={() => done(null)}
      title={ask ? `Someone has already made ${ask.label}` : ''}
      footer={
        <>
          {ask?.planning !== false && (
            <Button variant="ghost" onClick={() => done(null)}>
              Cancel
            </Button>
          )}
          <Button onClick={() => done('plan')}>
            <Sparkles className="size-4" /> {ask?.planning === false ? 'I’ll make it myself' : 'Plan it myself anyway'}
          </Button>
        </>
      }
    >
      {ask && (
        <div className="flex flex-col gap-3">
          <p className="text-[0.92rem] text-muted">
            {ask.matches.some((m) => m.score >= 0.35 || m.sameFiles)
              ? `${ask.matches.length === 1 ? 'A week on the marketplace was' : `${ask.matches.length} weeks on the marketplace were`} made from the same material.`
              : `${ask.matches.length === 1 ? 'Someone has' : 'People have'} published ${ask.label} of what looks like the same course.`}{' '}
            Adding one costs no tokens; planning and writing it yourself does.
          </p>
          {ask.matches.map((m) => (
            <div key={m.week.id} className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {m.course.name} · {m.week.label}
                  </div>
                  <div className="flex items-center gap-1.5 text-[0.85rem] text-muted">
                    <Users className="size-3.5" /> {m.week.author}
                    {m.week.mine && ' (you)'} · {m.week.downloads} download{m.week.downloads === 1 ? '' : 's'}
                  </div>
                </div>
                <Pill tone={m.score >= 0.7 || m.sameFiles ? 'good' : 'accent'}>
                  {m.sameFiles ? `${m.sameFiles} same file${m.sameFiles === 1 ? '' : 's'}` : m.score >= 0.35 ? `${matchPercent(m)} the same` : 'Same course and week'}
                </Pill>
              </div>
              {copies[m.week.id] && (
                <div className="flex items-center gap-1.5 text-[0.85rem] text-good">
                  <Check className="size-3.5" /> You already have it: {copyText(copies[m.week.id])}
                </div>
              )}
              <div className="text-[0.88rem] text-muted">{weekSummary(m.week)}</div>
              <div className="text-[0.85rem]">
                <span className="text-muted">Written with </span>
                {modelsText(m.week.writtenWith)}
                {m.week.plannedWith && <span className="text-muted"> · planned with {modelLabel(m.week.plannedWith)}</span>}
              </div>
              <div className="text-[0.85rem] text-muted">{m.week.topics.map((t) => t.title).join(' · ')}</div>
              <div>
                <Button variant="primary" size="sm" onClick={() => done({ use: m.week.id, mine: m.week.mine, courseId: m.week.courseId })}>
                  <Download className="size-4" /> Use this week
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
