import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { attachUser } from './lib/auth.js';
import { startDailyRefresh } from './lib/fx.js';
import { authRouter } from './routes/auth.js';
import { sitesRouter } from './routes/sites.js';
import { issuesRouter } from './routes/issues.js';
import { metaRouter } from './routes/meta.js';

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
app.use((_req, res, next) => {
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/sites', sitesRouter);
app.use('/api/issues', issuesRouter);
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
  // Keeps the EUR/USD reference rate current without anyone having to think about it.
  if (process.env.DISABLE_FX_REFRESH !== '1') startDailyRefresh();

  app.listen(port, () => {
    console.log(`Integration Tracker API on http://localhost:${port}`);
    if (!existsSync(clientDist)) console.log('No client build found - run `npm run dev` for the UI.');
  });
}
