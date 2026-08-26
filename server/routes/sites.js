import { Router } from 'express';
import { z } from 'zod';
import { db, logActivity } from '../lib/db.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { removeUpload } from '../lib/uploads.js';
import { normaliseDomain } from '../lib/sheet.js';
import { APPROVAL, CMP, CURRENCIES, OPEN_ISSUE_STATUSES, TRACK_STATUS } from '../../shared/domain.js';

export const sitesRouter = Router();
sitesRouter.use(requireAuth);

const statusEnum = z.enum(Object.keys(TRACK_STATUS));
const openList = OPEN_ISSUE_STATUSES.map(() => '?').join(',');

/** See the note in routes/issues.js: a NUL truncates the value everywhere downstream. */
const cleanText = (value) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : value;

/** A feed-sized excerpt that ends at a word and says it was cut. */
function excerpt(body, limit = 120) {
  const text = String(body).trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

const siteFields = {
  /*
   * The same normaliser the importer uses. Without it "https://www.Foo.de/bar",
   * "Foo.de" and "foo.de" became three rows, because the duplicate check is a
   * case-sensitive equality test.
   */
  domain: z
    .string()
    .trim()
    .max(255)
    .transform((value) => normaliseDomain(value))
    .refine((value) => value.length > 0, 'That is not a valid domain name'),
  priority: z.coerce.number({ invalid_type_error: 'Priority must be a number' }).int('Priority must be a whole number').min(1, 'Priority must be between 1 and 99').max(99, 'Priority must be between 1 and 99'),
  test_url: z.preprocess(cleanText, z.string().trim().max(500)),
  status_video: statusEnum,
  status_display: statusEnum,
  status_ads_txt: statusEnum,
  status_ad_tag: statusEnum,
  status_mcm: statusEnum,
  cmp: z.enum(Object.keys(CMP)),
  approval: z.enum(Object.keys(APPROVAL)),
  // An empty string means "clear it"; z.coerce.number() would turn that into 0.
  rpm_previous: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number({ invalid_type_error: 'An RPM must be a number' }).min(0, 'An RPM cannot be negative').max(10000, 'An RPM above 10000 looks like a typo').nullable()),
  rpm_primis: z.preprocess((v) => (v === '' || v == null ? null : v), z.coerce.number({ invalid_type_error: 'An RPM must be a number' }).min(0, 'An RPM cannot be negative').max(10000, 'An RPM above 10000 looks like a typo').nullable()),
  rpm_previous_currency: z.enum(CURRENCIES),
  rpm_primis_currency: z.enum(CURRENCIES),
  managed_by: z.preprocess(cleanText, z.string().trim().max(190)),
  /*
   * A real boolean, not a coerced one. z.coerce.boolean() turns "false" and
   * "0" into true, so the call meant to bring a site back archived it instead.
   * The same trap was already fixed for users.active and the FX switch.
   */
  archived: z.boolean({ invalid_type_error: 'archived must be true or false' }),
};

const createSchema = z.object(siteFields).partial().required({ domain: true }).strict();
const updateSchema = z.object(siteFields).partial().strict();

/**
 * The same field rules, for the CSV importer. A pasted sheet used to reach the
 * table unchecked, so a negative RPM the API rejects with a 400 went straight in
 * and then silently dropped the domain out of the dashboard comparison.
 */
export const importRowSchema = z
  .object({ ...siteFields, notes: z.string().trim().max(20000) })
  .partial()
  .required({ domain: true })
  .strict();

/** Sites plus their open-issue counts, so the list view needs a single query. */
function listSites({ includeArchived = false } = {}) {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM issues i WHERE i.site_id = s.id AND i.deleted_at IS NULL AND i.status IN (${openList})) AS open_issues,
              (SELECT COUNT(*) FROM issues i WHERE i.site_id = s.id AND i.deleted_at IS NULL AND i.status = 'ready_for_qa') AS awaiting_qa,
              (SELECT COUNT(*) FROM issues i WHERE i.site_id = s.id AND i.deleted_at IS NULL AND i.status = 'blocked') AS blocked_issues,
              (SELECT COUNT(*) FROM issues i WHERE i.site_id = s.id AND i.deleted_at IS NULL) AS total_issues,
              (SELECT COUNT(*) FROM site_messages m WHERE m.site_id = s.id AND m.deleted_at IS NULL) AS message_count
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
      body: z.preprocess(
        cleanText,
        z.string().trim().min(1, 'A message cannot be empty').max(20000, 'That message is too long (max 20000 characters)')
      ),
      reply_to_id: z.coerce.number().int().positive().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'A message cannot be empty' });
  }

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

  /*
   * Goes on the audit trail so a new question surfaces in the activity feed.
   * `field` carries the message id, which is what lets a later delete redact
   * this row and nothing else.
   */
  logActivity({
    siteId: id,
    actorId: req.user.id,
    kind: 'message_posted',
    field: String(messageId),
    newValue: excerpt(parsed.data.body),
  });

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

  /*
   * Tombstone, keeping the body: a reply keeps the question it answers, and the
   * delete stays reversible. What must go is the copy in the audit trail, which
   * was still printing the text on the History panel and the dashboard feed
   * after the author had removed it.
   */
  db.prepare("UPDATE site_messages SET deleted_at = datetime('now') WHERE id = ?").run(message.id);

  /*
   * Redact this message's own row, addressed by id, and keep the original in
   * old_value so a restore can put it back.
   *
   * The match used to be on the body text, which had two consequences: posting
   * the same sentence as somebody else and deleting your own copy redacted
   * their audit row as well - a way to launder another party's entry - and a
   * restore never undid the redaction, so the History panel kept saying
   * "(message deleted)" about a message that was visible again.
   */
  const redact = db.prepare(
    `UPDATE activity SET old_value = new_value, new_value = '(message deleted)'
      WHERE kind = 'message_posted' AND field = ? AND new_value != '(message deleted)'`
  ).run(String(message.id));

  if (redact.changes === 0) {
    /*
     * Rows written before the id was recorded. Narrowed to this author, so it
     * can still only redact their own entry.
     */
    db.prepare(
      `UPDATE activity SET old_value = new_value, new_value = '(message deleted)'
        WHERE site_id = ? AND kind = 'message_posted' AND field IS NULL
          AND new_value = ? AND actor_id IS ?`
    ).run(message.site_id, excerpt(message.body), message.author_id);
  }

  logActivity({ siteId: message.site_id, actorId: req.user.id, kind: 'message_deleted', newValue: '(message deleted)' });

  res.json({ ok: true, message: listMessages(message.site_id).find((m) => m.id === message.id) });
});

