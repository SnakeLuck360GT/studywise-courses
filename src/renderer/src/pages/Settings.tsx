import { useEffect, useMemo, useRef, useState } from 'react'
import { keyLabel } from '@shared/keymap'
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { diffLines } from 'diff'
import {
  Terminal,
  RefreshCw,
  FolderOpen,
  CheckCircle2,
  XCircle,
  Play,
  Copy,
  Star,
  RotateCcw,
  History,
  Trash2,
  Upload,
  Download,
  Plus,
  Save,
  Sparkles,
  Cpu,
  Settings as Gear,
  Activity,
  ListChecks,
  Wand2,
  Info,
  Archive,
  Smartphone,
  Laptop,
  Store,
  WifiOff,
  Volume2
} from 'lucide-react'
import type { UpdateStatus } from '@shared/update'
import type { Preset, PresetVersion, CustomAction, ModelChoice, AiCall, Thresholds, AiProvider, OllamaModel } from '@shared/types'
import { ACTION_PLACEMENTS, DEFAULT_THRESHOLDS } from '@shared/types'
import { QUESTION_AMOUNTS, QUESTION_AMOUNT_INFO, isQuestionAmount, type QuestionAmount } from '@shared/course'
import { TASK_INFO, TASKS, MODEL_ALIASES, EFFORT_LEVELS, OLLAMA_EFFORT_LEVELS, type TaskId } from '@shared/tasks'
import { useStore, toast } from '../lib/store'
import { Jobs } from './Jobs'
import { api, onEvent, streamCall, errorText } from '../lib/api'
import { useCommands } from '../lib/commands'
import { confirmDialog, askText } from '../lib/dialogs'
import { Shell, PageTitle } from '../components/Shell'
import { Button, Card, Field, Input, Modal, Pill, Segmented, Select, Textarea, Toggle, cx, Kbd } from '../components/ui'
import { Markdown } from '../components/Markdown'
import { UsageBars } from '../components/UsageMeter'
import { OllamaModelOptions, useOllamaModels } from '../components/OllamaModels'
import { DesktopPhoneTab, MobileSyncTab } from '../components/PhoneSync'
import { MarketSetup } from '../components/MarketSetup'
import { IS_MOBILE, mobile } from '../lib/platform'
import { DEFAULT_VOICE_PROMPT, VOICE_MODELS, modelHasTags, type VoiceOption, type VoiceStatus } from '@shared/voice'
import { setVoiceStatus, speak, stopVoice, useSpeaking } from '../lib/voice'

const DESKTOP_TABS = [
  { id: 'general', label: 'General', icon: Gear },
  { id: 'claude', label: 'AI provider', icon: Terminal },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'prompts', label: 'Prompts', icon: Sparkles },
  { id: 'actions', label: 'Custom actions', icon: Wand2 },
  { id: 'usage', label: 'AI usage', icon: Activity },
  { id: 'voice', label: 'Voice', icon: Volume2 },
  { id: 'phone', label: 'Devices', icon: Smartphone },
  { id: 'market', label: 'Marketplace', icon: Store },
  { id: 'jobs', label: 'Jobs', icon: ListChecks }
] as const
// On the phone, AI is set up on the computer; what's left is the phone's own settings and syncing.
const MOBILE_TABS = [
  { id: 'general', label: 'General', icon: Gear },
  { id: 'sync', label: 'Sync', icon: Laptop },
  { id: 'jobs', label: 'Jobs', icon: ListChecks }
] as const
const TABS: readonly { id: string; label: string; icon: typeof Gear }[] = IS_MOBILE ? MOBILE_TABS : DESKTOP_TABS

export function Settings({ tab = 'general' }: { tab?: string }) {
  const go = useStore((s) => s.go)
  const cur = TABS.find((t) => t.id === tab) ? tab : 'general'
  const running = useStore((s) => s.jobs.filter((j) => j.status === 'running').length)
  useCommands({
    'go.nextDeck': () => {
      const i = TABS.findIndex((t) => t.id === cur)
      go({ name: 'settings', tab: TABS[(i + 1) % TABS.length].id })
    },
    'go.prevDeck': () => {
      const i = TABS.findIndex((t) => t.id === cur)
      go({ name: 'settings', tab: TABS[(i - 1 + TABS.length) % TABS.length].id })
    }
  }, [cur])
  return (
    <Shell wide>
      <PageTitle eyebrow={IS_MOBILE ? undefined : 'Studywise Courses'} title="Settings" />
      <div className="no-scrollbar -mx-4 mb-6 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => go({ name: 'settings', tab: t.id })}
            className={cx(
              'inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-[0.92rem] font-semibold transition-[background,color,transform] duration-300 active:scale-95',
              cur === t.id ? 'bg-ink text-bg' : 'bg-surface-2 text-muted hover:text-ink'
            )}
          >
            <t.icon className="size-4" /> {t.label}
            {t.id === 'jobs' && running > 0 && <span className="tabular inline-grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.68rem] leading-4 text-accent-ink">{running}</span>}
          </button>
        ))}
      </div>
      <div key={cur} className="page-in">
        {cur === 'general' && <General />}
        {cur === 'claude' && <ProviderTab />}
        {cur === 'models' && <ModelsTab />}
        {cur === 'prompts' && <PromptsTab />}
        {cur === 'actions' && <ActionsTab />}
        {cur === 'usage' && <UsageTab />}
        {cur === 'voice' && <VoiceTab />}
        {cur === 'phone' && <DesktopPhoneTab />}
        {cur === 'market' && (
          <div className="max-w-2xl">
            <MarketSetup />
          </div>
        )}
        {cur === 'sync' && <MobileSyncTab />}
        {cur === 'jobs' && <Jobs embedded />}
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------------------

/** Offline mode: study with no AI at all (per device, so it doesn't sync). */
function OfflineCard() {
  const offline = useStore((s) => s.offline)
  const setOffline = useStore((s) => s.setOffline)
  return (
    <Card className={cx('flex flex-col gap-3 lg:col-span-2', offline && 'ring-1 ring-warn/40')}>
      <div className="flex items-center gap-2">
        <WifiOff className={cx('size-5', offline ? 'text-warn' : 'text-muted')} />
        <h3 className="text-lg font-semibold">Offline mode</h3>
      </div>
      <Toggle checked={offline} onChange={(v) => setOffline(v)} label="Study without AI" />
      <p className="text-[0.88rem] text-muted">
        Nothing calls the AI, so it works with no internet, no Claude login and no computer nearby. Learn asks multiple choice, true or false, matching and fill-in-the-blank questions, using ones the AI made
        before or building them from your cards, and marks them on this device. Free-answer questions and a topic’s written answers are skipped, since only AI can mark them. A blank only counts when it matches exactly; press “I was right” when yours means the same.
        Explain, feedback, generating and writing topics come back when you turn it off. It’s set on each device separately.
      </p>
    </Card>
  )
}

