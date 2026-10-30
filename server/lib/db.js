import './env.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.DATABASE_PATH
  ? resolve(process.env.DATABASE_PATH)
  : resolve(process.cwd(), 'data/tracker.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Schema. Every migration is append-only and idempotent so `node scripts/seed.js`
 * can be run against an existing database without losing data.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','dev','partner')),
  company       TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  -- The newest discussion message this person has seen. An id, not a
  -- timestamp: both were written to the second, so a message posted in the
  -- same second as the "seen" mark was counted as already read and never
  -- shown to anyone.
  inbox_seen_message_id INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS sites (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  domain            TEXT NOT NULL UNIQUE,
  priority          INTEGER NOT NULL DEFAULT 99,
  test_url          TEXT NOT NULL DEFAULT '',
  status_video      TEXT NOT NULL DEFAULT 'pending',
  status_display    TEXT NOT NULL DEFAULT 'pending',
  status_ads_txt    TEXT NOT NULL DEFAULT 'pending',
  status_ad_tag     TEXT NOT NULL DEFAULT 'pending',
  status_mcm        TEXT NOT NULL DEFAULT 'pending',
  cmp               TEXT NOT NULL DEFAULT 'none',
  approval          TEXT NOT NULL DEFAULT 'none',
  rpm_previous          REAL,
  rpm_previous_currency TEXT NOT NULL DEFAULT 'EUR',
  rpm_primis            REAL,
  -- Both RPM columns default to the base currency. The Primis column used to
  -- default to USD, so a figure typed as euros next to a euro figure was read
  -- as dollars and the uplift beside it was wrong by the exchange rate.
  rpm_primis_currency   TEXT NOT NULL DEFAULT 'EUR',
  managed_by        TEXT NOT NULL DEFAULT '',
  -- Who is answerable for getting this domain live. A real person in the tool,
  -- on either side: Primis own their steps of the rollout as much as the
  -- publisher's team does. managed_by stays what it was - a free-text note for
  -- work that happens outside the tracker altogether.
  owner_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes             TEXT NOT NULL DEFAULT '',
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sites_priority ON sites(priority, domain);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS issues (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL means the issue is network-wide: it belongs to no single domain and
  -- is ticked off once for the whole network (an ads.txt line, an MCM change).
  site_id      INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  batch_id     INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'technical',
  category     TEXT NOT NULL DEFAULT 'other',
  severity     TEXT NOT NULL DEFAULT 'medium',
  status       TEXT NOT NULL DEFAULT 'open',
  reporter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT,
  closed_at    TEXT,
  deleted_at   TEXT,
  deleted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Only meaningful while status = 'blocked': who the work waits on, and since
  -- when. Kept after the block clears, so the history still shows what happened.
  blocked_on   TEXT NOT NULL DEFAULT '',
  blocked_since TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_site ON issues(site_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id   INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);

CREATE TABLE IF NOT EXISTS site_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reply_to_id INTEGER REFERENCES site_messages(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_messages_site ON site_messages(site_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  comment_id  INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_issue ON attachments(issue_id);
CREATE INDEX IF NOT EXISTS idx_attachments_comment ON attachments(comment_id);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id    INTEGER REFERENCES sites(id) ON DELETE CASCADE,
  issue_id   INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL,
  field      TEXT,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_site ON activity(site_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_issue ON activity(issue_id, id DESC);

-- Potential projects: candidate domains, before any of them becomes a site.
CREATE TABLE IF NOT EXISTS prospects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  domain         TEXT NOT NULL UNIQUE,
  project_status TEXT NOT NULL DEFAULT 'new',
  domain_status  TEXT NOT NULL DEFAULT 'new',
  -- Marked as high potential: highlighted and kept at the top of the list.
  high_potential INTEGER NOT NULL DEFAULT 0,
  added_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/*
 * Columns that the CREATE TABLE blocks above cannot add to a database that
 * already exists, and that a later migration or index depends on. They come
 * first, so nothing downstream names a column that is not there yet - an index
 * on issues.batch_id used to sit inside the CREATE TABLE block and take the
 * whole boot down with "no such column" on any database predating it.
 *
 * Columns whose migration also backfills data keep their own block below.
 */
const LATE_COLUMNS = [
  ['issues', 'batch_id', 'INTEGER REFERENCES batches(id) ON DELETE SET NULL'],
  ['site_messages', 'reply_to_id', 'INTEGER REFERENCES site_messages(id) ON DELETE SET NULL'],
  // Who the work is waiting on, and since when.
  ['issues', 'blocked_on', "TEXT NOT NULL DEFAULT ''"],
  ['issues', 'blocked_since', 'TEXT'],
  // The newest discussion message this person has seen.
  ['users', 'inbox_seen_message_id', 'INTEGER NOT NULL DEFAULT 0'],
  // Who is answerable for the domain.
  ['sites', 'owner_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  // The single prospect status became two.
  ['prospects', 'project_status', "TEXT NOT NULL DEFAULT 'new'"],
  ['prospects', 'domain_status', "TEXT NOT NULL DEFAULT 'new'"],
  ['prospects', 'high_potential', 'INTEGER NOT NULL DEFAULT 0'],
];

for (const [table, column, definition] of LATE_COLUMNS) {
  const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Renames the earlier generic RPM columns onto the two the team actually enters. */
const siteColumns = db.prepare('PRAGMA table_info(sites)').all().map((c) => c.name);
if (siteColumns.includes('rpm_benchmark') && !siteColumns.includes('rpm_previous')) {
  db.exec('ALTER TABLE sites RENAME COLUMN rpm_benchmark TO rpm_previous');
}
if (siteColumns.includes('rpm_current') && !siteColumns.includes('rpm_primis')) {
  db.exec('ALTER TABLE sites RENAME COLUMN rpm_current TO rpm_primis');
}

/** The two RPM figures are reported in different currencies by the two partners. */
if (!siteColumns.includes('rpm_previous_currency')) {
  db.exec("ALTER TABLE sites ADD COLUMN rpm_previous_currency TEXT NOT NULL DEFAULT 'EUR'");
}
if (!siteColumns.includes('rpm_primis_currency')) {
  db.exec("ALTER TABLE sites ADD COLUMN rpm_primis_currency TEXT NOT NULL DEFAULT 'EUR'");
}

/*
 * Deleting an issue hides it rather than erasing it: the history has to keep
 * showing that it existed, and a wrong delete has to be reversible.
 */
/*
 * A deleted discussion message is tombstoned rather than removed. The reply
 * that quotes it keeps its thread: erasing the row set reply_to_id to NULL and
 * the quote block vanished, leaving the answer with no question.
 */
const messageCols = db.prepare('PRAGMA table_info(site_messages)').all().map((c) => c.name);
if (!messageCols.includes('deleted_at')) {
  db.exec('ALTER TABLE site_messages ADD COLUMN deleted_at TEXT');
}

const issueCols = db.prepare('PRAGMA table_info(issues)').all().map((c) => c.name);
if (!issueCols.includes('deleted_at')) {
  db.exec('ALTER TABLE issues ADD COLUMN deleted_at TEXT');
  db.exec('ALTER TABLE issues ADD COLUMN deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_issues_deleted ON issues(deleted_at)');

const issueColumns = db.prepare('PRAGMA table_info(issues)').all().map((c) => c.name);
if (!issueColumns.includes('type')) {
  db.exec("ALTER TABLE issues ADD COLUMN type TEXT NOT NULL DEFAULT 'technical'");
  db.exec("UPDATE issues SET type = 'revenue' WHERE category IN ('performance', 'fill_rate')");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_issues_type ON issues(type)');

/*
 * Network-wide issues live in the same table with no site attached, so every
 * filter, comment and attachment keeps working on them. SQLite cannot drop a
 * NOT NULL, so the table is rebuilt once.
 */
const siteIdRequired = db.prepare('PRAGMA table_info(issues)').all().find((c) => c.name === 'site_id')?.notnull;
if (siteIdRequired) {
  const columns = [
    'id', 'site_id', 'batch_id', 'title', 'description', 'type', 'category', 'severity', 'status',
    'reporter_id', 'assignee_id', 'due_date', 'created_at', 'updated_at', 'resolved_at', 'closed_at',
    'deleted_at', 'deleted_by', 'blocked_on', 'blocked_since',
  ]
    .filter((column) => db.prepare('PRAGMA table_info(issues)').all().some((c) => c.name === column))
    .join(', ');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE issues_rebuilt (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id      INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      batch_id     INTEGER REFERENCES batches(id) ON DELETE SET NULL,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      type         TEXT NOT NULL DEFAULT 'technical',
      category     TEXT NOT NULL DEFAULT 'other',
      severity     TEXT NOT NULL DEFAULT 'medium',
      status       TEXT NOT NULL DEFAULT 'open',
      reporter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date     TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at  TEXT,
      closed_at    TEXT,
      deleted_at   TEXT,
      deleted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      blocked_on   TEXT NOT NULL DEFAULT '',
      blocked_since TEXT
    );
    INSERT INTO issues_rebuilt (${columns}) SELECT ${columns} FROM issues;
    DROP TABLE issues;
    ALTER TABLE issues_rebuilt RENAME TO issues;
    CREATE INDEX idx_issues_site ON issues(site_id);
    CREATE INDEX idx_issues_status ON issues(status);
    CREATE INDEX idx_issues_batch ON issues(batch_id);
    CREATE INDEX idx_issues_deleted ON issues(deleted_at);
    CREATE INDEX idx_issues_type ON issues(type);
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}

const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('username')) {
  db.exec(`
    ALTER TABLE users ADD COLUMN username TEXT;
    UPDATE users SET username = lower(substr(email, 1, instr(email, '@') - 1)) WHERE username IS NULL;
  `);
}

/*
 * Two people at the two companies - qa@publisher.test and qa@primis.com - back
 * fill to the same username, and the unique index below then threw on every
 * boot for ever after. Under `Restart=always` that is a permanent crash loop
 * with nothing in the UI or the docs to fix it, so the collisions are resolved
 * here instead: the oldest account keeps the plain name, the others get their
 * company or their id appended.
 */
for (const clash of db
  .prepare('SELECT username FROM users WHERE username IS NOT NULL GROUP BY username HAVING COUNT(*) > 1')
  .all()) {
  const rows = db.prepare('SELECT id, username, company FROM users WHERE username = ? ORDER BY id').all(clash.username);
  for (const row of rows.slice(1)) {
    const suffix = String(row.company ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let candidate = suffix ? `${row.username}-${suffix}` : `${row.username}-${row.id}`;
    if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(candidate, row.id)) {
      candidate = `${row.username}-${row.id}`;
    }
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(candidate, row.id);
    console.warn(`Renamed duplicate username "${row.username}" to "${candidate}" (user ${row.id}).`);
  }
}

// A user with no e-mail to derive from would otherwise be NULL, and several
// NULLs do not collide in SQLite - but they cannot sign in either.
for (const row of db.prepare('SELECT id FROM users WHERE username IS NULL OR username = ?').all('').concat()) {
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(`user-${row.id}`, row.id);
  console.warn(`User ${row.id} had no username; set to "user-${row.id}".`);
}

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');

/*
 * Indexes on columns that only exist after a migration. They cannot live in the
 * CREATE TABLE block above: `CREATE TABLE IF NOT EXISTS` is a no-op on an
 * existing table, so an index naming a column that table does not have yet
 * failed with "no such column" and took the boot down before the migration that
 * adds it ever ran.
 */
db.exec('CREATE INDEX IF NOT EXISTS idx_issues_batch ON issues(batch_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sites_owner ON sites(owner_id)');

/*
 * Potential projects first had one status (NEW / MOSTLY BLOCKED / REMOVED);
 * it split into a project status and a domain status. Each old value goes to
 * the question it was answering: REMOVED was about the project, MOSTLY BLOCKED
 * about the domain. Runs once; the old column is left in place, unread.
 */
const prospectColumns = db.prepare('PRAGMA table_info(prospects)').all().map((c) => c.name);
if (prospectColumns.includes('status') && !getSetting('prospect_status_split')) {
  db.exec(`
    UPDATE prospects SET project_status = 'removed' WHERE status = 'removed';
    UPDATE prospects SET domain_status = 'mostly_blocked' WHERE status = 'mostly_blocked';
  `);
  setSetting('prospect_status_split', '1');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_prospects_project ON prospects(project_status)');
db.exec('CREATE INDEX IF NOT EXISTS idx_prospects_domain ON prospects(domain_status)');

/*
 * Rows created under the old USD default that nobody has entered a figure for
 * yet. Leaving them would mean the next number typed into an empty cell is
 * still read as dollars. Rows that already carry a value are left alone - that
 * currency was a real choice.
 */
db.prepare("UPDATE sites SET rpm_primis_currency = 'EUR' WHERE rpm_primis IS NULL AND rpm_primis_currency = 'USD'").run();

/*
 * Nobody should meet the whole discussion history as unread on the day this
 * ships, so everyone starts level with what is already there.
 */
if (!getSetting('inbox_baseline_set')) {
  db.exec('UPDATE users SET inbox_seen_message_id = (SELECT COALESCE(MAX(id), 0) FROM site_messages)');
  setSetting('inbox_baseline_set', '1');
}

/*
 * The per-site notes field became a discussion thread. Anything already written
 * there is carried over as the opening message, once. This used to run on every
 * boot, so a note written through the API afterwards was silently emptied by the
 * next restart.
 */
const NOTES_MIGRATED = 'notes_migrated_to_discussion';
const notesAlreadyMigrated = db.prepare('SELECT value FROM settings WHERE key = ?').get(NOTES_MIGRATED)?.value === '1';
if (!notesAlreadyMigrated) {
  const carried = db.prepare("SELECT id, notes FROM sites WHERE notes != ''").all();
  const insert = db.prepare('INSERT INTO site_messages (site_id, author_id, body) VALUES (?, NULL, ?)');
  const clear = db.prepare("UPDATE sites SET notes = '' WHERE id = ?");
  for (const site of carried) {
    const already = db.prepare('SELECT 1 FROM site_messages WHERE site_id = ? AND body = ?').get(site.id, site.notes);
    if (!already) insert.run(site.id, site.notes);
    clear.run(site.id);
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(NOTES_MIGRATED, '1');
}

/** Small key/value store for the handful of instance-wide settings. */
export function getSetting(key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, String(value));
}

/** Records a single field change / event on the audit trail. */
export function logActivity({ siteId = null, issueId = null, actorId = null, kind, field = null, oldValue = null, newValue = null }) {
  db.prepare(
    `INSERT INTO activity (site_id, issue_id, actor_id, kind, field, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(siteId, issueId, actorId, kind, field, oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue));
}

export { DB_PATH };