/** A misfired delete on a discussion has to be undoable, as it is for issues. */
sitesRouter.post('/:id/messages/:messageId/restore', (req, res) => {
  const message = db
    .prepare('SELECT * FROM site_messages WHERE id = ? AND site_id = ?')
    .get(Number(req.params.messageId), Number(req.params.id));
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (!message.deleted_at) return res.json({ ok: true, message });
  if (req.user.role !== 'admin' && message.author_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the author or an admin can restore a message' });
  }

  db.prepare('UPDATE site_messages SET deleted_at = NULL WHERE id = ?').run(message.id);

  // Put the redacted audit row back, now that the message is visible again.
  db.prepare(
    `UPDATE activity SET new_value = old_value, old_value = NULL
      WHERE kind = 'message_posted' AND field = ? AND new_value = '(message deleted)' AND old_value IS NOT NULL`
  ).run(String(message.id));

  logActivity({ siteId: message.site_id, actorId: req.user.id, kind: 'message_restored', newValue: excerpt(message.body) });

  res.json({ ok: true, message: listMessages(message.site_id).find((m) => m.id === message.id) });
});

function listMessages(siteId) {
  return db
    .prepare(
      `SELECT m.id, m.site_id, m.author_id, m.reply_to_id, m.created_at, m.deleted_at,
              CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
              u.name AS author_name, u.role AS author_role,
              CASE WHEN p.deleted_at IS NULL THEN p.body ELSE '' END AS reply_to_body,
              p.deleted_at AS reply_to_deleted_at, pu.name AS reply_to_author
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
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error), details: parsed.error.flatten() });

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
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error), details: parsed.error.flatten() });

  if (parsed.data.domain && parsed.data.domain !== site.domain) {
    const clash = db.prepare('SELECT id FROM sites WHERE domain = ? AND id != ?').get(parsed.data.domain, id);
    if (clash) return res.status(409).json({ error: `${parsed.data.domain} is already tracked` });
  }

  // The partner owns approval and its own RPM figure; the rest is the publisher's.
  const partnerWritable = new Set(['approval', 'rpm_primis', 'rpm_primis_currency']);
  if (req.user.role === 'partner') {
    const forbidden = Object.keys(parsed.data).filter((field) => !partnerWritable.has(field));
    if (forbidden.length) {
      // Dropping these quietly and answering 200 told an API caller a write had
      // happened when it had not.
      return res.status(403).json({ error: `The partner side cannot change: ${forbidden.join(', ')}` });
    }
  }

  const updates = Object.entries(parsed.data).filter(([field, value]) => normalise(value) !== site[field]);
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

  const counts = {
    issues: db.prepare('SELECT COUNT(*) AS n FROM issues WHERE site_id = ?').get(id).n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM site_messages WHERE site_id = ?').get(id).n,
    attachments: keys.length,
  };

  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
  keys.forEach(removeUpload);

  /*
   * Written after the delete and with no site_id, deliberately. activity rows
   * cascade with the site, so an entry written beforehand would have been
   * erased along with everything else - an admin could remove a domain and
   * leave no trace anywhere that it had ever existed. This one survives,
   * because it belongs to no site.
   */
  logActivity({
    actorId: req.user.id,
    kind: 'site_deleted',
    field: 'domain',
    oldValue: site.domain,
    newValue: `${site.domain} (${counts.issues} issue(s), ${counts.messages} message(s), ${counts.attachments} file(s))`,
  });

  res.json({ ok: true, removed_images: keys.length, removed: counts });
});

/** What the column is called on screen, not what it is called in the database. */
const FIELD_LABELS = {
  domain: 'Domain',
  priority: 'Prio',
  test_url: 'Test URL',
  status_video: 'Video',
  status_display: 'Display',
  status_ads_txt: 'ads.txt',
  status_ad_tag: 'Ad tag',
  status_mcm: 'MCM',
  cmp: 'CMP',
  approval: 'Approval',
  rpm_previous: 'Previous Session RPM',
  rpm_primis: 'Primis Session RPM',
  rpm_previous_currency: 'Previous RPM currency',
  rpm_primis_currency: 'Primis RPM currency',
  managed_by: 'Managed by',
  archived: 'Archived',
};

/** Zod's first concrete complaint beats a generic "Invalid site data". */
function firstMessage(error) {
  const issue = error.issues?.[0];
  if (!issue) return 'Invalid site data';

  if (issue.code === 'unrecognized_keys') {
    return `Unknown field: ${issue.keys.join(', ')}`;
  }

  const field = issue.path?.[0];
  const label = FIELD_LABELS[field];
  if (!label) return issue.message;
  return issue.message.toLowerCase().includes(label.toLowerCase()) ? issue.message : `${label}: ${issue.message}`;
}

/** SQLite has no boolean type and rejects `undefined`. */
function normalise(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

export { listSites };
