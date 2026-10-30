import { randomBytes } from 'node:crypto';
import { db } from './db.js';

/**
 * A sign-in lasts seven days from the moment it happened, then the person asks
 * for a new e-mail. Fixed rather than sliding, so a session left open on a
 * shared machine does not live for ever.
 */
export const SESSION_DAYS = 7;
export const SESSION_COOKIE = 'it_session';

export function createSession(userId) {
  const id = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires.toISOString());
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  // Expired sessions are only ever looked at to be refused; no need to keep them.
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  return { id, expires };
}

/** omerp@primis.tech -> "omerp", or "omerp2" if that is taken. */
export function usernameFor(address) {
  const base = address.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '') || 'user';
  let candidate = base;
  for (let n = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate); n += 1) candidate = `${base}${n}`;
  return candidate;
}

export function destroySession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function userForSession(sessionId) {
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.email, u.name, u.role, u.company, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND u.active = 1`
    )
    .get(sessionId);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    destroySession(sessionId);
    return null;
  }
  const { expires_at, ...user } = row;
  return user;
}

/** Populates req.user from the session cookie. Never rejects on its own. */
export function attachUser(req, _res, next) {
  req.user = userForSession(req.cookies?.[SESSION_COOKIE]);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/** Route guard: `requireRole('admin', 'dev')`. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

/**
 * `secure` follows the actual connection rather than NODE_ENV. Marking the cookie
 * secure on a plain-HTTP deployment makes the browser drop it silently: the sign-in
 * request succeeds, every request after it is a 401, and the app looks empty.
 *
 * `req.secure` is true for direct HTTPS, and behind a reverse proxy it reads
 * X-Forwarded-Proto once TRUST_PROXY is set - so a proper deployment still gets
 * a secure cookie. INSECURE_COOKIES=1 forces it off if a proxy reports the wrong
 * protocol.
 */
export function cookieOptions(req) {
  const overHttps = process.env.INSECURE_COOKIES === '1' ? false : Boolean(req?.secure);
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: overHttps,
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  };
}
