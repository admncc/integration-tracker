import express, { Router } from 'express';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { db, logActivity } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, removeUpload, safeFilename, storeUpload, uploadPath } from '../lib/uploads.js';
import { ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, OPEN_ISSUE_STATUSES, SEVERITY } from '../../shared/domain.js';
import { toCsv } from '../lib/sheet.js';

export const issuesRouter = Router();
issuesRouter.use(requireAuth);

const typeEnum = z.enum(Object.keys(ISSUE_TYPE));
const categoryEnum = z.enum(Object.keys(ISSUE_CATEGORY));
const severityEnum = z.enum(Object.keys(SEVERITY));
const statusEnum = z.enum(Object.keys(ISSUE_STATUS));

/**
 * Who may move an issue where. The publisher side fixes and hands back,
 * the partner side decides whether a fix actually passed QA.
 */
const ALLOWED_TRANSITIONS = {
  admin: Object.keys(ISSUE_STATUS),
  dev: ['open', 'in_progress', 'ready_for_qa', 'wont_fix'],
  partner: ['open', 'verified', 'wont_fix'],
};

/** A non-existent assignee used to reach SQLite and fail as a 500. */
function assigneeError(assigneeId) {
  if (assigneeId == null) return null;
  const user = db.prepare('SELECT id, active FROM users WHERE id = ?').get(assigneeId);
  if (!user) return 'That assignee does not exist';
  if (!user.active) return 'That assignee is disabled';
  return null;
}

const baseIssue = {
  title: z.string().trim().min(3, 'A title needs at least 3 characters').max(300, 'A title can be at most 300 characters'),
  description: z.string().trim().max(20000).default(''),
  type: typeEnum.default('technical'),
  category: categoryEnum.default('other'),
  severity: severityEnum.default('medium'),
  assignee_id: z.coerce.number().int().positive().nullable().optional(),
  // A free-text due date rendered as "Due not-a-date" and broke the overdue compare.
  due_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'A due date must look like 2026-08-31')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'That is not a real date')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
};

issuesRouter.get('/', (req, res) => {
  const where = [];
  const params = [];

  // A deleted issue is only ever returned when it is explicitly asked for.
  if (req.query.status === 'deleted') {
    where.push('i.deleted_at IS NOT NULL');
  } else {
    where.push('i.deleted_at IS NULL');
    // `all` is the explicit "no status filter"; an absent param is not the same thing.
    if (req.query.status === 'all') {
      // nothing further to add
    } else if (req.query.status === 'open') {
      where.push(`i.status IN (${OPEN_ISSUE_STATUSES.map(() => '?').join(',')})`);
      params.push(...OPEN_ISSUE_STATUSES);
    } else if (req.query.status) {
      where.push('i.status = ?');
      params.push(req.query.status);
    }
  }
  for (const [param, column] of [['site_id', 'i.site_id'], ['type', 'i.type'], ['severity', 'i.severity'], ['category', 'i.category'], ['assignee_id', 'i.assignee_id'], ['batch_id', 'i.batch_id']]) {
    if (req.query[param]) {
      where.push(`${column} = ?`);
      params.push(req.query[param]);
    }
  }
  if (req.query.q) {
    // Without escaping, a search for "%" or "_" matched every row.
    where.push(`(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR s.domain LIKE ? ESCAPE '\\')`);
    const like = `%${String(req.query.q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.push(like, like, like);
  }

  const issues = db
    .prepare(
      `SELECT i.*, s.domain, s.priority AS site_priority,
              r.name AS reporter_name, a.name AS assignee_name, d.name AS deleted_by_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
              (SELECT COUNT(*) FROM activity ac WHERE ac.issue_id = i.id AND ac.field = 'status' AND ac.new_value = 'ready_for_qa') AS qa_rounds
         FROM issues i
         JOIN sites s ON s.id = i.site_id
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
         LEFT JOIN users d ON d.id = i.deleted_by
        WHERE ${where.join(' AND ')}
        ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready_for_qa' THEN 2 WHEN 'verified' THEN 3 ELSE 4 END,
                 CASE i.severity WHEN 'blocker' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 s.priority ASC, i.id DESC
        LIMIT 500`
    )
    .all(...params);

  res.json({ issues });
});

/** The issue list as a spreadsheet, for status reports outside the tool. */
issuesRouter.get('/export.csv', (req, res) => {
  const onlyOpen = req.query.status !== 'all';
  const rows = db
    .prepare(
      `SELECT i.id, s.domain, s.priority, i.type, i.category, i.severity, i.status, i.title,
              r.name AS reporter, a.name AS assignee, i.due_date, i.created_at, i.updated_at, i.closed_at,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comments,
              (SELECT COUNT(*) FROM attachments at WHERE at.issue_id = i.id) AS images
         FROM issues i
         JOIN sites s ON s.id = i.site_id
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
        WHERE i.deleted_at IS NULL${onlyOpen ? ` AND i.status IN (${OPEN_ISSUE_STATUSES.map(() => '?').join(',')})` : ''}
        ORDER BY s.priority, s.domain, i.id`
    )
    .all(...(onlyOpen ? OPEN_ISSUE_STATUSES : []));

  const header = [
    'ID', 'Domain', 'Prio', 'Type', 'Category', 'Severity', 'Status', 'Title',
    'Raised by', 'Assignee', 'Due', 'Created', 'Updated', 'Closed', 'Comments', 'Images',
  ];
  const body = rows.map((row) => [
    row.id, row.domain, row.priority,
    ISSUE_TYPE[row.type]?.label ?? row.type,
    ISSUE_CATEGORY[row.category] ?? row.category,
    SEVERITY[row.severity]?.label ?? row.severity,
    ISSUE_STATUS[row.status]?.label ?? row.status,
    row.title, row.reporter ?? '', row.assignee ?? '', row.due_date ?? '',
    row.created_at, row.updated_at, row.closed_at ?? '', row.comments, row.images,
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="issues-${onlyOpen ? 'open' : 'all'}.csv"`);
  res.send(toCsv([header, ...body]));
});

