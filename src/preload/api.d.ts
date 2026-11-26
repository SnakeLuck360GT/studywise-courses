import type { StudywiseApi } from '../main/ipc'
import type { JobInfo, ClaudeStatus, UsageLimits, LinkStatus, CloudStatus } from '../shared/types'
import type { UpdateStatus } from '../shared/update'

export type StudywiseEvent =
  | { type: 'ai:delta'; streamId: string; text: string }
  | { type: 'job'; job: JobInfo }
  | { type: 'job:delta'; jobId: string; text: string }
  | { type: 'menu'; action: string }
  | { type: 'open-files'; paths: string[] }
  | { type: 'claude:status'; status: ClaudeStatus }
  | { type: 'fullscreen'; on: boolean }
  | { type: 'usage'; usage: UsageLimits }
  | { type: 'update'; status: UpdateStatus }
  /** A phone or linked computer synced; `received` rows changed here. */
  | { type: 'sync'; received: number }
  /** The link to another computer changed state (syncing, synced, can't reach it). */
  | { type: 'link'; status: LinkStatus }
  /** Cloud sync changed state (syncing, synced, can't reach the server). */
  | { type: 'cloud'; status: CloudStatus }

declare global {
  interface Window {
    studywise: StudywiseApi & {
      on: (cb: (ev: StudywiseEvent) => void) => () => void
      pathForFile: (file: File) => string
    }
  }
}

export {}
