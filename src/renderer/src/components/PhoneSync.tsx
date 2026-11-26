import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Smartphone, Laptop, RefreshCw, Trash2, Wifi, WifiOff, CheckCircle2, AlertTriangle, Cloud, CloudOff, History } from 'lucide-react'
import type { CloudInfo, CloudStatus, LinkStatus, SyncStatus } from '@shared/types'
import type { PhoneSyncStatus } from '@shared/mobile'
import { api, errorText, onEvent } from '../lib/api'
import { mobile } from '../lib/platform'
import { toast, useStore } from '../lib/store'
import { confirmDialog } from '../lib/dialogs'
import { Button, Card, Field, Input, Pill, Toggle, Spinner, cx } from './ui'

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

// ---------------------------------------------------------------------------
// Desktop: phones and other computers syncing with this one, and this one
// linking to another computer. Every connection shows in one "Synced devices"
// list, the same way on both computers of a linked pair.

export function DesktopPhoneTab() {
  const [s, setS] = useState<SyncStatus | null>(null)
  const [link, setLink] = useState<LinkStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const known = useRef<number | null>(null)

  const load = () => api.sync.status().then(setS)
  useEffect(() => {
    void load()
    void api.sync.linkStatus().then(setLink)
    // A device pairing or syncing changes what's shown here.
    const off = onEvent((ev) => {
      if (ev.type === 'sync') void load()
      if (ev.type === 'link') setLink(ev.status)
    })
    const t = setInterval(load, 5000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])
  useEffect(() => {
    if (!s) return
    if (known.current !== null && s.devices.length > known.current) toast(`Paired with ${s.devices[s.devices.length - 1].name}`, 'good')
    known.current = s.devices.length
  }, [s?.devices.length])

  if (!s || !link) return null
  const setEnabled = async (on: boolean) => {
    setBusy(true)
    try {
      setS(await api.sync.setEnabled({ enabled: on }))
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  const addr = s.addresses.map((a) => `${a}:${s.port}`)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CloudCard />
      <Card className="flex flex-col gap-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Smartphone className="size-5" /> Sync with your phone or another computer
        </h3>
        <p className="text-[0.92rem] text-muted">
          The Studywise phone app (Android or iPhone) keeps its own copy of your decks, notes and courses, so you can study offline. When it can reach this computer it syncs both ways: progress, reviews and edits made on either side. AI features on the phone (Explain, marking, writing topics) run here, through your Claude login.
        </p>
        <p className="text-[0.92rem] text-muted">Another computer can link to this one the same way and gets everything, course files included, with no file to copy.</p>
        <Toggle checked={s.enabled} disabled={busy} onChange={setEnabled} label="Let paired phones and computers on this network sync" />
        {s.enabled && (
          <div className="rounded-lg bg-surface-2 px-4 py-3 text-[0.9rem]">
            {s.running ? (
              <>
                <div className="flex items-center gap-2 font-semibold">
                  <Wifi className="size-4 text-good" /> Ready on {s.name}
                </div>
                <div className="mt-1 text-muted">
                  Address: {addr.length ? addr.map((a) => <code key={a} className="mr-2 font-mono text-ink">{a}</code>) : 'no network connection found'}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-bad">
                <AlertTriangle className="size-4" /> {s.error ?? 'Not running'}
              </div>
            )}
          </div>
        )}
        <p className="text-[0.85rem] text-muted">
          The other device and this computer need to be on the same Wi‑Fi (or the same Tailscale network). The first time, Windows may ask whether Studywise can use the network: allow it on private networks.
        </p>
      </Card>

      <Card className="flex flex-col gap-4">
        <h3 className="text-lg font-semibold">Pair a device</h3>
        {!s.enabled || !s.running ? (
          <p className="text-[0.92rem] text-muted">Turn on syncing first.</p>
        ) : s.pairCode ? (
          <div className="flex flex-col gap-3">
            <p className="text-[0.92rem] text-muted">On a phone, open Settings → Sync. On another computer, open Settings → Devices → Link to another computer. Then enter:</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-surface-2 px-4 py-3">
                <div className="text-[0.8rem] text-muted">Computer address</div>
                <div className="mt-1 font-mono text-[1.05rem] font-semibold break-all">{addr[0] ?? '—'}</div>
                {addr.length > 1 && <div className="mt-1 text-[0.8rem] text-muted">or {addr.slice(1).join(', ')}</div>}
              </div>
              <div className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-3">
                <div className="text-[0.8rem] text-muted">Pairing code</div>
                <div className="tabular mt-1 font-mono text-[1.6rem] font-semibold tracking-[0.2em] text-accent">{s.pairCode}</div>
              </div>
            </div>
            <p className="text-[0.85rem] text-muted">The code works once, for 10 minutes.</p>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[0.92rem] text-muted">Get a one-time code to type on the phone or the other computer.</p>
            <Button variant="primary" onClick={async () => setS(await api.sync.pairCode())}>
              <Smartphone className="size-4" /> Pair a device
            </Button>
          </div>
        )}
      </Card>

      <SyncedDevices status={s} link={link} onStatus={setS} onLink={setLink} />
      {!link.linked && <LinkComputerCard onLinked={setLink} />}
    </div>
  )
}

/** One connection, drawn the same whichever side of it you're on. */
function DeviceRow({ kind, name, lines, busy, warn, actions }: { kind: 'phone' | 'computer'; name: string; lines: (string | false | null | undefined)[]; busy?: boolean; warn?: boolean; actions: ReactNode }) {
  const Icon = kind === 'computer' ? Laptop : Smartphone
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
        <Icon className="size-[18px]" />
        <span className={cx('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface', busy ? 'animate-pulse bg-accent' : warn ? 'bg-warn' : 'bg-good')} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="text-[0.82rem] text-muted">{lines.filter(Boolean).join(' · ')}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  )
}

function SyncedDevices({ status, link, onStatus, onLink }: { status: SyncStatus; link: LinkStatus; onStatus: (s: SyncStatus) => void; onLink: (s: LinkStatus) => void }) {
  const none = !link.linked && !status.devices.length
  return (
    <Card className="flex flex-col gap-3 lg:col-span-2">
      <h3 className="text-lg font-semibold">Synced devices</h3>
      {none ? (
        <p className="text-[0.92rem] text-muted">None yet. Pair a phone or computer above, or link this computer to another one below.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {link.linked && (
            <DeviceRow
              kind="computer"
              name={link.name ?? 'Computer'}
              busy={link.state === 'syncing'}
              warn={link.state === 'error'}
              lines={[
                'Linked from this computer',
                link.state === 'syncing' ? 'Syncing…' : `Synced ${timeAgo(link.lastSync)}`,
                link.pending > 0 && link.state !== 'syncing' && `${link.pending} ${link.pending === 1 ? 'change' : 'changes'} to send`,
                link.filesLeft > 0 && `${link.filesLeft} ${link.filesLeft === 1 ? 'file' : 'files'} still to copy`
              ]}
              actions={
                <>
                  <Button size="icon" variant="ghost" title="Sync now" aria-label={`Sync with ${link.name} now`} disabled={link.state === 'syncing'} onClick={async () => onLink(await api.sync.linkNow())}>
                    <RefreshCw className={cx('size-4', link.state === 'syncing' && 'animate-spin')} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Unlink"
                    aria-label={`Unlink from ${link.name}`}
                    onClick={async () => {
                      if (await confirmDialog(`Unlink from ${link.name}?`, 'Both computers keep everything they have, but changes stop going between them until you link again.', { confirmText: 'Unlink', danger: true }))
                        onLink(await api.sync.unlink())
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </>
              }
            />
          )}
          {status.devices.map((d) => (
            <DeviceRow
              key={d.id}
              kind={d.kind}
              name={d.name}
              lines={['Paired with this computer', `Synced ${timeAgo(d.lastSync)}`]}
              actions={
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Unpair ${d.name}`}
                  title="Unpair"
                  onClick={async () => {
                    if (await confirmDialog(`Unpair ${d.name}?`, 'It keeps its copy of your library but stops syncing until you pair it again.', { confirmText: 'Unpair', danger: true })) onStatus(await api.sync.unpair({ id: d.id }))
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              }
            />
          ))}
        </ul>
      )}
      {link.error && (
        <div className="flex items-start gap-2 text-[0.9rem] text-warn">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {link.error}
        </div>
      )}
      {!none && (
        <p className="text-[0.85rem] text-muted">
          Devices sync in the background while Studywise is open on both: a few seconds after a change, and every minute. Settings, prompts and API keys stay on each device.
          {link.linked && status.devices.length > 0 && ` Devices paired with this computer sync through it to ${link.name} too.`}
        </p>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Desktop: link this computer to another one (it pairs like a phone does).

function LinkComputerCard({ onLinked }: { onLinked: (s: LinkStatus) => void }) {
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [linking, setLinking] = useState(false)

  const link = async () => {
    setLinking(true)
    try {
      const r = await api.sync.link({ address: address.trim(), code: code.trim() })
      setCode('')
      onLinked(r)
      toast(`Linked with ${r.name}. Your libraries are merged and now stay in sync.`, 'good')
      useStore.getState().bump()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setLinking(false)
    }
  }

  return (
    <Card className="flex flex-col gap-4 lg:col-span-2">
      <h3 className="flex items-center gap-2 text-lg font-semibold">
        <Laptop className="size-5" /> Link to another computer
      </h3>
      <p className="text-[0.92rem] text-muted">
        Bring your courses, decks, notes and progress over from another computer, and keep both in sync from then on, with no file to export or copy. Course files (slides, transcripts) and pasted images are copied across too. Nothing on either
        computer is replaced: the two libraries are merged, and after that a change on one shows up on the other.
      </p>
      <ol className="list-decimal space-y-1 pl-5 text-[0.92rem] text-muted">
        <li>On the other computer, open Studywise → Settings → Devices.</li>
        <li>Turn on syncing and press Pair a device.</li>
        <li>Type the address and code it shows here.</li>
      </ol>
      <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
        <Field label="Other computer’s address">
          <Input autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="192.168.1.20:47821" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="Pairing code">
          <Input
            inputMode="numeric"
            maxLength={6}
            placeholder="123456"
            className="tabular font-mono tracking-[0.2em]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && address.trim() && code.length === 6 && void link()}
          />
        </Field>
        <Button variant="primary" loading={linking} disabled={!address.trim() || code.length !== 6} onClick={link}>
          <Laptop className="size-4" /> Link
        </Button>
      </div>
      <p className="text-[0.85rem] text-muted">Both computers need to be on the same network (or the same Tailscale network), with the same version of Studywise. The first sync can take a minute for a big library.</p>
    </Card>
  )
}


// ---------------------------------------------------------------------------
// Desktop: syncing and backing up through the cloud (the marketplace server).

const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(bytes / 1e6, bytes ? 0.1 : 0).toFixed(1)} MB`)

export function useCloudStatus(): [CloudStatus | null, (s: CloudStatus) => void] {
  const [s, setS] = useState<CloudStatus | null>(null)
  useEffect(() => {
    void api.sync.cloudStatus().then(setS)
    return onEvent((ev) => {
      if (ev.type === 'cloud') setS(ev.status)
    })
  }, [])
  return [s, setS]
}

function CloudCard() {
  const [s, setS] = useCloudStatus()
  const [info, setInfo] = useState<CloudInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const go = useStore((st) => st.go)
  const loadInfo = () => void api.sync.cloudInfo().then(setInfo).catch(() => setInfo(null))
  useEffect(() => {
    if (s?.on && s.state === 'idle') loadInfo()
  }, [s?.on, s?.state, s?.lastSync])
  if (!s) return null
  const host = s.server?.replace(/^https?:\/\//, '') ?? 'the cloud'
  const set = async (on: boolean) => {
    setBusy(true)
    try {
      setS(await api.sync.cloudSet({ on }))
      toast(on ? `Your library is backed up to ${host} and syncs through it.` : 'Cloud sync is off. This computer keeps everything; the cloud keeps its copy too.', 'good')
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!(await confirmDialog(`Delete your copy on ${host}?`, 'Your library, its files and the daily backups go from the cloud. Every device keeps its own copy, but they stop syncing through the cloud.', { confirmText: 'Delete cloud copy', danger: true }))) return
    try {
      setS(await api.sync.cloudDelete())
      setInfo(null)
      toast('Deleted from the cloud', 'good')
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const used = info ? info.usage.data + info.usage.files : 0
  return (
    <Card className="flex flex-col gap-4 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Cloud className="size-5" /> Cloud sync & backup
        </h3>
        {s.on && (
          <div className="flex items-center gap-2 text-[0.9rem]">
            {s.state === 'syncing' ? (
              <Pill tone="accent">
                <Spinner className="mr-1.5 size-3" /> Syncing…
              </Pill>
            ) : s.state === 'error' ? (
              <Pill tone="warn">
                <CloudOff className="mr-1 size-3.5" /> Not synced
              </Pill>
            ) : (
              <Pill tone="good">
                <CheckCircle2 className="mr-1 size-3.5" /> Synced {timeAgo(s.lastSync)}
              </Pill>
            )}
            <Button size="icon" variant="ghost" title="Sync now" aria-label="Sync with the cloud now" disabled={s.state === 'syncing'} onClick={async () => setS(await api.sync.cloudNow())}>
              <RefreshCw className={cx('size-4', s.state === 'syncing' && 'animate-spin')} />
            </Button>
          </div>
        )}
      </div>
      <p className="text-[0.92rem] text-muted">
        Keep a copy of your whole library (courses, decks, notes, progress, and the slides and transcripts your courses are made from) on {s.ready ? host : 'your marketplace server'}, and sync your computers and phone through it. They don’t need to be on the same Wi‑Fi or switched on at the same time, and nothing is lost if a device is. A
        new computer or phone gets everything by turning this on there.
      </p>
      {!s.ready ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-4 py-3 text-[0.9rem]">
          <span className="min-w-0 flex-1 text-muted">Cloud sync uses your marketplace account. Connect to it first.</span>
          <Button size="sm" onClick={() => go({ name: 'settings', tab: 'market' })}>
            Settings → Marketplace
          </Button>
        </div>
      ) : (
        <Toggle checked={s.on === true} disabled={busy} onChange={(on) => void set(on)} label={busy ? (s.on ? 'Turning off…' : 'Sending your library up… (the first time can take a few minutes)') : `Sync and back up through ${host}${s.user ? ` as ${s.user}` : ''}`} />
      )}
      {s.on && (
        <>
          {s.error && (
            <div className="flex items-start gap-2 text-[0.9rem] text-warn">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {s.error}
            </div>
          )}
          {(s.pending > 0 || s.filesLeft > 0) && s.state !== 'syncing' && (
            <p className="text-[0.88rem] text-muted">
              {[s.pending > 0 && `${s.pending} ${s.pending === 1 ? 'change' : 'changes'} to send`, s.filesLeft > 0 && `${s.filesLeft} ${s.filesLeft === 1 ? 'file' : 'files'} still to copy`].filter(Boolean).join(' · ')}
            </p>
          )}
          {info && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-line px-4 py-3">
                <div className="flex items-baseline justify-between text-[0.9rem]">
                  <span className="font-semibold">Space used</span>
                  <span className="text-muted">
                    {gb(used)} of {gb(info.quota)}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2">
                  <div className={cx('h-full rounded-full', used / info.quota > 0.9 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, Math.max(1, (used / info.quota) * 100))}%` }} />
                </div>
                <div className="mt-2 text-[0.82rem] text-muted">
                  {info.rows.toLocaleString()} items · {gb(info.usage.files)} of files
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[0.82rem] text-muted">
                  <History className="size-3.5" /> {info.snapshots.length ? `Daily backups for the last ${info.snapshots.length} day${info.snapshots.length === 1 ? '' : 's'} (kept 14 days)` : 'A daily backup is kept for 14 days, from tomorrow.'}
                </div>
              </div>
              <div className="rounded-xl border border-line px-4 py-3">
                <div className="mb-1 text-[0.9rem] font-semibold">Syncing through the cloud</div>
                <ul className="flex flex-col gap-1.5">
                  {info.devices.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 text-[0.88rem]">
                      {d.kind === 'phone' ? <Smartphone className="size-4 text-muted" /> : <Laptop className="size-4 text-muted" />}
                      <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      <span className="text-muted">{timeAgo(d.lastSync)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <p className="text-[0.85rem] text-muted">
            On your phone, open Settings → Sync and choose <b>Sync through the cloud</b>. Pairing it with this computer below is still how its AI features (Explain, marking answers) reach your Claude login. Settings, prompts and API keys stay on each device.
          </p>
          <div>
            <Button size="sm" variant="ghost" className="text-bad" onClick={() => void remove()}>
              <Trash2 className="size-4" /> Delete my cloud copy…
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

/** Asked once, when the marketplace is connected and cloud sync hasn't been decided: turn it on? */
export async function offerCloudSync(): Promise<void> {
  const s = await api.sync.cloudStatus().catch(() => null)
  if (!s || s.on !== null || !s.ready) return
  const host = s.server?.replace(/^https?:\/\//, '') ?? 'the cloud'
  const yes = await confirmDialog(
    `Back up and sync through ${host}?`,
    `Studywise can keep a copy of your whole library on ${host} (your marketplace account) and sync your computers and phone through it, so they don’t need the same Wi‑Fi and nothing is lost if a device is. Turn it off any time in Settings → Devices.`,
    { confirmText: 'Turn on' }
  )
  try {
    await api.sync.cloudSet({ on: yes })
    if (yes) toast(`Your library is backed up to ${host} and syncs through it.`, 'good')
  } catch (e) {
    toast(errorText(e), 'bad')
  }
}

// ---------------------------------------------------------------------------
// Phone: pair with a computer and see how syncing is going.

export function usePhoneSync(): PhoneSyncStatus | null {
  const [s, setS] = useState<PhoneSyncStatus | null>(null)
  useEffect(() => {
    void mobile().sync.status().then(setS)
    return mobile().sync.onStatus(setS)
  }, [])
  return s
}

/** Phone: sync through the cloud (with the computer's account, or an address and key typed in). */
function PhoneCloudCard({ s }: { s: PhoneSyncStatus }) {
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const use = async (input?: { url: string; key: string }) => {
    setBusy(true)
    try {
      await mobile().sync.useCloud(input)
      toast('Syncing through the cloud', 'good')
      useStore.getState().bump()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }
  if (s.cloud.on)
    return (
      <Card className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Cloud className="size-5" /> Syncing through the cloud
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-[0.92rem]">
          {s.state === 'syncing' ? (
            <Pill tone="accent">
              <Spinner className="mr-1.5 size-3" /> Syncing…
            </Pill>
          ) : s.error ? (
            <Pill tone="warn">
              <CloudOff className="mr-1 size-3.5" /> Not synced
            </Pill>
          ) : (
            <Pill tone="good">
              <CheckCircle2 className="mr-1 size-3.5" /> Synced {timeAgo(s.cloud.lastSync)}
            </Pill>
          )}
        </div>
        {s.pending > 0 && <p className="text-[0.9rem] text-muted">{s.pending} change{s.pending === 1 ? '' : 's'} waiting to sync.</p>}
        {s.error && <p className="text-[0.88rem] text-muted">{s.error}</p>}
        <div className="text-[0.85rem] text-muted">
          Server <code className="font-mono">{s.cloud.server?.replace(/^https?:\/\//, '')}</code>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={s.state === 'syncing'}
            onClick={async () => {
              const r = await mobile().sync.now()
              if (r.error) toast(r.error, 'bad')
              else toast('Synced', 'good')
            }}
          >
            <RefreshCw className="size-4" /> Sync now
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              if (await confirmDialog('Stop syncing through the cloud?', s.paired ? 'Your library stays on the phone, and syncs with your computer over Wi‑Fi again.' : 'Your library stays on the phone but stops syncing.', { confirmText: 'Stop', danger: true })) await mobile().sync.stopCloud()
            }}
          >
            Stop using the cloud
          </Button>
        </div>
        <p className="text-[0.85rem] text-muted">Your changes go up whenever you’re online, from anywhere, and come down to your computers. Studying works offline as always.</p>
      </Card>
    )
  return (
    <Card className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-lg font-semibold">
        <Cloud className="size-5" /> Sync through the cloud
      </h3>
      <p className="text-[0.9rem] text-muted">Sync from anywhere, not just on the same Wi‑Fi as your computer, with your library backed up on your marketplace server. Your computer needs cloud sync on too (Settings → Devices there).</p>
      {s.paired && (
        <Button variant="primary" loading={busy && !manual} onClick={() => void use()}>
          <Cloud className="size-4" /> Use the same cloud as {s.desktopName ?? 'my computer'}
        </Button>
      )}
      {manual || !s.paired ? (
        <div className="flex flex-col gap-3">
          <Field label="Server address">
            <Input inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="courses.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="API key" hint="Make one on the server’s site: Account → API keys.">
            <Input autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="swm_…" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Button variant={s.paired ? 'ghost' : 'primary'} loading={busy && manual} disabled={!url.trim() || !key.trim()} onClick={() => (setManual(true), void use({ url, key }))}>
            Sync through this server
          </Button>
        </div>
      ) : (
        <button className="self-start text-[0.85rem] text-muted underline" onClick={() => setManual(true)}>
          Type an address and key instead
        </button>
      )}
    </Card>
  )
}

export function MobileSyncTab() {
  const s = usePhoneSync()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [pairing, setPairing] = useState(false)
  if (!s) return null

  const pair = async () => {
    setPairing(true)
    try {
      const r = await mobile().sync.pair({ address: address.trim(), code: code.trim() })
      toast(`Paired with ${r.desktopName}`, 'good')
      useStore.getState().bump()
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setPairing(false)
    }
  }

  if (!s.paired)
    return (
      <div className="flex flex-col gap-4">
      <PhoneCloudCard s={s} />
      <Card className="flex flex-col gap-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Laptop className="size-5" /> {s.cloud.on ? 'Pair with your computer for AI' : 'Connect to your computer'}
        </h3>
        {s.cloud.on && <p className="text-[0.9rem] text-muted">Your library syncs through the cloud. Pairing with your computer lets AI features (Explain, marking written answers, writing topics) run there, through your Claude login, when you’re on the same Wi‑Fi.</p>}
        <ol className="list-decimal space-y-1 pl-5 text-[0.92rem] text-muted">
          <li>On your computer, open Studywise → Settings → Devices.</li>
          <li>Turn on syncing and press Pair a device.</li>
          <li>Type the address and code it shows.</li>
        </ol>
        <Field label="Computer address">
          <Input inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="192.168.1.20:47821" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="Pairing code">
          <Input inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="tabular font-mono tracking-[0.2em]" />
        </Field>
        <Button variant="primary" loading={pairing} disabled={!address.trim() || code.length !== 6} onClick={pair}>
          Pair
        </Button>
        <p className="text-[0.85rem] text-muted">Your phone and computer need to be on the same Wi‑Fi. After pairing, your library copies to the phone and you can study offline; changes sync whenever the computer is reachable.</p>
      </Card>
      </div>
    )

  return (
    <div className="flex flex-col gap-4">
      <PhoneCloudCard s={s} />
      <Card className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Laptop className="size-5" /> {s.desktopName ?? 'Your computer'}
        </h3>
        {s.cloud.on && <p className="text-[0.88rem] text-muted">Paired for AI features. Your library syncs through the cloud.</p>}
        <div className="flex flex-wrap items-center gap-2 text-[0.92rem]">
          {s.state === 'syncing' ? (
            <Pill tone="accent">
              <Spinner className="mr-1.5 size-3" /> Syncing…
            </Pill>
          ) : s.online ? (
            <Pill tone="good">
              <CheckCircle2 className="mr-1 size-3.5" /> Connected
            </Pill>
          ) : (
            <Pill tone="warn">
              <WifiOff className="mr-1 size-3.5" /> Can’t reach it
            </Pill>
          )}
          {!s.cloud.on && <span className="text-muted">Last synced {timeAgo(s.lastSync)}</span>}
        </div>
        {!s.cloud.on && s.pending > 0 && <p className="text-[0.9rem] text-muted">{s.pending} change{s.pending === 1 ? '' : 's'} waiting to sync.</p>}
        {!s.cloud.on && s.error && !s.online && <p className="text-[0.88rem] text-muted">{s.error}</p>}
        <div className="text-[0.85rem] text-muted">
          Address <code className="font-mono">{s.address}</code>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={s.state === 'syncing'}
            onClick={async () => {
              const r = await mobile().sync.now()
              if (r.error) toast(r.error, 'bad')
              else toast('Synced', 'good')
            }}
          >
            <RefreshCw className="size-4" /> Sync now
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              if (await confirmDialog('Unpair this phone?', 'Your library stays on the phone. To sync again, pair with a new code from the computer.', { confirmText: 'Unpair', danger: true })) await mobile().sync.unpair()
            }}
          >
            Unpair
          </Button>
        </div>
      </Card>
      <Card className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">How it works</h3>
        <p className="text-[0.9rem] text-muted">
          Studying, reviews, notes and edits work offline and sync both ways whenever your computer is reachable: when the app opens, every minute while it’s open, and after you change something. If the same thing was changed on both, the later change wins. AI features (Explain, marking written answers, writing topics, generating cards) run on your computer, so they need it to be on.
        </p>
      </Card>
    </div>
  )
}
