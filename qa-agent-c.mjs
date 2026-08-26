import { chromium } from 'playwright';
const BASE = 'http://tracker.test:4403';
const noise = [];
const log = (...a) => console.log(...a);

async function launch() {
  return chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--host-resolver-rules=MAP tracker.test 127.0.0.1'] });
}
async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...opts });
  try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (e) { log('  (clipboard perm not granted:', e.message.slice(0,60), ')'); }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { noise.push(`PAGEERROR ${e.message}`); log('  !! PAGEERROR', e.message); });
  page.on('response', async (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) {
      let b = ''; try { b = (await r.text()).slice(0, 160); } catch {}
      noise.push(`HTTP${r.status()} ${r.request().method()} ${r.url().replace(BASE,'')} ${b}`);
      log(`  ~~ http${r.status()} ${r.request().method()} ${r.url().replace(BASE,'')} ${b}`);
    }
  });
  return page;
}
async function signIn(page, user, pass = 'changeme123') {
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('nav a:has-text("Dashboard")', { timeout: 15000 });
}
const api = (jar) => async (method, path, body) => {
  const res = await fetch(BASE.replace('tracker.test', '127.0.0.1') + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: jar, Host: 'tracker.test' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ---------------------------------------------------------------- phase 1
async function phase1() {
  const browser = await launch();
  const page = await newPage(browser);
  await signIn(page, 'admin');

  log('\n== 1. TEST URL BAR ==');
  await page.goto(BASE + '/sites/1', { waitUntil: 'networkidle' });
  const bar = page.locator('div.card', { has: page.getByText('Test URL', { exact: true }) }).first();
  const link = bar.locator('a').first();
  log('  link href   :', await link.getAttribute('href'));
  log('  link target :', await link.getAttribute('target'), 'rel:', await link.getAttribute('rel'));
  const openBtn = bar.getByText('Open test page');
  log('  open btn target:', await openBtn.getAttribute('target'));

  // Copy
  log('  navigator.clipboard present:', await page.evaluate(() => Boolean(navigator.clipboard)));
  await bar.getByRole('button', { name: 'Copy' }).click();
  await page.waitForTimeout(400);
  log('  btn label 400ms after copy:', JSON.stringify(await bar.getByRole('button').first().innerText()));
  const clip = await page.evaluate(() => (navigator.clipboard ? navigator.clipboard.readText().catch((e) => 'ERR ' + e.message) : 'NO CLIPBOARD API'));
  log('  clipboard   :', JSON.stringify(String(clip).slice(0, 60)));

  // Edit + save
  await bar.getByRole('button', { name: 'Edit' }).click();
  const input = page.locator('form.card input[type=url]');
  const orig = await input.inputValue();
  await input.fill('https://example.com/qa-c-edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  const after = await page.locator('div.card a[href="https://example.com/qa-c-edit"]').count();
  log('  saved+rendered as link:', after > 0);
  const chk = await (await fetch('http://127.0.0.1:4403/api/sites/1', { headers: { Cookie: process.env.JAR, Host: 'tracker.test' } })).json();
  log('  server test_url:', chk.site?.test_url);

  // invalid URL
  await page.locator('div.card').filter({ hasText: 'Test URL' }).first().getByRole('button', { name: 'Edit' }).click();
  const input2 = page.locator('form.card input[type=url]');
  await input2.fill('not a url at all');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  log('  after invalid save, still editing?', await page.locator('form.card input[type=url]').count() > 0);
  log('  input validity:', await input2.evaluate((el) => el.validity.valid).catch(() => 'gone'));
  const chk2 = await (await fetch('http://127.0.0.1:4403/api/sites/1', { headers: { Cookie: process.env.JAR, Host: 'tracker.test' } })).json();
  log('  server test_url after invalid:', JSON.stringify(chk2.site?.test_url));
  const linkNow = await page.locator('div.card').filter({ hasText: 'Test URL' }).first().locator('a').first().getAttribute('href').catch(() => null);
  log('  rendered href now:', JSON.stringify(linkNow));

  // restore
  await page.evaluate(async (u) => {
    await fetch('/api/sites/1', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test_url: u }) });
  }, orig);

  log('\n== site with no test URL (site 7 serien.de) ==');
  await page.goto(BASE + '/sites/7', { waitUntil: 'networkidle' });
  log('  add form shown:', await page.locator('form.card input[type=url]').count() > 0);
  log('  placeholder:', await page.locator('form.card input[type=url]').getAttribute('placeholder'));

  await browser.close();
  log('\nNOISE:', noise.length ? noise : 'none');
}