function General() {
  const [s, setS] = useState<Record<string, unknown>>({})
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.app.info>> | null>(null)
  useEffect(() => {
    void api.settings.all().then(setS)
    void api.app.info().then(setInfo)
  }, [])
  const set = async (key: string, value: unknown) => {
    setS((cur) => ({ ...cur, [key]: value }))
    await api.settings.set({ key, value })
  }
  const th = (s.thresholds as Thresholds) ?? DEFAULT_THRESHOLDS
  const questions: QuestionAmount = isQuestionAmount(s['course.questions']) ? s['course.questions'] : 'usual'
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <OfflineCard />
      <Card className="flex flex-col gap-4">
        <h3 className="text-lg font-semibold">Appearance</h3>
        <Field label="Theme">
          <Segmented
            value={(s['ui.theme'] as string) ?? 'system'}
            onChange={(v) => {
              void set('ui.theme', v)
              document.documentElement.dataset.theme = v
              document.documentElement.classList.toggle('dark', v === 'dark' || (v === 'system' && matchMedia('(prefers-color-scheme: dark)').matches))
            }}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
          />
        </Field>
        <p className="desktop-only text-[0.85rem] text-muted">
          Text size: <Kbd>{keyLabel("⌘=")}</Kbd> <Kbd>{keyLabel("⌘-")}</Kbd> <Kbd>{keyLabel("⌘0")}</Kbd>. Cycle theme: <Kbd>{keyLabel("⇧⌘L")}</Kbd>.
        </p>
      </Card>
      <Card className="desktop-only flex flex-col gap-4">
        <h3 className="text-lg font-semibold">AI jobs</h3>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Parallel calls">
            <Input type="number" min={1} max={8} value={Number(s['ai.concurrency'] ?? 3)} onChange={(e) => set('ai.concurrency', Math.max(1, Math.min(8, Number(e.target.value) || 3)))} />
          </Field>
          <Field label="Timeout (s)">
            <Input type="number" min={30} max={900} value={Number(s['ai.timeoutSec'] ?? 120)} onChange={(e) => set('ai.timeoutSec', Math.max(30, Number(e.target.value) || 120))} />
          </Field>
          <Field label="Long jobs (s)">
            <Input type="number" min={120} max={7200} value={Number(s['ai.longTimeoutSec'] ?? 900)} onChange={(e) => set('ai.longTimeoutSec', Math.max(120, Number(e.target.value) || 900))} />
          </Field>
        </div>
      </Card>
      <Card className="desktop-only flex flex-col gap-4">
        <h3 className="text-lg font-semibold">Courses</h3>
        <Field label="Questions while learning a topic" hint={`${QUESTION_AMOUNT_INFO[questions].about} Quick revision and the other depths scale from their own usual amount. Applies to topics written (or written again) from now on.`}>
          <Segmented<QuestionAmount> value={questions} onChange={(v) => set('course.questions', v)} options={QUESTION_AMOUNTS.map((a) => ({ value: a, label: QUESTION_AMOUNT_INFO[a].label }))} />
        </Field>
      </Card>
      <Card className="flex flex-col gap-4">
        <h3 className="text-lg font-semibold">Spaced repetition</h3>
        <Segmented
          value={(s['review.scheduler'] as string) ?? 'studysmarter'}
          onChange={(v) => set('review.scheduler', v)}
          options={[
            { value: 'studysmarter', label: 'StudySmarter' },
            { value: 'adaptive', label: 'Difficulty-based' },
            { value: 'sm2', label: 'SM-2' }
          ]}
        />
        {!IS_MOBILE && <Toggle checked={s['anki.keepSchedule'] !== false} onChange={(v) => set('anki.keepSchedule', v)} label="Keep review progress when importing Anki decks" />}
        <p className="text-[0.88rem] text-muted">
          {((s['review.scheduler'] as string) ?? 'studysmarter') === 'studysmarter'
            ? 'Red, yellow and green, like StudySmarter. A new card is learnt after two greens (the first makes it light green); yellow sends it to the back of the pile and red brings it back three cards later. A learnt card comes back after 1 day, then 3, 7, 14, 30, 60… days, a step further each time you get it green. Yellow or red on a review means learning it again, and the gaps start over at 1 day.'
            : ((s['review.scheduler'] as string) ?? 'studysmarter') === 'adaptive'
            ? 'Cards start at difficulty 0.60 with three 1-day steps, then intervals grow fast (≈3, 8, 20, 115, 280+ days). A card comes back after interval × (0.694 − 0.187 × difficulty), so harder cards return sooner.'
            : 'Classic SuperMemo-2: ease factor starts at 2.5, intervals go 1 → 6 → interval × ease. Again resets the card.'}
        </p>
      </Card>
      <Card className="flex flex-col gap-4">
        <h3 className="text-lg font-semibold">Free-answer marking</h3>
        <p className="text-[0.9rem] text-muted">Scores are out of 10. Decks can override these.</p>
        <Field label={`Correct at ${th.correct} or more`}>
          <input type="range" min={1} max={10} value={th.correct} onChange={(e) => set('thresholds', { ...th, correct: Number(e.target.value), partial: Math.min(th.partial, Number(e.target.value) - 1) })} className="accent-[var(--accent)]" />
        </Field>
        <Field label={`Partial at ${th.partial} or more (below is wrong)`}>
          <input type="range" min={0} max={9} value={th.partial} onChange={(e) => set('thresholds', { ...th, partial: Math.min(Number(e.target.value), th.correct - 1) })} className="accent-[var(--accent)]" />
        </Field>
      </Card>
      {IS_MOBILE && <PhoneLibrary />}
      <Card className="desktop-only flex flex-col gap-3">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Archive className="size-5" /> Your library
        </h3>
        <p className="text-[0.9rem] text-muted break-all">
          Everything lives in <code className="font-mono text-[0.85em]">{info?.userData}</code>: the database, attachments, cache and logs.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => api.app.showDataFolder()}>
            Show data folder
          </Button>
          <Button onClick={async () => (await api.app.backup()) && toast('Backup saved', 'good')}>
            Back up (.zip)
          </Button>
          <Button onClick={() => api.app.restore().catch((e) => toast(errorText(e), 'bad'))}>
            Restore…
          </Button>
        </div>
      </Card>
      {!IS_MOBILE && <MoveLibrary />}
      <Card className="flex flex-col gap-2 lg:col-span-2">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Info className="size-5" /> About
        </h3>
        <p className="text-[0.92rem] text-muted">
          Studywise {info?.version} {IS_MOBILE ? (mobile().platform === 'ios' ? '· iPhone' : mobile().platform === 'android' ? '· Android' : '· Web') : `· Electron ${info?.electron}`} {info?.mock && <Pill tone="warn">AI_MOCK on</Pill>}
        </p>
        {!IS_MOBILE && <UpdateCheck />}
        <p className="text-[0.92rem] text-muted">
          {IS_MOBILE && 'On the phone, AI features run on your paired computer. '}AI features run through the Claude Code CLI on this computer with your own Claude subscription, or through Ollama if you switch to it under AI provider. Studywise never sees your Claude login. Use is subject to each provider’s terms.
        </p>
      </Card>
    </div>
  )
}

