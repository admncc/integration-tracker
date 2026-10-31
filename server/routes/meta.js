import { Router } from 'express';
import { z } from 'zod';
import { db, getSetting, logActivity, setSetting } from '../lib/db.js';
import { requireAuth, requireRole, usernameFor } from '../lib/auth.js';
import { mailConfig, mailConfigured, sendMail } from '../lib/mail.js';
import { publicUrl } from '../lib/login.js';
import { APPROVAL, CMP, DEFAULT_EUR_USD, DEMAND_BLOCK, FX_SETTING_KEY, OPEN_ISSUE_STATUSES, TRACKS, TRACK_STATUS } from '../../shared/domain.js';
import { FX_KEYS, fxState, refreshRate } from '../lib/fx.js';
import { DIGEST_KEYS, buildDigest, digestPayload, digestState, isQuiet, sendDigest } from '../lib/digest.js';
import { csvToSites, toCsv } from '../lib/sheet.js';
import { importRowSchema } from './sites.js';

export const metaRouter = Router();
metaRouter.use(requireAuth);

const openPlaceholders = OPEN_ISSUE_STATUSES.map(() => '?').join(',');

metaRouter.get('/stats', (_req, res) => {
  const trackBreakdown = Object.fromEntries(
    TRACKS.map(({ key, label }) => [
      key,
      {
        label,
        counts: db.prepare(`SELECT ${key} AS status, COUNT(*) AS n FROM sites WHERE archived = 0 GROUP BY ${key}`).all(),
      },
    ])
  );

  const issuesByStatus = db.prepare('SELECT i.status AS status, COUNT(*) AS n FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) GROUP BY i.status').all();
  const issuesBySeverity = db
    .prepare(`SELECT severity, COUNT(*) AS n FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status IN (${openPlaceholders}) GROUP BY severity`)
    .all(...OPEN_ISSUE_STATUSES);
  const issuesByType = db
    .prepare(`SELECT type, COUNT(*) AS n FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status IN (${openPlaceholders}) GROUP BY type`)
    .all(...OPEN_ISSUE_STATUSES);
  const issuesByCategory = db
    .prepare(`SELECT category, COUNT(*) AS n FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status IN (${openPlaceholders}) GROUP BY category ORDER BY n DESC`)
    .all(...OPEN_ISSUE_STATUSES);

  const hotSites = db
    .prepare(
      `SELECT s.id, s.domain, s.priority, COUNT(i.id) AS open_issues
         FROM sites s JOIN issues i ON i.site_id = s.id AND i.deleted_at IS NULL AND i.status IN (${openPlaceholders})
        WHERE s.archived = 0
        GROUP BY s.id ORDER BY open_issues DESC, s.priority ASC LIMIT 10`
    )
    .all(...OPEN_ISSUE_STATUSES);

  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sites WHERE archived = 0) AS sites,
         (SELECT COUNT(*) FROM sites
           WHERE archived = 0 AND priority < 99
             AND status_video = 'live' AND status_display = 'live' AND status_ads_txt = 'live'
             AND status_ad_tag = 'live' AND status_mcm = 'live') AS fully_live,
         (SELECT COUNT(*) FROM sites WHERE archived = 0 AND priority >= 99) AS inactive,
         (SELECT COUNT(*) FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status IN (${openPlaceholders})) AS open_issues,
         (SELECT COUNT(*) FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status = 'ready_for_qa') AS awaiting_qa,
         (SELECT COUNT(*) FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status = 'verified') AS verified,
         (SELECT COUNT(*) FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status = 'blocked') AS blocked`
    )
    .get(...OPEN_ISSUE_STATUSES);

  /*
   * "How is Primis performing?" - the comparison both sides look at. The two
   * figures arrive in different currencies, so each is divided by the EUR/USD
   * rate when it is a USD value before anything is compared or averaged.
   */
  const eurUsd = Number(getSetting(FX_SETTING_KEY, DEFAULT_EUR_USD)) || DEFAULT_EUR_USD;
  const inBase = (column, currencyColumn) => `(CASE WHEN ${currencyColumn} = 'USD' THEN ${column} / ${eurUsd} ELSE ${column} END)`;
  const prevBase = inBase('rpm_previous', 'rpm_previous_currency');
  const primisBase = inBase('rpm_primis', 'rpm_primis_currency');
  const comparable = `archived = 0 AND rpm_previous IS NOT NULL AND rpm_primis IS NOT NULL AND rpm_previous > 0`;

  const revenue = db
    .prepare(
      `SELECT
         COUNT(*) AS with_figures,
         SUM(CASE WHEN ${primisBase} > ${prevBase} THEN 1 ELSE 0 END) AS better,
         SUM(CASE WHEN ${primisBase} < ${prevBase} THEN 1 ELSE 0 END) AS worse,
         AVG(${prevBase}) AS avg_previous,
         AVG(${primisBase}) AS avg_primis
       FROM sites WHERE ${comparable}`
    )
    .get();

  const rpmSites = db
    .prepare(
      `SELECT id, domain, rpm_previous, rpm_previous_currency, rpm_primis, rpm_primis_currency,
              ${prevBase} AS previous_base, ${primisBase} AS primis_base,
              ((${primisBase} - ${prevBase}) / ${prevBase}) * 100 AS uplift
         FROM sites WHERE ${comparable}
        ORDER BY uplift ASC`
    )
    .all();

  const missingRpm = db
    .prepare('SELECT COUNT(*) AS n FROM sites WHERE archived = 0 AND (rpm_previous IS NULL OR rpm_primis IS NULL)')
    .get().n;

  /*
   * The feed carries the issue's title as well as the domain. It used to read
   * "Dev Team moved In progress on sky-flight.de" - with four open issues on
   * that domain, nobody could tell which one had moved.
   */
  const blockedIssues = db
    .prepare(
      `SELECT i.id, i.title, i.blocked_on, i.blocked_since, s.domain, i.site_id
         FROM issues i LEFT JOIN sites s ON s.id = i.site_id
        WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status = 'blocked'
        ORDER BY COALESCE(i.blocked_since, i.updated_at) ASC
        LIMIT 10`
    )
    .all();

  const recent = db
    .prepare(
      `SELECT ac.*, u.name AS actor_name, s.domain, i.title AS issue_title, np.name AS new_person
         FROM activity ac
         LEFT JOIN users u ON u.id = ac.actor_id
         LEFT JOIN sites s ON s.id = ac.site_id
         LEFT JOIN issues i ON i.id = ac.issue_id
         -- A responsible or an assignee is stored as a user id; the feed names the person.
         LEFT JOIN users np ON ac.field IN ('owner_id', 'assignee_id') AND np.id = CAST(ac.new_value AS INTEGER)
        ORDER BY ac.id DESC LIMIT 15`
    )
    .all();

  res.json({
    totals, trackBreakdown, issuesByStatus, issuesByType, issuesBySeverity, issuesByCategory, hotSites, recent, blockedIssues,
    revenue: { ...revenue, eur_usd: eurUsd, missing: missingRpm, worst: rpmSites.slice(0, 5), best: rpmSites.slice(-5).reverse() },
  });
});

/**
 * "Is it my turn?" - the question the mail thread answered and the tracker did
 * not. Every handoff here crosses a company boundary, so without this each side
 * has to guess, and the guessing goes back into e-mail.
 *
 * It is deliberately derived, not stored: no read state to keep in sync, no
 * notification table to garbage-collect.
 */
metaRouter.get('/inbox', (req, res) => {
  const openPlaceholders = OPEN_ISSUE_STATUSES.map(() => '?').join(',');
  const live = `i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL)`;
  const from = `FROM issues i LEFT JOIN sites s ON s.id = i.site_id`;
  const seen = db.prepare('SELECT inbox_seen_message_id FROM users WHERE id = ?').get(req.user.id)?.inbox_seen_message_id ?? 0;

  const items = [];

  /*
   * A site the demand partners mostly refuse is losing money every hour it
   * stays up, so on the publisher side it goes first. The partner raised it;
   * there is nothing more for them to do.
   */
  if (req.user.role !== 'partner') {
    const flagged = db
      .prepare("SELECT COUNT(*) AS n FROM sites WHERE archived = 0 AND demand_block = 'mostly_blocked'")
      .get().n;
    if (flagged) {
      items.push({
        key: 'demand_blocked',
        n: flagged,
        label: flagged === 1 ? '1 site mostly blocked - take it offline' : `${flagged} sites mostly blocked - take them offline`,
        to: '/sites?blocked=1',
        alert: true,
      });
    }
  }

  /*
   * Work on your own desk, whoever you work for. The partner has their own
   * steps in this rollout - approving a domain with their demand partners,
   * generating the display tags - so a task assigned to them belongs here too.
   */
  const mine = db
    .prepare(`SELECT COUNT(*) AS n ${from} WHERE ${live} AND i.assignee_id = ? AND i.status IN ('open','in_progress')`)
    .get(req.user.id).n;
  if (mine) items.push({ key: 'assigned', n: mine, label: mine === 1 ? '1 issue assigned to you' : `${mine} issues assigned to you`, to: `/issues?status=open&assignee_id=${req.user.id}` });

  /*
   * Domains on your name that have not made it live yet. This is the rollout
   * backlog somebody actually owns, as opposed to the pile of open issues.
   */
  const domains = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sites
        WHERE archived = 0 AND owner_id = ? AND priority < 99
          AND NOT (status_video = 'live' AND status_display = 'live' AND status_ads_txt = 'live'
                   AND status_ad_tag = 'live' AND status_mcm = 'live')`
    )
    .get(req.user.id).n;
  if (domains) {
    items.push({
      key: 'domains',
      n: domains,
      label: domains === 1 ? '1 domain of yours is not live yet' : `${domains} domains of yours are not live yet`,
      to: `/sites?owner=${req.user.id}`,
    });
  }

  if (req.user.role === 'partner') {
    // Fixed and handed back: nothing moves until the partner looks.
    const n = db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${live} AND i.status = 'ready_for_qa'`).get().n;
    if (n) items.push({ key: 'ready_for_qa', n, label: n === 1 ? '1 fix to re-check' : `${n} fixes to re-check`, to: '/issues?status=ready_for_qa' });
  } else {
    const unowned = db
      .prepare(`SELECT COUNT(*) AS n ${from} WHERE ${live} AND i.assignee_id IS NULL AND i.status = 'open'`)
      .get().n;
    if (unowned) items.push({ key: 'unassigned', n: unowned, label: `${unowned} open, nobody assigned`, to: '/issues?status=open&assignee_id=none' });
  }

  // Everyone sees what has been said since they last looked here.
  const messages = db
    .prepare(
      `SELECT COUNT(*) AS n FROM site_messages m JOIN sites s ON s.id = m.site_id
        WHERE m.deleted_at IS NULL AND s.archived = 0 AND m.author_id IS NOT ? AND m.id > ?`
    )
    .get(req.user.id, seen).n;
  if (messages) items.push({ key: 'messages', n: messages, label: messages === 1 ? '1 new message' : `${messages} new messages`, to: '/sites' });

  const blocked = db
    .prepare(`SELECT COUNT(*) AS n ${from} WHERE ${live} AND i.status = 'blocked'`)
    .get().n;

  res.json({
    items,
    total: items.reduce((sum, item) => sum + item.n, 0),
    blocked,
    open: db.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${live} AND i.status IN (${openPlaceholders})`).get(...OPEN_ISSUE_STATUSES).n,
  });
});

