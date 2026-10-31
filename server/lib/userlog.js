import { db } from './db.js';
import { clientIp } from './lockout.js';

/**
 * The admin's log: who signed in and from where, who was online, and what each
 * person did - every change they made, refused ones included, and every
 * export. Entries older than seven days are deleted.
 *
 * Separate from the history of each site (the activity table), which is part of
 * the project record and stays.
 */
export const KEEP_DAYS = 7;
/** Seen within this many minutes counts as online. */
export const ONLINE_MINUTES = 5;

export function logUser({ userId = null, ip = null, kind, detail = '', status = null }) {
  db.prepare('INSERT INTO user_log (user_id, ip, kind, detail, status) VALUES (?, ?, ?, ?, ?)').run(userId, ip, kind, String(detail).slice(0, 500), status);
}

export function purgeUserLog() {
  return db.prepare(`DELETE FROM user_log WHERE created_at < datetime('now', '-${KEEP_DAYS} days')`).run().changes;
}

// ---- Last seen ----------------------------------------------------------------------

/*
 * One write per person per minute at most: "online" does not need second
 * precision, and every request writing to the database would.
 */
const lastTouched = new Map();
export function touchLastSeen(userId) {
  const now = Date.now();
  if (now - (lastTouched.get(userId) ?? 0) < 60_000) return;
  lastTouched.set(userId, now);
  db.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?").run(userId);
}

// ---- What a request did, in words ---------------------------------------------------------

const domainOf = (id) => db.prepare('SELECT domain FROM sites WHERE id = ?').get(Number(id))?.domain ?? `site ${id}`;
const issueOf = (id) => {
  const row = db.prepare('SELECT title FROM issues WHERE id = ?').get(Number(id));
  return row ? `#${id} "${row.title.length > 60 ? `${row.title.slice(0, 60)}...` : row.title}"` : `issue #${id}`;
};
const userOf = (id) => db.prepare('SELECT name FROM users WHERE id = ?').get(Number(id))?.name ?? `user ${id}`;
const fieldsOf = (body) =>
  Object.keys(body ?? {})
    .filter((key) => !['expected_updated_at'].includes(key))
    .join(', ');
const count = (list) => (Array.isArray(list) ? list.length : 0);

/**
 * Worked out before the request runs, while what it touches still exists - a
 * deleted site has no name to look up afterwards.
 */