// ---------------------------------------------------------------- phase 2
async function phase2() {
  const browser = await launch();
  const page = await newPage(browser);
  let alerted = null;
  page.on('dialog', async (d) => { alerted = d.message(); await d.dismiss(); });
  await signIn(page, 'admin');

  log('\n== javascript: test URL ==');
  await page.goto(BASE + '/sites/2', { waitUntil: 'networkidle' });
  const bar = () => page.locator('div.card, form.card').filter({ hasText: 'Test URL' }).first();
  await bar().getByRole('button', { name: 'Edit' }).click();
  const inp = page.locator('form.card input[type=url]');
  await inp.fill('javascript:alert(document.domain)');
  log('  input validity for javascript: URL:', await inp.evaluate((el) => el.validity.valid));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(700);
  const saved = await page.evaluate(() => fetch('/api/sites/2').then((r) => r.json()).then((j) => j.site.test_url));
  log('  stored test_url:', JSON.stringify(saved));
  const href = await bar().locator('a').first().getAttribute('href').catch(() => 'no-link');
  log('  rendered href:', JSON.stringify(href));
  if (href && href.startsWith('javascript:')) {
    await bar().locator('a').first().click({ timeout: 3000 }).catch((e) => log('  click err', e.message.slice(0,60)));
    await page.waitForTimeout(600);
    log('  ALERT FIRED:', JSON.stringify(alerted));
  }
  await page.evaluate(() => fetch('/api/sites/2', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test_url: 'https://baumarkt-verzeichnis.de/renovierungsschutt-vom-baumarkt-projekt-richtig-entsorgen-lassen/' }) }));

  log('\n== 2. STATUS PANEL (site 30 wissens-forum.de) ==');
  const SITE = 30;
  const TRACKS = ['Video', 'Display', 'ads.txt', 'Ad tag', 'MCM'];
  await page.goto(`${BASE}/sites/${SITE}`, { waitUntil: 'networkidle' });
  const sel = (label) => page.locator('div').filter({ has: page.locator(`dt:text-is("${label}")`) }).locator('select').first();
  const readState = async () => ({
    pct: (await page.locator('text=/% of the five tracks live/').innerText()).trim(),
    barW: await page.locator('.h-1\\.5 > div').first().evaluate((el) => el.style.width),
    badge: (await page.locator('h1 + p span').first().innerText()).trim(),
    missing: await page.locator('p.text-tone-red').first().innerText().catch(() => null),
    parked: await page.locator('p.text-ink-faint:has-text("parked")').innerText().catch(() => null),
    dot: await page.locator('h1 span').first().getAttribute('class'),
  });
  log('  initial:', JSON.stringify(await readState()));

  for (const t of TRACKS) {
    await sel(t).selectOption('live');
    await page.waitForTimeout(450);
    const st = await readState();
    log(`  after ${t}=live -> pct=${st.pct} bar=${st.barW} badge=${st.badge} missing=${JSON.stringify(st.missing)}`);
  }
  const srv = await page.evaluate((id) => fetch('/api/sites/' + id).then((r) => r.json()).then((j) => j.site), SITE);
  log('  server tracks:', ['status_video','status_display','status_ads_txt','status_ad_tag','status_mcm'].map((k) => `${k}=${srv[k]}`).join(' '));
  log('  dot class (want bg-tone-green):', (await readState()).dot);

  log('  -- set Display back to 4 - Tags prep --');
  await sel('Display').selectOption('tag_prep');
  await page.waitForTimeout(450);
  log('  ', JSON.stringify(await readState()));
  log('  -- set MCM to n/a as well --');
  await sel('MCM').selectOption('na');
  await page.waitForTimeout(450);
  log('  ', JSON.stringify(await readState()));

  log('  -- priority 99 --');
  const prio = page.locator('div').filter({ has: page.locator('span:text-is("Priority")') }).locator('input[type=number]').first();
  await prio.fill('99'); await prio.press('Enter');
  await page.waitForTimeout(600);
  log('  ', JSON.stringify(await readState()));
  log('  -- back to priority 30, all live --');
  await prio.fill('30'); await prio.press('Enter');
  await page.waitForTimeout(500);
  await sel('Display').selectOption('live'); await page.waitForTimeout(400);
  await sel('MCM').selectOption('live'); await page.waitForTimeout(400);
  log('  ', JSON.stringify(await readState()));

  await browser.close();
  log('\nNOISE:', noise.length ? noise : 'none');
}

const phases = { phase1, phase2 };
await phases[process.argv[2]]();
