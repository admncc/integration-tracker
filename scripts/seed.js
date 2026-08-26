/**
 * Seeds the tracker with the current rollout state: every domain from the shared
 * Google Sheet plus the QA findings that were still living in the mail thread.
 *
 *   node scripts/seed.js            # upsert, keeps existing data
 *   node scripts/seed.js --reset    # drop the database file first
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dbPath = process.env.DATABASE_PATH ? resolve(process.env.DATABASE_PATH) : resolve(process.cwd(), 'data/tracker.db');
if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  console.log(`Removed ${dbPath}`);
}

const { db, logActivity } = await import('../server/lib/db.js');
const { hashPassword } = await import('../server/lib/auth.js');
const { parseStatus, parseCmp, parseApproval, normaliseDomain } = await import('../server/lib/sheet.js');

const DEFAULT_PASSWORD = process.env.SEED_PASSWORD ?? 'changeme123';

const USERS = [
  { username: 'admin',      email: 'admin@publisher.test', name: 'Khoi Pham',    role: 'admin',   company: 'Publisher' },
  { username: 'dev',        email: 'dev@publisher.test',   name: 'Dev Team',     role: 'dev',     company: 'Publisher' },
  { username: 'dev-extern', email: 'dev2@publisher.test',  name: 'External Dev', role: 'dev',     company: 'Publisher' },
  { username: 'primis-qa',  email: 'qa@primis.test',       name: 'Primis QA',    role: 'partner', company: 'Primis' },
];

// PRIO | domain | video | display | test URL | ads.txt | ad tag | MCM | CMP | approval
const SHEET = `
1|maikikii.de|1 - LIVE|1 - LIVE|https://www.maikikii.de/weitere-buecher/gesundheit-wohlfuehlen/was-ist-eine-kristallmatte-und-wie-wirkt-sie/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
2|baumarkt-verzeichnis.de|1 - LIVE|1 - LIVE|https://baumarkt-verzeichnis.de/renovierungsschutt-vom-baumarkt-projekt-richtig-entsorgen-lassen/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|Approved
3|www.speedxtc.com|1 - LIVE|1 - LIVE|https://www.speedxtc.com/essen-motor-show-2024-tuningparadies-autofans/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|Approved
4|weine-dieser-welt.com|1 - LIVE|1 - LIVE|https://weine-dieser-welt.com/weinempfehlung-mac-and-cheese/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|Approved
5|anwalt-seiten.de|1 - LIVE|1 - LIVE|https://anwalt-seiten.de/sachverstaendige-geodaeten-grenzstreitverfahren/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|Approved
6|www.speedxpertz.com|1 - LIVE|1 - LIVE|https://www.speedxpertz.com/kim-dotcom/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|Approved
7|serien.de|1 - LIVE|2 - Site under QAs||1 - LIVE|5 - PENDING|5 - PENDING|OLD CMP|Approved
8|it-boltwise.de|1 - LIVE|3 - Tags Implemantion||1 - LIVE|5 - PENDING|5 - PENDING|OLD CMP|Approved
9|popcorntimes.tv|1 - LIVE|3 - Tags Implemantion||1 - LIVE|5 - PENDING|5 - PENDING|OLD CMP|Approved
10|trailer.de|1 - LIVE|2 - Site under QAs||1 - LIVE|5 - PENDING|5 - PENDING|OLD CMP|Approved
11|thenachricht.de|1 - LIVE|2 - Site under QAs|https://thenachricht.de/energiepreise-gebaeudetechnik-verbrauch-reduzieren/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
12|buecherchaos.de|1 - LIVE|1 - LIVE|https://buecherchaos.de/fantasy/ouija-tote-luegen-nicht-von-melissa-ratsch/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
13|ceilersnews.de|1 - LIVE|2 - Site under QAs|https://ceilersnews.de/sport/olympische-sommerspiele-spielplan-und-ergebnisse/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
14|eintragnews.de|1 - LIVE|1 - LIVE|https://eintragnews.de/unternehmenseffizienz-durch-umzugslogistik/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
15|fhm-online.de|1 - LIVE|2 - Site under QAs|https://fhm-online.de/auto-technik/fuhrparkkosten-2026/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
16|foxyform.de|1 - LIVE|2 - Site under QAs|https://foxyform.de/drachen-tattoo/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
17|sky-flight.de|1 - LIVE|2 - Site under QAs|https://sky-flight.de/groesster-supermarkt-welt/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
18|haus-wissen.de|1 - LIVE|2 - Site under QAs|https://haus-wissen.de/duschrueckwand-aluverbund-montage-2026/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
19|finanz-fachwelt.de|1 - LIVE|2 - Site under QAs|https://finanz-fachwelt.de/immobilienmakler-vs-privatverkauf/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
20|investoren-strategie.de|1 - LIVE|1 - LIVE|https://investoren-strategie.de/kredit-von-privat/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
21|geschaefts-kompetenz.de|1 - LIVE|4 - Tags prep||1 - LIVE|1 - LIVE|1 - LIVE|OLD CMP|
22|effizienzinstitut.de|1 - LIVE|4 - Tags prep||1 - LIVE|1 - LIVE|1 - LIVE|OLD CMP|
22|business-und-kompetenz.de|1 - LIVE|1 - LIVE|https://business-und-kompetenz.de/agenturen-patientengewinnung-bewertungsmanagement-arztpraxen-2026/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
23|altstadtkirche.de|1 - LIVE|1 - LIVE|https://altstadtkirche.de/aus-der-schatzkiste/oyarzabal/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|
24|timesmojo.com|1 - LIVE|4 - Tags prep||1 - LIVE|1 - LIVE|1 - LIVE|OLD CMP|Approved
25|planforsuccesshq.com|1 - LIVE|4 - Tags prep||1 - LIVE|1 - LIVE|1 - LIVE|OLD CMP|
26|deutschtime.de|1 - LIVE|4 - Tags prep||1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|Approved
27|reinvestiert.de|1 - LIVE|2 - Site under QAs|https://reinvestiert.de/maerkte-hintergruende/naherholungsgebiete-einfluss-immobilienpreise/|1 - LIVE|1 - LIVE|1 - LIVE|NEW CMP|Approved
28|themenmagnet.de|1 - LIVE|4 - Tags prep||1 - LIVE|1 - LIVE|1 - LIVE|OLD CMP|
29|wissens-forum.de|1 - LIVE|4 - Tags prep||1 - LIVE|1 - LIVE|1 - LIVE|OLD CMP|
30|glueckzuhaus.de|1 - LIVE|4 - Tags prep||1 - LIVE|5 - PENDING|5 - PENDING|NEW CMP|
31|das-nachrichtenblatt.de|1 - LIVE|4 - Tags prep||1 - LIVE|5 - PENDING|5 - PENDING|NEW CMP|
32|nachrichtenzeit.de|1 - LIVE|4 - Tags prep||1 - LIVE|5 - PENDING|5 - PENDING|NEW CMP|
33|transfernews.de|5 - PENDING|4 - Tags prep||1 - LIVE|5 - PENDING|5 - PENDING|NEW CMP|
33|meldungen.net|5 - PENDING|5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING|OLD CMP|
99|get-a-wingman.com||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|www.grammesencentilitres.com||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|www.millilitresengrammes.com||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||Sent to approval
99|www.grammesenmillilitres.com||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||Sent to approval
99|einfach-sparen.org||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|mindelmedia-news.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|kapital-insider.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|wermachtwas.online||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|newsile.com||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|wohnfrage.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|kapital-wissen.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|netzreichweite.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|contentspiegel.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|businessweitblick.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||
99|nwzonline.at||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||Sent to approval
99|welt-der-legenden.de||5 - PENDING||5 - PENDING|1 - LIVE|5 - PENDING||Sent to approval
99|news-7.de||5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING||Sent to approval
99|ideenhub.de||5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING||Sent to approval
99|gemeinschaft-energie.de||5 - PENDING||5 - PENDING|1 - LIVE|1 - LIVE||Sent to approval
99|eltern-sucht.de||5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING||Sent to approval
99|freie-infos.de||5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING||Sent to approval
99|bastelnd.de||5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING||Sent to approval
99|stillend.de||5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING||Sent to approval
99|klamm.de||5 - PENDING||5 - PENDING|5 - PENDING|5 - PENDING||
`.trim();

const userIds = {};
for (const user of USERS) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(user.username);
  userIds[user.username] = existing
    ? existing.id
    : Number(
        db
          .prepare('INSERT INTO users (username, email, name, password_hash, role, company) VALUES (?, ?, ?, ?, ?, ?)')
          .run(user.username, user.email, user.name, hashPassword(DEFAULT_PASSWORD), user.role, user.company).lastInsertRowid
      );
}

const admin = userIds.admin;
const dev = userIds.dev;
const externalDev = userIds['dev-extern'];
const partner = userIds['primis-qa'];

/*
 * Additive on purpose: re-running the seed after a `git pull` brings in newly
 * listed domains without resetting a status somebody has since moved by hand.
 */