issuesRouter.get('/:id', (req, res) => {
  const issue = db
    .prepare(
      `SELECT i.*, s.domain, s.test_url, r.name AS reporter_name, a.name AS assignee_name, d.name AS deleted_by_name, b.title AS batch_title,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
              (SELECT COUNT(*) FROM activity ac WHERE ac.issue_id = i.id AND ac.field = 'status' AND ac.new_value = 'ready_for_qa') AS qa_rounds
         FROM issues i
         JOIN sites s ON s.id = i.site_id
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
         LEFT JOIN users d ON d.id = i.deleted_by
         LEFT JOIN batches b ON b.id = i.batch_id
        WHERE i.id = ?`
    )
    .get(Number(req.params.id));
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const comments = db
    .prepare(
      `SELECT c.*, u.name AS author_name, u.role AS author_role
         FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.issue_id = ? ORDER BY c.id ASC`
    )
    .all(issue.id);

  const activity = db
    .prepare(
      `SELECT ac.*, u.name AS actor_name FROM activity ac LEFT JOIN users u ON u.id = ac.actor_id
        WHERE ac.issue_id = ? ORDER BY ac.id ASC`
    )
    .all(issue.id);

  // Siblings: the same QA finding raised against other domains in one go.
  const siblings = issue.batch_id
    ? db
        .prepare(
          `SELECT i.id, i.status, s.domain FROM issues i JOIN sites s ON s.id = i.site_id
            WHERE i.batch_id = ? AND i.id != ? AND i.deleted_at IS NULL ORDER BY s.priority, s.domain`
        )
        .all(issue.batch_id, issue.id)
    : [];

  const attachments = db
    .prepare(
      `SELECT a.id, a.issue_id, a.comment_id, a.uploader_id, a.filename, a.mime, a.size, a.created_at, u.name AS uploader_name
         FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id
        WHERE a.issue_id = ? ORDER BY a.id ASC`
    )
    .all(issue.id);

  res.json({ issue, comments, activity, siblings, attachments });
});

issuesRouter.post('/', (req, res) => {
  const parsed = z.object({ site_id: z.coerce.number().int().positive(), ...baseIssue }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error), details: parsed.error.flatten() });

  const site = db.prepare('SELECT id, domain FROM sites WHERE id = ?').get(parsed.data.site_id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  const badAssignee = assigneeError(parsed.data.assignee_id);
  if (badAssignee) return res.status(400).json({ error: badAssignee });

  const issue = insertIssue({ ...parsed.data, reporter_id: req.user.id, batch_id: null }, req.user.id, site.domain);
  res.status(201).json({ issue });
});

/**
 * One QA finding, many domains. This is the case the mail thread kept getting
 * wrong: "the player is in <head> on these 13 sites" becomes 13 trackable items
 * that stay grouped under one batch.
 */
