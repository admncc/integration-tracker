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
  rpm_primis_currency   TEXT NOT NULL DEFAULT 'USD',
  managed_by        TEXT NOT NULL DEFAULT '',
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
  site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
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
  closed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_issues_site ON issues(site_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_batch ON issues(batch_id);

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
`);

/**
 * Migration for databases created before usernames existed: adds the column,
 * backfills it from the e-mail local part and enforces uniqueness.
 */
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
  db.exec("ALTER TABLE sites ADD COLUMN rpm_primis_currency TEXT NOT NULL DEFAULT 'USD'");
}

const issueColumns = db.prepare('PRAGMA table_info(issues)').all().map((c) => c.name);
if (!issueColumns.includes('type')) {
  db.exec("ALTER TABLE issues ADD COLUMN type TEXT NOT NULL DEFAULT 'technical'");
  db.exec("UPDATE issues SET type = 'revenue' WHERE category IN ('performance', 'fill_rate')");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_issues_type ON issues(type)');

const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('username')) {
  db.exec(`
    ALTER TABLE users ADD COLUMN username TEXT;
    UPDATE users SET username = lower(substr(email, 1, instr(email, '@') - 1)) WHERE username IS NULL;
  `);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');

/*
 * The per-site notes field became a discussion thread. Anything already written
 * there is carried over as the opening message so no context is lost, and the
 * column is left empty for the CSV importer to keep using.
 */
if (db.prepare("SELECT COUNT(*) AS n FROM sites WHERE notes != ''").get().n > 0) {
  const carried = db.prepare("SELECT id, notes FROM sites WHERE notes != ''").all();
  const insert = db.prepare('INSERT INTO site_messages (site_id, author_id, body) VALUES (?, NULL, ?)');
  const clear = db.prepare("UPDATE sites SET notes = '' WHERE id = ?");
  for (const site of carried) {
    const already = db.prepare('SELECT 1 FROM site_messages WHERE site_id = ? AND body = ?').get(site.id, site.notes);
    if (!already) insert.run(site.id, site.notes);
    clear.run(site.id);
  }
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