const upsertSite = db.prepare(`
  INSERT INTO sites (domain, priority, test_url, status_video, status_display, status_ads_txt, status_ad_tag, status_mcm, cmp, approval, managed_by, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(domain) DO NOTHING
`);

// Domains the mail thread flags as handled by a third party - worth carrying over.
const EXTERNALLY_MANAGED = new Set(['it-boltwise.de', 'popcorntimes.tv']);

let siteCount = 0;
for (const line of SHEET.split('\n')) {
  const [prio, rawDomain, video, display, testUrl, adsTxt, adTag, mcm, cmp, approval] = line.split('|');
  const domain = normaliseDomain(rawDomain);
  if (!domain) {
    console.warn(`Skipped unparseable domain: ${rawDomain}`);
    continue;
  }
  const info = upsertSite.run(
    domain,
    Number.parseInt(prio, 10) || 99,
    testUrl ?? '',
    parseStatus(video), parseStatus(display), parseStatus(adsTxt), parseStatus(adTag), parseStatus(mcm),
    parseCmp(cmp), parseApproval(approval),
    EXTERNALLY_MANAGED.has(domain) ? 'External team' : '',
    ''
  );
  if (info.changes > 0) siteCount += 1;
}

/*
 * Live on the revenue side but absent from the Primis rollout sheet, so they are
 * tracked with every integration track still pending. Where the revenue sheet
 * carried a tracking link rather than an article URL, it goes into the notes -
 * it is not a page the partner can QA against.
 */
