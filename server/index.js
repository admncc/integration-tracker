// First, and by itself: importing it is what loads .env into process.env.
import './lib/env.js';

import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { db, setSetting } from './lib/db.js';
import { attachUser } from './lib/auth.js';
import { startDailyRefresh } from './lib/fx.js';
import { startDailyDigest } from './lib/digest.js';
import { startNotifications } from './lib/notify.js';
import { authRouter } from './routes/auth.js';
import { sitesRouter } from './routes/sites.js';
import { issuesRouter } from './routes/issues.js';
import { metaRouter } from './routes/meta.js';
import { prospectsRouter } from './routes/prospects.js';
import { notificationsRouter } from './routes/notifications.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(here, '../dist');

export const app = express();

app.disable('x-powered-by');
// Behind a reverse proxy, set TRUST_PROXY=1 so req.ip and secure cookies are correct.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
/*
 * The tool sits behind a login and links out to third-party test pages, so it
 * should not be framable and should not leak its URLs in a referer. The CSP is
 * deliberately narrow: everything the SPA needs is same-origin, and images may
 * come from data: URIs for the file previews in the upload dialog.
 */
app.use((req, res, next) => {
  // Over HTTPS only: telling a browser to insist on TLS from a plain-HTTP answer is ignored anyway.
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

/*
 * Touches the database rather than just proving the process is listening. With
 * the filesystem full this used to stay 200 while every write - sign-in
 * included - failed, so any uptime check built on it was green through a total
 * outage. The write goes to a temporary table, so it costs nothing and leaves
 * nothing behind.
 */
let lastProbeWrite = 0;
app.get('/api/health', (_req, res) => {
  try {
    // A real write to the real database file, which is what a full disk stops.
    // One settings row, rewritten - it is the cheapest honest probe there is.
    // At most every ten seconds: the route is open to anyone, and must not be
    // a way to make the server write as fast as it is asked to.
    if (Date.now() - lastProbeWrite > 10_000) {
      setSetting('health_probe_at', new Date().toISOString());
      lastProbeWrite = Date.now();
    }
    const sites = db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;
    res.json({ ok: true, sites });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});
app.use('/api/auth', authRouter);
app.use('/api/sites', sitesRouter);
app.use('/api/issues', issuesRouter);
app.use('/api/prospects', prospectsRouter);
// Before the catch-all /api router, which requires a sign-in: opting out from an e-mail must not.
app.use('/api/notifications', notificationsRouter);
app.use('/api', metaRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// In production the built SPA is served from the same origin, so the cookie is first-party.
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  // body-parser tags its failures with a status; passing those through as 500
  // told the caller the server broke when the request was simply malformed.
  const status = Number(err.status ?? err.statusCode) || 500;

  if (status >= 500) {
    console.error(err);

    /*
     * A full disk is an operational fact, not a bug, and it deserves to say so.
     * Every write failed with "Something went wrong on the server", sign-in
     * included - so the admin who came to diagnose the outage could not get in
     * and had nothing pointing at the cause.
     */
    if (/disk is full|database or disk|SQLITE_FULL|ENOSPC/i.test(String(err?.message))) {
      return res.status(507).json({
        error: 'The server has run out of disk space, so nothing can be saved. Free some space and try again.',
      });
    }

    return res.status(500).json({ error: 'Something went wrong on the server' });
  }

  const message =
    err.type === 'entity.parse.failed'
      ? 'The request body is not valid JSON'
      : err.type === 'entity.too.large'
        ? 'The request body is too large'
        : err.message || 'Bad request';

  res.status(status).json({ error: message });
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4000);
  // Behind nginx this is 127.0.0.1, so the plain-HTTP port is not reachable from
  // outside and nobody can go around the certificate. Unset, every interface.
  const host = process.env.HOST || undefined;
  // Keeps the EUR/USD reference rate current without anyone having to think about it.
  if (process.env.DISABLE_FX_REFRESH !== '1') startDailyRefresh();
  // No-op until an admin sets a webhook URL in Settings.
  if (process.env.DISABLE_DIGEST !== '1') startDailyDigest();
  // Update e-mails to the people following each site; nothing goes out without PUBLIC_URL and SMTP.
  if (process.env.DISABLE_NOTIFICATIONS !== '1') startNotifications();

  app.listen(port, host, () => {
    console.log(`Integration Tracker API on http://${host ?? 'localhost'}:${port}`);
    if (!existsSync(clientDist)) console.log('No client build found - run `npm run dev` for the UI.');
  });
}
