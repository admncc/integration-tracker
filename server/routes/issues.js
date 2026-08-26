import express, { Router } from 'express';
import { createReadStream, statSync } from 'node:fs';
import { z } from 'zod';
import { db, logActivity } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { MAX_UPLOAD_BYTES, isInlineType, removeUpload, safeFilename, storeUpload, uploadPath } from '../lib/uploads.js';
import { INACTIVE_PRIORITY, ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, OPEN_ISSUE_STATUSES, SEVERITY } from '../../shared/domain.js';
import { toCsv } from '../lib/sheet.js';

export const issuesRouter = Router();
issuesRouter.use(requireAuth);

/** One page of results; the response says when it had to cut the list short. */
const LIST_LIMIT = 500;

/*
 * Milliseconds, because updated_at is the optimistic-concurrency token.
 * datetime('now') has one-second resolution, so two saves inside the same
 * second carried the same token and both passed the check - the dev handing an
 * issue back and the partner verifying it at the same moment, which is exactly
 * the case the check exists for.
 */
const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')";

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
  dev: ['open', 'in_progress', 'blocked', 'ready_for_qa', 'wont_fix'],
  // The partner can park their own finding too - waiting on a contract is not
  // the publisher's news to break.
  partner: ['open', 'blocked', 'verified', 'wont_fix'],
};

/** A non-existent assignee used to reach SQLite and fail as a 500. */
function assigneeError(assigneeId) {
  if (assigneeId == null) return null;
  const user = db.prepare('SELECT id, active FROM users WHERE id = ?').get(assigneeId);
  if (!user) return 'That assignee does not exist';
  if (!user.active) return 'That assignee is disabled';
  return null;
}

/**
 * Strips control characters. SQLite stores a NUL happily, but every C string it
 * passes through afterwards stops there, so "null\u0000byte title" came back
 * as "null" - stored, returned and displayed, with no warning anywhere.
 */
const cleanText = (value) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : value;

const baseIssue = {
  title: z
    .preprocess(cleanText, z.string().trim().min(3, 'A title needs at least 3 characters').max(300, 'A title can be at most 300 characters')),
  description: z.preprocess(cleanText, z.string().trim().max(20000)).default(''),
  type: typeEnum.default('technical'),
  category: categoryEnum.default('other'),
  severity: severityEnum.default('medium'),
  assignee_id: z.coerce.number().int().positive().nullable().optional(),
  // Who or what the work is waiting on. Free text on purpose: it is a contract,
  // a person at another company, an approval queue - not a value from a list.
  blocked_on: z.preprocess(cleanText, z.string().trim().max(300, 'Keep "blocked on" under 300 characters')).optional(),
  // A free-text due date rendered as "Due not-a-date" and broke the overdue compare.
  due_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'A due date must look like 2026-08-31')
    /*
     * Date.parse alone accepted 2026-02-30: V8 rolls it forward to March 2, so
     * the refinement passed and the card then read "Overdue since 2026-02-30",
     * a date that does not exist. Comparing the round trip catches it.
     */
    .refine((value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, 'That is not a real date')
    .refine((value) => value >= '2000-01-01' && value <= '2100-12-31', 'That due date is not in this century')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
};

/**
 * Shared by the list and the CSV export so the two can never disagree about
 * what "the current view" means.
 */
