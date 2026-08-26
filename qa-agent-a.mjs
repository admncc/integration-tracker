import { chromium } from 'playwright';

export async function open({ user = 'admin', width = 1440, height = 900 } = {}) {
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--host-resolver-rules=MAP tracker.test 127.0.0.1'],
  });
  const ctx = await b.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [], bad = [], console_ = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console_.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  await page.goto('http://tracker.test:4401/');
  await page.fill('input[name="username"], input[placeholder*="sername" i], #username', user).catch(async () => {
    await page.getByLabel(/username/i).fill(user);
  });
  await page.getByLabel(/password/i).fill('changeme123').catch(async () => page.fill('input[type=password]', 'changeme123'));
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/(sites)?$/, { timeout: 10000 }).catch(() => {});
  await page.goto('http://tracker.test:4401/sites');
  await page.waitForSelector('table tbody tr', { timeout: 15000 });
  return { b, ctx, page, errors, bad, console_ };
}

export const apiSites = (page, q = '') =>
  page.evaluate((q) => fetch('/api/sites' + q, { credentials: 'same-origin' }).then((r) => r.json()), q);
