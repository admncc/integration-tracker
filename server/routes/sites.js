import { Router } from 'express';
import { z } from 'zod';
import { db, logActivity } from '../lib/db.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { removeUpload } from '../lib/uploads.js';
import { APPROVAL, CMP, CURRENCIES, OPEN_ISSUE_STATUSES, TRACK_STATUS } from '../../shared/domain.js';

export const sitesRouter = Router();
sitesRouter.use(requireAuth);

const statusEnum = z.enum(Object.keys(TRACK_STATUS));
const openList = OPEN_ISSUE_STATUSES.map(() => '?').join(',');

const siteFields = {
  domain: z.string().trim().min(3).max(190),
  priority: z.coerce.number().int().min(1).max(99),
  test_url: z.string().trim().max(500),
  status_video: statusEnum,
  status_display: statusEnum,
  status_ads_txt: statusEnum,
  status_ad_tag: statusEnum,
  status_mcm: statusEnum,
  cmp: z.enum(Object.keys(CMP)),
  approval: z.enum(Object.keys(APPROVAL)),
  // An empty string means "clear it"; z.coerce.number() would turn that into 0.
  rpm_previous: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number().min(0).nullable()),
  rpm_primis: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number().min(0).nullable()),
  rpm_previous_currency: z.enum(CURRENCIES),
  rpm_primis_currency: z.enum(CURRENCIES),
  managed_by: z.string().trim().max(190),
  notes: z.string().trim().max(5000),
  archived: z.coerce.boolean(),
};

const createSchema = z.object(siteFields).partial().required({ domain: true });
const updateSchema = z.object(siteFields).partial();

/** Sites plus their open-issue counts, so the list view needs a single query. */
function listSites({ includeArchived = false } = {}) {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM issues i WHERE i.site_id = s.id AND i.deleted_at IS NULL AND i.status IN (${openList})) AS open_issues,
              (SELECT COUNT(*) FROM issues i WHERE i.site_id = s.id AND i.deleted_at IS NULL AND i.status = 'ready_for_qa') AS awaiting_qa,
              (SELECT COUNT(*) FROM issues i WHERE i.site_id = s.id AND i.deleted_at IS NULL) AS total_issues,
              (SELECT COUNT(*) FROM site_messages m WHERE m.site_id = s.id) AS message_count
         FROM sites s
        WHERE (? = 1 OR s.archived = 0)
        ORDER BY s.priority ASC, s.domain ASC`
    )
    .all(...OPEN_ISSUE_STATUSES, includeArchived ? 1 : 0);
}

sitesRouter.get('/', (req, res) => {
  res.json({ sites: listSites({ includeArchived: req.query.archived === '1' }) });
});

sitesRouter.get('/:id', (req, res) => {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const issues = db
    .prepare(
      `SELECT i.*, r.name AS reporter_name, a.name AS assignee_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
              (SELECT COUNT(*) FROM activity ac WHERE ac.issue_id = i.id AND ac.field = 'status' AND ac.new_value = 'ready_for_qa') AS qa_rounds,
              d.name AS deleted_by_name
         FROM issues i
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
         LEFT JOIN users d ON d.id = i.deleted_by
        WHERE i.site_id = ?
        ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready_for_qa' THEN 2 ELSE 3 END,
                 CASE i.severity WHEN 'blocker' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 i.id DESC`
    )
    .all(site.id);

  const activity = db
    .prepare(
      `SELECT ac.*, u.name AS actor_name
         FROM activity ac LEFT JOIN users u ON u.id = ac.actor_id
        WHERE ac.site_id = ?
        ORDER BY ac.id DESC LIMIT 100`
    )
    .all(site.id);

  res.json({ site, issues, activity, messages: listMessages(site.id) });
});

/** The per-domain discussion: anyone signed in can post, and reply to a post. */
sitesRouter.post('/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(id)) return res.status(404).json({ error: 'Site not found' });

  const parsed = z
    .object({
      body: z.string().trim().min(1).max(20000),
      reply_to_id: z.coerce.number().int().positive().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A message cannot be empty' });

  let replyTo = null;
  if (parsed.data.reply_to_id) {
    const parent = db.prepare('SELECT id FROM site_messages WHERE id = ? AND site_id = ?').get(parsed.data.reply_to_id, id);
    if (!parent) return res.status(400).json({ error: 'That message belongs to another site' });
    replyTo = parent.id;
  }

  const messageId = Number(
    db
      .prepare('INSERT INTO site_messages (site_id, author_id, reply_to_id, body) VALUES (?, ?, ?, ?)')
      .run(id, req.user.id, replyTo, parsed.data.body).lastInsertRowid
  );

  // Goes on the audit trail so a new question surfaces in the activity feed.
  logActivity({ siteId: id, actorId: req.user.id, kind: 'message_posted', newValue: parsed.data.body.slice(0, 120) });

  res.status(201).json({ message: listMessages(id).find((m) => m.id === messageId) });
});

sitesRouter.delete('/:id/messages/:messageId', (req, res) => {
  const message = db
    .prepare('SELECT * FROM site_messages WHERE id = ? AND site_id = ?')
    .get(Number(req.params.messageId), Number(req.params.id));
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (req.user.role !== 'admin' && message.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the author or an admin can delete a message' });
  }

  db.prepare('DELETE FROM site_messages WHERE id = ?').run(message.id);
  res.json({ ok: true });
});

function listMessages(siteId) {
  return db
    .prepare(
      `SELECT m.id, m.site_id, m.author_id, m.reply_to_id, m.body, m.created_at,
              u.name AS author_name, u.role AS author_role,
              p.body AS reply_to_body, pu.name AS reply_to_author
         FROM site_messages m
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN site_messages p ON p.id = m.reply_to_id
         LEFT JOIN users pu ON pu.id = p.author_id
        WHERE m.site_id = ?
        ORDER BY m.id ASC`
    )
    .all(siteId);
}

sitesRouter.post('/', requireRole('admin', 'dev'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid site data', details: parsed.error.flatten() });

  const data = parsed.data;
  const exists = db.prepare('SELECT id FROM sites WHERE domain = ?').get(data.domain);
  if (exists) return res.status(409).json({ error: `${data.domain} is already tracked` });

  const columns = Object.keys(data);
  const info = db
    .prepare(`INSERT INTO sites (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map((c) => normalise(data[c])));

  const id = Number(info.lastInsertRowid);
  logActivity({ siteId: id, actorId: req.user.id, kind: 'site_created', newValue: data.domain });
  res.status(201).json({ site: db.prepare('SELECT * FROM sites WHERE id = ?').get(id) });
});

