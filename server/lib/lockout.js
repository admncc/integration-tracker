import { db } from './db.js';

/**
 * Three failed sign-ins from one connection, and that connection is locked out
 * of signing in for 24 hours.
 *
 * A failure is a wrong code, or a sign-in link that never existed. A link that
 * did exist but has expired or was used already is not counted: that is a
 * colleague clicking an old e-mail, not somebody guessing.
 *
 * Kept in the database, so restarting the service does not hand out a fresh
 * set of tries. An admin lifts a block in Settings, or on the server with
 * `npm run users -- unblock <ip>` - the way back in for an admin who locked
 * themselves out.
 *
 * Mind that a whole office behind one address shares the count.
 */
export const MAX_FAILURES = Number(process.env.LOGIN_MAX_FAILURES ?? 3);
export const BLOCK_HOURS = Number(process.env.LOGIN_BLOCK_HOURS ?? 24);

/** "::ffff:1.2.3.4" and "1.2.3.4" are the same client. */
export function clientIp(req) {
  return String(req.ip ?? req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

const now = () => new Date().toISOString();

/** The block on this address, if there is one in force. */
export function activeBlock(ip) {
  return db.prepare('SELECT ip, blocked_at, until, failures FROM ip_blocks WHERE ip = ? AND until > ?').get(ip, now()) ?? null;
}

/** Counts one failure; blocks the address once it reaches the limit. Returns the block, if any. */
export function recordFailure(ip, kind) {
  db.prepare('INSERT INTO login_failures (ip, kind) VALUES (?, ?)').run(ip, kind);
  db.prepare(`DELETE FROM login_failures WHERE created_at < datetime('now', '-${BLOCK_HOURS} hours')`).run();
  const failures = db
    .prepare(`SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND created_at >= datetime('now', '-${BLOCK_HOURS} hours')`)
    .get(ip).n;
  if (failures < MAX_FAILURES) return null;

  const until = new Date(Date.now() + BLOCK_HOURS * 3600_000).toISOString();
  db.prepare(
    `INSERT INTO ip_blocks (ip, blocked_at, until, failures) VALUES (?, datetime('now'), ?, ?)
     ON CONFLICT(ip) DO UPDATE SET blocked_at = excluded.blocked_at, until = excluded.until, failures = excluded.failures`
  ).run(ip, until, failures);
  console.warn(`Sign-in blocked for ${ip} until ${until} after ${failures} failed attempts`);
  return activeBlock(ip);
}

/** A sign-in that worked wipes the slate for that address. */
export function clearFailures(ip) {
  db.prepare('DELETE FROM login_failures WHERE ip = ?').run(ip);
}

export function listBlocks() {
  return db.prepare('SELECT ip, blocked_at, until, failures FROM ip_blocks WHERE until > ? ORDER BY blocked_at DESC').all(now());
}

/** Lifts one block, or every block with "all". Returns how many were lifted. */
export function unblock(ip) {
  if (ip === 'all') {
    db.prepare('DELETE FROM login_failures').run();
    return db.prepare('DELETE FROM ip_blocks').run().changes;
  }
  db.prepare('DELETE FROM login_failures WHERE ip = ?').run(ip);
  return db.prepare('DELETE FROM ip_blocks WHERE ip = ?').run(ip).changes;
}

export function blockedMessage(block) {
  const until = new Date(block.until);
  const when = until.toISOString().replace('T', ' ').slice(0, 16);
  return `Signing in from this connection is blocked until ${when} UTC after ${block.failures} failed attempts. Ask the administrator to lift it.`;
}
