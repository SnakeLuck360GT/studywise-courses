import { useEffect, useState } from 'react'
import { GraduationCap, Plus, FileText, X, Upload, Download, Store, Copy, Merge } from 'lucide-react'
import { confirmDialog } from '../lib/dialogs'
import { importSharedWeek } from '../lib/weekShare'
import { IS_MOBILE } from '../lib/platform'
import type { CourseFocus, CourseSummary } from '@shared/course'
import { CourseFocusPicker } from '../components/CourseFocus'
import { useStore, toast } from '../lib/store'
import { api, errorText } from '../lib/api'
import { offerPlan } from '../lib/courseFlows'
import { offerMarketWeek } from '../lib/market'
import { Shell, PageTitle } from '../components/Shell'
import { PrivatePill, VisibilityField, type Visibility } from '../components/Visibility'
import { Button, Card, Empty, Field, Input, Modal, Pill, ProgressBar, Textarea } from '../components/ui'

/**
 * Courses that are in the library more than once (two devices that each had
 * them, synced together): one click makes each one course again.
 */
function DuplicateCourses() {
  const version = useStore((s) => s.version)
  const [groups, setGroups] = useState<{ name: string; courseIds: string[] }[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => void api.courses.duplicates().then(setGroups).catch(() => setGroups([])), [version])
  if (!groups.length) return null
  const extra = groups.reduce((n, g) => n + g.courseIds.length - 1, 0)
  const merge = async () => {
    const ok = await confirmDialog(
      groups.length === 1 ? `Merge the copies of ${groups[0].name}?` : `Merge the copies of these ${groups.length} courses?`,
      'These courses are here more than once, usually because two devices each had them (one downloaded them from the marketplace, say) before they were synced together. Each becomes one course again: every week, topic, depth, question and flashcard from every copy is kept. Where copies differ, Claude combines their notes, keeping every detail and taking out only what is repeated or reworded, and questions asked twice in other words are kept once. You keep whichever copy you got further in, with your card reviews. This can take a few minutes. The extra copies are removed, on your other synced devices too.',
      { confirmText: 'Merge copies' }
    )
    if (!ok) return
    setBusy(true)
    let done = 0
    try {
      for (const g of groups) {
        await api.courses.mergeCourses({ courseId: g.courseIds[0], otherIds: g.courseIds.slice(1) })
        done++
      }
      toast(done === 1 ? `${groups[0].name} is one course again.` : `${done} courses are one course each again.`, 'good')
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
      useStore.getState().bump()
    }
  }
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-[0.92rem]">
      <Copy className="size-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{extra === 1 ? 'A course is here twice' : `${extra} courses are here more than once`}</span>
        <span className="text-muted">
          : {groups.map((g) => `${g.name}${g.courseIds.length > 2 ? ` (${g.courseIds.length} copies)` : ''}`).join(', ')}. Merge them back into one each, keeping everything and your progress.
        </span>
      </span>
      <Button size="sm" loading={busy} onClick={merge}>
        <Merge className="size-4" /> Merge copies
      </Button>
    </div>
  )
}