const REVENUE_ONLY = [
  ['wholekitchensink.com', 'Active on the revenue side. Tracking link: https://gnxm5.ttrk.io/6953101d99fa978f1afc17cd'],
  ['zitatecke.de', 'Active on the revenue side. Tracking link: https://gnxm5.ttrk.io/695ae862076a3d4e737303f6'],
  ['beautyandthebenchpress.com', 'Active on the revenue side, no RPM reported yet. Tracking link: https://gnxm5.ttrk.io/69c0ec507b35c8c14baccccf'],
  ['forkidsplus.com', 'Active on the revenue side.'],
  ['labon.fr', 'Active on the revenue side.'],
  ['hotelsandhoteliers.com', 'Active on the revenue side, flagged for review.'],
];

let extraCount = 0;
for (const [rawDomain, note] of REVENUE_ONLY) {
  const domain = normaliseDomain(rawDomain);
  if (!domain) continue;
  const info = upsertSite.run(
    domain, 99, '',
    'pending', 'pending', 'pending', 'pending', 'pending',
    'none', 'none', '',
    `${note} Not part of the Primis rollout list yet.`
  );
  if (info.changes > 0) extraCount += 1;
}

db.prepare("UPDATE sites SET notes = 'Paused on the revenue side.' WHERE domain = 'news-7.de' AND notes = ''").run();

const siteId = (domain) => db.prepare('SELECT id FROM sites WHERE domain = ?').get(normaliseDomain(domain))?.id;
const siteExists = (domain) => Boolean(db.prepare('SELECT 1 FROM sites WHERE domain = ?').get(domain));

