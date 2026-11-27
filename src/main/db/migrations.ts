import type Database from 'better-sqlite3'
import { SYNC_SCHEMA_SQL, SYNC_TABLES, syncTriggersSql } from '@shared/syncTables'

/** The synced tables that existed when migration 11 rebuilt the triggers (later tables get theirs in their own migration). */
const UP_TO_11 = SYNC_TABLES.filter((t) => !t.since || t.since <= 11)

// Each entry runs once, in order. user_version tracks how many have run.
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('deck','note')),
    created_at TEXT NOT NULL
  );

  CREATE TABLE decks (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    extra_instructions TEXT NOT NULL DEFAULT '',
    model_overrides TEXT NOT NULL DEFAULT '{}',
    learn_settings TEXT,
    thresholds TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    position REAL NOT NULL DEFAULT 0,
    format TEXT NOT NULL DEFAULT 'term_definition',
    kind TEXT NOT NULL DEFAULT 'regular',
    front TEXT NOT NULL DEFAULT '',
    back TEXT NOT NULL DEFAULT '',
    language TEXT,
    options TEXT NOT NULL DEFAULT '[]',
    cloze_answers TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    hints TEXT NOT NULL DEFAULT '[]',
    explanation TEXT NOT NULL DEFAULT '',
    source TEXT,
    required_points INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX cards_deck ON cards(deck_id, position);

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT 'Untitled',
    module TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    week TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE note_decks (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, deck_id)
  );

  CREATE TABLE question_cache (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    qtype TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    preset_version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (card_id, qtype, preset_id, preset_version)
  );

  CREATE TABLE review_state (
    card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    ease REAL NOT NULL,
    interval REAL NOT NULL,
    repetitions INTEGER NOT NULL,
    lapses INTEGER NOT NULL,
    due TEXT NOT NULL,
    last_reviewed TEXT
  );

  CREATE TABLE review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    deck_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX review_log_deck ON review_log(deck_id, at);

  CREATE TABLE learn_sessions (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    settings TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    stats TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE answer_attempts (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES learn_sessions(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    qtype TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    score REAL NOT NULL,
    verdict TEXT NOT NULL,
    mark TEXT NOT NULL,
    feedback TEXT,
    overridden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attempts_card ON answer_attempts(card_id, created_at);

  CREATE TABLE explanations (
    id TEXT PRIMARY KEY,
    card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
    note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
    context TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE explain_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    explanation_id TEXT NOT NULL REFERENCES explanations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    label TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    name TEXT NOT NULL,
    builtin_key TEXT UNIQUE,
    output_mode TEXT NOT NULL,
    system TEXT NOT NULL,
    user_template TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE preset_versions (
    preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    system TEXT NOT NULL,
    user_template TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (preset_id, version)
  );

  CREATE TABLE custom_actions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'sparkles',
    prompt TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'sonnet',
    output TEXT NOT NULL DEFAULT 'markdown',
    placements TEXT NOT NULL DEFAULT '["card"]',
    builtin_key TEXT UNIQUE,
    position REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE ai_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    preset_id TEXT,
    preset_name TEXT,
    preset_version INTEGER,
    model TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    ok INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  `,
  /* 2: difficulty-based scheduler fields */ `
  ALTER TABLE review_state ADD COLUMN difficulty REAL NOT NULL DEFAULT 0.6;
  ALTER TABLE review_state ADD COLUMN sr_state INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE review_state ADD COLUMN good_count INTEGER NOT NULL DEFAULT 0;
  `,
  /* 3: courses, split into weeks */ `
  CREATE TABLE courses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    module TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT '',
    deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE weeks (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'empty',
    error TEXT,
    outline TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX weeks_course ON weeks(course_id, position);
  CREATE TABLE course_files (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    week_id TEXT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    pages INTEGER,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    week_id TEXT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    position INTEGER NOT NULL,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    error TEXT,
    content TEXT,
    progress TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX topics_week ON topics(week_id, position);
  `,
  /* 4: topics keep their notes as a note, in a folder per course */ `
  ALTER TABLE topics ADD COLUMN note_id TEXT REFERENCES notes(id) ON DELETE SET NULL;
  ALTER TABLE courses ADD COLUMN note_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
  `,
  /* 5: each course gets a deck folder, with a deck per week */ `
  ALTER TABLE courses ADD COLUMN deck_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
  ALTER TABLE weeks ADD COLUMN deck_id TEXT REFERENCES decks(id) ON DELETE SET NULL;
  `,
  /* 6: syncing with the phone app (change log filled by triggers) */ SYNC_SCHEMA_SQL,
  /* 7: recall can be turned off for a week */ `
  ALTER TABLE weeks ADD COLUMN recall_off INTEGER NOT NULL DEFAULT 0;
  `,
  /* 8: topic cards wait until you've studied them; courses have an exam date */ `
  ALTER TABLE cards ADD COLUMN dormant INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE courses ADD COLUMN exam_date TEXT;
  `,
  /* 9: a note for the AI per course; topics written at more than one level of detail; time studied */ `
  ALTER TABLE courses ADD COLUMN note TEXT NOT NULL DEFAULT '';
  ALTER TABLE topics ADD COLUMN level TEXT NOT NULL DEFAULT 'standard';
  ALTER TABLE topics ADD COLUMN versions TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE study_time (
    day TEXT NOT NULL,
    device TEXT NOT NULL,
    seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, device)
  );
  ${syncTriggersSql(SYNC_TABLES.filter((t) => t.since === 9))}
  `,
  /* 10: which model and effort planned each week and wrote each level of a topic (shown on the marketplace) */ `
  ALTER TABLE weeks ADD COLUMN planned_with TEXT;
  ALTER TABLE topics ADD COLUMN written_with TEXT NOT NULL DEFAULT '{}';
  `,
  /* 11: a change is always logged as later than the version it replaced (a phone a little behind the computer's clock lost edits) */ `
  ${UP_TO_11.flatMap((t) => ['ins', 'upd', 'del'].map((k) => `DROP TRIGGER IF EXISTS sync_${t.name}_${k};`)).join('\n  ')}
  ${syncTriggersSql(UP_TO_11)}
  `,
  /* 12: courses and weeks can be private: never published to the marketplace (a week is private if it or its course is) */ `
  ALTER TABLE courses ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE weeks ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
  `,
  /* 13: notes have a place in their folder, so they can be listed in revision order (null: made before this, listed after) */ `
  ALTER TABLE notes ADD COLUMN position REAL;
  `,
  /* 14: settings that sync, one row per entry (the marketplace's record of which weeks you added and published; see SYNCED_SETTINGS) */ `
  CREATE TABLE synced_settings (
    key TEXT NOT NULL,
    item TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (key, item)
  );
  ${syncTriggersSql(SYNC_TABLES.filter((t) => t.since === 14))}
  `,
  /* 15: a week can have an end-of-week test (multiple choice, JSON) */ `
  ALTER TABLE weeks ADD COLUMN test TEXT;
  `,
  /* 16: a course says what kind it is (theory, practical/coding, formula/method heavy: a JSON list), and every prompt for it tailors to that */ `
  ALTER TABLE courses ADD COLUMN focus TEXT NOT NULL DEFAULT '[]';
  `,
  /* 17: when writing or planning failed, and which level of detail a topic failed at: warnings go after a day, and the marketplace can fill in what's missing */ `
  ALTER TABLE topics ADD COLUMN error_at TEXT;
  ALTER TABLE topics ADD COLUMN error_level TEXT;
  ALTER TABLE weeks ADD COLUMN error_at TEXT;
  UPDATE topics SET error_at = updated_at WHERE error IS NOT NULL;
  UPDATE weeks SET error_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE error IS NOT NULL;
  `
]

export function migrate(db: Database.Database): number {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i])
      db.pragma(`user_version = ${i + 1}`)
    })()
  }
  return MIGRATIONS.length
}
