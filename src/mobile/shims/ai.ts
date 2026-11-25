// The phone's src/main/ai: AI runs on the computer (the phone forwards those
// requests), so anything that reaches this locally just says so.
import { isOffline, OfflineError } from '../../main/offline'

export class NeedsComputer extends Error {
  constructor() {
    super('That needs your computer. Connect to it in Settings → Sync.')
  }
}
export async function runAI(): Promise<never> {
  if (isOffline()) throw new OfflineError()
  throw new NeedsComputer()
}
export function renderPrompt(): never {
  throw new NeedsComputer()
}
export const friendlyError = (e: unknown): string => (e as Error)?.message ?? String(e)
export const isMock = () => false
export const aiQueue = { running: 0, waiting: 0, setLimit: () => {} }
