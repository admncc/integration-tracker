import { Router } from 'express';
import { z } from 'zod';
import { db, logActivity } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { normaliseDomain } from '../lib/sheet.js';
import { DOMAIN_STATUS, PROJECT_STATUS } from '../../shared/domain.js';

/**
 * Potential Sites: candidate domains with a project status and a domain
 * status, nothing more.
 *
 * It is deliberately not the sites table. A pasted batch of a few hundred
 * candidates would otherwise land in the rollout numbers, the dashboard, the
 * digest and the partner's "waiting on you" before anybody had decided to work
 * on a single one of them.
 */
export const prospectsRouter = Router();
prospectsRouter.use(requireAuth);

const projectStatus = z.enum(Object.keys(PROJECT_STATUS));
const domainStatus = z.enum(Object.keys(DOMAIN_STATUS));

/** One paste can be large, but not unbounded: past this it is a mistake, not a list. */
const MAX_LINES = 5000;

const ids = z.array(z.coerce.number().int().positive()).min(1, 'Pick at least one domain').max(MAX_LINES);

function listProspects() {
  return db
    .prepare(
      `SELECT p.id, p.domain, p.project_status, p.domain_status, p.high_potential, p.created_at, p.updated_at,
              u.name AS added_by_name,
              (SELECT s.id FROM sites s WHERE s.domain = p.domain) AS site_id
         FROM prospects p
         LEFT JOIN users u ON u.id = p.added_by
        -- High-potential projects first, so the ones worth chasing are never
        -- buried under the latest paste.
        ORDER BY p.high_potential DESC, p.id DESC`
    )
    .all();
}

prospectsRouter.get('/', (_req, res) => {
  res.json({ prospects: listProspects() });
});

/**
 * A pasted list or the text of an uploaded .txt file. One domain per line is
 * the expected shape, but commas, semicolons, tabs and spaces separate as well,
 * and full URLs are reduced to their domain - which is what a list copied out
 * of a spreadsheet or an e-mail actually looks like.
 */