sitesRouter.patch('/:id', requireRole('admin', 'dev', 'partner'), (req, res) => {
  const id = Number(req.params.id);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid site data', details: parsed.error.flatten() });

  if (parsed.data.domain && parsed.data.domain !== site.domain) {
    const clash = db.prepare('SELECT id FROM sites WHERE domain = ? AND id != ?').get(parsed.data.domain, id);
    if (clash) return res.status(409).json({ error: `${parsed.data.domain} is already tracked` });
  }

  // The partner owns approval and QA state; everything else belongs to the publisher.
  const partnerWritable = new Set(['approval', 'rpm_primis', 'rpm_primis_currency', 'notes']);
  const updates = Object.entries(parsed.data).filter(([field, value]) => {
    if (req.user.role === 'partner' && !partnerWritable.has(field)) return false;
    return normalise(value) !== site[field];
  });
  if (!updates.length) return res.json({ site });

  db.prepare(
    `UPDATE sites SET ${updates.map(([f]) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).run(...updates.map(([, v]) => normalise(v)), id);

  for (const [field, value] of updates) {
    logActivity({ siteId: id, actorId: req.user.id, kind: 'site_updated', field, oldValue: site[field], newValue: normalise(value) });
  }
  res.json({ site: db.prepare('SELECT * FROM sites WHERE id = ?').get(id) });
});

sitesRouter.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  // Rows cascade, files do not - collect the storage keys before they disappear.
  const keys = db
    .prepare('SELECT a.storage_key FROM attachments a JOIN issues i ON i.id = a.issue_id WHERE i.site_id = ?')
    .all(id)
    .map((row) => row.storage_key);

  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  keys.forEach(removeUpload);

  res.json({ ok: true, removed_images: keys.length });
});

/** SQLite has no boolean type and rejects `undefined`. */
function normalise(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export { listSites };
