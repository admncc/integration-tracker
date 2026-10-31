import { randomBytes } from 'node:crypto';
import { db, onActivity } from './db.js';
import { mailConfigured, sendMail } from './mail.js';
import { publicUrl } from './login.js';
import { APPROVAL, CMP, DEMAND_BLOCK, ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, SEVERITY, TRACK_STATUS } from '../../shared/domain.js';

/**
 * Update e-mails about a site.
 *
 * Who hears about a site:
 *  - anybody who has done something on it - changed a value, raised an issue,
 *    commented, written in the discussion - from that moment on;
 *  - whoever is made responsible for it, or is assigned an issue on it;
 *  - the publisher's admins, for every site, without having to do anything.
 * Everyone can opt out of one site from the link in the e-mail, or of all
 * update e-mails. An opt-out sticks: doing something on the site again does not
 * sign the person back up - the site's page has a switch for that.
 *
 * Changes are collected for a few minutes and go out as one e-mail per person,
 * so a sweep across forty domains is one message, not forty. Nobody is told
 * about their own changes.
 */

/** Minutes a change waits for others to join it in the same e-mail. */
const BATCH_MINUTES = Number(process.env.NOTIFY_BATCH_MINUTES ?? 3);
/** How often the queue is looked at. */
const CHECK_SECONDS = Number(process.env.NOTIFY_CHECK_SECONDS ?? 30);
/** Lines that could not be sent for this long are given up on. */
const GIVE_UP_HOURS = 24;

// ---- Who watches ------------------------------------------------------------------

/** Signs somebody up for a site, unless they opted out of it before. */
export function watch(siteId, userId, reason) {
  if (!siteId || !userId) return;
  db.prepare('INSERT OR IGNORE INTO site_watchers (site_id, user_id, watching, reason) VALUES (?, ?, 1, ?)').run(siteId, userId, reason);
}

/** The switch on the site's page and the opt-out link: an explicit choice, so it overrides. */
export function setWatching(siteId, userId, watching) {
  db.prepare(
    `INSERT INTO site_watchers (site_id, user_id, watching, reason) VALUES (?, ?, ?, 'chosen')
     ON CONFLICT(site_id, user_id) DO UPDATE SET watching = excluded.watching, updated_at = datetime('now')`
  ).run(siteId, userId, watching ? 1 : 0);
  if (!watching) db.prepare('DELETE FROM notification_queue WHERE site_id = ? AND user_id = ?').run(siteId, userId);
}

/*
 * The one rule for "does this person get e-mails about this site", used both
 * when a change is queued and when the e-mail goes out - an opt-out in between
 * must win. Placeholder addresses (*.test) are left out; they cannot receive.
 */
const RECIPIENT_RULE = `
  u.active = 1 AND u.notify_enabled = 1
  AND u.email IS NOT NULL AND u.email != '' AND lower(u.email) NOT LIKE '%.test'
  AND (w.watching = 1 OR (w.watching IS NULL AND u.role = 'admin'))`;

function recipients(siteId, actorId) {
  return db
    .prepare(
      `SELECT u.id FROM users u
         LEFT JOIN site_watchers w ON w.user_id = u.id AND w.site_id = ?
        WHERE ${RECIPIENT_RULE} AND u.id IS NOT ?`
    )
    .all(siteId, actorId ?? null)
    .map((row) => row.id);
}

/** Whether this person gets e-mails about this site - for the switch on its page. */
export function isWatching(siteId, userId) {
  const row = db
    .prepare(
      `SELECT u.notify_enabled, u.role, w.watching FROM users u
         LEFT JOIN site_watchers w ON w.user_id = u.id AND w.site_id = ? WHERE u.id = ?`
    )
    .get(siteId, userId);
  if (!row) return false;
  return row.watching === 1 || (row.watching == null && row.role === 'admin');
}

// ---- What happened, in words ----------------------------------------------------------

const SITE_FIELDS = {
  priority: ['the priority'],
  domain: ['the domain'],
  test_url: ['the test URL'],
  status_video: ['Video', TRACK_STATUS],
  status_display: ['Display', TRACK_STATUS],
  status_ads_txt: ['ads.txt', TRACK_STATUS],
  status_ad_tag: ['Ad tag', TRACK_STATUS],
  status_mcm: ['MCM', TRACK_STATUS],
  cmp: ['CMP', CMP],
  approval: ['the demand partner approval', APPROVAL],
  rpm_previous: ['Previous Session RPM'],
  rpm_primis: ['Primis Session RPM'],
  rpm_previous_currency: ['the previous RPM currency'],
  rpm_primis_currency: ['the Primis RPM currency'],
  managed_by: ['Managed by'],
};

