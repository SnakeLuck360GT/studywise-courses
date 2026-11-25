// The phone's side of talking to the desktop's sync server. Plain JSON over
// HTTP through a fetch-like function, so it runs in the phone app (native HTTP)
// and in tests (Node's fetch).

import type { Change, ChangePage, SyncTransport } from './engine'

export interface HttpResponse {
  status: number
  json(): Promise<unknown>
  bytes(): Promise<Uint8Array>
}
export type HttpFn = (req: { method: 'GET' | 'POST' | 'PUT'; url: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number }) => Promise<HttpResponse>

export const SYNC_PORT = 47821

/** "192.168.1.5", "192.168.1.5:47821" or "http://host:port/" → "http://host:port". */
export function baseUrl(address: string): string {
  let a = address.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`
  const u = new URL(a)
  if (!u.port) u.port = String(SYNC_PORT)
  return `${u.protocol}//${u.host}`
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export class SyncClient {
  constructor(
    readonly base: string,
    private readonly http: HttpFn,
    private token: string | null = null
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    let res: HttpResponse
    try {
      res = await this.http({
        method,
        url: this.base + path,
        headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs
      })
    } catch (e) {
      throw new SyncError(`Can’t reach your computer at ${this.base.replace(/^https?:\/\//, '')}. Check it’s on, Studywise is open with syncing turned on, and you’re on the same Wi‑Fi.`, 0)
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (res.status >= 400) throw new SyncError(data?.error ?? `The computer answered ${res.status}`, res.status)
    return data
  }

  hello(): Promise<{ app: string; name: string; id: string; pairing: boolean }> {
    return this.call('GET', '/hello', undefined, 6000)
  }

  async pair(code: string, deviceId: string, name: string, kind: 'phone' | 'computer' = 'phone'): Promise<{ token: string; desktopId: string; desktopName: string }> {
    const r = await this.call<{ token: string; desktopId: string; desktopName: string }>('POST', '/pair', { code, deviceId, name, kind }, 10_000)
    this.token = r.token
    return r
  }

  transport(): SyncTransport {
    return {
      push: (changes: Change[], done = true) => this.call('POST', '/push', { changes, done }, 120_000),
      pull: (since: number) => this.call<ChangePage>('POST', '/pull', { since }, 120_000)
    }
  }

  rpc(channel: string, input: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    // AI calls can take minutes.
    return this.call('POST', '/rpc', { channel, input }, 15 * 60_000)
  }

  events(since: number): Promise<{ events: { n: number; ev: unknown }[]; next: number }> {
    return this.call('GET', `/events?since=${since}`, undefined, 30_000)
  }

  async getFile(url: string): Promise<Uint8Array | null> {
    const res = await this.http({ method: 'GET', url: `${this.base}/file?u=${encodeURIComponent(url)}`, headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}, timeoutMs: 60_000 })
    return res.status === 200 ? res.bytes() : null
  }

  /** Which of these files the other computer doesn't have yet (pasted images by name, course files by id). */
  have(attachments: string[], courseFiles: string[]): Promise<{ attachments: string[]; courseFiles: string[] }> {
    return this.call('POST', '/have', { attachments, courseFiles }, 60_000)
  }

  /** A course file's bytes (a computer linked to another copies the slides and transcripts its courses were made from). */
  async getCourseFile(id: string): Promise<Uint8Array | null> {
    const res = await this.http({ method: 'GET', url: `${this.base}/course-file?id=${encodeURIComponent(id)}`, headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}, timeoutMs: 10 * 60_000 })
    return res.status === 200 ? res.bytes() : null
  }

  async putCourseFile(id: string, data: Uint8Array): Promise<boolean> {
    const res = await this.http({
      method: 'PUT',
      url: `${this.base}/course-file?id=${encodeURIComponent(id)}`,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ data: toBase64(data) }),
      timeoutMs: 10 * 60_000
    })
    return res.status === 200
  }

  /** Sent as base64 in JSON, which every HTTP layer (including Capacitor's native one) handles the same way. */
  async putFile(url: string, data: Uint8Array): Promise<boolean> {
    const res = await this.http({
      method: 'PUT',
      url: `${this.base}/file?u=${encodeURIComponent(url)}`,
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ data: toBase64(data) }),
      timeoutMs: 60_000
    })
    return res.status === 200
  }
}

function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}