/** Clears the "new messages" part of the inbox for this user. */
metaRouter.post('/inbox/seen', (req, res) => {
  db.prepare(
    'UPDATE users SET inbox_seen_message_id = (SELECT COALESCE(MAX(id), 0) FROM site_messages) WHERE id = ?'
  ).run(req.user.id);
  res.json({ ok: true });
});

metaRouter.get('/settings', (req, res) => {
  // The webhook URL is a credential - it lets anyone holding it post into the
  // team's channel - so only an admin, who is the only one who can set it, sees it.
  res.json({ settings: fxState(), digest: req.user.role === 'admin' ? digestState() : null });
});

metaRouter.patch('/settings', requireRole('admin'), (req, res) => {
  /*
   * Strict types, not coercion: z.coerce turned `true` into the rate 1 and the
   * string "false" into automation switched on.
   */
  const parsed = z
    .object({
      [FX_SETTING_KEY]: z.number({ invalid_type_error: 'The EUR/USD rate must be a number' }).gt(0).lt(100),
      fx_auto: z.boolean({ invalid_type_error: 'The daily-update switch must be true or false' }),
      digest_webhook_url: z
        .string()
        .trim()
        .max(2000)
        .refine(
          (value) => value === '' || /^https:\/\/[^\s]+$/i.test(value),
          'A webhook URL has to start with https:// - Slack and Teams both give you one'
        ),
      digest_hour: z.number({ invalid_type_error: 'The hour must be a number' }).int().min(0).max(23),
      public_url: z.string().trim().max(500),
    })
    .partial()
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'The EUR/USD rate must be a positive number' });
  }

  if (parsed.data[FX_SETTING_KEY] !== undefined) {
    setSetting(FX_SETTING_KEY, parsed.data[FX_SETTING_KEY]);
    // A hand-typed rate is only kept until the next automatic pull, so record where it came from.
    setSetting(FX_KEYS.source, 'manual');
    setSetting(FX_KEYS.updatedAt, new Date().toISOString());
    logActivity({ actorId: req.user.id, kind: 'setting_changed', field: FX_SETTING_KEY, newValue: parsed.data[FX_SETTING_KEY] });
  }
  if (parsed.data.fx_auto !== undefined) {
    setSetting(FX_KEYS.auto, parsed.data.fx_auto ? '1' : '0');
    logActivity({ actorId: req.user.id, kind: 'setting_changed', field: 'fx_auto', newValue: parsed.data.fx_auto ? 'on' : 'off' });
  }

  if (parsed.data.digest_webhook_url !== undefined) {
    setSetting(DIGEST_KEYS.url, parsed.data.digest_webhook_url);
    // The URL itself is never written to the audit trail: it is the credential.
    logActivity({
      actorId: req.user.id, kind: 'setting_changed', field: 'digest_webhook_url',
      newValue: parsed.data.digest_webhook_url ? 'set' : 'cleared',
    });
  }
  if (parsed.data.digest_hour !== undefined) {
    setSetting(DIGEST_KEYS.hour, parsed.data.digest_hour);
    logActivity({ actorId: req.user.id, kind: 'setting_changed', field: 'digest_hour', newValue: `${parsed.data.digest_hour}:00` });
  }
  if (parsed.data.public_url !== undefined) {
    setSetting('public_url', parsed.data.public_url.replace(/\/+$/, ''));
  }

  res.json({ settings: fxState(), digest: digestState() });
});

