import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Smartphone, Laptop, RefreshCw, Trash2, Wifi, WifiOff, CheckCircle2, AlertTriangle } from 'lucide-react'
import type { LinkStatus, SyncStatus } from '@shared/types'
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
// Phone: pair with a computer and see how syncing is going.

export function usePhoneSync(): PhoneSyncStatus | null {
  const [s, setS] = useState<PhoneSyncStatus | null>(null)
  useEffect(() => {
    void mobile().sync.status().then(setS)
    return mobile().sync.onStatus(setS)
  }, [])
  return s
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
      <Card className="flex flex-col gap-4">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Laptop className="size-5" /> Connect to your computer
        </h3>
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
    )

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Laptop className="size-5" /> {s.desktopName ?? 'Your computer'}
        </h3>
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
          <span className="text-muted">Last synced {timeAgo(s.lastSync)}</span>
        </div>
        {s.pending > 0 && <p className="text-[0.9rem] text-muted">{s.pending} change{s.pending === 1 ? '' : 's'} waiting to sync.</p>}
        {s.error && !s.online && <p className="text-[0.88rem] text-muted">{s.error}</p>}
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