/** Voice mode: ElevenLabs reads notes cards and explanations aloud while you go through a week. */
function VoiceTab() {
  const [st, setSt] = useState<VoiceStatus | null>(null)
  const [key, setKey] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [voices, setVoices] = useState<VoiceOption[] | null>(null)
  const [voicesErr, setVoicesErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'voices' | null>(null)
  const speaking = useSpeaking()
  const testing = speaking?.key === 'voice-test'

  const apply = (s: VoiceStatus) => {
    setSt(s)
    setVoiceId(s.voiceId)
    setPrompt(s.prompt)
    setVoiceStatus(s)
  }
  const save = async (patch: Parameters<typeof api.voice.setConfig>[0]) => {
    setBusy('save')
    try {
      apply(await api.voice.setConfig(patch))
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(null)
    }
  }
  const loadVoices = async () => {
    setBusy('voices')
    setVoicesErr(null)
    try {
      setVoices(await api.voice.voices())
    } catch (e) {
      setVoicesErr(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => {
    void api.voice.status().then((s) => {
      apply(s)
      if (s.hasKey) void loadVoices()
    })
    return () => stopVoice()
  }, [])
  if (!st) return null
  const tags = modelHasTags(st.model)
  const test = () =>
    testing
      ? stopVoice()
      : void speak(
          'Here’s how your notes will sound. The photoelectric effect: when light shines on a metal, electrons can be knocked out of it, but only if each photon has enough energy.',
          'voice-test'
        )

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="flex flex-col gap-4">
        <Card className={cx('flex flex-col gap-3', st.ready && 'ring-1 ring-accent/40')}>
          <div className="flex items-center gap-2">
            <Volume2 className={cx('size-5', st.ready ? 'text-accent' : 'text-muted')} />
            <h3 className="text-lg font-semibold">Voice mode</h3>
          </div>
          <Toggle checked={st.enabled} onChange={(v) => void save({ enabled: v })} label="Read notes cards and explanations aloud" />
          <Field label="Play">
            <Segmented<'auto' | 'click'>
              value={st.autoplay ? 'auto' : 'click'}
              onChange={(v) => void save({ autoplay: v === 'auto' })}
              options={[
                { value: 'auto', label: 'Automatically' },
                { value: 'click', label: 'When I click' }
              ]}
            />
          </Field>
          <p className="text-[0.88rem] text-muted">
            {st.enabled && !st.hasKey
              ? 'Add your ElevenLabs API key below to hear it.'
              : st.autoplay
                ? 'While you go through a week, each notes card is read out as it opens, and so is an explanation once you press Explain. Questions and flashcards are never read out. The speaker button on a card plays it again or stops it.'
                : 'Each notes card and explanation has a Read aloud button: nothing plays until you press it. Questions and flashcards are never read out.'}
          </p>
        </Card>
        <Card className="flex flex-col gap-4">
          <h3 className="text-lg font-semibold">ElevenLabs</h3>
          <Field
            label="API key"
            hint={st.hasKey ? 'Saved and encrypted with your login on this computer. It’s only ever sent to ElevenLabs.' : 'Create one at elevenlabs.io under Developers → API keys. It needs text to speech (and voices, to list your voices).'}
          >
            <div className="flex gap-2">
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={st.hasKey ? '••••••••••••  (saved)' : 'Paste your key'} autoComplete="off" />
              <Button
                variant="primary"
                disabled={!key.trim()}
                loading={busy === 'save'}
                onClick={async () => {
                  await save({ apiKey: key.trim() })
                  setKey('')
                  void loadVoices()
                }}
              >
                Save
              </Button>
              {st.hasKey && (
                <Button variant="ghost" onClick={() => save({ apiKey: null })}>
                  Remove
                </Button>
              )}
            </div>
          </Field>
          <Field label="Voice ID" hint="Pick one of your voices, or paste any voice’s ID from ElevenLabs’ voice library.">
            <div className="flex flex-col gap-2">
              {voices && voices.length > 0 && (
                <Select value={voices.some((v) => v.id === st.voiceId) ? st.voiceId : ''} onChange={(e) => e.target.value && void save({ voiceId: e.target.value })}>
                  <option value="">Your voices…</option>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {[v.name, v.category, v.description.slice(0, 60)].filter(Boolean).join(' · ')}
                    </option>
                  ))}
                </Select>
              )}
              <div className="flex gap-2">
                <Input
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  onBlur={() => voiceId.trim() !== st.voiceId && void save({ voiceId: voiceId.trim() })}
                  className="font-mono text-[0.85rem]"
                  placeholder="JBFqnCBsd6RMkjVDRZzb"
                />
                {st.hasKey && (
                  <Button variant="ghost" loading={busy === 'voices'} onClick={loadVoices} title="Load your voices from ElevenLabs">
                    <RefreshCw className="size-4" />
                  </Button>
                )}
              </div>
              {voicesErr && <span className="text-[0.85rem] text-bad">{voicesErr}</span>}
            </div>
          </Field>
          <Field label="Model">
            <Select value={st.model} onChange={(e) => void save({ model: e.target.value })}>
              {VOICE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-col gap-1.5">
            <Toggle checked={st.autoTag && tags} onChange={(v) => void save({ autoTag: v })} label="Auto-tag: Claude adds audio tags before it’s read" />
            <p className="text-[0.85rem] text-muted">
              {tags
                ? 'Claude adds tags like [curious], [short pause] or [reassuring] where they fit, following your voice prompt, so it sounds like someone teaching. It never changes the words. One quick AI call per card the first time you hear it.'
                : 'This model doesn’t understand audio tags. Pick an Eleven v4 or v3 model to use them.'}
            </p>
          </div>
          <Field label="Voice prompt" hint="How the voice should sound. Claude follows it when it adds the tags.">
            <Textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => prompt.trim() !== st.prompt && void save({ prompt: prompt.trim() })}
              disabled={!tags || !st.autoTag}
              placeholder={DEFAULT_VOICE_PROMPT}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={test} disabled={!st.hasKey} loading={testing && speaking?.loading}>
              <Play className="size-4" /> {testing && !speaking?.loading ? 'Stop' : 'Test the voice'}
            </Button>
            {prompt.trim() !== DEFAULT_VOICE_PROMPT && tags && st.autoTag && (
              <Button variant="ghost" onClick={() => save({ prompt: '' })}>
                <RotateCcw className="size-4" /> Default prompt
              </Button>
            )}
          </div>
        </Card>
      </div>
      <Card className="flex flex-col gap-3 self-start text-[0.92rem]">
        <h3 className="text-lg font-semibold">How it works</h3>
        <p className="text-muted">Each notes card goes to ElevenLabs’ text-to-speech with your own key, so it uses your ElevenLabs characters. Code, formulas and diagrams are mentioned rather than read symbol by symbol.</p>
        <p className="text-muted">Audio is kept on this computer, so a card you’ve heard before plays straight away, even offline, and costs nothing again. Changing the voice, model or prompt makes new audio.</p>
        <p className="text-muted">On your phone, voice mode uses this computer’s ElevenLabs key while it’s paired.</p>
      </Card>
    </div>
  )
}

/** Settings → About: whether this copy is up to date, and a button to check now. */
function UpdateCheck() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void api.updates.status().then(setStatus)
    return onEvent((ev) => ev.type === 'update' && setStatus(ev.status))
  }, [])
  if (!status?.supported) return null
  const check = async () => {
    try {
      const s = await api.updates.check()
      setStatus(s)
      if (s.state === 'idle' && !s.version && !s.behind) toast('You’re on the latest version', 'good')
    } catch (e) {
      toast(errorText(e), 'bad')
    }
  }
  const ago = status.checkedAt ? new Date(status.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null
  const text =
    status.state === 'checking'
      ? 'Checking for updates…'
      : status.state === 'updating' || status.state === 'restarting'
        ? (status.stage ?? 'Updating…')
        : status.state === 'error'
          ? (status.error ?? 'The update didn’t finish.')
          : status.ready
            ? `Version ${status.version} is ready: restart to update.`
            : status.version || status.behind
              ? status.kind === 'release'
                ? `Version ${status.version} is out.`
                : `${status.behind} new change${status.behind === 1 ? '' : 's'} on GitHub.`
              : ago
                ? `Up to date (checked at ${ago}).`
                : 'Checks for updates automatically.'
  return (
    <div className="flex flex-wrap items-center gap-3 text-[0.92rem]">
      <span className="text-muted">{text}</span>
      <Button size="sm" onClick={check} loading={status.state === 'checking'} disabled={status.state === 'updating' || status.state === 'restarting'}>
        Check for updates
      </Button>
    </div>
  )
}

/** The phone's own copy of the library. */
function PhoneLibrary() {
  return (
    <Card className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-lg font-semibold">
        <Archive className="size-5" /> On this phone
      </h3>
      <p className="text-[0.9rem] text-muted">Your library is stored on the phone so you can study offline, and syncs with your computer. If something looks wrong, clear the phone’s copy: it comes back from the computer on the next sync. Changes not synced yet are lost.</p>
      <div>
        <Button
          variant="ghost"
          className="text-bad"
          onClick={async () => {
            if (await confirmDialog('Clear the phone’s copy?', 'Everything on this phone is removed, including changes that haven’t synced. Your computer’s library isn’t touched; pair again to bring it back.', { confirmText: 'Clear', danger: true })) await window.studywiseMobile?.resetLibrary()
          }}
        >
          <Trash2 className="size-4" /> Clear and start again
        </Button>
      </div>
    </Card>
  )
}

/** Export everything to a .studywise file for another computer (Mac or Windows), or bring one in. */
function MoveLibrary() {
  const [progress, setProgress] = useState(false)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const run = async (kind: 'export' | 'import') => {
    setBusy(kind)
    try {
      if (kind === 'export') {
        const r = await api.io.exportLibrary({ includeProgress: progress })
        if (r) toast(`Exported ${r.decks} decks, ${r.cards} cards, ${r.notes} notes and ${r.courses} courses${progress ? ', with your progress' : ''}`, 'good')
      } else {
        const r = await api.io.importLibrary()
        if (r) {
          toast(`Added ${r.decks} decks, ${r.cards} cards, ${r.notes} notes and ${r.courses} courses${r.includesProgress ? ', with progress' : ''}`, 'good')
          useStore.getState().bump()
        }
      }
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Card className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-lg font-semibold">
        <Download className="size-5" /> Move to another computer
      </h3>
      <p className="text-[0.9rem] text-muted">
        One <code className="font-mono text-[0.85em]">.studywise</code> file with all your decks, cards, notes, courses (with their files and figures), prompts and custom actions. It opens on Mac and Windows. Importing adds to the library that’s there; nothing is replaced.
      </p>
      <Toggle checked={progress} onChange={setProgress} label="Include my progress (review history, due dates and where I am in each topic)" />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" loading={busy === 'export'} onClick={() => run('export')}>
          Export library…
        </Button>
        <Button loading={busy === 'import'} onClick={() => run('import')}>
          <Upload className="size-4" /> Import library…
        </Button>
      </div>
    </Card>
  )
}

function ProviderTab() {
  const ai = useStore((s) => s.ai)
  const setAi = useStore((s) => s.setAi)
  if (!ai) return <div className="skeleton h-80" />
  const choose = async (provider: AiProvider) => setAi(await api.ai.setProvider({ provider }))
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold">Which AI runs Studywise</h3>
        <Segmented
          value={ai.provider}
          onChange={(v) => void choose(v)}
          options={[
            { value: 'claude', label: 'Claude Code' },
            { value: 'ollama', label: 'Ollama' }
          ]}
          className="self-start"
        />
        <p className="text-[0.9rem] text-muted">
          {ai.provider === 'claude'
            ? 'Every AI feature runs through the Claude Code CLI on this computer, using your Claude subscription.'
            : 'Every AI feature runs on Ollama: its cloud models with an API key, or models on your own Ollama server. Pick the models in Settings → Models.'}
        </p>
      </Card>
      {ai.provider === 'ollama' ? <OllamaCard /> : <ClaudeCard />}
    </div>
  )
}

