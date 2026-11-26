import { useEffect, useState } from 'react'
import { ExternalLink, Store } from 'lucide-react'
import { AUTO_PUBLISH_SETTING, type MarketStatus } from '@shared/market'
import { api, errorText } from '../lib/api'
import { toast } from '../lib/store'
import { confirmDialog } from '../lib/dialogs'
import { Button, Card, Field, Input, Pill, Toggle } from './ui'
import { offerCloudSync } from './PhoneSync'

/**
 * Connect to a marketplace: its address, and an API key made on its account
 * page. The key is stored encrypted and never comes back to the page.
 */
export function MarketSetup({ onConnected }: { onConnected?: () => void }) {
  const [status, setStatus] = useState<MarketStatus | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [user, setUser] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)

  useEffect(() => {
    void api.settings.all().then((s) => setAuto(s[AUTO_PUBLISH_SETTING] === true))
    api.market
      .status()
      .then((s) => {
        setStatus(s)
        setUrl(s.url)
        if (s.url && s.hasKey)
          api.market
            .test()
            .then((r) => setUser(r.user))
            .catch((e) => setError(errorText(e)))
      })
      // Shown rather than an empty card: usually the app needs a restart after an update.
      .catch((e) => {
        setStatus({ url: '', hasKey: false })
        setError(`${errorText(e)} Quit Studywise and open it again.`)
      })
  }, [])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.market.configure({ url, key: key.trim() || null })
      setUser(r.user)
      setKey('')
      setStatus(await api.market.status())
      toast(`Connected as ${r.user}`, 'good')
      onConnected?.()
      // The same account can back up and sync the library: offer it now (only if it hasn't been decided).
      void offerCloudSync()
    } catch (e) {
      setUser(null)
      setError(errorText(e))
      setStatus(await api.market.status())
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    await api.market.disconnect()
    setUser(null)
    setStatus(await api.market.status())
  }

  const setAutoPublish = async (on: boolean) => {
    if (
      on &&
      !(await confirmDialog(
        'Publish your weeks automatically?',
        'Each week you write topics in is published once they finish, with its slides and transcripts, and published again when you write more. Weeks you added from someone else are never published automatically. Weeks you wrote before turning this on aren’t published until you write in them again, or use Publish all my courses. Only turn this on if you’re allowed to share your course material.',
        { confirmText: 'Turn on' }
      ))
    )
      return
    setAuto(on)
    await api.settings.set({ key: AUTO_PUBLISH_SETTING, value: on })
  }

  const site = (() => {
    try {
      return url.trim() ? new URL(/^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).origin : null
    } catch {
      return null
    }
  })()

  if (!status) return null
  return (
    <Card className="flex flex-col gap-4">
      <h3 className="flex items-center gap-2 text-lg font-semibold">
        <Store className="size-5" /> Course marketplace
        {user && <Pill tone="good">Connected as {user}</Pill>}
      </h3>
      <p className="text-[0.92rem] text-muted">
        Browse weeks other people have made and add them without generating anything, publish your own, and get a warning before you plan a week someone has already made from the same slides. Make an account on the marketplace’s site, then make an API key on its account page.
      </p>
      <Field label="Marketplace address">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://courses.example.com" spellCheck={false} />
      </Field>
      <Field label="API key" hint={status.hasKey ? 'A key is saved. Paste a new one to replace it.' : site ? undefined : 'Made on the marketplace’s account page.'}>
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={status.hasKey ? '••••••••' : 'swm_…'} spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && void connect()} />
      </Field>
      {status.hasKey && (
        <div className="flex flex-col gap-1 rounded-lg bg-surface-2/60 px-3 py-2.5">
          <Toggle checked={auto} onChange={(v) => void setAutoPublish(v)} label="Publish my weeks automatically" />
          <div className="text-[0.84rem] text-muted">When a week’s topics finish writing, it’s published (or updated) on the marketplace. Weeks you added from someone else never are.</div>
        </div>
      )}
      {error && <div className="rounded-lg bg-bad-soft px-3 py-2 text-[0.88rem] text-bad">{error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={busy} disabled={!url.trim() || (!key.trim() && !status.hasKey)} onClick={connect}>
          {status.hasKey && !key.trim() ? 'Check connection' : 'Connect'}
        </Button>
        {site && site.startsWith('https://') && (
          <Button variant="ghost" onClick={() => void api.app.openExternal({ url: `${site}/account` })}>
            <ExternalLink className="size-4" /> Get a key
          </Button>
        )}
        {status.hasKey && (
          <Button variant="ghost" onClick={disconnect}>
            Forget key
          </Button>
        )}
      </div>
    </Card>
  )
}
