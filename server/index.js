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
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
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