function buildIssueFilter(rawQuery) {
  /*
   * Express turns ?site_id=1&site_id=2 into an array, which node:sqlite cannot
   * bind - a hand-edited filter link came back as a 500. The last value wins,
   * which is what a browser form would have sent anyway.
   */
  const query = Object.fromEntries(
    Object.entries(rawQuery ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value[value.length - 1] : value])
  );

  const where = [];
  const params = [];

  // A deleted issue is only ever returned when it is explicitly asked for.
  if (query.status === 'deleted') {
    where.push('i.deleted_at IS NOT NULL');
  } else {
    where.push('i.deleted_at IS NULL');
    // `all` is the explicit "no status filter"; an absent param is not the same thing.
    if (query.status === 'all') {
      // nothing further to add
    } else if (query.status === 'open') {
      where.push(`i.status IN (${OPEN_ISSUE_STATUSES.map(() => '?').join(',')})`);
      params.push(...OPEN_ISSUE_STATUSES);
    } else if (query.status) {
      where.push('i.status = ?');
      params.push(query.status);
    }
  }

  /*
   * A network-wide issue belongs to no domain, so it is addressed by the word
   * rather than by an id: site_id=network. Without this it was unreachable, as
   * `i.site_id = ?` never matches NULL.
   */
  if (query.site_id === 'network') {
    where.push('i.site_id IS NULL');
  } else if (query.site_id === 'per_site') {
    where.push('i.site_id IS NOT NULL');
  } else if (query.site_id) {
    where.push('i.site_id = ?');
    params.push(query.site_id);
  } else {
    /*
     * Issues on archived domains are out by default, so this list agrees with
     * the dashboard card that links to it. Asking for one archived site by id
     * still shows it, and ?archived=1 brings them all back.
     */
    if (query.archived !== '1') where.push('(i.site_id IS NULL OR s.archived = 0)');
  }

  /*
   * "What did I raise today?" and "what came in since Friday?" had no answer at
   * all: the list could not be filtered by who raised an issue or when, and it
   * has no date sort, so both questions sent people back to a spreadsheet.
   */
  // "What are we blocked on?" - across every status, in one place.
  if (query.blocked === '1') where.push("i.status = 'blocked'");

  if (query.reporter_id) {
    where.push('i.reporter_id = ?');
    params.push(query.reporter_id);
  }
  if (query.since && /^\d{4}-\d{2}-\d{2}$/.test(String(query.since))) {
    where.push('i.created_at >= ?');
    params.push(`${query.since} 00:00:00`);
  }

  // Unassigned is a real filter value: it is where everything the partner
  // raises without picking somebody ends up, and nothing could reach it.
  if (query.assignee_id === 'none') {
    where.push('i.assignee_id IS NULL');
  } else if (query.assignee_id) {
    where.push('i.assignee_id = ?');
    params.push(query.assignee_id);
  }

  for (const [param, column] of [
    ['type', 'i.type'],
    ['severity', 'i.severity'],
    ['category', 'i.category'],
    ['batch_id', 'i.batch_id'],
  ]) {
    if (query[param]) {
      where.push(`${column} = ?`);
      params.push(query[param]);
    }
  }

  if (query.q) {
    // Without escaping, a search for "%" or "_" matched every row.
    // COALESCE, because a NULL domain made the whole OR chain NULL for network issues.
    where.push(`(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR COALESCE(s.domain, '') LIKE ? ESCAPE '\\')`);
    const like = `%${String(query.q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.push(like, like, like);
  }

  return { where, params };
}

issuesRouter.get('/', (req, res) => {
  const { where, params } = buildIssueFilter(req.query);

  const issues = db
    .prepare(
      `SELECT i.*, s.domain, s.test_url, s.priority AS site_priority,
              r.name AS reporter_name, a.name AS assignee_name, d.name AS deleted_by_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
              (SELECT COUNT(*) FROM activity ac WHERE ac.issue_id = i.id AND ac.field = 'status' AND ac.new_value = 'ready_for_qa') AS qa_rounds
         FROM issues i
         LEFT JOIN sites s ON s.id = i.site_id
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
         LEFT JOIN users d ON d.id = i.deleted_by
        WHERE ${where.join(' AND ')}
        ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready_for_qa' THEN 2 WHEN 'verified' THEN 3 ELSE 4 END,
                 CASE i.severity WHEN 'blocker' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 COALESCE(s.priority, 0) ASC, i.id DESC
        LIMIT ${LIST_LIMIT}`
    )
    .all(...params);

  // The cap used to be invisible: the header printed the truncated length as fact
  // while the dashboard counted the real total.
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM issues i LEFT JOIN sites s ON s.id = i.site_id WHERE ${where.join(' AND ')}`)
    .get(...params).n;

  res.json({ issues, total, limit: LIST_LIMIT, truncated: total > issues.length });
});

/**
 * The issue list as a spreadsheet. It applies the same filters as the list, so
 * the button next to a filtered view exports that view rather than everything.
 */