const ISSUE_FIELDS = {
  title: ['the title'],
  description: ['the description'],
  type: ['the type', ISSUE_TYPE],
  severity: ['the severity', SEVERITY],
  category: ['the category', ISSUE_CATEGORY],
  due_date: ['the due date'],
  blocked_on: ['what it is blocked on'],
  test_url: ['the test URL'],
};

const nameOf = (id) => (id ? db.prepare('SELECT name FROM users WHERE id = ?').get(Number(id))?.name : null) ?? 'nobody';
const label = (map, value) => (map ? (map[value]?.label ?? value) : value);

/** One change as a sentence, with where to look at it. Null for what nobody needs telling. */
export function describe(entry) {
  const actor = entry.actorId ? nameOf(entry.actorId) : 'Somebody';
  const issue = entry.issueId ? db.prepare('SELECT title FROM issues WHERE id = ?').get(entry.issueId) : null;
  const title = issue ? `"${issue.title}"` : 'an issue';
  const link = entry.issueId ? `/issues/${entry.issueId}` : `/sites/${entry.siteId}`;
  const value = entry.newValue ?? '';

  let text;
  switch (entry.kind) {
    case 'site_created':
      text = 'added the site';
      break;
    case 'site_updated': {
      if (entry.field === 'owner_id') text = value ? `made ${nameOf(value)} responsible` : 'removed the responsible person';
      else if (entry.field === 'archived') text = value === '1' ? 'archived the site' : 'brought the site back';
      else if (entry.field === 'demand_block') {
        text =
          value === 'mostly_blocked'
            ? 'flagged it as MOSTLY BLOCKED BY DEMAND PARTNERS'
            : value === 'offline'
              ? 'took it offline (mostly blocked by demand partners)'
              : 'removed the demand-partner flag';
      } else {
        const [name, map] = SITE_FIELDS[entry.field] ?? [entry.field];
        text = `set ${name} to ${value === '' ? 'nothing' : label(map, value)}`;
      }
      break;
    }
    case 'issue_created':
      text = `raised ${title}`;
      break;
    case 'issue_status':
      text = `moved ${title} to ${label(ISSUE_STATUS, value)}`;
      break;
    case 'issue_updated': {
      if (entry.field === 'assignee_id') text = `assigned ${title} to ${nameOf(value)}`;
      else if (entry.field === 'title' || entry.field === 'description') text = `edited ${ISSUE_FIELDS[entry.field][0]} of ${title}`;
      else {
        const [name, map] = ISSUE_FIELDS[entry.field] ?? [entry.field];
        text = `set ${name} of ${title} to ${value === '' ? 'nothing' : label(map, value)}`;
      }
      break;
    }
    case 'comment_added':
      text = `commented on ${title}: "${value}"`;
      break;
    case 'attachment_added':
      text = `attached ${value} to ${title}`;
      break;
    case 'issue_deleted':
      text = `deleted the issue "${value}"`;
      break;
    case 'issue_restored':
      text = `restored the issue "${value}"`;
      break;
    case 'message_posted':
      text = `wrote in the discussion: "${value}"`;
      break;
    default:
      // Deleting or restoring a discussion message, imports: not worth an e-mail.
      return null;
  }
  return { line: `${actor} ${text}`, link };
}

// ---- Listening ----------------------------------------------------------------------------

function onSiteActivity(entry) {
  if (!entry.siteId) return;

  // Whoever acts on a site joins it; whoever is handed something on it joins it.
  if (entry.actorId && entry.kind !== 'site_deleted') watch(entry.siteId, entry.actorId, 'active');
  if (entry.kind === 'site_updated' && entry.field === 'owner_id' && entry.newValue) watch(entry.siteId, Number(entry.newValue), 'responsible');
  if (entry.kind === 'issue_updated' && entry.field === 'assignee_id' && entry.newValue) watch(entry.siteId, Number(entry.newValue), 'assigned');
  if (entry.kind === 'issue_created' && entry.issueId) {
    const assignee = db.prepare('SELECT assignee_id FROM issues WHERE id = ?').get(entry.issueId)?.assignee_id;
    if (assignee) watch(entry.siteId, assignee, 'assigned');
  }

  const said = describe(entry);
  if (!said) return;
  const insert = db.prepare('INSERT INTO notification_queue (user_id, site_id, line, link) VALUES (?, ?, ?, ?)');
  for (const userId of recipients(entry.siteId, entry.actorId)) insert.run(userId, entry.siteId, said.line, said.link);
}