prospectsRouter.post('/import', (req, res) => {
  const parsed = z
    .object({
      text: z.string().max(2_000_000, 'That list is too long to paste in one go'),
      project_status: projectStatus.default('new'),
      domain_status: domainStatus.default('new'),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Paste a list of domains' });

  const tokens = parsed.data.text
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return res.status(400).json({ error: 'There is no domain in that text' });
  if (tokens.length > MAX_LINES) {
    return res.status(400).json({ error: `At most ${MAX_LINES} domains at a time - that was ${tokens.length}` });
  }

  const invalid = [];
  const seen = new Set();
  const repeated = [];
  const candidates = [];
  for (const token of tokens) {
    const domain = normaliseDomain(token);
    if (!domain) {
      invalid.push(token);
      continue;
    }
    if (seen.has(domain)) {
      repeated.push(domain);
      continue;
    }
    seen.add(domain);
    candidates.push(domain);
  }

  const onList = new Set(db.prepare('SELECT domain FROM prospects').all().map((row) => row.domain));
  const tracked = new Set(db.prepare('SELECT domain FROM sites').all().map((row) => row.domain));

  const added = [];
  const alreadyListed = [];
  // A domain that is already a tracked site is past this stage; listing it as
  // a candidate again would only make two places disagree about it.
  const alreadyTracked = [];

  const insert = db.prepare('INSERT INTO prospects (domain, project_status, domain_status, added_by) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const domain of candidates) {
      if (tracked.has(domain)) alreadyTracked.push(domain);
      else if (onList.has(domain)) alreadyListed.push(domain);
      else {
        insert.run(domain, parsed.data.project_status, parsed.data.domain_status, req.user.id);
        added.push(domain);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (added.length) {
    logActivity({ actorId: req.user.id, kind: 'prospects_imported', newValue: `${added.length} potential site(s) added` });
  }

  res.status(added.length ? 201 : 200).json({
    added: added.length,
    already_listed: alreadyListed,
    already_tracked: alreadyTracked,
    repeated,
    invalid: invalid.slice(0, 50),
    invalid_count: invalid.length,
    prospects: listProspects(),
  });
});

/**
 * One or both statuses across a selection - or a single row, which is a
 * selection of one.
 */
prospectsRouter.patch('/bulk', (req, res) => {
  const parsed = z
    .object({
      ids,
      project_status: projectStatus.optional(),
      domain_status: domainStatus.optional(),
      // A real boolean: z.coerce.boolean() would read "false" as true.
      high_potential: z.boolean({ invalid_type_error: 'high_potential must be true or false' }).optional(),
    })
    .strict()
    .refine(
      (body) => body.project_status || body.domain_status || body.high_potential !== undefined,
      'Pick something to set'
    )
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Pick a status' });

  const { project_status: project, domain_status: domain, high_potential: highPotential } = parsed.data;
  const fields = [];
  const values = [];
  const differs = [];
  if (project) {
    fields.push('project_status = ?');
    values.push(project);
    differs.push('project_status != ?');
  }
  if (domain) {
    fields.push('domain_status = ?');
    values.push(domain);
    differs.push('domain_status != ?');
  }
  if (highPotential !== undefined) {
    fields.push('high_potential = ?');
    values.push(highPotential ? 1 : 0);
    differs.push('high_potential != ?');
  }

  const unique = [...new Set(parsed.data.ids)];
  const changed = db
    .prepare(
      `UPDATE prospects SET ${fields.join(', ')}, updated_at = datetime('now')
        WHERE (${differs.join(' OR ')}) AND id IN (${unique.map(() => '?').join(',')})`
    )
    .run(...values, ...values, ...unique).changes;

  res.json({ changed, prospects: listProspects() });
});

/**
 * "Convert to Integration": the candidate becomes a site in the integration
 * process - priority 1, every track Pending, CMP and approval at their
 * starting values. The candidate stays on this list, linked to the new site
 * ("In integration"), as the record of where it came from.
 *
 * The same people who can add a domain to the sites table can do this.
 */
prospectsRouter.post('/convert', (req, res) => {
  if (!['admin', 'dev'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only the publisher side can start an integration' });
  }
  const parsed = z.object({ ids }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Pick at least one domain' });

  const unique = [...new Set(parsed.data.ids)];
  const rows = db.prepare(`SELECT id, domain, project_status FROM prospects WHERE id IN (${unique.map(() => '?').join(',')})`).all(...unique);
  if (!rows.length) return res.status(404).json({ error: 'None of those domains are on the list' });

  const converted = [];
  const alreadyTracked = [];
  // A candidate marked FAILED was looked at and did not work out; it does not start an integration.
  const failed = [];
  const createSite = db.prepare(
    `INSERT INTO sites (domain, priority, status_video, status_display, status_ads_txt, status_ad_tag, status_mcm, cmp, approval)
     VALUES (?, 1, 'pending', 'pending', 'pending', 'pending', 'pending', 'none', 'none')`
  );

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (row.project_status === 'failed') {
        failed.push(row.domain);
        continue;
      }
      if (db.prepare('SELECT 1 FROM sites WHERE domain = ?').get(row.domain)) {
        alreadyTracked.push(row.domain);
        continue;
      }
      const siteId = Number(createSite.run(row.domain).lastInsertRowid);
      logActivity({ siteId, actorId: req.user.id, kind: 'site_created', newValue: `${row.domain} (from Potential Sites)` });
      converted.push({ prospect_id: row.id, site_id: siteId, domain: row.domain });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (!converted.length && !alreadyTracked.length && failed.length) {
    return res.status(409).json({ error: `${failed.length === 1 ? failed[0] : `All ${failed.length}`} marked FAILED - set the project status back to NEW to convert`, failed });
  }
  res.status(converted.length ? 201 : 200).json({ converted, already_tracked: alreadyTracked, failed, prospects: listProspects() });
});

/**
 * Takes rows off the list for good. A project status of FAILED keeps the
 * record that a domain was looked at and turned down; this is for a paste that
 * went wrong.
 */
// POST rather than DELETE: a DELETE with a body is dropped by some proxies.
prospectsRouter.post('/delete', (req, res) => {
  const parsed = z.object({ ids }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Pick at least one domain' });

  const unique = [...new Set(parsed.data.ids)];
  const deleted = db
    .prepare(`DELETE FROM prospects WHERE id IN (${unique.map(() => '?').join(',')})`)
    .run(...unique).changes;

  if (deleted) {
    logActivity({ actorId: req.user.id, kind: 'prospects_deleted', newValue: `${deleted} potential site(s) deleted` });
  }
  res.json({ deleted, prospects: listProspects() });
});
