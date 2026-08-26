import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { SESSION_COOKIE, cookieOptions, createSession, destroySession, hashPassword, requireAuth, verifyPassword } from '../lib/auth.js';

export const authRouter = Router();

/**
 * The partner signs in over the open internet, so failed attempts are throttled
 * per username+IP. In-memory is enough for a single-process deployment; move
 * this to the database if the tracker is ever run behind several workers.
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function throttleKey(req, identifier) {
  return `${req.ip ?? 'unknown'}|${identifier}`;
}

function tooManyAttempts(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > ATTEMPT_WINDOW_MS) attempts.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}

// Keep the map from growing without bound on a long-running process.
setInterval(() => {
  const cutoff = Date.now() - ATTEMPT_WINDOW_MS;
  for (const [key, entry] of attempts) if (entry.first < cutoff) attempts.delete(key);
}, ATTEMPT_WINDOW_MS).unref();

const credentials = z.object({
  // Either the username or the e-mail works; people remember one or the other.
  identifier: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
});

authRouter.post('/login', (req, res) => {
  const parsed = credentials.safeParse({ ...req.body, identifier: req.body?.identifier ?? req.body?.username ?? req.body?.email });
  if (!parsed.success) return res.status(400).json({ error: 'Username and password are required' });

  const { identifier, password } = parsed.data;
  const key = throttleKey(req, identifier);
  if (tooManyAttempts(key)) {
    return res.status(429).json({ error: 'Too many failed attempts - try again in 15 minutes' });
  }

  const row = db.prepare('SELECT * FROM users WHERE (username = ? OR lower(email) = ?) AND active = 1').get(identifier, identifier);
  // Same message either way so the form cannot be used to enumerate accounts.
  if (!row || !verifyPassword(password, row.password_hash)) {
    recordFailure(key);
    return res.status(401).json({ error: 'Wrong username or password' });
  }

  attempts.delete(key);
  const session = createSession(row.id);
  res.cookie(SESSION_COOKIE, session.id, cookieOptions(req));
  res.json({ user: { id: row.id, username: row.username, email: row.email, name: row.name, role: row.role, company: row.company } });
});

authRouter.post('/logout', (req, res) => {
  const id = req.cookies?.[SESSION_COOKIE];
  if (id) destroySession(id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ?? null });
});

authRouter.post('/password', requireAuth, (req, res) => {
  const schema = z.object({
    current: z.string().min(1, 'Enter your current password'),
    next: z.string().min(8, 'The new password must be at least 8 characters'),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid password' });
  }

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(parsed.data.current, row.password_hash)) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(parsed.data.next), req.user.id);

  /*
   * Changing a password is the standard answer to a stolen session, so every
   * other session of this user goes with it. The current one stays, otherwise
   * the change would sign you out of the page you just used.
   */
  const current = req.cookies?.[SESSION_COOKIE];
  const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, current ?? '');

  res.json({ ok: true, other_sessions_ended: changes });
});