/** Creates a batch plus one issue per domain, mirroring a single QA mail. */
function seedBatch({ title, description, type = 'technical', category, severity, domains, status = 'open', assignee = dev, overrides = {} }) {
  if (db.prepare('SELECT id FROM batches WHERE title = ?').get(title)) return;
  const batchId = Number(db.prepare('INSERT INTO batches (title, created_by) VALUES (?, ?)').run(title, partner).lastInsertRowid);

  for (const domain of domains) {
    const id = siteId(domain);
    if (!id) continue;
    const finalStatus = overrides[domain] ?? status;
    const issueId = Number(
      db
        .prepare(
          `INSERT INTO issues (site_id, batch_id, title, description, type, category, severity, status, reporter_id, assignee_id, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, batchId, title, description, type, category, severity, finalStatus, partner, assignee, finalStatus === 'verified' ? new Date().toISOString() : null)
        .lastInsertRowid
    );
    recordHistory({ siteId: id, issueId, title, status: finalStatus, assignee });
  }
}

function seedIssue({ domain, title, description, type = 'technical', category, severity, status = 'open', assignee = dev, comments = [] }) {
  const id = siteId(domain);
  if (!id || db.prepare('SELECT id FROM issues WHERE site_id = ? AND title = ?').get(id, title)) return;

  const issueId = Number(
    db
      .prepare(
        `INSERT INTO issues (site_id, title, description, type, category, severity, status, reporter_id, assignee_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, title, description, type, category, severity, status, partner, assignee).lastInsertRowid
  );
  for (const [authorId, body] of comments) {
    db.prepare('INSERT INTO comments (issue_id, author_id, body) VALUES (?, ?, ?)').run(issueId, authorId, body);
  }
  recordHistory({ siteId: id, issueId, title, status, assignee });
}

/**
 * Seeded issues are written straight into the table, so the audit trail has to
 * be filled in explicitly - otherwise a fresh install shows an empty history
 * next to a site that plainly has work on it.
 */
function recordHistory({ siteId: site, issueId, title, status, assignee }) {
  logActivity({ siteId: site, issueId, actorId: partner, kind: 'issue_created', newValue: title });

  const path = { open: [], in_progress: ['in_progress'], ready_for_qa: ['in_progress', 'ready_for_qa'], verified: ['in_progress', 'ready_for_qa', 'verified'] };
  let previous = 'open';
  for (const next of path[status] ?? []) {
    logActivity({
      siteId: site,
      issueId,
      actorId: next === 'verified' ? partner : assignee,
      kind: 'issue_status',
      field: 'status',
      oldValue: previous,
      newValue: next,
    });
    previous = next;
  }
}

seedBatch({
  title: 'Video player embedded in <head> instead of <body>',
  description:
    'The Primis video player must be placed in the <body>, not the <head>. Implementing it in the head code is expected to hurt monetization.\n\nReported by Primis on 23 Aug. Re-checked on 25 Aug - still open on the domains listed below.',
  category: 'video_tag',
  severity: 'high',
  status: 'verified',
  domains: [
    'weine-dieser-welt.com', 'speedxtc.com', 'fhm-online.de', 'finanz-fachwelt.de', 'foxyform.de',
    'haus-wissen.de', 'ceilersnews.de', 'business-und-kompetenz.de', 'newsile.com', 'altstadtkirche.de',
    'sky-flight.de', 'investoren-strategie.de', 'deutschtime.de',
  ],
  overrides: { 'weine-dieser-welt.com': 'open', 'investoren-strategie.de': 'open' },
});

seedBatch({
  title: 'Remove remaining TheMoneytizer units and ads.txt lines',
  description:
    'Primis should be the sole seller of this inventory. Remove the TheMoneytizer tags and their ads.txt lines so the market sees a single seller.\n\nBlocked where the contract still runs or an external team owns the site.',
  category: 'old_units',
  severity: 'medium',
  status: 'in_progress',
  domains: ['serien.de', 'it-boltwise.de', 'popcorntimes.tv', 'trailer.de'],
  assignee: externalDev,
});

seedIssue({
  domain: 'newsile.com',
  title: 'Primis tag removed from the site entirely',
  description: 'As of 25 Aug the Primis tag is no longer present on newsile.com. Likely removed by mistake during another deployment - please restore it and confirm.',
  category: 'display_tag',
  severity: 'blocker',
  comments: [[partner, 'Noticed this during the re-check on 25 Aug - the tag was still there the day before.']],
});

seedIssue({
  domain: 'sky-flight.de',
  title: 'Replace sidebar InContent unit with a Siderail unit',
  description: 'An InContent unit sits at the top of the left sidebar. Sidebars should carry Siderail units only. Primis can supply additional Siderail tags on request.',
  category: 'layout',
  severity: 'medium',
});

seedIssue({
  domain: 'sky-flight.de',
  title: 'AMP traffic needs its own tag setup',
  description: 'Mobile users are redirected to the AMP version unless they manually exit at the bottom. AMP requires a completely separate tag setup - confirm whether this domain serves strictly AMP traffic so Primis can generate dedicated AMP tags.',
  category: 'amp',
  severity: 'high',
});

seedIssue({
  domain: 'sky-flight.de',
  title: 'Duplicated ad tags reused without unique IDs',
  description:
    'The same ad tags are reused on the page without unique IDs. Each instance needs a matching unique `id` and `slotId`.\n\nExamples: sky-flight.de_leaderboard_2_33357, sky-flight.de_incontent_1_33357 through 5_33357.',
  category: 'duplicate_ids',
  severity: 'high',
});

seedIssue({
  domain: 'sky-flight.de',
  title: 'Hidden units inside wpb_wrapper are not rendering',
  description: 'Some units render off-page - e.g. sky-flight.de_incontent_1_33357 sits inside a wpb_wrapper container that is not fully rendering. Please review those placements.',
  category: 'layout',
  severity: 'medium',
});

seedIssue({
  domain: 'altstadtkirche.de',
  title: 'Remove leftover TheMoneytizer footer ad and AdSense units',
  description: 'There is still an extra TheMoneytizer ad in the footer, plus several inserted AdSense ads. Confirm whether the AdSense units are also being removed.',
  category: 'old_units',
  severity: 'medium',
});

seedIssue({
  domain: 'altstadtkirche.de',
  title: 'Container width 688px cuts off the 728px creative',
  description: 'The ad container is restricted to 688px, which crops the 728px creative. Widening the container to 728px should lift revenue.',
  category: 'layout',
  severity: 'high',
});

seedIssue({
  domain: 'altstadtkirche.de',
  title: 'Remove Incontent_6 from the top sidebar',
  description: 'Incontent_6 was added to the top sidebar. Sidebars should carry Siderail units only.',
  category: 'layout',
  severity: 'medium',
});

seedBatch({
  title: 'Negative revenue - investigate serving cost vs. yield',
  type: 'revenue',
  description:
    'Looker shows negative revenue on these domains: operational and serving costs exceed the revenue generated. Primis applied a major optimization on 19 Aug; re-evaluate after a few days and decide whether to keep, re-setup, or drop the site.',
  category: 'performance',
  severity: 'high',
  status: 'in_progress',
  domains: ['foxyform.de', 'eintragnews.de', 'investoren-strategie.de'],
  assignee: admin,
});

seedBatch({
  title: 'Add the TheMoneytizer Page RPM benchmark to the tracker',
  description:
    'Primis needs a rough Page RPM benchmark per site to steer optimization. Enter the RPM you were seeing with TheMoneytizer in the "RPM target" column so both sides can measure against the same number.',
  type: 'revenue',
  category: 'performance',
  severity: 'medium',
  domains: ['maikikii.de', 'baumarkt-verzeichnis.de', 'speedxtc.com', 'weine-dieser-welt.com', 'anwalt-seiten.de', 'speedxpertz.com'],
  assignee: admin,
});

seedIssue({
  domain: 'speedxtc.com',
  title: 'Video RPM lags display RPM by a wide margin',
  description:
    'Display is performing strongly here while video revenue stays flat. Video and display performance do not always correlate - review the player placement and demand mix on this domain.',
  type: 'revenue',
  category: 'performance',
  severity: 'medium',
  assignee: admin,
});

seedIssue({
  domain: 'investoren-strategie.de',
  title: 'CMP not detectable on the domain',
  description: 'Primis could not see a CMP on this domain. The publisher confirmed the new InMobi CMP is in use - verify it actually loads for EU traffic.',
  category: 'cmp',
  severity: 'high',
  status: 'ready_for_qa',
  comments: [
    [admin, 'We are using our new CMP from InMobi on this domain as well.'],
    [partner, 'Thanks - re-checking on our side.'],
  ],
});

/*
 * Previous Session RPM per domain, taken verbatim from the revenue sheet.
 * Values are mixed EUR and USD there, so the currency travels with the number.
 * Primis Session RPM is deliberately left empty - the team fills that in.
 */
const PREVIOUS_RPM = `
maikikii.de|3.13|EUR
anwalt-seiten.de|3.14|EUR
weine-dieser-welt.com|2.00|USD
buecherchaos.de|2.00|USD
ceilersnews.de|4.00|EUR
eintragnews.de|2.22|EUR
finanz-fachwelt.de|2.50|EUR
haus-wissen.de|4.81|EUR
speedxpertz.com|4.78|EUR
speedxtc.com|5.80|USD
foxyform.de|4.50|EUR
investoren-strategie.de|1.90|USD
geschaefts-kompetenz.de|3.60|EUR
baumarkt-verzeichnis.de|3.13|EUR
effizienzinstitut.de|3.80|EUR
business-und-kompetenz.de|2.80|EUR
newsile.com|6.00|USD
sky-flight.de|3.00|USD
fhm-online.de|5.58|USD
altstadtkirche.de|2.50|EUR
timesmojo.com|2.00|EUR
thenachricht.de|1.34|USD
planforsuccesshq.com|1.48|EUR
deutschtime.de|1.00|USD
reinvestiert.de|1.00|USD
themenmagnet.de|1.65|EUR
wissens-forum.de|1.30|EUR
grammesenmillilitres.com|1.22|USD
grammesencentilitres.com|1.00|EUR
millilitresengrammes.com|1.00|USD
kapital-insider.de|1.00|EUR
contentspiegel.de|1.00|EUR
kapital-wissen.de|1.00|EUR
businessweitblick.de|1.00|EUR
nwzonline.at|1.00|EUR
netzreichweite.de|1.16|EUR
wohnfrage.de|0.50|USD
wermachtwas.online|1.20|USD
mindelmedia-news.de|1.30|EUR
`.trim();

const setRpm = db.prepare(
  'UPDATE sites SET rpm_previous = ?, rpm_previous_currency = ? WHERE domain = ? AND rpm_previous IS NULL'
);

let rpmSet = 0;
let rpmMissing = [];
for (const line of PREVIOUS_RPM.split('\n')) {
  const [rawDomain, value, currency] = line.split('|');
  const domain = normaliseDomain(rawDomain);
  const info = setRpm.run(Number(value), currency, domain);
  if (info.changes > 0) rpmSet += 1;
  else if (!siteExists(domain)) rpmMissing.push(rawDomain);
}

const counts = db.prepare('SELECT (SELECT COUNT(*) FROM sites) AS sites, (SELECT COUNT(*) FROM issues) AS issues, (SELECT COUNT(*) FROM users) AS users').get();
console.log(`Added ${siteCount} domain(s) from the rollout sheet and ${extraCount} from the revenue sheet.`);
console.log('Existing rows were left untouched - the seed only ever adds.');
console.log(`Set Previous Session RPM on ${rpmSet} site(s).`);
if (rpmMissing.length) console.log(`Not tracked yet, RPM skipped: ${rpmMissing.join(', ')}`);
console.log(`Database now holds ${counts.sites} sites, ${counts.issues} issues, ${counts.users} users.`);
console.log(`\nSign in with any of these (password: ${DEFAULT_PASSWORD}):`);
for (const u of USERS) console.log(`  ${u.role.padEnd(8)} ${u.username.padEnd(12)} (${u.name})`);
console.log('\nChange these passwords before putting the tracker in front of the partner.');