const ROUTES = [
  ['POST', /^\/api\/sites$/, (_m, b) => `added the site ${b?.domain ?? ''}`.trim()],
  ['PATCH', /^\/api\/sites\/bulk$/, (_m, b) => `edited ${count(b?.site_ids)} sites at once: ${fieldsOf(b?.changes)}`],
  ['POST', /^\/api\/sites\/bulk-delete$/, (_m, b) => (b?.dry_run ? null : `deleted ${count(b?.site_ids)} sites: ${(b?.site_ids ?? []).slice(0, 10).map(domainOf).join(', ')}`)],
  ['PATCH', /^\/api\/sites\/(\d+)$/, (m, b) => `edited ${domainOf(m[1])}: ${fieldsOf(b)}`],
  ['DELETE', /^\/api\/sites\/(\d+)$/, (m) => `deleted the site ${domainOf(m[1])}`],
  ['POST', /^\/api\/sites\/(\d+)\/messages$/, (m) => `wrote in the discussion of ${domainOf(m[1])}`],
  ['DELETE', /^\/api\/sites\/(\d+)\/messages\/\d+$/, (m) => `deleted a discussion message on ${domainOf(m[1])}`],
  ['POST', /^\/api\/sites\/(\d+)\/messages\/\d+\/restore$/, (m) => `restored a discussion message on ${domainOf(m[1])}`],
  ['POST', /^\/api\/issues$/, (_m, b) => `raised "${b?.title ?? ''}"${b?.site_id ? ` on ${domainOf(b.site_id)}` : ' (network-wide)'}`],
  ['POST', /^\/api\/issues\/bulk$/, (_m, b) => `raised "${b?.title ?? ''}" on ${count(b?.site_ids) || 'every'} sites`],
  ['PATCH', /^\/api\/issues\/(\d+)$/, (m, b) => `edited ${issueOf(m[1])}: ${fieldsOf(b)}${b?.status ? ` -> ${b.status}` : ''}`],
  ['DELETE', /^\/api\/issues\/(\d+)$/, (m) => `deleted ${issueOf(m[1])}`],
  ['POST', /^\/api\/issues\/(\d+)\/restore$/, (m) => `restored ${issueOf(m[1])}`],
  ['POST', /^\/api\/issues\/(\d+)\/comments$/, (m) => `commented on ${issueOf(m[1])}`],
  ['POST', /^\/api\/issues\/(\d+)\/attachments$/, (m) => `attached a file to ${issueOf(m[1])}`],
  ['DELETE', /^\/api\/issues\/attachments\/(\d+)$/, (m) => `deleted attachment #${m[1]}`],
  ['POST', /^\/api\/prospects\/import$/, () => 'added domains to Potential Sites'],
  ['PATCH', /^\/api\/prospects\/bulk$/, (_m, b) => `changed ${count(b?.ids)} potential sites: ${fieldsOf(b).replace(/^ids, ?/, '')}`],
  ['POST', /^\/api\/prospects\/delete$/, (_m, b) => `deleted ${count(b?.ids)} potential sites`],
  ['POST', /^\/api\/prospects\/convert$/, (_m, b) => `converted ${count(b?.ids)} potential site(s) to integration`],
  ['POST', /^\/api\/users$/, (_m, b) => `created the account ${b?.name ?? ''} <${b?.email ?? ''}> as ${b?.role ?? ''}`],
  ['PATCH', /^\/api\/users\/(\d+)$/, (m, b) => `changed the account of ${userOf(m[1])}: ${fieldsOf(b)}${'active' in (b ?? {}) ? (b.active ? ' (enabled)' : ' (disabled)') : ''}${b?.role ? ` -> ${b.role}` : ''}`],
  ['PATCH', /^\/api\/settings$/, (_m, b) => `changed settings: ${fieldsOf(b)}`],
  ['POST', /^\/api\/settings\/fx\/refresh$/, () => 'fetched the ECB rate'],
  ['POST', /^\/api\/settings\/digest\/test$/, () => 'sent a test digest'],
  ['POST', /^\/api\/settings\/mail\/test$/, () => 'sent a test e-mail'],
  ['POST', /^\/api\/settings\/blocks\/unblock$/, (_m, b) => `lifted the sign-in block on ${b?.ip ?? ''}`],
  ['POST', /^\/api\/import$/, () => 'imported sites from a sheet'],
  ['PUT', /^\/api\/notifications\/sites\/(\d+)$/, (m, b) => `turned update e-mails ${b?.watching ? 'on' : 'off'} for ${domainOf(m[1])}`],
  ['PATCH', /^\/api\/notifications\/me$/, (_m, b) => `turned all update e-mails ${b?.enabled ? 'on' : 'off'}`],
  // Reading is not logged - except taking the data away.
  ['GET', /^\/api\/export\.csv$/, () => 'exported the sites as CSV'],
  ['GET', /^\/api\/issues\/export\.csv$/, () => 'exported the issues as CSV'],
];

/** Logs signed-in changes and exports, with the outcome. Sign-ins are logged by the auth routes. */
export function userLogMiddleware(req, res, next) {
  if (!req.user || !req.path.startsWith('/api/') || req.path.startsWith('/api/auth/')) return next();
  touchLastSeen(req.user.id);

  const route = ROUTES.find(([method, pattern]) => method === req.method && pattern.test(req.path));
  let detail = null;
  if (route) {
    try {
      detail = route[2](req.path.match(route[1]), req.body);
    } catch {
      detail = `${req.method} ${req.path}`;
    }
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    detail = `${req.method} ${req.path}`;
  }
  if (!detail) return next();

  const userId = req.user.id;
  const ip = clientIp(req);
  res.on('finish', () => {
    try {
      logUser({ userId, ip, kind: 'action', detail, status: res.statusCode });
    } catch (err) {
      console.error(`User log: ${err.message}`);
    }
  });
  next();
}

export function startUserLog() {
  purgeUserLog();
  setInterval(() => {
    try {
      purgeUserLog();
    } catch (err) {
      console.error(`User log purge: ${err.message}`);
    }
  }, 3600_000).unref();
}
