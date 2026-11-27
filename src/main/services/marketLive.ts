// Hearing from the marketplace straight away: the app keeps GET /api/events
// open (server-sent events), and when a week you asked or voted for is done,
// the window shows it in a card at once rather than at the next sync. When
// the connection is up (again), anything done meanwhile is offered too. If
// it can't connect, it tries again, waiting longer each time (up to a minute).

import { request as httpRequest, type ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { marketAuth } from './market'
import { readyRequests } from './marketTasks'
import type { WeekRequest } from '@shared/market'

let onReady: (requests: WeekRequest[]) => void = () => {}
let current: ClientRequest | null = null
let retry: ReturnType<typeof setTimeout> | null = null
let wait = 5_000
let stopped = true
/** Which account the open connection is for: a different one (a new key) connects again. */
let connectedAs = ''

const offer = (pushed?: WeekRequest) =>
  void readyRequests(pushed)
    .then((rs) => rs.length && onReady(rs))
    .catch((e) => console.warn('Checking for ready weeks failed:', (e as Error).message))

function again(): void {
  current = null
  if (stopped || retry) return
  retry = setTimeout(() => {
    retry = null
    connect()
  }, wait)
  wait = Math.min(wait * 2, 60_000)
}

/** One event: "event: request-done" and its JSON. */
function handle(block: string): void {
  let event = 'message'
  let data = ''
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  if (event !== 'request-done' || !data) return
  try {
    offer(JSON.parse(data) as WeekRequest)
  } catch {
    /* not JSON: ignore */
  }
}

function connect(): void {
  if (stopped || current) return
  const a = marketAuth()
  if (!a) return again()
  let url: URL
  try {
    url = new URL(`${a.url}/api/events`)
  } catch {
    return again()
  }
  connectedAs = `${a.url}|${a.key}`
  const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers: { authorization: `Bearer ${a.key}`, accept: 'text/event-stream', 'user-agent': 'Studywise' } }, (res) => {
    // An older marketplace without live events, or a key it doesn't take: try now and then.
    if (res.statusCode !== 200) {
      res.resume()
      wait = 60_000
      return again()
    }
    wait = 5_000
    // Anything done while not connected.
    offer()
    let buf = ''
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => {
      buf += chunk
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        handle(buf.slice(0, i))
        buf = buf.slice(i + 2)
      }
    })
    res.on('end', again)
    res.on('error', again)
  })
  // The server sends something every 25 seconds: nothing for 90 means the connection is gone.
  req.setTimeout(90_000, () => req.destroy(new Error('No word from the marketplace')))
  req.on('error', again)
  req.end()
  current = req
}

/** Start listening (at startup). `ready` gets the weeks to offer. */
export function startMarketLive(opts: { onReady: (requests: WeekRequest[]) => void }): void {
  onReady = opts.onReady
  stopped = false
  connect()
  // The marketplace's address or key changed (connected, disconnected, a new key): connect again.
  setInterval(() => {
    const a = marketAuth()
    const now = a ? `${a.url}|${a.key}` : ''
    if (now === connectedAs) return
    current?.destroy()
    current = null
    if (retry) clearTimeout(retry)
    retry = null
    wait = 5_000
    connectedAs = now
    if (now) connect()
  }, 10_000).unref()
}

export function stopMarketLive(): void {
  stopped = true
  current?.destroy()
  current = null
  if (retry) clearTimeout(retry)
  retry = null
}
