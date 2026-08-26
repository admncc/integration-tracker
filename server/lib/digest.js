import { db, getSetting, setSetting } from './db.js';
import { OPEN_ISSUE_STATUSES, formatWaiting } from '../../shared/domain.js';

/**
 * A once-a-day summary posted to an incoming webhook.
 *
 * The tracker's whole value is a loop that crosses a company boundary: the
 * partner raises, a dev fixes, the partner re-checks. Every handoff needs the
 * other side to notice, and until something tells them, the mail thread stays
 * alive as the notification layer and the tracker becomes a record written
 * after the fact.
 *
 * A webhook rather than e-mail, deliberately: Slack and Teams both accept one
 * with no SMTP, no address list, no unsubscribe handling and no per-event
 * preferences - and the addresses on `users.email` are optional anyway.
 */

export const DIGEST_KEYS = {
  url: 'digest_webhook_url',
  hour: 'digest_hour',
  lastSentAt: 'digest_last_sent_at',
  lastError: 'digest_last_error',
  lastStatus: 'digest_last_status',
};

const SEND_TIMEOUT_MS = 15_000;
/** Checked every half hour; it fires on the first check inside the chosen hour. */
const TICK_MS = 30 * 60 * 1000;

export function digestState() {
  return {
    url: getSetting(DIGEST_KEYS.url, ''),
    hour: Number(getSetting(DIGEST_KEYS.hour, 8)),
    // Where this tracker answers, so the counts in the message can be links.
    public_url: getSetting('public_url', ''),
    last_sent_at: getSetting(DIGEST_KEYS.lastSentAt),
    last_error: getSetting(DIGEST_KEYS.lastError),
    last_status: getSetting(DIGEST_KEYS.lastStatus),
  };
}

/** What happened in the last 24 hours, and what is sitting still. */
export function buildDigest() {
  const open = OPEN_ISSUE_STATUSES.map(() => '?').join(',');
  const live = `i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL)`;
  const from = 'FROM issues i LEFT JOIN sites s ON s.id = i.site_id';
  const since = "datetime('now', '-1 day')";

  const count = (sql, params = []) => db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${live} AND ${sql}`).get(...params).n;

  const raised = count(`i.created_at >= ${since}`);
  const handedBack = db
    .prepare(
      `SELECT COUNT(DISTINCT ac.issue_id) AS n FROM activity ac
        WHERE ac.field = 'status' AND ac.new_value = 'ready_for_qa' AND ac.created_at >= ${since}`
    )
    .get().n;
  const verified = db
    .prepare(
      `SELECT COUNT(DISTINCT ac.issue_id) AS n FROM activity ac
        WHERE ac.field = 'status' AND ac.new_value = 'verified' AND ac.created_at >= ${since}`
    )
    .get().n;

  const waitingOnPartner = count("i.status = 'ready_for_qa'");
  const waitingOnDev = count("i.status IN ('open','in_progress')");
  const unassigned = count("i.status = 'open' AND i.assignee_id IS NULL");
  const openTotal = count(`i.status IN (${open})`, OPEN_ISSUE_STATUSES);

  const blocked = db
    .prepare(
      `SELECT i.id, i.title, i.blocked_on, i.blocked_since, s.domain ${from}
        WHERE ${live} AND i.status = 'blocked'
        ORDER BY COALESCE(i.blocked_since, i.updated_at) ASC LIMIT 5`
    )
    .all();

  const messages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM site_messages m JOIN sites s ON s.id = m.site_id
        WHERE m.deleted_at IS NULL AND s.archived = 0 AND m.created_at >= ${since}`
    )
    .get().n;

  return {
    raised, handed_back: handedBack, verified, messages,
    waiting_on_partner: waitingOnPartner, waiting_on_dev: waitingOnDev, unassigned,
    open_total: openTotal,
    blocked: blocked.map((row) => ({
      ...row,
      waiting: formatWaiting(row.blocked_since),
    })),
  };
}