issuesRouter.post('/bulk', (req, res) => {
  const parsed = z
    .object({ site_ids: z.array(z.coerce.number().int().positive()).min(1).max(500), ...baseIssue })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error), details: parsed.error.flatten() });

  const { site_ids, ...fields } = parsed.data;

  const badAssignee = assigneeError(fields.assignee_id);
  if (badAssignee) return res.status(400).json({ error: badAssignee });

  const uniqueIds = [...new Set(site_ids)];
  const sites = db
    .prepare(`SELECT id, domain FROM sites WHERE id IN (${uniqueIds.map(() => '?').join(',')})`)
    .all(...uniqueIds);
  if (!sites.length) return res.status(404).json({ error: 'None of those sites exist' });

  const batchId = Number(
    db.prepare('INSERT INTO batches (title, created_by) VALUES (?, ?)').run(fields.title, req.user.id).lastInsertRowid
  );

  const created = sites.map((site) =>
    insertIssue({ ...fields, site_id: site.id, reporter_id: req.user.id, batch_id: batchId }, req.user.id, site.domain)
  );

  res.status(201).json({ batch_id: batchId, created: created.length, issues: created });
});

issuesRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  if (issue.deleted_at) return res.status(409).json({ error: 'This issue is deleted. Restore it first.' });

  const parsed = z
    .object({ ...baseIssue, status: statusEnum })
    .partial()
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error), details: parsed.error.flatten() });

  const data = parsed.data;

  if (data.assignee_id !== undefined) {
    const badAssignee = assigneeError(data.assignee_id);
    if (badAssignee) return res.status(400).json({ error: badAssignee });
  }

  if (data.status && data.status !== issue.status && !ALLOWED_TRANSITIONS[req.user.role].includes(data.status)) {
    return res.status(403).json({ error: `A ${req.user.role} cannot set an issue to "${ISSUE_STATUS[data.status].label}"` });
  }
  if (req.user.role === 'partner' && Object.keys(data).some((k) => k !== 'status')) {
    return res.status(403).json({ error: 'The partner side can change the status and add comments, not the issue body' });
  }

  const updates = Object.entries(data).filter(([field, value]) => normalise(value, field) !== issue[field]);
  if (!updates.length) return res.json({ issue });

  const extra = [];
  if (data.status && data.status !== issue.status) {
    extra.push(`resolved_at = ${data.status === 'ready_for_qa' ? "datetime('now')" : 'resolved_at'}`);
    extra.push(`closed_at = ${ISSUE_STATUS[data.status].terminal ? "datetime('now')" : 'NULL'}`);
  }

  db.prepare(
    `UPDATE issues SET ${updates.map(([f]) => `${f} = ?`).join(', ')}${extra.length ? `, ${extra.join(', ')}` : ''},
            updated_at = datetime('now') WHERE id = ?`
  ).run(...updates.map(([field, v]) => normalise(v, field)), id);

  for (const [field, value] of updates) {
    logActivity({
      siteId: issue.site_id, issueId: id, actorId: req.user.id,
      kind: field === 'status' ? 'issue_status' : 'issue_updated',
      field, oldValue: issue[field], newValue: normalise(value, field),
    });
  }

  res.json({ issue: db.prepare('SELECT * FROM issues WHERE id = ?').get(id) });
});

issuesRouter.post('/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const parsed = z.object({ body: z.string().trim().min(1).max(20000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Comment cannot be empty' });

  const commentId = Number(
    db.prepare('INSERT INTO comments (issue_id, author_id, body) VALUES (?, ?, ?)').run(id, req.user.id, parsed.data.body).lastInsertRowid
  );
  db.prepare("UPDATE issues SET updated_at = datetime('now') WHERE id = ?").run(id);

  res.status(201).json({
    comment: db
      .prepare(`SELECT c.*, u.name AS author_name, u.role AS author_role FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`)
      .get(commentId),
  });
});

/**
 * Screenshots are posted as a raw image body rather than multipart: one request
 * per file, no parser dependency, and the size cap is enforced by Express.
 * `?comment_id=` ties the image to a specific comment instead of the issue itself.
 */