/** Pulls today's ECB reference rate on demand. */
metaRouter.post('/settings/fx/refresh', requireRole('admin'), async (req, res) => {
  const state = await refreshRate({ force: true });
  if (state.error) return res.status(502).json({ error: `Could not reach the ECB: ${state.error}`, settings: state });
  logActivity({ actorId: req.user.id, kind: 'setting_changed', field: 'fx_eur_usd', newValue: `${state[FX_SETTING_KEY]} (ECB)` });
  res.json({ settings: state });
});

/** Sends the digest now, so an admin can see what it looks like before trusting it. */
metaRouter.post('/settings/digest/test', requireRole('admin'), async (req, res) => {
  const result = await sendDigest({ force: true });
  if (result.skipped) return res.status(400).json({ error: `Nothing was sent: ${result.skipped}`, digest: digestState() });
  if (!result.ok) return res.status(502).json({ error: result.error, digest: digestState() });
  logActivity({ actorId: req.user.id, kind: 'setting_changed', field: 'digest_webhook_url', newValue: 'test sent' });
  res.json({ digest: digestState(), sent: result.digest });
});

/** What the next digest would say, without sending anything. */
metaRouter.get('/settings/digest/preview', requireRole('admin'), (_req, res) => {
  const digest = buildDigest();
  res.json({ digest, quiet: isQuiet(digest), payload: digestPayload(digest, getSetting('public_url', '')) });
});

