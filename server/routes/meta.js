import { Router } from 'express';
import { z } from 'zod';
import { db, getSetting, logActivity, setSetting } from '../lib/db.js';
import { hashPassword, requireAuth, requireRole } from '../lib/auth.js';
import { APPROVAL, CMP, DEFAULT_EUR_USD, FX_SETTING_KEY, OPEN_ISSUE_STATUSES, TRACKS, TRACK_STATUS } from '../../shared/domain.js';
import { FX_KEYS, fxState, refreshRate } from '../lib/fx.js';
import { csvToSites, toCsv } from '../lib/sheet.js';

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
         (SELECT COUNT(*) FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE i.deleted_at IS NULL AND (s.archived = 0 OR i.site_id IS NULL) AND i.status = 'verified') AS verified`
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

  const recent = db
    .prepare(
      `SELECT ac.*, u.name AS actor_name, s.domain
         FROM activity ac
         LEFT JOIN users u ON u.id = ac.actor_id
         LEFT JOIN sites s ON s.id = ac.site_id
        ORDER BY ac.id DESC LIMIT 25`
    )
    .all();

  res.json({
    totals, trackBreakdown, issuesByStatus, issuesByType, issuesBySeverity, issuesByCategory, hotSites, recent,
    revenue: { ...revenue, eur_usd: eurUsd, missing: missingRpm, worst: rpmSites.slice(0, 5), best: rpmSites.slice(-5).reverse() },
  });
});

metaRouter.get('/settings', (_req, res) => {
  res.json({ settings: fxState() });
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

  res.json({ settings: fxState() });
});

/** Pulls today's ECB reference rate on demand. */
metaRouter.post('/settings/fx/refresh', requireRole('admin'), async (req, res) => {
  const state = await refreshRate({ force: true });
  if (state.error) return res.status(502).json({ error: `Could not reach the ECB: ${state.error}`, settings: state });
  logActivity({ actorId: req.user.id, kind: 'setting_changed', field: 'fx_eur_usd', newValue: `${state[FX_SETTING_KEY]} (ECB)` });
  res.json({ settings: state });
});

metaRouter.get('/users', (req, res) => {
  // Everyone needs the roster to assign work; only an admin needs the addresses.
  const columns = req.user.role === 'admin' ? 'id, username, email, name, role, company, active' : 'id, username, name, role, company, active';
  res.json({ users: db.prepare(`SELECT ${columns} FROM users ORDER BY role, name`).all() });
});

metaRouter.post('/users', requireRole('admin'), (req, res) => {
  const parsed = z
    .object({
      username: z.string().trim().toLowerCase().min(2).max(60).regex(/^[a-z0-9._-]+$/, 'letters, digits, dot, dash and underscore only'),
      email: z.string().trim().toLowerCase().email().or(z.literal('')).default(''),
      name: z.string().trim().min(1).max(190),
      password: z.string().min(8),
      role: z.enum(['admin', 'dev', 'partner']),
      company: z.string().trim().max(190).default(''),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid user data', details: parsed.error.flatten() });
  }

  const { username, email, name, password, role, company } = parsed.data;
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: `The username "${username}" is taken` });
  }
  if (email && db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email)) {
    return res.status(409).json({ error: 'That e-mail is already registered' });
  }
  const id = Number(
    db
      .prepare('INSERT INTO users (username, email, name, password_hash, role, company) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, email || null, name, hashPassword(password), role, company).lastInsertRowid
  );
  res.status(201).json({ user: { id, username, email, name, role, company, active: 1 } });
});

metaRouter.patch('/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const parsed = z
    .object({
      name: z.string().trim().min(1).max(190),
      role: z.enum(['admin', 'dev', 'partner']),
      company: z.string().trim().max(190),
      // Strict, not coerced: "false" and "off" are truthy strings, so the very
      // call meant to disable a compromised account used to enable it.
      active: z.boolean({ invalid_type_error: 'active must be true or false' }),
      password: z.string().min(8, 'A password must be at least 8 characters'),
    })
    .partial()
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid user data' });
  }

  const { password, ...fields } = parsed.data;

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

  if (password) fields.password_hash = hashPassword(password);
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
  // A new password or a disabled account must not leave old sessions alive.
  if (password || fields.active === 0) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  res.json({ user: db.prepare('SELECT id, username, email, name, role, company, active FROM users WHERE id = ?').get(id) });
});

/** Sheet-compatible export, so the old workbook can still be produced on demand. */
metaRouter.get('/export.csv', (_req, res) => {
  const sites = db.prepare('SELECT * FROM sites ORDER BY priority, domain').all();
  const header = [
    'PRIO', 'Domain', 'STATUS (video)', 'STATUS (display)', 'TEST URL', 'Ads.txt (ManagerDomain)',
    'STATUS (ads.txt & ad tag)', 'MCM', 'CMP', 'Demand partner approval',
    'Previous Session RPM', 'Previous RPM currency', 'Primis Session RPM', 'Primis RPM currency',
    'Managed by', 'Open issues', 'Latest message',
  ];
  const latestMessage = new Map(
    db
      .prepare(
        `SELECT site_id, body FROM site_messages
          WHERE id IN (SELECT MAX(id) FROM site_messages GROUP BY site_id)`
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
    s.managed_by, openCounts.get(s.id) ?? 0, latestMessage.get(s.id) ?? '',
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