/** Nothing happened and nothing is waiting - not worth a message. */
export function isQuiet(digest) {
  return (
    digest.raised === 0 &&
    digest.handed_back === 0 &&
    digest.verified === 0 &&
    digest.messages === 0 &&
    digest.waiting_on_partner === 0 &&
    digest.waiting_on_dev === 0
  );
}

/**
 * Slack and Teams both render a plain `text` field, so one shape reaches both.
 * The structured counts ride along for anything else pointed at the hook.
 */
export function digestPayload(digest, baseUrl = '') {
  const link = (path, label) => (baseUrl ? `<${baseUrl}${path}|${label}>` : label);
  const lines = [`*Integration Tracker - last 24 hours*`];

  const moved = [];
  if (digest.raised) moved.push(`${digest.raised} raised`);
  if (digest.handed_back) moved.push(`${digest.handed_back} handed back for re-check`);
  if (digest.verified) moved.push(`${digest.verified} verified`);
  if (digest.messages) moved.push(`${digest.messages} discussion message(s)`);
  lines.push(moved.length ? moved.join(' · ') : 'Nothing moved.');

  const waiting = [];
  if (digest.waiting_on_partner) waiting.push(`${link('/issues?status=ready_for_qa', `${digest.waiting_on_partner} waiting on the partner`)}`);
  if (digest.waiting_on_dev) waiting.push(`${link('/issues?status=open', `${digest.waiting_on_dev} waiting on the publisher`)}`);
  if (digest.unassigned) waiting.push(`${digest.unassigned} with nobody assigned`);
  if (waiting.length) lines.push(`Open now: ${waiting.join(' · ')}`);

  if (digest.blocked.length) {
    lines.push(`Blocked on someone else:`);
    for (const item of digest.blocked) {
      lines.push(`  • ${item.title}${item.domain ? ` (${item.domain})` : ''} - on ${item.blocked_on || 'someone outside the team'} ${item.waiting}`);
    }
  }

  return { text: lines.join('\n'), digest };
}

/** Posts the digest. A failure is recorded, never thrown. */
export async function sendDigest({ force = false } = {}) {
  const url = getSetting(DIGEST_KEYS.url, '');
  if (!url) return { ok: false, skipped: 'no webhook configured' };

  const digest = buildDigest();
  if (!force && isQuiet(digest)) {
    setSetting(DIGEST_KEYS.lastSentAt, new Date().toISOString());
    setSetting(DIGEST_KEYS.lastStatus, 'skipped - a quiet day');
    return { ok: true, skipped: 'nothing to report' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(digestPayload(digest, getSetting('public_url', ''))),
      signal: controller.signal,
    });

    setSetting(DIGEST_KEYS.lastSentAt, new Date().toISOString());
    if (!response.ok) {
      const detail = `The webhook answered ${response.status}`;
      setSetting(DIGEST_KEYS.lastError, detail);
      setSetting(DIGEST_KEYS.lastStatus, 'failed');
      return { ok: false, error: detail };
    }

    setSetting(DIGEST_KEYS.lastError, '');
    setSetting(DIGEST_KEYS.lastStatus, 'sent');
    return { ok: true, digest };
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'The webhook did not answer within 15 seconds' : String(err.message ?? err);
    setSetting(DIGEST_KEYS.lastSentAt, new Date().toISOString());
    setSetting(DIGEST_KEYS.lastError, detail);
    setSetting(DIGEST_KEYS.lastStatus, 'failed');
    return { ok: false, error: detail };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fires once per day, at the configured local hour. The "already sent today"
 * marker is a date string rather than a timer, so a restart cannot produce a
 * second digest and a machine asleep at the chosen hour still sends when it
 * wakes.
 */
export function startDailyDigest() {
  const tick = async () => {
    if (!getSetting(DIGEST_KEYS.url, '')) return;

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (getSetting('digest_last_day') === today) return;
    if (now.getHours() < Number(getSetting(DIGEST_KEYS.hour, 8))) return;

    setSetting('digest_last_day', today);
    const result = await sendDigest();
    if (!result.ok && !result.skipped) console.error(`Daily digest failed: ${result.error}`);
  };

  tick();
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  return timer;
}