metaRouter.get('/users', (req, res) => {
  // Everyone needs the roster to assign work; only an admin needs the addresses.
  const columns =
    req.user.role === 'admin'
      ? 'id, username, email, name, role, company, active, last_login_at'
      : 'id, username, name, role, company, active';
  res.json({ users: db.prepare(`SELECT ${columns} FROM users ORDER BY role, name`).all() });
});

const USER_COLUMNS = 'id, username, email, name, role, company, active, last_login_at';

const emailField = z.string().trim().toLowerCase().email('Enter a valid e-mail address - it is what the person signs in with');

metaRouter.post('/users', requireRole('admin'), (req, res) => {
  const parsed = z
    .object({
      email: emailField,
      name: z.string().trim().min(1, 'Enter a name').max(190),
      role: z.enum(['admin', 'dev', 'partner']),
      company: z.string().trim().max(190).default(''),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid user data', details: parsed.error.flatten() });
  }

  const { email, name, role, company } = parsed.data;
  if (db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email)) {
    return res.status(409).json({ error: 'That e-mail is already registered' });
  }
  const id = Number(
    db
      /*
       * A new colleague starts level with the discussion as it stands. Without
       * the baseline their first sign-in would announce every message ever
       * written as unread. No password: sign-in is by e-mail.
       */
      .prepare(
        `INSERT INTO users (username, email, name, password_hash, role, company, inbox_seen_message_id)
         VALUES (?, ?, ?, '', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM site_messages))`
      )
      .run(usernameFor(email), email, name, role, company).lastInsertRowid
  );
  res.status(201).json({ user: db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) });
});