issuesRouter.get('/export.csv', (req, res) => {
  const { where, params } = buildIssueFilter(req.query);

  const rows = db
    .prepare(
      `SELECT i.id, i.site_id, s.domain, s.priority, s.test_url, i.type, i.category, i.severity, i.status, i.title,
              r.name AS reporter, a.name AS assignee, i.due_date, i.created_at, i.updated_at, i.closed_at,
              i.deleted_at, d.name AS deleted_by, i.blocked_on, i.blocked_since,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comments,
              (SELECT COUNT(*) FROM attachments at WHERE at.issue_id = i.id) AS attachments,
              -- How often this went back for a re-check. It is the answer to
              -- "which finding keeps bouncing", which the export could not give.
              (SELECT COUNT(*) FROM activity ac WHERE ac.issue_id = i.id AND ac.field = 'status' AND ac.new_value = 'ready_for_qa') AS qa_rounds
         FROM issues i
         LEFT JOIN sites s ON s.id = i.site_id
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
         LEFT JOIN users d ON d.id = i.deleted_by
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(s.priority, 0), COALESCE(s.domain, ''), i.id`
    )
    .all(...params);

  const header = [
    'ID', 'Domain', 'Prio', 'Test URL', 'Type', 'Category', 'Severity', 'Status', 'Title',
    'Raised by', 'Assignee', 'Due', 'Created', 'Updated', 'Closed', 'Deleted', 'Deleted by',
    'Comments', 'Attachments', 'QA rounds', 'Blocked on', 'Blocked since',
  ];
  const body = rows.map((row) => [
    row.id, row.domain ?? 'All domains (network-wide)', row.site_id == null ? '' : row.priority, row.test_url ?? '',
    ISSUE_TYPE[row.type]?.label ?? row.type,
    ISSUE_CATEGORY[row.category] ?? row.category,
    SEVERITY[row.severity]?.label ?? row.severity,
    ISSUE_STATUS[row.status]?.label ?? row.status,
    row.title, row.reporter ?? '', row.assignee ?? '', row.due_date ?? '',
    row.created_at, String(row.updated_at).slice(0, 19), row.closed_at ?? '', row.deleted_at ?? '', row.deleted_by ?? '',
    row.comments, row.attachments, row.qa_rounds, row.blocked_on ?? '', row.blocked_since ?? '',
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="issues-${req.query.status ?? 'open'}.csv"`);
  res.send(toCsv([header, ...body]));
});

/**
 * What the band above the sites table shows. Two different things live there:
 *
 *  - network-wide issues: one row, no domain, ticked off once (an ads.txt line
 *    that is identical everywhere, an MCM account change);
 *  - per-domain rollouts: one issue per active domain under a shared batch, so
 *    the same task has to be ticked off on every single site.
 */
issuesRouter.get('/network', (req, res) => {
  const openList = OPEN_ISSUE_STATUSES.map(() => '?').join(',');

  const issues = db
    .prepare(
      `SELECT i.*, r.name AS reporter_name, a.name AS assignee_name,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count
         FROM issues i
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
        WHERE i.site_id IS NULL AND i.deleted_at IS NULL
        ORDER BY CASE WHEN i.status IN (${openList}) THEN 0 ELSE 1 END,
                 CASE i.severity WHEN 'blocker' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                 i.id DESC
        LIMIT 50`
    )
    .all(...OPEN_ISSUE_STATUSES);

  const rollouts = db
    .prepare(
      `SELECT b.id, b.title, b.created_at, u.name AS created_by_name,
              COUNT(i.id) AS total,
              SUM(CASE WHEN i.status IN (${openList}) THEN 1 ELSE 0 END) AS still_open
         FROM batches b
         JOIN issues i ON i.batch_id = b.id AND i.deleted_at IS NULL
         LEFT JOIN users u ON u.id = b.created_by
        GROUP BY b.id
       HAVING total > 1 AND still_open > 0
        ORDER BY b.id DESC
        LIMIT 20`
    )
    .all(...OPEN_ISSUE_STATUSES)
    .map((row) => ({ ...row, done: row.total - row.still_open }));

  res.json({ issues, rollouts });
});

issuesRouter.get('/:id', (req, res) => {
  const issue = db
    .prepare(
      `SELECT i.*, s.domain, s.test_url, r.name AS reporter_name, a.name AS assignee_name, d.name AS deleted_by_name, b.title AS batch_title,
              (SELECT COUNT(*) FROM comments c WHERE c.issue_id = i.id) AS comment_count,
              (SELECT COUNT(*) FROM activity ac WHERE ac.issue_id = i.id AND ac.field = 'status' AND ac.new_value = 'ready_for_qa') AS qa_rounds
         FROM issues i
         LEFT JOIN sites s ON s.id = i.site_id
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
          `SELECT i.id, i.status, s.domain FROM issues i LEFT JOIN sites s ON s.id = i.site_id
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

/**
 * One issue on one domain, or - with site_id: null - one network-wide issue
 * that is ticked off once for the whole network.
 */
issuesRouter.post('/', (req, res) => {
  const parsed = z
    .object({ site_id: z.union([z.null(), z.coerce.number().int().positive()]).default(null), ...baseIssue })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error), details: parsed.error.flatten() });

  let domain = null;
  if (parsed.data.site_id != null) {
    const site = db.prepare('SELECT id, domain, archived FROM sites WHERE id = ?').get(parsed.data.site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    // An issue on an archived domain never shows up in any list or total.
    if (site.archived) {
      return res.status(409).json({ error: `${site.domain} is archived. Bring it back before raising issues on it.` });
    }
    domain = site.domain;
  }

  const badAssignee = assigneeError(parsed.data.assignee_id);
  if (badAssignee) return res.status(400).json({ error: badAssignee });

  const issue = insertIssue({ ...parsed.data, reporter_id: req.user.id, batch_id: null }, req.user.id, domain);
  res.status(201).json({ issue });
});

/**
 * One QA finding, many domains. This is the case the mail thread kept getting
 * wrong: "the player is in <head> on these 13 sites" becomes 13 trackable items
 * that stay grouped under one batch.
 */
issuesRouter.post('/bulk', (req, res) => {
  const parsed = z
    .object({
      site_ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
      // "For each domain": the server resolves the list, so the count is the
      // real one at the moment of creation rather than whatever a stale table
      // in the browser happened to show.
      all_active: z.boolean().default(false),
      ...baseIssue,
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: firstMessage(parsed.error), details: parsed.error.flatten() });

  const { site_ids, all_active, ...fields } = parsed.data;

  const badAssignee = assigneeError(fields.assignee_id);
  if (badAssignee) return res.status(400).json({ error: badAssignee });

  let uniqueIds;
  if (all_active) {
    // Priority 99 is the "not active" marker, so those domains stay out of it.
    uniqueIds = db
      .prepare(`SELECT id FROM sites WHERE archived = 0 AND priority < ${INACTIVE_PRIORITY} ORDER BY priority, domain`)
      .all()
      .map((row) => row.id);
    if (!uniqueIds.length) return res.status(400).json({ error: 'There is no active domain to raise this on' });
  } else {
    if (!site_ids?.length) return res.status(400).json({ error: 'Pick at least one domain' });
    uniqueIds = [...new Set(site_ids)];
  }

  const sites = db
    .prepare(`SELECT id, domain FROM sites WHERE id IN (${uniqueIds.map(() => '?').join(',')}) AND archived = 0`)
    .all(...uniqueIds);
  if (!sites.length) return res.status(404).json({ error: 'None of those sites exist, or all of them are archived' });

  const batchId = Number(
    db.prepare('INSERT INTO batches (title, created_by) VALUES (?, ?)').run(fields.title, req.user.id).lastInsertRowid
  );

  const created = sites.map((site) =>
    insertIssue({ ...fields, site_id: site.id, reporter_id: req.user.id, batch_id: batchId }, req.user.id, site.domain)
  );

  // Archived domains land in `skipped` rather than silently receiving work.
  const missing = uniqueIds.filter((id) => !sites.some((site) => site.id === id));
  res.status(201).json({ batch_id: batchId, created: created.length, skipped: missing, issues: created });
});

issuesRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  if (issue.deleted_at) return res.status(409).json({ error: 'This issue is deleted. Restore it first.' });

  /*
   * Optimistic concurrency. Without it a dev handing an issue back and a partner
   * verifying it at the same moment produced one silent winner, and the loser's
   * screen went on claiming its own result indefinitely.
   */
  const expected = req.body?.expected_updated_at;
  if (expected && expected !== issue.updated_at) {
    return res.status(409).json({
      error: 'Somebody else changed this issue while you had it open. It has been refreshed.',
      issue,
    });
  }

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
  // The partner can park an issue, so they must be able to say what on.
  const PARTNER_WRITABLE = new Set(['status', 'blocked_on']);
  if (req.user.role === 'partner' && Object.keys(data).some((k) => !PARTNER_WRITABLE.has(k))) {
    return res.status(403).json({ error: 'The partner side can change the status and add comments, not the issue body' });
  }

  const updates = Object.entries(data).filter(([field, value]) => normalise(value, field) !== issue[field]);
  if (!updates.length) return res.json({ issue });

  const extra = [];

  /*
   * blocked_since is stamped on the way in and left alone afterwards, so
   * "waiting since when" survives an edit to the reason. Leaving `blocked`
   * clears it, and the reason is kept - the history should still say what the
   * hold-up had been.
   */
  if (data.status === 'blocked' && issue.status !== 'blocked') {
    extra.push("blocked_since = datetime('now')");
  } else if (data.status && data.status !== 'blocked' && issue.status === 'blocked') {
    extra.push('blocked_since = NULL');
  }

  if (data.status && data.status !== issue.status) {
    /*
     * resolved_at is "when the work stopped", so a terminal status sets it too.
     * It used to be set only on the hand-back to QA, so an issue an admin took
     * straight from open to verified had no resolved_at at all and its time to
     * fix was unrecoverable.
     */
    const resolving = data.status === 'ready_for_qa' || ISSUE_STATUS[data.status].terminal;
    extra.push(`resolved_at = ${resolving ? "COALESCE(resolved_at, datetime('now'))" : 'resolved_at'}`);
    extra.push(`closed_at = ${ISSUE_STATUS[data.status].terminal ? "datetime('now')" : 'NULL'}`);
  }

  db.prepare(
    `UPDATE issues SET ${updates.map(([f]) => `${f} = ?`).join(', ')}${extra.length ? `, ${extra.join(', ')}` : ''},
            updated_at = ${NOW} WHERE id = ?`
  ).run(...updates.map(([field, v]) => normalise(v, field)), id);

  for (const [field, value] of updates) {
    logActivity({
      siteId: issue.site_id, issueId: id, actorId: req.user.id,
      kind: field === 'status' ? 'issue_status' : 'issue_updated',
      field, oldValue: issue[field], newValue: normalise(value, field),
    });
  }

  res.json({ issue: issueRow(id) });
});

issuesRouter.post('/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  if (issue.deleted_at) return res.status(409).json({ error: 'This issue is deleted. Restore it first.' });

  const parsed = z.object({ body: z.preprocess(cleanText, z.string().trim().min(1).max(20000)) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Comment cannot be empty' });

  const commentId = Number(
    db.prepare('INSERT INTO comments (issue_id, author_id, body) VALUES (?, ?, ?)').run(id, req.user.id, parsed.data.body).lastInsertRowid
  );
  db.prepare(`UPDATE issues SET updated_at = ${NOW} WHERE id = ?`).run(id);

  /*
   * The refreshed issue travels back with the comment. Posting one bumps
   * updated_at, so a card that kept its old copy sent a stale
   * expected_updated_at on the very next status change and was told "somebody
   * else changed this issue" - about itself, during the normal loop of
   * explaining a fix and then handing it back.
   */
  res.status(201).json({
    comment: db
      .prepare(`SELECT c.*, u.name AS author_name, u.role AS author_role FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`)
      .get(commentId),
    issue: issueRow(id),
  });
});

/**
 * Screenshots are posted as a raw image body rather than multipart: one request
 * per file, no parser dependency, and the size cap is enforced by Express.
 * `?comment_id=` ties the image to a specific comment instead of the issue itself.
 */
issuesRouter.post(
  '/:id/attachments',
  // Any type: a QA finding travels with a screenshot as often as with a log
  // extract, a CSV of tag ids or the ads.txt in question.
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const id = Number(req.params.id);
    const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });

    if (issue.deleted_at) return res.status(409).json({ error: 'This issue is deleted. Restore it first.' });

    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim() || 'application/octet-stream';
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty file' });
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
      key = storeUpload(req.body, mime, filename);
    } catch (err) {
      return res.status(500).json({ error: `Could not store the file: ${err.message}` });
    }

    const attachmentId = Number(
      db
        .prepare(
          `INSERT INTO attachments (issue_id, comment_id, uploader_id, filename, mime, size, storage_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, commentId, req.user.id, filename, mime, req.body.length, key).lastInsertRowid
    );

    db.prepare(`UPDATE issues SET updated_at = ${NOW} WHERE id = ?`).run(id);
    logActivity({ siteId: issue.site_id, issueId: id, actorId: req.user.id, kind: 'attachment_added', newValue: filename });

    res.status(201).json({
      attachment: db
        .prepare(`SELECT a.id, a.issue_id, a.comment_id, a.uploader_id, a.filename, a.mime, a.size, a.created_at, u.name AS uploader_name
                    FROM attachments a LEFT JOIN users u ON u.id = a.uploader_id WHERE a.id = ?`)
        .get(attachmentId),
      // An upload bumps updated_at too - the card needs the new token.
      issue: issueRow(id),
    });
  }
);

issuesRouter.get('/attachments/:attachmentId/raw', (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.attachmentId));
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

  /*
   * Everything that can fail is settled before a single header is written.
   *
   * The old order set Content-Type, Content-Length and Content-Disposition
   * first and only then opened the file, so a missing file produced a 404 that
   * promised 86 bytes and delivered none - the browser held the connection for
   * six seconds and reported ERR_CONTENT_LENGTH_MISMATCH, and a tampered
   * storage key threw a 500 that went out labelled image/png.
   */
  let path;
  let size;
  try {
    path = uploadPath(attachment.storage_key);
    size = statSync(path).size;
  } catch {
    return res.status(404).json({ error: 'That file is no longer on disk' });
  }

  /*
   * Only a raster image may render in place. Anything else - an SVG, an HTML
   * file, a PDF - is sent as a download, so an uploaded file can never execute
   * as markup on our own origin.
   *
   * filename* carries the real name; the plain filename is the ASCII fallback,
   * otherwise a saved file ends up called "mein%20sch%C3%B6nes%20bild.png".
   */
  const inline = isInlineType(attachment.mime);
  res.setHeader('Content-Type', inline ? attachment.mime : 'application/octet-stream');
  // The length of what is actually there, not what the row remembers: a file
  // truncated behind the app's back used to stall the connection for six
  // seconds and then drop it.
  res.setHeader('Content-Length', size);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

  const ascii = attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
  );

  createReadStream(path)
    // Headers are already out by now, so there is no status left to send:
    // ending the response is the only honest thing to do.
    .on('error', () => res.end())
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
  if (issue.deleted_at) return res.json({ ok: true, issue: issueRow(id) });
  if (req.user.role !== 'admin' && issue.reporter_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the reporter or an admin can delete an issue' });
  }

  db.prepare(`UPDATE issues SET deleted_at = datetime('now'), deleted_by = ?, updated_at = ${NOW} WHERE id = ?`).run(req.user.id, id);
  logActivity({ siteId: issue.site_id, issueId: id, actorId: req.user.id, kind: 'issue_deleted', newValue: issue.title });

  res.json({ ok: true, issue: issueRow(id) });
});

