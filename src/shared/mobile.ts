// What the phone app adds to the page (window.studywiseMobile), next to the
// usual window.studywise API. Absent in the desktop app.

export interface PhoneSyncStatus {
  paired: boolean
  desktopName: string | null
  /** host:port of the computer. */
  address: string | null
  lastSync: string | null
  state: 'idle' | 'syncing' | 'error'
  /** Whether the computer answered the last time we tried. */
  online: boolean
  error: string | null
  /** Local changes not sent yet. */
  pending: number
  /** Syncing through the cloud (the marketplace server) instead of with the computer; the computer is then only for AI. */
  cloud: { on: boolean; server: string | null; lastSync: string | null }
}

export interface MobileApi {
  platform: 'android' | 'ios' | 'web'
  sync: {
    status(): Promise<PhoneSyncStatus>
    /** Pair with a computer: its address (host or host:port) and the code it shows. */
    pair(input: { address: string; code: string }): Promise<PhoneSyncStatus>
    unpair(): Promise<PhoneSyncStatus>
    /** Sync now (also happens by itself). */
    now(): Promise<PhoneSyncStatus>
    /** Sync through the cloud: with the address and key given, or the ones the paired computer uses. */
    useCloud(input?: { url: string; key: string }): Promise<PhoneSyncStatus>
    /** Back to syncing with the computer over Wi‑Fi. */
    stopCloud(): Promise<PhoneSyncStatus>
    onStatus(cb: (s: PhoneSyncStatus) => void): () => void
  }
  /** Wipe the phone's copy of the library (it comes back on the next sync). */
  resetLibrary(): Promise<void>
  /** A studywise-file:// image → a URL an <img> can show (cached on the phone), or null. */
  fileUrl(url: string): Promise<string | null>
}