issuesRouter.post(
  '/:id/attachments',
  express.raw({ type: ALLOWED_MIME, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const id = Number(req.params.id);
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    if (!ALLOWED_MIME.includes(mime)) {
      return res.status(415).json({ error: `Only images are accepted (${ALLOWED_MIME.join(', ')})` });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty upload' });
    }

    let commentId = null;
    if (req.query.comment_id) {
      const comment = db.prepare('SELECT id FROM comments WHERE id = ? AND issue_id = ?').get(Number(req.query.comment_id), id);
      if (!comment) return res.status(400).json({ error: 'That comment does not belong to this issue' });
      commentId = comment.id;
    }

    // The client percent-encodes the name so non-ASCII survives the header.
    let filename;
    try {
      filename = safeFilename(decodeURIComponent(String(req.headers['x-filename'] ?? '')));
    } catch {
      filename = safeFilename(req.headers['x-filename']);
    }
    let key;
    try {
      key = storeUpload(req.body, mime);
    } catch (err) {
      return res.status(415).json({ error: err.message });
    }

    const attachmentId = Number(
      db
        .prepare(
          `INSERT INTO attachments (issue_id, comment_id, uploader_id, filename, mime, size, storage_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, commentId, req.user.id, filename, mime, req.body.length, key).lastInsertRowid
    );

    db.prepare("UPDATE issues SET updated_at = datetime('now') WHERE id = ?").run(id);
    logActivity({ siteId: issue.site_id, issueId: id, actorId: req.user.id, kind: 'attachment_added', newValue: filename });

    res.status(201).json({
      attachment: db
        .prepare(`SELECT a.id, a.issue_id, a.comment_id, a.uploader_id, a.filename, a.mime, a.size, a.created_at, u.name AS uploader_name
                    FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id WHERE a.id = ?`)
        .get(attachmentId),
    });
  }
);

issuesRouter.get('/attachments/:attachmentId/raw', (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.attachmentId));
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

  res.setHeader('Content-Type', attachment.mime);
  res.setHeader('Content-Length', attachment.size);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  // Never render an upload inline as markup, whatever the stored mime claims.
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.filename)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  createReadStream(uploadPath(attachment.storage_key))
    .on('error', () => res.status(404).end())
    .pipe(res);
});

issuesRouter.delete('/attachments/:attachmentId', (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.attachmentId));
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
  if (req.user.role !== 'admin' && attachment.uploader_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the uploader or an admin can delete an image' });
  }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id);
  removeUpload(attachment.storage_key);
  res.json({ ok: true });
});

/**
 * Deleting hides the issue and records who did it. Nothing is erased: it stays
 * in the site's history, it is listed under the "Deleted" filter, and it can be
 * restored. Comments and screenshots ride along untouched.
 */
issuesRouter.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (issue.deleted_at) return res.json({ ok: true, issue });
  if (req.user.role !== 'admin' && issue.reporter_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the reporter or an admin can delete an issue' });
  }

  db.prepare("UPDATE issues SET deleted_at = datetime('now'), deleted_by = ?, updated_at = datetime('now') WHERE id = ?").run(req.user.id, id);
  logActivity({ siteId: issue.site_id, issueId: id, actorId: req.user.id, kind: 'issue_deleted', newValue: issue.title });

  res.json({ ok: true, issue: db.prepare('SELECT * FROM issues WHERE id = ?').get(id) });
});

issuesRouter.post('/:id/restore', (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (!issue.deleted_at) return res.json({ ok: true, issue });
  if (req.user.role !== 'admin' && issue.reporter_id !== req.user.id && issue.deleted_by !== req.user.id) {
    return res.status(403).json({ error: 'Only the reporter, whoever deleted it, or an admin can restore an issue' });
  }

  db.prepare("UPDATE issues SET deleted_at = NULL, deleted_by = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  logActivity({ siteId: issue.site_id, issueId: id, actorId: req.user.id, kind: 'issue_restored', newValue: issue.title });

  res.json({ ok: true, issue: db.prepare('SELECT * FROM issues WHERE id = ?').get(id) });
});

/** Zod's first concrete complaint beats a generic "Invalid issue data". */
function firstMessage(error) {
  const issue = error.issues?.[0];
  if (!issue) return 'Invalid issue data';
  const field = issue.path?.join('.');
  return field && !issue.message.toLowerCase().includes(field) ? `${field}: ${issue.message}` : issue.message;
}

function insertIssue(fields, actorId, domain) {
  const columns = ['site_id', 'batch_id', 'title', 'description', 'type', 'category', 'severity', 'reporter_id', 'assignee_id', 'due_date'];
  const info = db
    .prepare(`INSERT INTO issues (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map((c) => normalise(fields[c], c)));

  const id = Number(info.lastInsertRowid);
  logActivity({ siteId: fields.site_id, issueId: id, actorId, kind: 'issue_created', newValue: fields.title });
  return db.prepare('SELECT *, ? AS domain FROM issues WHERE id = ?').get(domain, id);
}

/** Only the genuinely nullable columns accept an empty value as NULL. */
const NULLABLE_FIELDS = new Set(['assignee_id', 'due_date', 'batch_id']);

function normalise(value, field) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return field && !NULLABLE_FIELDS.has(field) ? '' : null;
  if (value === '') return field && NULLABLE_FIELDS.has(field) ? null : value;
  return value;
}
