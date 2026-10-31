import express, { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { isWatching, setWatching, userForToken } from '../lib/notify.js';

/**
 * Update e-mails: opting out from the link in a message, and the switches in
 * the app.
 *
 * The opt-out routes need no sign-in - they are reached from an e-mail, on
 * whatever device it was read on. The key in the link (users.notify_token)
 * can change nothing but that person's own update e-mails.
 */
export const notificationsRouter = Router();

const optOut = z.object({
  u: z.string().min(20).max(100),
  site: z.coerce.number().int().positive().optional(),
  all: z.union([z.boolean(), z.literal('1')]).optional(),
  // "Undo" on the page puts it back.
  resubscribe: z.boolean().optional(),
});

/** What the opt-out page shows before anything is changed. */
notificationsRouter.get('/unsubscribe', (req, res) => {
  const parsed = optOut.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'This link is incomplete. Open it from the e-mail again.' });
  const user = userForToken(parsed.data.u);
  if (!user) return res.status(404).json({ error: 'This link is no longer valid.' });
  const site = parsed.data.site ? db.prepare('SELECT id, domain FROM sites WHERE id = ?').get(parsed.data.site) : null;
  res.json({
    name: user.name.split(/\s+/)[0],
    site: site ? { id: site.id, domain: site.domain, watching: isWatching(site.id, user.id) } : null,
    all_enabled: user.notify_enabled === 1,
  });
});

function apply({ u, site, all, resubscribe }) {
  const user = userForToken(u);
  if (!user) return { status: 404, body: { error: 'This link is no longer valid.' } };
  if (all || !site) {
    db.prepare('UPDATE users SET notify_enabled = ? WHERE id = ?').run(resubscribe ? 1 : 0, user.id);
    if (!resubscribe) db.prepare('DELETE FROM notification_queue WHERE user_id = ?').run(user.id);
    return { status: 200, body: { ok: true, all_enabled: Boolean(resubscribe) } };
  }
  if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(site)) return { status: 404, body: { error: 'That site no longer exists.' } };
  setWatching(site, user.id, Boolean(resubscribe));
  return { status: 200, body: { ok: true, watching: Boolean(resubscribe) } };
}

/**
 * The button on the opt-out page. A plain GET of the link changes nothing on
 * purpose: mail filters open every link in a message before the recipient
 * does, and would sign everybody out of their updates.
 */
notificationsRouter.post('/unsubscribe', (req, res) => {
  const parsed = optOut.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'This link is incomplete. Open it from the e-mail again.' });
  const { status, body } = apply(parsed.data);
  res.status(status).json(body);
});

/**
 * One-click opt-out from the mail app itself (RFC 8058): Gmail and others POST
 * "List-Unsubscribe=One-Click" here, form-encoded, with the key in the URL.
 */
notificationsRouter.post('/one-click', express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
  const parsed = optOut.safeParse(req.query);
  if (!parsed.success) return res.status(400).send('Bad request');
  const { status } = apply(parsed.data);
  res.status(status).send(status === 200 ? 'Unsubscribed' : 'Not found');
});

// ---- Signed in -------------------------------------------------------------------------------

/** Your own update e-mails: on or off, and which sites they cover. */
notificationsRouter.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT role, notify_enabled FROM users WHERE id = ?').get(req.user.id);
  const rows = db
    .prepare(
      `SELECT s.id, s.domain, w.watching, w.reason FROM site_watchers w JOIN sites s ON s.id = w.site_id
        WHERE w.user_id = ? AND s.archived = 0 ORDER BY s.domain`
    )
    .all(req.user.id);
  res.json({
    enabled: user.notify_enabled === 1,
    // The publisher's admins follow every site unless they opted out of one.
    every_site: user.role === 'admin',
    watching: rows.filter((r) => r.watching === 1).map(({ id, domain, reason }) => ({ id, domain, reason })),
    muted: rows.filter((r) => r.watching === 0).map(({ id, domain }) => ({ id, domain })),
  });
});

notificationsRouter.patch('/me', requireAuth, (req, res) => {
  const parsed = z.object({ enabled: z.boolean({ invalid_type_error: 'enabled must be true or false' }) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid' });
  db.prepare('UPDATE users SET notify_enabled = ? WHERE id = ?').run(parsed.data.enabled ? 1 : 0, req.user.id);
  if (!parsed.data.enabled) db.prepare('DELETE FROM notification_queue WHERE user_id = ?').run(req.user.id);
  res.json({ enabled: parsed.data.enabled });
});

/** The switch on a site's page. */
notificationsRouter.put('/sites/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const parsed = z.object({ watching: z.boolean({ invalid_type_error: 'watching must be true or false' }) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid' });
  if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(id)) return res.status(404).json({ error: 'Site not found' });
  setWatching(id, req.user.id, parsed.data.watching);
  res.json({ watching: isWatching(id, req.user.id) });
});