function OllamaCard() {
  const ai = useStore((s) => s.ai)!
  const setAi = useStore((s) => s.setAi)
  const go = useStore((s) => s.go)
  const st = ai.ollama
  const [url, setUrl] = useState(st.baseUrl)
  const [key, setKey] = useState('')
  const [numCtx, setNumCtx] = useState<number | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => setUrl(st.baseUrl), [st.baseUrl])
  useEffect(() => {
    void api.settings.all().then((s) => setNumCtx(Number(s['ollama.numCtx'] ?? 32768)))
  }, [])
  const refresh = async () => setAi(await api.ai.status())
  const save = async (patch: Parameters<typeof api.ollama.setConfig>[0]) => {
    setBusy('save')
    try {
      await api.ollama.setConfig(patch)
      await refresh()
      setTest(null)
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(null)
    }
  }
  const runTest = async () => {
    setBusy('test')
    try {
      const models = await api.ollama.models({ refresh: true })
      setTest({ ok: true, text: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available.` })
    } catch (e) {
      setTest({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }
  const isCloud = /^(https?:\/\/)?([^/]+\.)?ollama\.com(\/|$)/i.test(url.trim())
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Card className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className={cx('grid size-12 place-items-center rounded-full', st.ready ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad')}>
            {st.ready ? <CheckCircle2 className="size-6" /> : <XCircle className="size-6" />}
          </span>
          <div>
            <div className="text-lg font-semibold">{st.ready ? (st.cloud ? 'Ollama Cloud is ready' : 'Using your Ollama server') : 'Add your API key'}</div>
            <div className="text-[0.9rem] text-muted">{st.defaultModel ? `Default model: ${st.defaultModel}` : 'No default model chosen yet'}</div>
          </div>
        </div>
        <Field label="Server" hint={isCloud ? 'Ollama Cloud. Calls go straight to ollama.com.' : 'Your own Ollama, e.g. http://localhost:11434. Models ending in -cloud run on Ollama Cloud through it.'}>
          <div className="flex gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim() !== st.baseUrl && void save({ baseUrl: url })} className="font-mono text-[0.85rem]" />
            <Select
              value=""
              onChange={(e) => {
                if (!e.target.value) return
                setUrl(e.target.value)
                void save({ baseUrl: e.target.value })
              }}
              className="w-36 shrink-0"
            >
              <option value="">Presets…</option>
              <option value="https://ollama.com">Ollama Cloud</option>
              <option value="http://localhost:11434">This computer</option>
            </Select>
          </div>
        </Field>
        <Field
          label="API key"
          hint={
            st.keyFromEnv
              ? 'Using the OLLAMA_API_KEY environment variable.'
              : st.hasKey
                ? 'Saved and encrypted with your Windows login. It is only ever sent to your Ollama server.'
                : isCloud
                  ? 'Create one at ollama.com/settings/keys.'
                  : 'Not needed for a local server.'
          }
        >
          <div className="flex gap-2">
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={st.hasKey ? '••••••••••••  (saved)' : 'Paste your key'} autoComplete="off" />
            <Button
              variant="primary"
              disabled={!key.trim()}
              loading={busy === 'save'}
              onClick={async () => {
                await save({ apiKey: key.trim() })
                setKey('')
              }}
            >
              Save
            </Button>
            {st.hasKey && !st.keyFromEnv && (
              <Button variant="ghost" onClick={() => save({ apiKey: null })}>
                Remove
              </Button>
            )}
          </div>
        </Field>
        {!isCloud && numCtx !== null && (
          <Field label="Context size (tokens)" hint="Local models default to a small window, so long PDFs get cut off. Bigger needs more memory.">
            <Input type="number" min={2048} step={1024} value={numCtx} onChange={(e) => setNumCtx(Number(e.target.value) || 32768)} onBlur={() => save({ numCtx: Math.max(2048, numCtx) })} className="w-40" />
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button loading={busy === 'test'} onClick={runTest}>
            Test connection
          </Button>
          <Button variant="ghost" onClick={() => go({ name: 'settings', tab: 'models' })}>
            Choose models →
          </Button>
          {test && <span className={cx('text-[0.88rem]', test.ok ? 'text-good' : 'text-bad')}>{test.text}</span>}
        </div>
      </Card>
      <Card className="flex flex-col gap-3 text-[0.92rem]">
        <h3 className="text-lg font-semibold">How it works</h3>
        <p className="text-muted">Studywise sends each prompt to Ollama’s chat API and streams the reply back. Files you give it are read on this computer and sent as text. Scanned PDFs go as page images, which needs a model with vision.</p>
        <p className="text-muted">Cloud models don’t support structured output, so for questions, marking and courses the expected JSON format goes in the prompt, and the reply is checked and retried once if it doesn’t fit. Bigger models follow it more reliably.</p>
        <p className="text-muted">Your Claude settings are kept, so you can switch back at any time.</p>
      </Card>
    </div>
  )
}

function ClaudeCard() {
  const claude = useStore((s) => s.claude)
  const setClaude = useStore((s) => s.setClaude)
  const [busy, setBusy] = useState(false)
  const recheck = async () => {
    setBusy(true)
    setClaude(await api.claude.recheck())
    setBusy(false)
  }
  const ok = !!claude?.path && claude.loggedIn
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Card className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span className={cx('grid size-12 place-items-center rounded-full', ok ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad')}>{ok ? <CheckCircle2 className="size-6" /> : <XCircle className="size-6" />}</span>
          <div>
            <div className="text-lg font-semibold">{ok ? 'Claude Code is ready' : claude?.path ? 'Not logged in' : 'Claude Code not found'}</div>
            <div className="text-[0.9rem] text-muted">{claude?.authMethod ? `Signed in via ${claude.authMethod}` : claude?.error}</div>
          </div>
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[0.92rem]">
          <dt className="text-muted">Path</dt>
          <dd className="font-mono text-[0.85rem] break-all">{claude?.path ?? '—'}</dd>
          <dt className="text-muted">Version</dt>
          <dd>{claude?.version ?? '—'}</dd>
          <dt className="text-muted">Override</dt>
          <dd className="font-mono text-[0.85rem] break-all">{claude?.overridePath ?? 'none (auto-detect)'}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy} onClick={recheck}>
            Re-check
          </Button>
          <Button onClick={async () => setClaude(await api.claude.choose())}>
            Choose…
          </Button>
          {claude?.overridePath && (
            <Button variant="ghost" onClick={async () => setClaude(await api.claude.clearOverride())}>
              Use auto-detect
            </Button>
          )}
        </div>
      </Card>
      <Card className="flex flex-col gap-3 text-[0.92rem]">
        <h3 className="text-lg font-semibold">How it works</h3>
        <p className="text-muted">Studywise runs the official <code className="font-mono">claude</code> CLI in print mode for every AI feature, with no tools except read-only access to a PDF you give it. API keys are removed from its environment, so it always uses your Claude login.</p>
        <p className="text-muted">Apps opened from Finder don’t see your shell’s PATH, so Studywise asks your login shell for it once, then also checks ~/.claude/local, ~/.local/bin, Homebrew, /usr/local/bin and npm’s global bin.</p>
        <div className="rounded-lg bg-surface-2 p-3 font-mono text-[0.82rem]">
          npm install -g @anthropic-ai/claude-code
          <br />
          claude   # sign in once
        </div>
      </Card>
    </div>
  )
}

function ModelsTab() {
  const provider = useStore((s) => s.ai?.provider)
  if (!provider) return <div className="skeleton h-80" />
  return provider === 'ollama' ? <OllamaModelsTab /> : <ClaudeModelsTab />
}

type TestState = Record<string, { ok: boolean; reply: string; ms: number } | 'running'>

function TestResult({ r }: { r: TestState[string] | undefined }) {
  if (!r || r === 'running') return null
  return (
    <span title={r.reply} className={cx('max-w-40 truncate text-[0.8rem]', r.ok ? 'text-good' : 'text-bad')}>
      {r.ok ? `✓ ${(r.ms / 1000).toFixed(1)}s` : `✗ ${r.reply}`}
    </span>
  )
}

function OllamaModelsTab() {
  const ai = useStore((s) => s.ai)!
  const setAi = useStore((s) => s.setAi)
  const st = ai.ollama
  const { models: list, error, loading, load } = useOllamaModels(true)
  const [table, setTable] = useState<Record<string, ModelChoice> | null>(null)
  const [tests, setTests] = useState<TestState>({})
  const [filter, setFilter] = useState('')
  const [custom, setCustom] = useState('')
  useEffect(() => void api.models.get({ provider: 'ollama' }).then(setTable), [])
  if (!table || !list) return <div className="skeleton h-80" />
  const set = async (task: TaskId, choice: ModelChoice) => {
    setTable({ ...table, [task]: choice })
    await api.models.set({ task, choice, provider: 'ollama' })
  }
  const test = async (key: string, model: string, effort: string | null) => {
    if (!model) return toast('Choose a model first', 'bad')
    setTests((t) => ({ ...t, [key]: 'running' }))
    const r = await api.models.test({ model, effort, provider: 'ollama' })
    setTests((t) => ({ ...t, [key]: r }))
  }
  const star = async (model: string, saved: boolean) => setAi({ ...ai, ollama: await api.ollama.saveModel({ model, saved }) })
  const setDefault = async (model: string) => setAi({ ...ai, ollama: await api.ollama.setDefault({ model }) })
  const shown = list.filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()))
  const unlisted = st.saved.filter((m) => !list.some((x) => x.name === m))
  const caps = (m: OllamaModel) => m.capabilities.filter((c) => c === 'vision' || c === 'thinking')

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card className="flex flex-col gap-4">
          <div>
            <h3 className="text-lg font-semibold">Default model</h3>
            <p className="text-[0.9rem] text-muted">Every task uses this unless you pick something else below.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={st.defaultModel} onChange={(e) => void setDefault(e.target.value)} className="h-10 min-w-56 flex-1">
              <option value="">Choose a model…</option>
              <OllamaModelOptions models={list} saved={st.saved} current={st.defaultModel} />
            </Select>
            <Button loading={tests.__default === 'running'} onClick={() => test('__default', st.defaultModel, null)}>
              Test
            </Button>
            <TestResult r={tests.__default} />
          </div>
          {error && <p className="text-[0.88rem] text-bad">{error}</p>}
          <Field label="Add a model that isn’t listed" hint="Any model name your server accepts, e.g. one you’ve pulled locally.">
            <div className="flex gap-2">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. llama3.2:3b" className="font-mono text-[0.85rem]" />
              <Button
                disabled={!custom.trim()}
                onClick={async () => {
                  await star(custom.trim(), true)
                  setCustom('')
                  toast('Saved. It’s now in every model list.', 'good')
                }}
              >
                Save
              </Button>
            </div>
          </Field>
        </Card>
        <Card className="!p-0 flex flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
            <div>
              <h3 className="text-lg font-semibold">Your models</h3>
              <p className="text-[0.9rem] text-muted">Star the ones you use. Saved models come first in every list.</p>
            </div>
            <Button size="sm" variant="ghost" loading={loading} onClick={() => load(true)}>
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          </div>
          <div className="border-b border-line px-5 py-2">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Search ${list.length} models`} className="h-9" />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {unlisted.map((m) => (
              <div key={m} className="flex items-center gap-3 border-b border-line px-5 py-2">
                <button onClick={() => star(m, false)} aria-label={`Unsave ${m}`} className="text-accent">
                  <Star className="size-4 fill-current" />
                </button>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.85rem]">{m}</span>
                <Pill tone="warn">not listed</Pill>
              </div>
            ))}
            {shown.length === 0 && unlisted.length === 0 && <div className="px-5 py-6 text-center text-muted">{list.length ? 'No matches' : 'No models found. Check the connection under AI provider.'}</div>}
            {shown.map((m) => {
              const saved = st.saved.includes(m.name)
              return (
                <div key={m.name} className="flex items-center gap-3 border-b border-line px-5 py-2 last:border-0">
                  <button onClick={() => star(m.name, !saved)} aria-label={saved ? `Unsave ${m.name}` : `Save ${m.name}`} className={saved ? 'text-accent' : 'text-muted hover:text-ink'}>
                    <Star className={cx('size-4', saved && 'fill-current')} />
                  </button>
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.85rem]">{m.name}</span>
                  {caps(m).map((c) => (
                    <Pill key={c} tone={c === 'vision' ? 'good' : 'neutral'}>
                      {c}
                    </Pill>
                  ))}
                  {st.defaultModel === m.name ? (
                    <Pill tone="accent">default</Pill>
                  ) : (
                    <button onClick={() => setDefault(m.name)} className="text-[0.8rem] text-muted hover:text-ink">
                      Make default
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      <Card className="!p-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold">Model per task</h3>
            <p className="text-[0.9rem] text-muted">Leave a row on Default to use the default model. Decks can override any row.</p>
          </div>
          <Button
            variant="ghost"
            onClick={async () => {
              await api.models.reset({ provider: 'ollama' })
              setTable(await api.models.get({ provider: 'ollama' }))
            }}
          >
            All on default
          </Button>
        </div>
        <div className="grid grid-cols-[1.3fr_1.4fr_1fr_auto] items-center gap-x-3 border-b border-line bg-surface-2/60 px-5 py-2 text-[0.75rem] font-semibold text-muted max-md:hidden">
          <span>Task</span>
          <span>Model</span>
          <span>Thinking</span>
          <span>Test</span>
        </div>
        {TASKS.map((t) => {
          const m = table[t]
          return (
            <div key={t} className="grid grid-cols-[1.3fr_1.4fr_1fr_auto] items-center gap-x-3 gap-y-2 border-b border-line px-5 py-2.5 last:border-0 max-md:grid-cols-1">
              <div>
                <div className="font-semibold">{TASK_INFO[t].label}</div>
                <div className="font-mono text-[0.75rem] text-muted">{t}</div>
              </div>
              <Select value={m.model} onChange={(e) => set(t, { ...m, model: e.target.value })} className="h-9">
                <option value="">Default{st.defaultModel ? ` (${st.defaultModel})` : ''}</option>
                <OllamaModelOptions models={list} saved={st.saved} current={m.model} />
              </Select>
              <Select value={m.effort ?? ''} onChange={(e) => set(t, { ...m, effort: e.target.value || null })} className="h-9">
                <option value="">Model default</option>
                {OLLAMA_EFFORT_LEVELS.map((x) => (
                  <option key={x} value={x}>
                    {x === 'off' ? 'Off' : x}
                  </option>
                ))}
              </Select>
              <div className="flex items-center gap-2">
                <Button size="sm" loading={tests[t] === 'running'} onClick={() => test(t, m.model || st.defaultModel, m.effort)}>
                  Test
                </Button>
                <TestResult r={tests[t]} />
              </div>
            </div>
          )
        })}
      </Card>
    </div>
  )
}

function ClaudeModelsTab() {
  const [models, setModels] = useState<Record<string, ModelChoice> | null>(null)
  const [tests, setTests] = useState<Record<string, { ok: boolean; reply: string; ms: number } | 'running'>>({})
  useEffect(() => void api.models.get({ provider: 'claude' }).then(setModels), [])
  if (!models) return <div className="skeleton h-80" />
  const set = async (task: TaskId, choice: ModelChoice) => {
    setModels({ ...models, [task]: choice })
    await api.models.set({ task, choice, provider: 'claude' })
  }
  const test = async (task: TaskId) => {
    setTests((t) => ({ ...t, [task]: 'running' }))
    const r = await api.models.test({ model: models[task].model, effort: models[task].effort, provider: 'claude' })
    setTests((t) => ({ ...t, [task]: r }))
  }
  return (
    <Card className="!p-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold">Model per task</h3>
          <p className="text-[0.9rem] text-muted">Aliases always point at the newest model. Type a full model name for a specific one. Decks can override any row.</p>
        </div>
        <Button
          variant="ghost"
          onClick={async () => {
            await api.models.reset({ provider: 'claude' })
            setModels(await api.models.get({ provider: 'claude' }))
          }}
        >
          Reset defaults
        </Button>
      </div>
      <div className="grid grid-cols-[1.3fr_1.4fr_1fr_auto] items-center gap-x-3 border-b border-line bg-surface-2/60 px-5 py-2 text-[0.75rem] font-semibold text-muted max-md:hidden">
        <span>Task</span>
        <span>Model</span>
        <span>Thinking / effort</span>
        <span>Test</span>
      </div>
      {TASKS.map((t) => {
        const m = models[t]
        const isAlias = (MODEL_ALIASES as readonly string[]).includes(m.model)
        const r = tests[t]
        return (
          <div key={t} className="grid grid-cols-[1.3fr_1.4fr_1fr_auto] items-center gap-x-3 gap-y-2 border-b border-line px-5 py-2.5 last:border-0 max-md:grid-cols-1">
            <div>
              <div className="font-semibold">{TASK_INFO[t].label}</div>
              <div className="font-mono text-[0.75rem] text-muted">{t}</div>
            </div>
            <div className="flex gap-2">
              <Select value={isAlias ? m.model : '__custom'} onChange={(e) => set(t, { ...m, model: e.target.value === '__custom' ? '' : e.target.value })} className="h-9 w-32 shrink-0">
                {MODEL_ALIASES.map((a) => (
                  <option key={a}>{a}</option>
                ))}
                <option value="__custom">Full name…</option>
              </Select>
              {!isAlias && <Input value={m.model} onChange={(e) => setModels({ ...models, [t]: { ...m, model: e.target.value } })} onBlur={(e) => set(t, { ...m, model: e.target.value.trim() || TASK_INFO[t].defaultModel })} placeholder="claude-…" className="h-9 font-mono text-[0.85rem]" />}
            </div>
            <Select value={m.effort ?? ''} onChange={(e) => set(t, { ...m, effort: e.target.value || null })} className="h-9">
              <option value="">Default</option>
              {EFFORT_LEVELS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Button size="sm" loading={r === 'running'} onClick={() => test(t)}>
                Test
              </Button>
              {r && r !== 'running' && (
                <span title={r.reply} className={cx('max-w-40 truncate text-[0.8rem]', r.ok ? 'text-good' : 'text-bad')}>
                  {r.ok ? `✓ ${(r.ms / 1000).toFixed(1)}s` : `✗ ${r.reply}`}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </Card>
  )
}

// ---------------------------------------------------------------------------

const SAMPLE_VARS: Record<string, unknown> = {
  front: 'Explain why a threshold frequency exists (2)',
  back: '- below the threshold frequency, photons have less energy than the work function\n\n- so they do not have enough energy to remove an electron',
  required_points: 2,
  question: 'Explain why a threshold frequency exists (2)',
  expected_answer: 'photons below the threshold have less energy than the work function, so cannot remove an electron',
  user_answer: 'because the light is not bright enough',
  source_text: 'The photoelectric effect: light above a threshold frequency ejects electrons from a metal. The work function is the minimum energy needed to remove an electron. Each electron absorbs one photon. E = hf.',
  instructions: '',
  deck_name: 'Quantum physics',
  title: 'The photoelectric effect',
  module: 'PHYS101',
  type: 'Lecture',
  week: '4',
  level: 'A-level',
  language: '',
  count: 5,
  format: 'question_answer',
  card_type: 'regular',
  mode: 'Explain this card clearly.',
  history: 'Me: why does brightness not matter?',
  previous_hints: '(none)',
  problem: 'Question says (3) but the answer has 2 bullets',
  cards: JSON.stringify([{ card_id: 'c1', type: 'multiple_choice', front: 'What is the work function?', back: 'the minimum energy needed to remove an electron from the surface of a metal' }], null, 1),
  action_prompt: 'Explain like I’m 12: what is the work function?'
}

const cmTheme = EditorView.theme({ '&': { color: 'var(--ink)', fontSize: '0.85rem' }, '.cm-scroller': { fontFamily: 'var(--font-mono)' }, '.cm-content': { padding: '10px 0' } })

function PromptsTab() {
  const [task, setTask] = useState<TaskId>('generate_cards')
  const [presets, setPresets] = useState<Preset[]>([])
  const [sel, setSel] = useState<string>('')
  const [draft, setDraft] = useState<{ name: string; system: string; user_template: string; output_mode: Preset['output_mode'] } | null>(null)
  const [varsText, setVarsText] = useState('')
  const [preview, setPreview] = useState<{ system: string; prompt: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [testOut, setTestOut] = useState<{ ok: boolean; raw: string; parsed: unknown; error?: string; ms: number } | null>(null)
  const [streamRaw, setStreamRaw] = useState('')
  const [versions, setVersions] = useState<PresetVersion[] | null>(null)
  const [diffWith, setDiffWith] = useState<PresetVersion | null>(null)
  const editor = useRef<ReactCodeMirrorRef>(null)

  const loadPresets = async (keep?: string) => {
    const p = await api.presets.list({ task })
    setPresets(p)
    const pick = p.find((x) => x.id === keep) ?? p.find((x) => x.is_default) ?? p[0]
    setSel(pick?.id ?? '')
  }
  useEffect(() => {
    void loadPresets()
    const vars = Object.fromEntries(TASK_INFO[task].variables.concat(task === 'custom_action' ? ['action_prompt'] : []).map((v) => [v, SAMPLE_VARS[v] ?? '']))
    setVarsText(JSON.stringify(vars, null, 2))
    setTestOut(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task])
  const preset = presets.find((p) => p.id === sel)
  useEffect(() => {
    if (preset) setDraft({ name: preset.name, system: preset.system, user_template: preset.user_template, output_mode: preset.output_mode })
    setVersions(null)
    setTestOut(null)
  }, [preset?.id, preset?.version])

  const dirty = !!preset && !!draft && (draft.system !== preset.system || draft.user_template !== preset.user_template || draft.name !== preset.name || draft.output_mode !== preset.output_mode)
  const vars = useMemo(() => {
    try {
      return JSON.parse(varsText) as Record<string, unknown>
    } catch {
      return null
    }
  }, [varsText])

  useEffect(() => {
    if (!preset || !draft || !vars) return
    const t = setTimeout(() => {
      void api.presets
        .preview({ id: preset.id, vars, override: { system: draft.system, user_template: draft.user_template, output_mode: draft.output_mode } })
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 250)
    return () => clearTimeout(t)
  }, [preset, draft, vars])

  const save = async () => {
    if (!preset || !draft) return
    await api.presets.update({ id: preset.id, patch: draft })
    toast(`Saved ${draft.name}`, 'good')
    await loadPresets(preset.id)
  }
  useCommands({ 'note.save': dirty ? save : null }, [dirty, draft])

  const insertVar = (v: string) => {
    const view = editor.current?.view
    if (!view) return
    view.dispatch(view.state.replaceSelection(`{{${v}}}`))
    view.focus()
  }
  const runTest = async () => {
    if (!preset || !draft || !vars) return
    setTesting(true)
    setTestOut(null)
    setStreamRaw('')
    try {
      const r = await streamCall((streamId) => api.presets.testRun({ id: preset.id, vars, override: { system: draft.system, user_template: draft.user_template, output_mode: draft.output_mode }, streamId }), setStreamRaw)
      setTestOut(r as typeof testOut)
    } finally {
      setTesting(false)
    }
  }

  const groups: [string, TaskId[]][] = [
    ['Generation', ['generate_notes', 'generate_cards', 'fix_cards']],
    ['Learn', ['make_questions', 'make_categorize', 'mark_free_answer', 'mark_fill_blank', 'feedback_wrong', 'feedback_right', 'hint']],
    ['Explain', ['explain', 'explain_chat', 'custom_action']],
    ['Notes', ['note_simplify', 'note_shorten', 'note_fix_formatting', 'note_expand']]
  ]

  return (
    <div className="grid gap-4 xl:grid-cols-[260px_1fr]">
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Button size="sm" onClick={async () => (await api.presets.exportFile()) && toast('Exported presets & actions', 'good')}>
            Export
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              try {
                const r = await api.presets.importFile()
                if (r) {
                  toast(`Imported ${r.presets} presets, ${r.actions} actions`, 'good')
                  await loadPresets(sel)
                }
              } catch (e) {
                toast(errorText(e), 'bad')
              }
            }}
          >
            Import
          </Button>
        </div>
        {groups.map(([g, ts]) => (
          <div key={g}>
            <div className="mb-1 px-2 text-[0.72rem] font-semibold text-muted">{g}</div>
            {ts.map((t) => (
              <button key={t} onClick={() => setTask(t)} className={cx('block w-full rounded-full px-3 py-1.5 text-left text-[0.9rem] transition-colors', task === t ? 'bg-accent-soft font-semibold' : 'hover:bg-surface-2')}>
                {TASK_INFO[t].label}
              </button>
            ))}
          </div>
        ))}
      </div>

      {preset && draft && (
        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={sel} onChange={(e) => setSel(e.target.value)} className="w-auto min-w-56">
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.is_default ? '★' : ''} · v{p.version}
                  </option>
                ))}
              </Select>
              {preset.is_default ? (
                <Pill tone="accent">
                  <Star className="size-3" /> Default
                </Pill>
              ) : (
                <Button size="sm" variant="soft" onClick={async () => (await api.presets.setDefault({ id: preset.id }), loadPresets(preset.id))}>
                  Make default
                </Button>
              )}
              {preset.builtin_key && <Pill>Built-in</Pill>}
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const name = await askText('Duplicate preset', { initial: `${preset.name} (copy)` })
                  if (name) {
                    const p = await api.presets.duplicate({ id: preset.id, name })
                    await loadPresets(p.id)
                  }
                }}
              >
                Duplicate
              </Button>
              <Button size="sm" variant="ghost" onClick={async () => setVersions(await api.presets.versions({ id: preset.id }))}>
                History
              </Button>
              {preset.builtin_key ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (await confirmDialog('Reset to the built-in version?', 'Your edits stay in the history.')) {
                      await api.presets.reset({ id: preset.id })
                      await loadPresets(preset.id)
                    }
                  }}
                >
                  Reset
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (await confirmDialog(`Delete “${preset.name}”?`, undefined, { danger: true })) {
                      await api.presets.delete({ id: preset.id })
                      await loadPresets()
                    }
                  }}
                >
                  Delete
                </Button>
              )}
              <Button size="sm" variant="primary" disabled={!dirty} onClick={save}>
                Save
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Output">
                <Select value={draft.output_mode} onChange={(e) => setDraft({ ...draft, output_mode: e.target.value as Preset['output_mode'] })} disabled={TASK_INFO[task].modes.length === 1}>
                  {TASK_INFO[task].modes.map((m) => (
                    <option key={m} value={m}>
                      {m === 'studysmarter_text' ? 'StudySmarter text' : m}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {draft.output_mode === 'json' && (
              <div className="flex items-start gap-2 rounded-lg bg-accent-soft px-4 py-2.5 text-[0.88rem]">
                <Info className="mt-0.5 size-4 shrink-0 text-accent" />
                The JSON output schema is added by the app and can’t be edited, so a custom prompt can change what Claude says but never breaks parsing.
              </div>
            )}
            {draft.output_mode === 'studysmarter_text' && (
              <div className="flex items-start gap-2 rounded-lg bg-accent-soft px-4 py-2.5 text-[0.88rem]">
                <Info className="mt-0.5 size-4 shrink-0 text-accent" />
                Output is parsed as <code className="font-mono">question/#*#/answer</code> cards separated by lines with just <code className="font-mono">#</code>. Long outputs auto-continue in the same session.
              </div>
            )}
            <Field label="System prompt">
              <div className="rounded-lg border border-line bg-surface-2/50 px-3">
                <CodeMirror value={draft.system} onChange={(v) => setDraft({ ...draft, system: v })} extensions={[EditorView.lineWrapping, cmTheme]} basicSetup={{ lineNumbers: false, foldGutter: false }} theme="none" maxHeight="160px" />
              </div>
            </Field>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[0.8rem] font-semibold text-muted">User template</span>
                {TASK_INFO[task].variables.concat(task === 'custom_action' ? ['action_prompt'] : []).map((v) => (
                  <button key={v} onClick={() => insertVar(v)} className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[0.75rem] transition-colors hover:bg-accent-soft" title="Insert">
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <div className="rounded-lg border border-line bg-surface-2/50 px-3">
                <CodeMirror ref={editor} value={draft.user_template} onChange={(v) => setDraft({ ...draft, user_template: v })} extensions={[markdown(), EditorView.lineWrapping, cmTheme]} basicSetup={{ lineNumbers: true, foldGutter: false }} theme="none" maxHeight="420px" />
              </div>
            </div>
          </Card>

          <div className="grid gap-4 2xl:grid-cols-2">
            <Card className="flex min-w-0 flex-col gap-3">
              <h3 className="font-semibold">Sample variables</h3>
              <Textarea rows={8} value={varsText} onChange={(e) => setVarsText(e.target.value)} className={cx('font-mono text-[0.8rem]', !vars && 'border-bad')} />
              <h3 className="font-semibold">Live preview (what Claude receives)</h3>
              <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[0.75rem] whitespace-pre-wrap">{preview ? `── system ──\n${preview.system}\n\n── prompt ──\n${preview.prompt}` : 'Fix the sample JSON to see a preview.'}</pre>
            </Card>
            <Card className="flex min-w-0 flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">Test run</h3>
                <Button variant="primary" size="sm" loading={testing} onClick={runTest} disabled={!vars}>
                  Run with Claude
                </Button>
              </div>
              {(testing || testOut) && (
                <>
                  <div className="text-[0.8rem] font-semibold text-muted">Raw output {testOut && `· ${(testOut.ms / 1000).toFixed(1)}s`}</div>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[0.75rem] whitespace-pre-wrap">{testOut?.raw || streamRaw || (testing ? '…' : '')}</pre>
                  {testOut && (
                    <>
                      <div className="text-[0.8rem] font-semibold text-muted">Parsed</div>
                      {testOut.ok ? (
                        typeof testOut.parsed === 'string' ? (
                          <div className="max-h-80 overflow-auto rounded-lg border border-line p-3">
                            <Markdown>{testOut.parsed}</Markdown>
                          </div>
                        ) : (
                          <pre className="max-h-80 overflow-auto rounded-lg bg-good-soft p-3 font-mono text-[0.75rem] whitespace-pre-wrap">{JSON.stringify(testOut.parsed, null, 2)}</pre>
                        )
                      ) : (
                        <div className="rounded-lg bg-bad-soft p-3 text-[0.9rem] text-bad">{testOut.error}</div>
                      )}
                    </>
                  )}
                </>
              )}
              {!testing && !testOut && <p className="text-[0.9rem] text-muted">Runs this (unsaved) prompt against the sample variables and shows the raw reply and what the app parsed from it.</p>}
            </Card>
          </div>
        </div>
      )}

      <Modal open={!!versions} onClose={() => (setVersions(null), setDiffWith(null))} title="Version history" wide>
        {versions && versions.length === 0 && <p className="text-muted">No earlier versions yet. Saving an edit keeps the previous version here.</p>}
        <div className="flex flex-col gap-2">
          {versions?.map((v) => (
            <div key={v.version} className="flex items-center gap-3 rounded-lg border border-line px-4 py-2.5">
              <span className="font-semibold">v{v.version}</span>
              <span className="flex-1 text-[0.85rem] text-muted">{new Date(v.created_at).toLocaleString()}</span>
              <Button size="sm" variant="ghost" onClick={() => setDiffWith(diffWith?.version === v.version ? null : v)}>
                {diffWith?.version === v.version ? 'Hide diff' : 'Diff with current'}
              </Button>
              <Button
                size="sm"
                variant="soft"
                onClick={() => {
                  if (draft) setDraft({ ...draft, system: v.system, user_template: v.user_template })
                  setVersions(null)
                  toast(`Loaded v${v.version} into the editor. Save to keep it.`, 'info')
                }}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
        {diffWith && draft && (
          <pre className="mt-4 max-h-[50vh] overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[0.75rem] whitespace-pre-wrap">
            {diffLines(`${diffWith.system}\n\n${diffWith.user_template}`, `${draft.system}\n\n${draft.user_template}`).map((part, i) => (
              <span key={i} className={part.added ? 'bg-good-soft text-good' : part.removed ? 'bg-bad-soft text-bad line-through' : 'text-muted'}>
                {part.value}
              </span>
            ))}
          </pre>
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------------------

const PLACEMENT_LABEL: Record<string, string> = { card: 'On cards', note_selection: 'Note selection', learn_question: 'Learn question', after_answer: 'After answering' }

function ActionsTab() {
  const [actions, setActions] = useState<CustomAction[]>([])
  const [edit, setEdit] = useState<Partial<CustomAction> | null>(null)
  const aiState = useStore((s) => s.ai)
  const load = () => void api.actions.list().then(setActions)
  useEffect(load, [])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-muted">Your own AI buttons. Each one renders its prompt with the card or selection and either shows Markdown in the Explain panel or makes new cards.</p>
        <Button variant="primary" onClick={() => setEdit({ name: '', prompt: 'Q: {{front}}\nA: {{back}}\n{{source_text}}\n\n', model: 'sonnet', output: 'markdown', placements: ['card'], icon: 'sparkles' })}>
          New action
        </Button>
      </div>
      <div className="stagger grid gap-3 md:grid-cols-2">
        {actions.map((a) => (
          <Card key={a.id} className="flex flex-col gap-2" onClick={() => setEdit(a)}>
            <div className="flex items-center gap-2">
              <span className="text-accent">
                <Sparkles className="size-4" />
              </span>
              <span className="flex-1 font-semibold">{a.name}</span>
              <Pill>{a.model}</Pill>
              <Pill tone="accent">{a.output === 'cards' ? 'New cards' : 'Markdown'}</Pill>
            </div>
            <p className="line-clamp-2 font-mono text-[0.78rem] text-muted">{a.prompt}</p>
            <div className="flex flex-wrap gap-1">
              {a.placements.map((p) => (
                <Pill key={p}>{PLACEMENT_LABEL[p]}</Pill>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {edit && (
        <Modal
          open
          onClose={() => setEdit(null)}
          wide
          title={edit.id ? 'Edit action' : 'New action'}
          footer={
            <>
              {edit.id && (
                <Button
                  variant="danger"
                  className="mr-auto"
                  onClick={async () => {
                    if (await confirmDialog(`Delete “${edit.name}”?`, undefined, { danger: true })) {
                      await api.actions.delete({ id: edit.id! })
                      setEdit(null)
                      load()
                    }
                  }}
                >
                  Delete
                </Button>
              )}
              <Button variant="ghost" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  if (!edit.name?.trim() || !edit.prompt?.trim()) return toast('Name and prompt are required', 'bad')
                  await api.actions.save({ ...edit, name: edit.name, prompt: edit.prompt })
                  setEdit(null)
                  load()
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name" className="sm:col-span-1">
                <Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus />
              </Field>
              <Field label="Model" hint={aiState?.provider === 'ollama' ? 'With Ollama, a Claude name here uses the Custom action model from Settings → Models.' : undefined}>
                <Input value={edit.model ?? 'sonnet'} onChange={(e) => setEdit({ ...edit, model: e.target.value })} list="model-aliases" />
                <datalist id="model-aliases">
                  {[...MODEL_ALIASES, ...(aiState?.ollama.saved ?? [])].map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </Field>
              <Field label="Output">
                <Segmented
                  value={edit.output ?? 'markdown'}
                  onChange={(v) => setEdit({ ...edit, output: v })}
                  options={[
                    { value: 'markdown', label: 'Markdown' },
                    { value: 'cards', label: 'New cards' }
                  ]}
                />
              </Field>
            </div>
            <Field label="Prompt" hint="Variables: {{front}} {{back}} {{question}} {{user_answer}} {{expected_answer}} {{source_text}} {{deck_name}} {{required_points}}">
              <Textarea rows={8} value={edit.prompt ?? ''} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} className="font-mono text-[0.85rem]" />
            </Field>
            <Field label="Show it on">
              <div className="flex flex-wrap gap-4">
                {ACTION_PLACEMENTS.map((p) => (
                  <Toggle
                    key={p}
                    checked={!!edit.placements?.includes(p)}
                    onChange={(v) => setEdit({ ...edit, placements: v ? [...(edit.placements ?? []), p] : (edit.placements ?? []).filter((x) => x !== p) })}
                    label={PLACEMENT_LABEL[p]}
                  />
                ))}
              </div>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  )
}

function UsageTab() {
  const [calls, setCalls] = useState<AiCall[]>([])
  const [summary, setSummary] = useState<{ task: string; model: string; calls: number; ok: number; avg_ms: number; input_tokens: number; output_tokens: number }[]>([])
  const load = () => {
    void api.ai.calls({ limit: 300 }).then(setCalls)
    void api.ai.summary().then((s) => setSummary(s as typeof summary))
  }
  useEffect(load, [])
  const totalIn = summary.reduce((n, s) => n + s.input_tokens, 0)
  const totalOut = summary.reduce((n, s) => n + s.output_tokens, 0)
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <h3 className="mb-3 font-semibold">Claude plan usage</h3>
        <UsageBars />
      </Card>
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <div className="text-[0.75rem] font-semibold text-muted">Calls</div>
          <div className="text-3xl font-semibold">{summary.reduce((n, s) => n + s.calls, 0)}</div>
        </Card>
        <Card>
          <div className="text-[0.75rem] font-semibold text-muted">Input tokens</div>
          <div className="text-3xl font-semibold">{totalIn.toLocaleString()}</div>
        </Card>
        <Card>
          <div className="text-[0.75rem] font-semibold text-muted">Output tokens</div>
          <div className="text-3xl font-semibold">{totalOut.toLocaleString()}</div>
        </Card>
      </div>
      <Card className="!p-0 overflow-x-auto">
        <div className="flex items-center justify-between px-5 py-3">
          <h3 className="font-semibold">By task</h3>
          <Button size="sm" variant="ghost" onClick={load}>
            Refresh
          </Button>
        </div>
        <table className="w-full text-[0.88rem]">
          <thead className="bg-surface-2/60 text-left text-[0.75rem] text-muted">
            <tr>
              {['Task', 'Model', 'Calls', 'OK', 'Avg time', 'Tokens in / out'].map((h) => (
                <th key={h} className="px-5 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.map((s, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-5 py-2 font-semibold">{TASK_INFO[s.task as TaskId]?.label ?? s.task}</td>
                <td className="px-5 py-2 font-mono text-[0.8rem]">{s.model}</td>
                <td className="px-5 py-2">{s.calls}</td>
                <td className="px-5 py-2">{s.ok}</td>
                <td className="px-5 py-2">{(s.avg_ms / 1000).toFixed(1)}s</td>
                <td className="px-5 py-2">
                  {s.input_tokens.toLocaleString()} / {s.output_tokens.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card className="!p-0 overflow-x-auto">
        <h3 className="px-5 py-3 font-semibold">Recent calls</h3>
        <table className="w-full text-[0.85rem]">
          <thead className="bg-surface-2/60 text-left text-[0.75rem] text-muted">
            <tr>
              {['When', 'Task', 'Preset', 'Model', 'Time', 'Tokens', 'Result'].map((h) => (
                <th key={h} className="px-4 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className="border-t border-line align-top">
                <td className="px-4 py-2 whitespace-nowrap text-muted">{new Date(c.created_at).toLocaleString()}</td>
                <td className="px-4 py-2">{c.task}</td>
                <td className="px-4 py-2">
                  {c.preset_name} {c.preset_version != null && <span className="text-muted">v{c.preset_version}</span>}
                </td>
                <td className="px-4 py-2 font-mono text-[0.78rem]">{c.model}</td>
                <td className="px-4 py-2">{(c.duration_ms / 1000).toFixed(1)}s</td>
                <td className="px-4 py-2 whitespace-nowrap">{c.input_tokens != null ? `${c.input_tokens} / ${c.output_tokens}` : '—'}</td>
                <td className="px-4 py-2">{c.ok ? <span className="text-good">ok</span> : <span className="text-bad" title={c.error ?? ''}>{(c.error ?? 'error').slice(0, 60)}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
