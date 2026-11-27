// What writing will take of your Claude plan's 5-hour limit: sections to
// write times what a section has taken you before (main/services/usageEstimate).

import { useEffect, useState } from 'react'
import { usageText, type UsageRate } from '@shared/market'
import type { Topic } from '@shared/course'
import { api } from './api'
import { useStore } from './store'

let cached: Promise<UsageRate | null> | null = null
let cachedAt = -1

/** The rate, fetched again when the library changes (a topic finishing writing teaches it more). */
export function usageRate(version: number): Promise<UsageRate | null> {
  if (!cached || cachedAt !== version) {
    cachedAt = version
    cached = api.market.usageRate().catch(() => null)
  }
  return cached
}

export function useUsageRate(): UsageRate | null {
  const version = useStore((s) => s.version)
  const [rate, setRate] = useState<UsageRate | null>(null)
  useEffect(() => {
    let live = true
    void usageRate(version).then((r) => live && setRate(r))
    return () => {
      live = false
    }
  }, [version])
  return rate
}

/** Sections a topic's plan has (at least one). */
export const topicSections = (t: Pick<Topic, 'plan'>) => Math.max(1, t.plan.sections?.length ?? 0)

/** "about 6% of your 5-hour limit" for this many sections, or null without a limit (Ollama). */
export function estimateText(sections: number, rate: UsageRate | null, short = false): string | null {
  if (!rate || sections <= 0) return null
  const text = usageText(sections * rate.perSection)
  return short ? text.replace('your 5-hour limit', '5h limit') : text
}

/** Said under an estimate until your own topics have been measured. */
export const guessNote = (rate: UsageRate | null) => (rate && !rate.measured ? ' (a rough guess until Studywise has measured a few of your topics)' : '')