export function Courses() {
  const go = useStore((s) => s.go)
  const version = useStore((s) => s.version)
  const openNew = useStore((s) => s.openNewCourse)
  const [courses, setCourses] = useState<CourseSummary[] | null>(null)
  useEffect(() => void api.courses.list().then(setCourses), [version])

  return (
    <Shell>
      <PageTitle
        title="Courses"
        actions={
          <>
            <Button className="desktop-only" onClick={() => go({ name: 'market' })} title="Courses other people have made">
              <Store className="size-4" /> Marketplace
            </Button>
            <Button className="desktop-only" onClick={() => void importSharedWeek()} title="Add a week a friend shared with you (.studyweek)">
              <Download className="size-4" /> Add a shared week
            </Button>
            <Button variant="primary" className="desktop-only" onClick={() => openNew([])}>
              <Plus className="size-4" /> New course
            </Button>
          </>
        }
      >
        {IS_MOBILE
          ? 'Your courses from Studywise on your computer. Learn each topic in short sections, with flashcards and questions as you go.'
          : 'Make a course for a module, then add each week’s slides, transcripts and readings as you go. Claude splits every week into topics and teaches each one in short sections, with questions as you go.'}
      </PageTitle>
      <DuplicateCourses />
      {courses && courses.length === 0 && (
        <Empty icon={<GraduationCap className="size-8" />} title="No courses yet">
          {IS_MOBILE ? (
            <p className="mb-4">Make a course in Studywise on your computer, from your lecture slides and transcripts. It shows up here when your phone syncs.</p>
          ) : (
            <>
              <p className="mb-4">Start with week 1, or with nothing at all, and add weeks as the module goes on.</p>
              <Button variant="primary" onClick={() => openNew([])}>
                <Plus className="size-4" /> New course
              </Button>
            </>
          )}
        </Empty>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {courses?.map((c) => (
          <Card key={c.id} onClick={() => go({ name: 'course', id: c.id })} className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-[1.05rem] leading-snug font-semibold">{c.name}</h3>
              <div className="flex shrink-0 items-center gap-1.5">
                {c.private && !IS_MOBILE && <PrivatePill title="Private: none of its weeks go on the marketplace." />}
                {c.planning && <Pill tone="accent">Planning…</Pill>}
              </div>
            </div>
            <div className="text-[0.88rem] text-muted">
              {c.week_count} week{c.week_count === 1 ? '' : 's'} · {c.topic_count ? `${c.topic_count} topic${c.topic_count === 1 ? '' : 's'} · ${c.done_count} done` : c.planning ? 'planning topics…' : 'no topics yet'}
            </div>
            {c.topic_count > 0 && <ProgressBar value={c.done_count / c.topic_count} />}
            {c.due_count > 0 && <div className="text-[0.85rem] font-semibold text-accent">{c.due_count} recall card{c.due_count === 1 ? '' : 's'} due</div>}
          </Card>
        ))}
      </div>
    </Shell>
  )
}

/** Picked or dropped course files, with a remove button each. */
export function FileDrop({ list, setList }: { list: string[]; setList: (f: string[]) => void }) {
  const add = (more: string[]) => setList([...new Set([...list, ...more.filter((f) => ACCEPT.test(f))])])
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border-2 border-dashed border-line bg-surface p-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        add([...e.dataTransfer.files].map((f) => window.studywise.pathForFile(f)))
      }}
    >
      {list.map((f) => (
        <div key={f} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[0.9rem]">
          <FileText className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{f.split(/[\\/]/).pop()}</span>
          <button onClick={() => setList(list.filter((x) => x !== f))} aria-label="Remove" className="text-muted hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button variant="soft" onClick={async () => add(await api.app.pickFiles({ kind: 'course' }))}>
          <Upload className="size-4" /> Add files
        </Button>
        {!list.length && <span className="text-[0.85rem] text-muted">or drop slides, transcripts and readings here</span>}
      </div>
    </div>
  )
}

const ACCEPT = /\.(pdf|docx|pptx|txt|md|markdown|vtt|srt|html?|rtf|csv|png|jpe?g|webp|gif)$/i

export function NewCourseModal() {
  const files = useStore((s) => s.newCourse)
  const open = useStore((s) => s.openNewCourse)
  const go = useStore((s) => s.go)
  const [name, setName] = useState('')
  const [level, setLevel] = useState('')
  const [weekLabel, setWeekLabel] = useState('Week 1')
  const [list, setList] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [focus, setFocus] = useState<CourseFocus[]>([])
  const [visibility, setVisibility] = useState<Visibility>('public')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!files) return
    setList(files)
    setName('')
    setWeekLabel('Week 1')
    setNote('')
    setFocus([])
    setVisibility('public')
    void api.settings.all().then((s) => setLevel(String(s['profile.level'] ?? '')))
  }, [files])

  if (!files) return null
  const close = () => open(null)
  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const c = await api.courses.create({ name: name.trim(), level: level.trim(), weekLabel: weekLabel.trim(), files: list, note, focus, private: visibility === 'private' })
      close()
      useStore.getState().bump()
      go({ name: 'course', id: c.id })
      // Files are added, not planned: ask first.
      const week = c.weeks.find((w) => w.id === c.firstWeekId)
      if (list.length && week) await offerPlan(week, { added: week.files.length })
      // No files yet: has someone already made this week of this course?
      else if (week) await offerMarketWeek(week)
    } catch (e) {
      toast(errorText(e), 'bad')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={close}
      title="New course"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
            Create course
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Module">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Software Engineering 2" onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Field>
        <Field label="Your level" hint="Used in every prompt, e.g. “second-year CS undergraduate”.">
          <Input value={level} onChange={(e) => setLevel(e.target.value)} placeholder="e.g. second-year undergraduate" />
        </Field>
        <div className="rounded-xl bg-surface-2/60 p-4">
          <div className="mb-3 text-[0.85rem] text-muted">Add the first week’s material now, or leave it and add weeks from the course page.</div>
          <Field label="First week">
            <Input value={weekLabel} onChange={(e) => setWeekLabel(e.target.value)} placeholder="Week 1" />
          </Field>
          <div className="mt-3">
            <FileDrop list={list} setList={setList} />
          </div>
        </div>
        <CourseFocusPicker value={focus} onChange={setFocus} />
        <VisibilityField what="course" value={visibility} onChange={setVisibility} />
        <Field label="Note for the AI (optional)" hint="Added to every prompt for this course. You can change it later from the course page.">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. This course is coding heavy and in C, so tailor notes to learning the theory and the coding together." />
        </Field>
      </div>
    </Modal>
  )
}