metaRouter.patch('/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const parsed = z
    .object({
      name: z.string().trim().min(1).max(190),
      email: emailField,
      role: z.enum(['admin', 'dev', 'partner']),
      company: z.string().trim().max(190),
      // Strict, not coerced: "false" and "off" are truthy strings, so the very
      // call meant to disable a compromised account used to enable it.
      active: z.boolean({ invalid_type_error: 'active must be true or false' }),
    })
    .partial()
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid user data' });
  }

  const fields = { ...parsed.data };

  /*
   * One unconfirmed click on your own row used to lock you out for good,
   * recoverable only by another admin.
   */
  if (id === req.user.id) {
    if (fields.active === false) return res.status(400).json({ error: 'You cannot disable your own account' });
    if (fields.role && fields.role !== user.role) {
      return res.status(400).json({ error: 'You cannot change your own role. Ask another admin.' });
    }
  }

  if (fields.email && fields.email !== String(user.email ?? '').toLowerCase()) {
    if (db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(fields.email, id)) {
      return res.status(409).json({ error: 'That e-mail is already registered' });
    }
  }
  if (fields.active !== undefined) fields.active = fields.active ? 1 : 0;

  // Locking yourself out of the only admin account is not recoverable from the UI.
  if ((fields.active === 0 || (fields.role && fields.role !== 'admin')) && user.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) return res.status(400).json({ error: 'The last active admin cannot be demoted or disabled' });
  }

  const entries = Object.entries(fields);
  if (entries.length) {
    db.prepare(`UPDATE users SET ${entries.map(([f]) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
  }
  /*
   * A disabled account must not leave sessions alive, and neither must a
   * changed address: the old inbox might be the reason it was changed. Open
   * sign-in e-mails go the same way.
   */
  const emailChanged = fields.email !== undefined && fields.email !== String(user.email ?? '').toLowerCase();
  if (fields.active === 0 || emailChanged) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM login_tokens WHERE user_id = ?').run(id);
  }
  res.json({ user: db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) });
});

/** Whether the server can send the sign-in e-mails, for Settings. */
metaRouter.get('/settings/mail', requireRole('admin'), (_req, res) => {
  const { host, port, from } = mailConfig();
  res.json({ configured: mailConfigured(), host, port, from, public_url: publicUrl() });
});

/** A test message to the admin who asked, so a broken setup shows before anyone needs to sign in. */
metaRouter.post('/settings/mail/test', requireRole('admin'), async (req, res) => {
  if (!req.user.email) return res.status(400).json({ error: 'Your own account has no e-mail address to send to' });
  try {
    const sent = await sendMail({
      to: req.user.email,
      subject: 'Integration Tracker: test e-mail',
      text: `This is a test from the Integration Tracker${publicUrl() ? ` at ${publicUrl()}` : ''}.

If it reached you, sign-in e-mails will too.`,
    });
    res.json({ ok: true, to: req.user.email, ...sent });
  } catch (err) {
    res.status(502).json({ error: `Sending failed: ${err.message}` });
  }
});

/** Sheet-compatible export, so the old workbook can still be produced on demand. */
metaRouter.get('/export.csv', (_req, res) => {
  const sites = db
    .prepare(
      `SELECT s.*, o.name AS owner_name FROM sites s
       LEFT JOIN users o ON o.id = s.owner_id ORDER BY s.priority, s.domain`
    )
    .all();
  const header = [
    'PRIO', 'Domain', 'STATUS (video)', 'STATUS (display)', 'TEST URL', 'Ads.txt (ManagerDomain)',
    'STATUS (ads.txt & ad tag)', 'MCM', 'CMP', 'Demand partner approval',
    'Previous Session RPM', 'Previous RPM currency', 'Primis Session RPM', 'Primis RPM currency',
    'Responsible', 'Managed by', 'Open issues', 'Latest message', 'Demand partners',
  ];
  const latestMessage = new Map(
    db
      .prepare(
        /*
         * Deleted messages are excluded twice over: the tombstone must not be
         * exported, and it must not hide the live message behind it either.
         * The export used to carry the full text of a message the UI had
         * already replaced with "This message was deleted".
         */
        `SELECT site_id, body FROM site_messages
          WHERE deleted_at IS NULL
            AND id IN (SELECT MAX(id) FROM site_messages WHERE deleted_at IS NULL GROUP BY site_id)`
      )
      .all()
      .map((row) => [row.site_id, row.body])
  );
  const openCounts = new Map(
    db
      .prepare(`SELECT site_id, COUNT(*) AS n FROM issues i JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND s.archived = 0 AND i.status IN (${openPlaceholders}) GROUP BY site_id`)
      .all(...OPEN_ISSUE_STATUSES)
      .map((r) => [r.site_id, r.n])
  );

  const label = (map, key) => map[key]?.label ?? key;
  const rows = sites.map((s) => [
    s.priority, s.domain,
    label(TRACK_STATUS, s.status_video), label(TRACK_STATUS, s.status_display), s.test_url,
    label(TRACK_STATUS, s.status_ads_txt), label(TRACK_STATUS, s.status_ad_tag), label(TRACK_STATUS, s.status_mcm),
    label(CMP, s.cmp), label(APPROVAL, s.approval),
    s.rpm_previous ?? '', s.rpm_previous_currency, s.rpm_primis ?? '', s.rpm_primis_currency,
    s.owner_name ?? '', s.managed_by, openCounts.get(s.id) ?? 0, latestMessage.get(s.id) ?? '',
    s.demand_block === 'none' ? '' : label(DEMAND_BLOCK, s.demand_block),
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="integration-tracker.csv"');
  res.send(toCsv([header, ...rows]));
});

/**
 * Upserts by domain, writing only the columns the CSV actually carries, so a
 * two-column revenue sheet updates two columns and leaves the rollout state of
 * those domains alone.
 */
metaRouter.post('/import', requireRole('admin'), (req, res) => {
  const parsed = z.object({ csv: z.string().min(1), dry_run: z.boolean().default(false) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Paste the CSV into the "csv" field' });

  let sites;
  let columns;
  let skipped;
  try {
    ({ sites, columns, skipped } = csvToSites(parsed.data.csv));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  /*
   * Every row goes through the same rules the API enforces on a hand edit. A
   * row that breaks one is reported and left out rather than aborting the whole
   * paste - a single stray cell should not cost the operator the other 200 rows.
   */
  const rejected = [];
  const checked = [];
  for (const site of sites) {
    const row = importRowSchema.safeParse(site);
    // The validated row is what gets written, so the same coercions apply.
    if (row.success) checked.push(row.data);
    else {
      const problem = row.error.issues[0];
      rejected.push(`${site.domain || '(no domain)'}: ${problem.path.join('.') || 'row'} - ${problem.message}`);
    }
  }
  sites = checked;
  skipped = [...skipped, ...rejected];

  if (sites.length === 0) {
    return res.status(400).json({ error: 'No row in that CSV had a usable domain', skipped });
  }

  const existing = new Map(db.prepare('SELECT id, domain FROM sites').all().map((s) => [s.domain, s.id]));
  // A domain repeated across rows is one site, so it is reported once. The last
  // row still wins in the table, which is what a spreadsheet reader expects.
  const domains = [...new Set(sites.map((s) => s.domain))];
  const created = domains.filter((domain) => !existing.has(domain));
  const updated = domains.filter((domain) => existing.has(domain));

  if (parsed.data.dry_run) {
    return res.json({ dry_run: true, columns, created, updated, skipped });
  }

  // `notes` is not a column on the site any more; it opens the domain's discussion.
  const writable = columns.filter((c) => c !== 'notes');
  const insertColumns = ['domain', ...writable];
  const insert = db.prepare(
    `INSERT INTO sites (${insertColumns.join(',')}) VALUES (${insertColumns.map(() => '?').join(',')})
     ON CONFLICT(domain) DO UPDATE SET ${
       writable.length ? `${writable.map((c) => `${c} = excluded.${c}`).join(', ')}, ` : ''
     }updated_at = datetime('now')`
  );

  for (const site of sites) insert.run(...insertColumns.map((c) => site[c] ?? null));

  /*
   * A Notes column becomes the opening message of the domain's discussion. Only
   * the sites named in this CSV are touched - an earlier version cleared the
   * notes column across the whole table on every import.
   */
  let notesImported = 0;
  if (columns.includes('notes')) {
    const postNote = db.prepare('INSERT INTO site_messages (site_id, author_id, body) VALUES (?, ?, ?)');
    const noteExists = db.prepare('SELECT 1 FROM site_messages WHERE site_id = ? AND body = ?');
    const siteIdFor = db.prepare('SELECT id FROM sites WHERE domain = ?');

    for (const site of sites) {
      if (!site.notes) continue;
      const row = siteIdFor.get(site.domain);
      if (!row || noteExists.get(row.id, site.notes)) continue;
      postNote.run(row.id, req.user.id, site.notes);
      notesImported += 1;
    }
  }

  logActivity({ actorId: req.user.id, kind: 'import', newValue: `${created.length} created, ${updated.length} updated` });
  res.json({ columns, created, updated, skipped, notes_imported: notesImported });
});