// ---- Opt-out links -------------------------------------------------------------------------

/** The key in a person's opt-out links. It changes nothing but their own update e-mails. */
export function notifyToken(userId) {
  const existing = db.prepare('SELECT notify_token FROM users WHERE id = ?').get(userId)?.notify_token;
  if (existing) return existing;
  const token = randomBytes(24).toString('base64url');
  db.prepare('UPDATE users SET notify_token = ? WHERE id = ?').run(token, userId);
  return token;
}

export function userForToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  return db.prepare('SELECT id, name, notify_enabled FROM users WHERE notify_token = ?').get(token) ?? null;
}

const optOutLink = (base, token, siteId) => `${base}/unsubscribe?u=${encodeURIComponent(token)}${siteId ? `&site=${siteId}` : '&all=1'}`;

// ---- The e-mail ---------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function updateMail({ name, base, token, sites }) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const total = sites.reduce((sum, site) => sum + site.lines.length, 0);
  const alarm = sites.some((site) => site.lines.some((l) => /MOSTLY BLOCKED BY DEMAND PARTNERS/.test(l.line)));
  const subject =
    (alarm ? 'ALERT - ' : '') +
    (sites.length === 1 ? `${sites[0].domain}: ${total === 1 ? sites[0].lines[0].line : `${total} updates`}` : `${total} updates on ${sites.length} sites`);

  const text = [
    `Hi ${first},`,
    '',
    ...sites.flatMap((site) => [
      `${site.domain} - ${base}/sites/${site.id}`,
      ...site.lines.map((l) => `  • ${l.line}${l.link.startsWith('/issues/') ? ` (${base}${l.link})` : ''}`),
      '',
    ]),
    '----------------------------------------------------------------',
    ...sites.map((site) => `STOP UPDATES FOR ${site.domain.toUpperCase()}: ${optOutLink(base, token, site.id)}`),
    `Stop all update e-mails: ${optOutLink(base, token, null)}`,
    '',
    'You get these because you were active on these sites, are responsible for them or',
    'have work assigned on them. Integration Tracker · Digital Marketing Corp',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101828">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px">
<tr><td style="padding:24px 28px 4px">
  <div style="font-size:16px;font-weight:600">Integration Tracker</div>
  <div style="font-size:10px;font-weight:600;letter-spacing:.14em;color:#98a2b3;text-transform:uppercase">Digital Marketing Corp</div>
</td></tr>
<tr><td style="padding:14px 28px 4px;font-size:14px">Hi ${esc(first)}, here is what changed:</td></tr>
${sites
  .map(
    (site) => `<tr><td style="padding:14px 28px 0">
  <a href="${esc(`${base}/sites/${site.id}`)}" style="font-size:15px;font-weight:600;color:#4f46e5;text-decoration:none">${esc(site.domain)}</a>
  <ul style="margin:6px 0 0;padding-left:18px;font-size:13px;line-height:1.55;color:#344054">
    ${site.lines
      .map((l) => {
        const red = /MOSTLY BLOCKED BY DEMAND PARTNERS/.test(l.line);
        return `<li style="margin:2px 0${red ? ';color:#b42318;font-weight:600' : ''}">${esc(l.line)}${
          l.link.startsWith('/issues/') ? ` <a href="${esc(base + l.link)}" style="color:#4f46e5">open</a>` : ''
        }</li>`;
      })
      .join('\n    ')}
  </ul>
</td></tr>`
  )
  .join('\n')}
<tr><td style="padding:28px 28px 8px"><div style="border-top:1px solid #e4e7ec"></div></td></tr>
<tr><td style="padding:8px 28px 0">
${sites
  .map(
    (site) =>
      `<a href="${esc(optOutLink(base, token, site.id))}" style="display:block;margin:0 0 10px;padding:14px 16px;border-radius:10px;background:#fef3f2;border:1px solid #fecdca;color:#b42318;font-size:17px;font-weight:700;text-decoration:none;text-align:center">Stop updates for ${esc(site.domain)}</a>`
  )
  .join('\n')}
</td></tr>
<tr><td style="padding:2px 28px 24px;font-size:12px;line-height:1.5;color:#667085;text-align:center">
  <a href="${esc(optOutLink(base, token, null))}" style="color:#667085">Stop all update e-mails</a><br>
  You get these because you were active on these sites, are responsible for them or have work assigned on them.
</td></tr>
</table></td></tr></table></body></html>`;

  // One-click opt-out for mail apps that offer it (RFC 8058): of the one site, or of all when there are several.
  const oneClick = `${base}/api/notifications/one-click?u=${encodeURIComponent(token)}${sites.length === 1 ? `&site=${sites[0].id}` : '&all=1'}`;
  const headers = { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };

  return { subject, text, html, headers };
}

// ---- Sending ---------------------------------------------------------------------------------------

let flushing = false;
let warned = false;

/** Sends every batch that has waited long enough. Safe to call at any time. */
export async function flushNotifications({ now = new Date() } = {}) {
  if (flushing) return { sent: 0 };
  flushing = true;
  let sent = 0;
  try {
    db.prepare(`DELETE FROM notification_queue WHERE created_at < datetime('now', '-${GIVE_UP_HOURS} hours')`).run();

    const base = publicUrl();
    if (!base || (process.env.NODE_ENV === 'production' && !mailConfigured())) {
      // Without an address there is no opt-out link, and an update e-mail without one is not sent.
      if (!warned) console.warn('Update e-mails are waiting: set PUBLIC_URL and the SMTP settings in .env');
      warned = true;
      return { sent: 0 };
    }

    const cutoff = new Date(now.getTime() - BATCH_MINUTES * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    const due = db
      .prepare('SELECT user_id FROM notification_queue GROUP BY user_id HAVING MIN(created_at) <= ?')
      .all(cutoff)
      .map((row) => row.user_id);

    for (const userId of due) {
      const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
      const rows = db
        .prepare(
          `SELECT q.id, q.site_id, q.line, q.link, s.domain FROM notification_queue q
             JOIN sites s ON s.id = q.site_id
             JOIN users u ON u.id = q.user_id
             LEFT JOIN site_watchers w ON w.user_id = u.id AND w.site_id = q.site_id
            WHERE q.user_id = ? AND ${RECIPIENT_RULE}
            ORDER BY q.id`
        )
        .all(userId);
      // Anything left over belongs to an opt-out made since it was queued.
      const keep = new Set(rows.map((row) => row.id));
      const all = db.prepare('SELECT id FROM notification_queue WHERE user_id = ?').all(userId).map((row) => row.id);
      const dropped = all.filter((id) => !keep.has(id));
      if (dropped.length) db.prepare(`DELETE FROM notification_queue WHERE id IN (${dropped.map(() => '?').join(',')})`).run(...dropped);
      if (!rows.length || !user) continue;

      const bySite = new Map();
      for (const row of rows) {
        if (!bySite.has(row.site_id)) bySite.set(row.site_id, { id: row.site_id, domain: row.domain, lines: [] });
        bySite.get(row.site_id).lines.push({ line: row.line, link: row.link });
      }
      // The alarm first, then the rest in the order things happened.
      const sites = [...bySite.values()].sort(
        (a, b) =>
          Number(b.lines.some((l) => /MOSTLY BLOCKED/.test(l.line))) - Number(a.lines.some((l) => /MOSTLY BLOCKED/.test(l.line)))
      );

      try {
        await sendMail({ to: user.email, ...updateMail({ name: user.name, base, token: notifyToken(user.id), sites }) });
        db.prepare(`DELETE FROM notification_queue WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((row) => row.id));
        sent += 1;
      } catch (err) {
        // Kept for the next round; given up on after a day.
        console.error(`Update e-mail to ${user.email} failed: ${err.message}`);
      }
    }
  } finally {
    flushing = false;
  }
  return { sent };
}

export function startNotifications() {
  onActivity(onSiteActivity);
  const timer = setInterval(() => {
    flushNotifications().catch((err) => console.error(`Update e-mails: ${err.message}`));
  }, CHECK_SECONDS * 1000);
  timer.unref();
}
