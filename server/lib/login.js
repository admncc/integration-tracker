import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { db, getSetting } from './db.js';

/**
 * Sign-in by e-mail: a link and a six-digit code, both for one sign-in within
 * the hour. There are no passwords.
 *
 * Only hashes are stored. A copy of the database - a backup on someone's
 * laptop - must not be a pocketful of working sign-in links.
 */
export const TOKEN_MINUTES = 60;

/** Wrong codes allowed against one e-mail before that e-mail is dead. */
export const MAX_CODE_ATTEMPTS = 5;

/** Sign-in e-mails one address can be sent per hour. */
export const MAX_MAILS_PER_HOUR = 5;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/*
 * The code is hashed together with the user id: there are only a million
 * six-digit codes, so a bare hash of one could be reversed from a table in a
 * second. Salted with the user it at least has to be done per person.
 */
const codeHash = (userId, code) => sha256(`${userId}:${code}`);

const now = () => new Date().toISOString();

export function issueLoginToken(userId, { ip = null } = {}) {
  /*
   * Old rows only make the table grow. Thirty days, not one: a spent link has
   * to stay recognisable, so that somebody clicking last week's e-mail is told
   * it expired instead of being counted as guessing (lockout.js).
   */
  db.prepare("DELETE FROM login_tokens WHERE created_at < datetime('now', '-30 days')").run();

  const token = randomBytes(32).toString('base64url');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + TOKEN_MINUTES * 60_000);
  const id = Number(
    db
      .prepare('INSERT INTO login_tokens (user_id, token_hash, code_hash, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
      .run(userId, sha256(token), codeHash(userId, code), expiresAt.toISOString(), ip).lastInsertRowid
  );
  return { id, token, code, expiresAt };
}

/** For an e-mail that never went out: it should not count against the hourly limit. */
export function withdrawLoginToken(id) {
  db.prepare('DELETE FROM login_tokens WHERE id = ? AND used_at IS NULL').run(id);
}

/** How many sign-in e-mails this person was sent in the last hour. */
export function mailsLastHour(userId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE user_id = ? AND created_at > datetime('now', '-1 hour')")
    .get(userId).n;
}

/** Signing in once spends every link and code that person still had. */
function consumeAll(userId) {
  db.prepare('UPDATE login_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(now(), userId);
}

/** Whether a link token was ever issued - spent or expired included. */
export function linkWasIssued(token) {
  if (typeof token !== 'string' || token.length < 20) return false;
  return Boolean(db.prepare('SELECT 1 FROM login_tokens WHERE token_hash = ?').get(sha256(token)));
}

/** The link: returns the user id it signs in, or null. */
export function redeemLink(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = db
    .prepare(
      `SELECT t.user_id FROM login_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND u.active = 1`
    )
    .get(sha256(token), now());
  if (!row) return null;
  consumeAll(row.user_id);
  return row.user_id;
}

/**
 * The code, typed in with the e-mail it was sent to. Every wrong guess counts
 * against all of that person's open codes, so asking for five e-mails does not
 * buy twenty-five guesses.
 */
export function redeemCode(userId, code) {
  const open = db
    .prepare(
      `SELECT id, code_hash FROM login_tokens
        WHERE user_id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?`
    )
    .all(userId, now(), MAX_CODE_ATTEMPTS);
  if (open.length === 0) return false;

  const given = Buffer.from(codeHash(userId, String(code).replace(/\s+/g, '')), 'hex');
  const hit = open.some((row) => timingSafeEqual(Buffer.from(row.code_hash, 'hex'), given));
  if (hit) {
    consumeAll(userId);
    return true;
  }
  db.prepare('UPDATE login_tokens SET attempts = attempts + 1 WHERE user_id = ? AND used_at IS NULL').run(userId);
  return false;
}

/**
 * Where the link in the e-mail points. Never taken from the request: the Host
 * header is the caller's to choose, and a link built from it would let anyone
 * ask for a real sign-in link to be mailed to a colleague pointing at their
 * own server - which then receives the token when the colleague clicks.
 */
export function publicUrl() {
  const configured = process.env.PUBLIC_URL || getSetting('public_url', '') || '';
  return String(configured).trim().replace(/\/+$/, '');
}

export function signInLink(token) {
  const base = publicUrl();
  return base ? `${base}/login?token=${encodeURIComponent(token)}` : null;
}

/** The e-mail itself, in plain text and HTML. */
export function signInMail({ name, code, link }) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  const subject = `Your sign-in code: ${spaced}`;

  const text = [
    `Hi ${first},`,
    '',
    link ? `Sign in to the Integration Tracker:\n${link}\n\nOr enter this code on the sign-in page:` : 'Enter this code on the sign-in page:',
    '',
    `    ${spaced}`,
    '',
    `The link and the code work once, for the next ${TOKEN_MINUTES} minutes.`,
    "If you did not ask to sign in, ignore this e-mail - nobody gets in without it.",
    '',
    '-- ',
    'Integration Tracker · Digital Marketing Corp',
  ].join('\n');

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#101828">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #e4e7ec;border-radius:12px">
<tr><td style="padding:28px 28px 8px">
  <div style="font-size:16px;font-weight:600">Integration Tracker</div>
  <div style="font-size:10px;font-weight:600;letter-spacing:.14em;color:#98a2b3;text-transform:uppercase">Digital Marketing Corp</div>
</td></tr>
<tr><td style="padding:16px 28px 0;font-size:14px;line-height:1.5">Hi ${esc(first)},</td></tr>
${link ? `<tr><td style="padding:12px 28px 0;font-size:14px;line-height:1.5">click to sign in:</td></tr>
<tr><td style="padding:14px 28px 4px"><a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">Sign in to the tracker</a></td></tr>
<tr><td style="padding:16px 28px 0;font-size:14px;line-height:1.5">or enter this code on the sign-in page:</td></tr>` : `<tr><td style="padding:12px 28px 0;font-size:14px;line-height:1.5">enter this code on the sign-in page:</td></tr>`}
<tr><td style="padding:10px 28px 0"><div style="font-size:28px;font-weight:700;letter-spacing:.18em;font-family:ui-monospace,Menlo,Consolas,monospace">${esc(spaced)}</div></td></tr>
<tr><td style="padding:18px 28px 28px;font-size:12px;line-height:1.5;color:#667085">The link and the code work once, for the next ${TOKEN_MINUTES} minutes. If you did not ask to sign in, ignore this e-mail - nobody gets in without it.</td></tr>
</table></td></tr></table></body></html>`;

  return { subject, text, html };
}