issuesRouter.post('/:id/restore', (req, res) => {
  const id = Number(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });
  if (!issue.deleted_at) return res.json({ ok: true, issue: issueRow(id) });
  if (req.user.role !== 'admin' && issue.reporter_id !== req.user.id && issue.deleted_by !== req.user.id) {
    return res.status(403).json({ error: 'Only the reporter, whoever deleted it, or an admin can restore an issue' });
  }

  db.prepare(`UPDATE issues SET deleted_at = NULL, deleted_by = NULL, updated_at = ${NOW} WHERE id = ?`).run(id);
  logActivity({ siteId: issue.site_id, issueId: id, actorId: req.user.id, kind: 'issue_restored', newValue: issue.title });

  res.json({ ok: true, issue: issueRow(id) });
});

/** Zod's first concrete complaint beats a generic "Invalid issue data". */
function firstMessage(error) {
  const issue = error.issues?.[0];
  if (!issue) return 'Invalid issue data';
  const field = issue.path?.join('.');
  return field && !issue.message.toLowerCase().includes(field) ? `${field}: ${issue.message}` : issue.message;
}

/** One shape for an issue row, so a card never has to guess at a missing name. */
function issueRow(id) {
  return db
    .prepare(
      `SELECT i.*, s.domain, r.name AS reporter_name, a.name AS assignee_name, d.name AS deleted_by_name
         FROM issues i
         LEFT JOIN sites s ON s.id = i.site_id
         LEFT JOIN users r ON r.id = i.reporter_id
         LEFT JOIN users a ON a.id = i.assignee_id
         LEFT JOIN users d ON d.id = i.deleted_by
        WHERE i.id = ?`
    )
    .get(id);
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
const NULLABLE_FIELDS = new Set(['site_id', 'assignee_id', 'due_date', 'batch_id']);

function normalise(value, field) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return field && !NULLABLE_FIELDS.has(field) ? '' : null;
  if (value === '') return field && NULLABLE_FIELDS.has(field) ? null : value;
  return value;
}
