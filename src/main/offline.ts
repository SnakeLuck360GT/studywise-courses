import { getSetting } from './db/repo'
import { OFFLINE_MESSAGE, OFFLINE_SETTING } from '@shared/offline'

export const isOffline = (): boolean => getSetting<boolean>(OFFLINE_SETTING, false) === true

export class OfflineError extends Error {
  constructor() {
    super(OFFLINE_MESSAGE)
    this.name = 'OfflineError'
  }
}
