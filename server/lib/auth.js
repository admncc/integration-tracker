import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'it_session';

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(plain, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function createSession(userId) {
  const id = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expires.toISOString());
  return { id, expires };
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
