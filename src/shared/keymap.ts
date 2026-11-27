// One keymap for the whole app. The main process builds the menu bar from the
// `menu` entries, the renderer uses the same list for the command palette and
// the shortcut cheat sheet.

export type MenuName = 'File' | 'Edit' | 'View' | 'Study' | 'Go' | 'AI' | 'Window' | 'Help'

export interface Command {
  id: string
  label: string
  /** Electron accelerator, used for the menu bar and shown in the UI. */
  accelerator?: string
  /** Extra in-app keys (not in the menu), e.g. "g d" sequences or single keys. */
  keys?: string[]
  menu?: MenuName
  /** Where the in-app keys work. */
  scope?: 'global' | 'deck' | 'flashcards' | 'learn' | 'note' | 'generator' | 'explain'
  group: string
  separatorBefore?: boolean
}

export const COMMANDS: Command[] = [
  // File
  { id: 'card.new', label: 'New Card', accelerator: 'CmdOrCtrl+N', menu: 'File', group: 'Create' },
  { id: 'note.new', label: 'New Note', accelerator: 'Shift+CmdOrCtrl+N', menu: 'File', group: 'Create' },
  { id: 'deck.new', label: 'New Deck', accelerator: 'Alt+CmdOrCtrl+N', menu: 'File', group: 'Create' },
  { id: 'folder.new', label: 'New Folder', accelerator: 'Shift+Alt+CmdOrCtrl+N', menu: 'File', group: 'Create' },
  { id: 'gen.cards', label: 'Generate Flashcards with AI…', accelerator: 'CmdOrCtrl+G', menu: 'File', group: 'AI', separatorBefore: true },
  { id: 'gen.notes', label: 'Generate Notes with AI…', accelerator: 'Shift+CmdOrCtrl+G', menu: 'File', group: 'AI' },
  { id: 'io.importCards', label: 'Import Cards…', accelerator: 'CmdOrCtrl+I', menu: 'File', group: 'Import / export', separatorBefore: true },
  { id: 'io.importDeck', label: 'Import Deck as New…', accelerator: 'Shift+CmdOrCtrl+I', menu: 'File', group: 'Import / export' },
  { id: 'io.importNotes', label: 'Import Notes (Markdown / Notion)…', accelerator: 'Alt+CmdOrCtrl+I', menu: 'File', group: 'Import / export' },
  { id: 'io.exportTxt', label: 'Export Deck as StudySmarter Text…', accelerator: 'Shift+CmdOrCtrl+E', menu: 'File', group: 'Import / export' },
  { id: 'io.exportXlsx', label: 'Export Deck as StudySmarter Excel…', accelerator: 'Alt+Shift+CmdOrCtrl+E', menu: 'File', group: 'Import / export' },
  { id: 'io.exportJson', label: 'Export Deck as JSON…', menu: 'File', group: 'Import / export' },
  { id: 'io.exportCsv', label: 'Export Deck as CSV…', menu: 'File', group: 'Import / export' },
  { id: 'io.exportNote', label: 'Export Note as Markdown…', menu: 'File', group: 'Import / export' },
  { id: 'app.backup', label: 'Back Up Library…', accelerator: 'Shift+CmdOrCtrl+B', menu: 'File', group: 'Library', separatorBefore: true },
  { id: 'app.restore', label: 'Restore Library…', menu: 'File', group: 'Library' },
  { id: 'app.showData', label: 'Show Data Folder', menu: 'File', group: 'Library' },

  // Edit (role items are added by the menu builder)
  { id: 'search', label: 'Search', accelerator: 'CmdOrCtrl+F', keys: ['/'], menu: 'Edit', group: 'Navigate', separatorBefore: true },
  { id: 'palette', label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', keys: ['CmdOrCtrl+P'], menu: 'Edit', group: 'Navigate' },
  { id: 'selection.all', label: 'Select All Cards', accelerator: 'Alt+CmdOrCtrl+A', menu: 'Edit', group: 'Deck', scope: 'deck' },
  { id: 'selection.delete', label: 'Delete Selected', accelerator: 'Shift+CmdOrCtrl+Backspace', menu: 'Edit', group: 'Deck', scope: 'deck' },
  { id: 'selection.move', label: 'Move Selected to Deck…', accelerator: 'Shift+CmdOrCtrl+M', menu: 'Edit', group: 'Deck', scope: 'deck' },
  { id: 'item.rename', label: 'Rename', accelerator: 'CmdOrCtrl+R', menu: 'Edit', group: 'Deck' },
  { id: 'item.duplicate', label: 'Duplicate Card', accelerator: 'CmdOrCtrl+D', menu: 'Edit', group: 'Deck', scope: 'deck' },
  { id: 'note.save', label: 'Save Note', accelerator: 'CmdOrCtrl+S', menu: 'Edit', group: 'Notes', scope: 'note' },

  // View
  { id: 'view.sidebar', label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', menu: 'View', group: 'View' },
  { id: 'view.jobs', label: 'Show Jobs', accelerator: 'CmdOrCtrl+J', menu: 'View', group: 'View' },
  { id: 'view.explain', label: 'Toggle Explain Panel', accelerator: 'Alt+CmdOrCtrl+E', menu: 'View', group: 'View' },
  { id: 'view.preview', label: 'Toggle Note Preview', accelerator: 'Shift+CmdOrCtrl+P', menu: 'View', group: 'Notes', scope: 'note' },
  { id: 'view.focus', label: 'Focus Mode', accelerator: 'Shift+CmdOrCtrl+F', menu: 'View', group: 'View' },
  { id: 'view.offline', label: 'Offline Mode (No AI)', menu: 'View', group: 'View' },
  { id: 'view.theme', label: 'Cycle Theme (System / Light / Dark)', accelerator: 'Shift+CmdOrCtrl+L', menu: 'View', group: 'View' },
  { id: 'view.zoomIn', label: 'Larger Text', accelerator: 'CmdOrCtrl+=', menu: 'View', group: 'View', separatorBefore: true },
  { id: 'view.zoomOut', label: 'Smaller Text', accelerator: 'CmdOrCtrl+-', menu: 'View', group: 'View' },
  { id: 'view.zoomReset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', menu: 'View', group: 'View' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', keys: ['?'], menu: 'View', group: 'Help', separatorBefore: true },

  // Go
  { id: 'go.home', label: 'Home', accelerator: 'CmdOrCtrl+1', keys: ['g h'], menu: 'Go', group: 'Go to' },
  { id: 'go.courses', label: 'Courses', keys: ['g c'], menu: 'Go', group: 'Go to' },
  { id: 'go.tracker', label: 'Tracker', keys: ['g t'], menu: 'Go', group: 'Go to' },
  { id: 'go.market', label: 'Marketplace', keys: ['g k'], menu: 'Go', group: 'Go to' },
  { id: 'go.decks', label: 'Decks', accelerator: 'CmdOrCtrl+2', keys: ['g d'], menu: 'Go', group: 'Go to' },
  { id: 'go.notes', label: 'Notes', accelerator: 'CmdOrCtrl+3', keys: ['g n'], menu: 'Go', group: 'Go to' },
  { id: 'go.jobs', label: 'Settings › Jobs', accelerator: 'CmdOrCtrl+4', keys: ['g j'], menu: 'Go', group: 'Go to' },
  { id: 'go.settings', label: 'Settings', accelerator: 'CmdOrCtrl+,', keys: ['g s'], menu: 'Go', group: 'Go to' },
  { id: 'go.back', label: 'Back', accelerator: 'CmdOrCtrl+[', menu: 'Go', group: 'Go to', separatorBefore: true },
  { id: 'go.forward', label: 'Forward', accelerator: 'CmdOrCtrl+]', menu: 'Go', group: 'Go to' },
  { id: 'go.nextDeck', label: 'Next Deck / Note', accelerator: 'Alt+CmdOrCtrl+Down', menu: 'Go', group: 'Go to' },
  { id: 'go.prevDeck', label: 'Previous Deck / Note', accelerator: 'Alt+CmdOrCtrl+Up', menu: 'Go', group: 'Go to' },
  { id: 'go.prompts', label: 'Settings › Prompts', keys: ['g p'], group: 'Go to' },
  { id: 'go.models', label: 'Settings › Models', keys: ['g m'], group: 'Go to' },
  { id: 'go.usage', label: 'Settings › AI usage', keys: ['g u'], group: 'Go to' },
  { id: 'go.actions', label: 'Settings › Custom actions', keys: ['g a'], group: 'Go to' },

  // Study
  { id: 'study.learn', label: 'Start Learn', accelerator: 'CmdOrCtrl+L', menu: 'Study', group: 'Study' },
  { id: 'study.flashcards', label: 'Start Flashcards (Due)', accelerator: 'CmdOrCtrl+Y', menu: 'Study', group: 'Study' },
  { id: 'study.cram', label: 'Flashcards: All Cards', accelerator: 'Shift+CmdOrCtrl+Y', menu: 'Study', group: 'Study' },
  { id: 'study.learnWeak', label: 'Learn Weakest Cards', accelerator: 'Shift+CmdOrCtrl+W', menu: 'Study', group: 'Study' },
  { id: 'study.end', label: 'End Session', accelerator: 'CmdOrCtrl+.', keys: ['Escape'], menu: 'Study', group: 'Study' },
  { id: 'study.flip', label: 'Flip Card', keys: ['Space', 'f', 'ArrowUp', 'ArrowDown'], scope: 'flashcards', group: 'Flashcards' },
  { id: 'study.again', label: 'Red: didn’t know', keys: ['1', 'ArrowLeft'], scope: 'flashcards', group: 'Flashcards' },
  { id: 'study.hard', label: 'Yellow: sort of', keys: ['2'], scope: 'flashcards', group: 'Flashcards' },
  { id: 'study.good', label: 'Green: knew it', keys: ['3', 'ArrowRight'], scope: 'flashcards', group: 'Flashcards' },
  { id: 'study.easy', label: 'Green (also 4)', keys: ['4'], scope: 'flashcards', group: 'Flashcards' },
  { id: 'study.undo', label: 'Undo Last Rating', keys: ['CmdOrCtrl+Z', 'u'], scope: 'flashcards', group: 'Flashcards' },
  { id: 'study.editCard', label: 'Edit Current Card', keys: ['e'], scope: 'flashcards', group: 'Flashcards' },
  { id: 'learn.submit', label: 'Submit / Continue', keys: ['Enter'], scope: 'learn', group: 'Learn' },
  { id: 'learn.option', label: 'Pick Option 1–4 / A–D', keys: ['1', '2', '3', '4', 'a', 'b', 'c', 'd'], scope: 'learn', group: 'Learn' },
  { id: 'learn.true', label: 'True', keys: ['t'], scope: 'learn', group: 'Learn' },
  { id: 'learn.false', label: 'False', keys: ['f'], scope: 'learn', group: 'Learn' },
  { id: 'learn.hint', label: 'Hint', accelerator: 'Shift+CmdOrCtrl+H', keys: ['h'], menu: 'Study', group: 'Learn', separatorBefore: true },
  { id: 'learn.feedback', label: 'Get Feedback', keys: ['w'], scope: 'learn', group: 'Learn' },
  { id: 'learn.skip', label: 'Skip Question', accelerator: 'Alt+CmdOrCtrl+Right', keys: ['s'], menu: 'Study', group: 'Learn' },
  { id: 'learn.override', label: 'I Was Right', accelerator: 'Shift+CmdOrCtrl+R', keys: ['r'], menu: 'Study', group: 'Learn' },
  { id: 'learn.regenerate', label: 'Regenerate Question', accelerator: 'Alt+CmdOrCtrl+R', menu: 'Study', group: 'Learn' },
  { id: 'learn.settings', label: 'Learn Settings…', accelerator: 'Alt+CmdOrCtrl+,', menu: 'Study', group: 'Learn' },

  // AI
  { id: 'ai.explain', label: 'Explain', accelerator: 'CmdOrCtrl+E', menu: 'AI', group: 'AI' },
  { id: 'ai.simpler', label: 'Explain Simpler', keys: ['Alt+1'], scope: 'explain', group: 'Explain' },
  { id: 'ai.deeper', label: 'Go Deeper', keys: ['Alt+2'], scope: 'explain', group: 'Explain' },
  { id: 'ai.example', label: 'Give an Example', keys: ['Alt+3'], scope: 'explain', group: 'Explain' },
  { id: 'ai.diagram', label: 'Show a Diagram', keys: ['Alt+4'], scope: 'explain', group: 'Explain' },
  { id: 'ai.whyWrong', label: 'Why Is My Answer Wrong', keys: ['Alt+5'], scope: 'explain', group: 'Explain' },
  { id: 'ai.saveExplanation', label: 'Save Explanation to Card', accelerator: 'Alt+CmdOrCtrl+S', menu: 'AI', group: 'Explain' },
  { id: 'ai.simplify', label: 'Simplify Selection', accelerator: 'Alt+CmdOrCtrl+1', menu: 'AI', group: 'Note AI', scope: 'note', separatorBefore: true },
  { id: 'ai.expand', label: 'Expand Selection', accelerator: 'Alt+CmdOrCtrl+2', menu: 'AI', group: 'Note AI', scope: 'note' },
  { id: 'ai.shorten', label: 'Shorten Selection', accelerator: 'Alt+CmdOrCtrl+3', menu: 'AI', group: 'Note AI', scope: 'note' },
  { id: 'ai.fixFormatting', label: 'Fix Formatting', accelerator: 'Alt+CmdOrCtrl+4', menu: 'AI', group: 'Note AI', scope: 'note' },
  { id: 'ai.cardsFromSelection', label: 'Make Flashcards from Selection', accelerator: 'Alt+CmdOrCtrl+G', menu: 'AI', group: 'Note AI', scope: 'note' },
  { id: 'ai.quizSelection', label: 'Quiz Me on Selection', accelerator: 'Alt+CmdOrCtrl+Q', menu: 'AI', group: 'Note AI', scope: 'note' },
  { id: 'ai.cardsFromNote', label: 'Generate Flashcards from This Note', accelerator: 'Shift+Alt+CmdOrCtrl+G', menu: 'AI', group: 'Note AI', scope: 'note' },
  { id: 'ai.cancelAll', label: 'Cancel All Jobs', accelerator: 'Shift+CmdOrCtrl+.', menu: 'AI', group: 'AI', separatorBefore: true },

  // Lists
  { id: 'list.down', label: 'Next Item', keys: ['j', 'ArrowDown'], scope: 'deck', group: 'Lists' },
  { id: 'list.up', label: 'Previous Item', keys: ['k', 'ArrowUp'], scope: 'deck', group: 'Lists' },
  { id: 'list.open', label: 'Open / Edit Item', keys: ['Enter', 'o'], scope: 'deck', group: 'Lists' },
  { id: 'list.toggle', label: 'Select Item', keys: ['x'], scope: 'deck', group: 'Lists' },
  { id: 'list.explain', label: 'Explain Item', keys: ['e'], scope: 'deck', group: 'Lists' },
  { id: 'list.delete', label: 'Delete Item', keys: ['Backspace', 'Delete'], scope: 'deck', group: 'Lists' },

  // Generator
  { id: 'gen.submit', label: 'Generate', keys: ['CmdOrCtrl+Enter'], scope: 'generator', group: 'Generator' },
  { id: 'gen.saveAll', label: 'Save Cards to Deck', keys: ['CmdOrCtrl+S'], scope: 'generator', group: 'Generator' },
  { id: 'gen.fixAll', label: 'Fix All Warnings with AI', keys: ['Alt+CmdOrCtrl+F'], scope: 'generator', group: 'Generator' },

  // Help
  { id: 'help.readme', label: 'Studywise Help', menu: 'Help', group: 'Help' },
  { id: 'help.claude', label: 'Claude Code Setup…', menu: 'Help', group: 'Help' },
  { id: 'help.onboarding', label: 'Show Onboarding', menu: 'Help', group: 'Help' }
]

export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]))

