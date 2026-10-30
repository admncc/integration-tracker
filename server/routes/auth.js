import { Router } from 'express';
import { z } from 'zod';
import { db } from '../lib/db.js';
import { SESSION_COOKIE, cookieOptions, createSession, destroySession } from '../lib/auth.js';
import {
  MAX_MAILS_PER_HOUR,
  issueLoginToken,
  mailsLastHour,
  redeemCode,
  redeemLink,
  signInLink,
  signInMail,
  withdrawLoginToken,
} from '../lib/login.js';
import { mailConfigured, sendMail } from '../lib/mail.js';

export const authRouter = Router();

/*
 * Sign-in is by e-mail: ask for a message, then either follow its link or type
 * its six-digit code. There are no passwords.
 */

/**
 * Per-IP limits, in memory. Enough for a single process; move them to the
 * database if the tracker ever runs behind several workers. The per-address
 * limit on e-mails sent lives in the database (login.js) and survives restarts.
 */
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { request: 20, failure: 10 };
const counters = new Map();

function overLimit(kind, req) {
  const entry = counters.get(`${kind}|${req.ip ?? 'unknown'}`);
  if (!entry || Date.now() - entry.first > WINDOW_MS) return false;
  return entry.count >= LIMITS[kind];
}

function count(kind, req) {
  const key = `${kind}|${req.ip ?? 'unknown'}`;
  const entry = counters.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) counters.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}

// Keep the map from growing without bound on a long-running process.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, entry] of counters) if (entry.first < cutoff) counters.delete(key);
}, WINDOW_MS).unref();

const TOO_MANY = 'Too many attempts from this connection - try again in 15 minutes';

const email = z.string().trim().toLowerCase().email('Enter your e-mail address');

function userByEmail(address) {
  return db.prepare('SELECT id, name, email FROM users WHERE lower(email) = ? AND active = 1').get(address);
}

function signIn(req, res, userId) {
  const session = createSession(userId);
  res.cookie(SESSION_COOKIE, session.id, cookieOptions(req));
  const user = db.prepare('SELECT id, username, email, name, role, company FROM users WHERE id = ?').get(userId);
  res.json({ user });
}

/**
 * Step one: send the e-mail. The answer is the same whether or not the address
 * has an account, so the form cannot be used to find out who is on the team.
 */
authRouter.post('/login/email', async (req, res) => {
  const parsed = z.object({ email }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Enter your e-mail address' });

  if (process.env.NODE_ENV === 'production' && !mailConfigured()) {
    // Says nothing about the address, only about the server.
    return res.status(503).json({ error: 'Sign-in by e-mail is not set up on this server yet. Tell the administrator.' });
  }
  if (overLimit('request', req)) return res.status(429).json({ error: TOO_MANY });
  count('request', req);

  const sent = { ok: true, email: parsed.data.email };
  const user = userByEmail(parsed.data.email);
  // An unknown address and an address that has had its five e-mails this hour
  // look the same from outside: nothing is sent, and nothing says why.
  if (!user || mailsLastHour(user.id) >= MAX_MAILS_PER_HOUR) return res.json(sent);

  const { id, token, code } = issueLoginToken(user.id, { ip: req.ip });
  try {
    await sendMail({ to: user.email, ...signInMail({ name: user.name, code, link: signInLink(token) }) });
  } catch (err) {
    console.error(`Sign-in e-mail to ${user.email} failed: ${err.message}`);
    withdrawLoginToken(id);
    return res.status(502).json({ error: 'The e-mail could not be sent. Try again in a minute, or tell the administrator.' });
  }
  res.json(sent);
});

/** Step two, by hand: the e-mail address and the code from the message. */
authRouter.post('/login/code', (req, res) => {
  const parsed = z
    .object({ email, code: z.string().trim().regex(/^\d{3}\s?\d{3}$/, 'The code has six digits') })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Enter the code from the e-mail' });
  if (overLimit('failure', req)) return res.status(429).json({ error: TOO_MANY });

  const user = userByEmail(parsed.data.email);
  if (!user || !redeemCode(user.id, parsed.data.code)) {
    count('failure', req);
    return res.status(401).json({ error: 'That code is wrong or has expired. Check the newest e-mail, or ask for a new one.' });
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
  const parsed = z.object({ token: z.string().trim().min(20).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'That sign-in link is incomplete. Open it from the e-mail again.' });
  if (overLimit('failure', req)) return res.status(429).json({ error: TOO_MANY });

  const userId = redeemLink(parsed.data.token);
  if (!userId) {
    count('failure', req);
    return res.status(401).json({ error: 'This sign-in link has expired or was already used. Ask for a new e-mail below.' });
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
