import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { SESSION_COOKIE, cookieOptions, createSession, destroySession } from '../lib/auth.js';
import {
  MAX_MAILS_PER_HOUR,
  issueLoginToken,
  linkWasIssued,
  mailsLastHour,
  redeemCode,
  redeemLink,
  signInLink,
  signInMail,
  withdrawLoginToken,
} from '../lib/login.js';
import { mailConfigured, sendMail } from '../lib/mail.js';
import { activeBlock, blockedMessage, clearFailures, clientIp, recordFailure } from '../lib/lockout.js';

export const authRouter = Router();

/*
 * Sign-in is by e-mail: ask for a message, then either follow its link or type
 * its six-digit code. There are no passwords.
 */

/**
 * Two limits per connection:
 *  - three failed sign-ins and it is locked out for 24 hours (lockout.js, in
 *    the database);
 *  - at most 20 requests for a sign-in e-mail per 15 minutes, in memory, so
 *    the form cannot be used to flood people's inboxes. The per-address limit
 *    on e-mails (five an hour) lives in the database (login.js).
 */
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 20;
const requests = new Map();

function tooManyRequests(ip) {
  const entry = requests.get(ip);
  if (!entry || Date.now() - entry.first > REQUEST_WINDOW_MS) {
    requests.set(ip, { count: 1, first: Date.now() });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_REQUESTS;
}

// Keep the map from growing without bound on a long-running process.
setInterval(() => {
  const cutoff = Date.now() - REQUEST_WINDOW_MS;
  for (const [key, entry] of requests) if (entry.first < cutoff) requests.delete(key);
}, REQUEST_WINDOW_MS).unref();

/** Every sign-in route starts here: a locked-out connection gets no further. */
function refuseIfBlocked(req, res) {
  const block = activeBlock(clientIp(req));
  if (!block) return false;
  res.status(429).json({ error: blockedMessage(block), blocked_until: block.until });
  return true;
}

/** A failed attempt: counted, and if it was the last one allowed, said so. */
function failed(req, res, kind, message) {
  const block = recordFailure(clientIp(req), kind);
  if (block) return res.status(429).json({ error: blockedMessage(block), blocked_until: block.until });
  res.status(401).json({ error: message });
}

const email = z.string().trim().toLowerCase().email('Enter your e-mail address');

function userByEmail(address) {
  return db.prepare('SELECT id, name, email FROM users WHERE lower(email) = ? AND active = 1').get(address);
}

function signIn(req, res, userId) {
  clearFailures(clientIp(req));
  const session = createSession(userId);
  res.cookie(SESSION_COOKIE, session.id, cookieOptions(req));
  const user = db.prepare('SELECT id, username, email, name, role, company FROM users WHERE id = ?').get(userId);
  res.json({ user });
}

/** The e-mail itself, after the answer has gone: see below. */
async function deliverSignInMail(user, ip) {
  const { id, token, code } = issueLoginToken(user.id, { ip });
  try {
    await sendMail({ to: user.email, ...signInMail({ name: user.name, code, link: signInLink(token) }) });
  } catch (err) {
    console.error(`Sign-in e-mail to ${user.email} failed: ${err.message}`);
    withdrawLoginToken(id);
  }
}

/**
 * Step one: send the e-mail. The answer is the same whether or not the address
 * has an account, so the form cannot be used to find out who is on the team -
 * and it is given before any mail is sent. Waiting for the mail server used to
 * make a known address answer a second later than an unknown one, which said
 * exactly what the identical wording was hiding.
 */
authRouter.post('/login/email', (req, res) => {
  if (refuseIfBlocked(req, res)) return;
  const parsed = z.object({ email }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Enter your e-mail address' });

  if (process.env.NODE_ENV === 'production' && !mailConfigured()) {
    // Says nothing about the address, only about the server.
    return res.status(503).json({ error: 'Sign-in by e-mail is not set up on this server yet. Tell the administrator.' });
  }
  const ip = clientIp(req);
  if (tooManyRequests(ip)) return res.status(429).json({ error: 'Too many sign-in e-mails asked for from this connection - try again in 15 minutes' });

  res.json({ ok: true, email: parsed.data.email });

  const user = userByEmail(parsed.data.email);
  // An unknown address and one that has had its five e-mails this hour look the same from outside.
  if (!user || mailsLastHour(user.id) >= MAX_MAILS_PER_HOUR) return;
  deliverSignInMail(user, ip);
});

/** Step two, by hand: the e-mail address and the code from the message. */
authRouter.post('/login/code', (req, res) => {
  if (refuseIfBlocked(req, res)) return;
  const parsed = z
    .object({ email, code: z.string().trim().regex(/^\d{3}\s?\d{3}$/, 'The code has six digits') })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Enter the code from the e-mail' });

  const user = userByEmail(parsed.data.email);
  if (!user || !redeemCode(user.id, parsed.data.code)) {
    return failed(req, res, 'code', 'That code is wrong or has expired. Check the newest e-mail, or ask for a new one.');
  }
  signIn(req, res, user.id);
});

/**
 * Step two, by link. The link in the e-mail opens the sign-in page, which posts
 * the token here when the person clicks. It is not redeemed by simply opening
 * the URL: mail scanners (Outlook Safe Links and the like) fetch every link in
 * a message before the recipient sees it, and would spend it.
 */
authRouter.post('/login/link', (req, res) => {
  if (refuseIfBlocked(req, res)) return;
  const parsed = z.object({ token: z.string().trim().min(20).max(200) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'That sign-in link is incomplete. Open it from the e-mail again.' });

  const userId = redeemLink(parsed.data.token);
  if (!userId) {
    const message = 'This sign-in link has expired or was already used. Ask for a new e-mail below.';
    // A real link that has run out is a colleague with an old e-mail, not a guess.
    if (linkWasIssued(parsed.data.token)) return res.status(401).json({ error: message });
    return failed(req, res, 'link', message);
  }
  signIn(req, res, userId);
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