export const IS_MAC: boolean =
  typeof navigator !== 'undefined' ? /Mac/i.test(navigator.platform || navigator.userAgent) : typeof process !== 'undefined' && process.platform === 'darwin'

/** Turn Mac key symbols in a label into Windows/Linux names (no-op on a Mac). */
export function keyLabel(s: string): string {
  if (IS_MAC) return s
  return s
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌃/g, 'Ctrl+')
    .replace(/⌫/g, 'Backspace')
    .replace(/⌦/g, 'Delete')
    .replace(/↩/g, 'Enter')
    .replace(/\+\+/g, '+')
}

/** Pretty-print an accelerator or key for the UI (Mac symbols on a Mac, Ctrl+… elsewhere). */
export function prettyKey(k: string): string {
  return keyLabel(prettyMac(k))
}

function prettyMac(k: string): string {
  if (k.includes(' ') && !k.includes('+')) return k.split(' ').map(prettyMac).join(' then ')
  return k
    .split('+')
    .map((p) => {
      switch (p) {
        case 'CmdOrCtrl':
        case 'Cmd':
        case 'Command':
          return '⌘'
        case 'Shift':
          return '⇧'
        case 'Alt':
        case 'Option':
          return '⌥'
        case 'Ctrl':
        case 'Control':
          return '⌃'
        case 'Enter':
          return '↩'
        case 'Backspace':
          return '⌫'
        case 'Delete':
          return '⌦'
        case 'Escape':
          return 'esc'
        case 'Space':
          return 'Space'
        case 'Up':
        case 'ArrowUp':
          return '↑'
        case 'Down':
        case 'ArrowDown':
          return '↓'
        case 'Left':
        case 'ArrowLeft':
          return '←'
        case 'Right':
        case 'ArrowRight':
          return '→'
        default:
          return p.length === 1 ? p.toUpperCase() : p
      }
    })
    .join('')
}

/** Does a keyboard event match an accelerator-style string like "Shift+CmdOrCtrl+K"? */
export function matchesKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code?: string }, k: string): boolean {
  const parts = k.split('+')
  const key = parts.pop()!
  const wantCmd = parts.includes('CmdOrCtrl') || parts.includes('Cmd')
  const wantShift = parts.includes('Shift')
  const wantAlt = parts.includes('Alt')
  // CmdOrCtrl is ⌘ on a Mac and Ctrl elsewhere.
  const primary = IS_MAC ? e.metaKey : e.ctrlKey
  if (primary !== wantCmd) return false
  if (e.altKey !== wantAlt) return false
  const ek = e.key === ' ' ? 'Space' : e.key
  const sameKey = ek.toLowerCase() === key.toLowerCase() || (wantAlt && e.code === `Digit${key}`) || (wantAlt && e.code === `Key${key.toUpperCase()}`)
  // Shift is implied for "?" etc.
  if (key.length === 1 && !/[a-z0-9]/i.test(key)) return sameKey
  if (e.shiftKey !== wantShift) return false
  return sameKey
}
