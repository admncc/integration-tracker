import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvToSites, normaliseDomain, parseApproval, parseCsv, parseCurrency, parseNumber, parseStatus, toCsv } from '../server/lib/sheet.js';

test('parseStatus reads the sheet wording, typos included', () => {
  assert.equal(parseStatus('1 - LIVE'), 'live');
  assert.equal(parseStatus('2 - Site under QAs'), 'qa');
  assert.equal(parseStatus('3 - Tags Implemantion'), 'tag_impl');
  assert.equal(parseStatus('4 - Tags prep'), 'tag_prep');
  assert.equal(parseStatus('5 - PENDING'), 'pending');
});

test('parseStatus treats an empty cell as not applicable', () => {
  assert.equal(parseStatus(''), 'na');
  assert.equal(parseStatus(null), 'na');
});

test('parseApproval understands the free-text approval column', () => {
  assert.equal(parseApproval('Approved'), 'approved');
  assert.equal(parseApproval('Sent to approval'), 'sent');
  assert.equal(parseApproval(''), 'none');
});

test('normaliseDomain strips scheme, www and path', () => {
  assert.equal(normaliseDomain('https://www.speedxtc.com/magazin/'), 'speedxtc.com');
  assert.equal(normaliseDomain('baumarkt-verzeichnis.de/cb/wohnen'), 'baumarkt-verzeichnis.de');
  assert.equal(normaliseDomain('  MAIKIKII.de '), 'maikikii.de');
});

test('normaliseDomain rejects anything that is not a domain', () => {
  assert.equal(normaliseDomain('not a domain'), '');
  assert.equal(normaliseDomain(''), '');
  assert.equal(normaliseDomain('localhost'), '');
});

test('parseCurrency takes the symbol out of the revenue sheet cell', () => {
  assert.equal(parseCurrency('€3.13'), 'EUR');
  assert.equal(parseCurrency('$2.00'), 'USD');
  assert.equal(parseCurrency('2.00'), 'EUR');
  assert.equal(parseCurrency('2.00', 'usd'), 'USD', 'an explicit column wins over the symbol');
});

test('parseNumber pulls the figure out of a formatted cell', () => {
  assert.equal(parseNumber('€3,13'), 3.13);
  assert.equal(parseNumber('$5.80'), 5.8);
  assert.equal(parseNumber('-'), null);
  assert.equal(parseNumber(''), null);
});

test('parseCsv handles quoted fields, embedded commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"one, two",three\r\n"say ""hi""",4');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['one, two', 'three'],
    ['say "hi"', '4'],
  ]);
});

test('toCsv quotes only what needs quoting and round-trips', () => {
  const rows = [
    ['Domain', 'Notes'],
    ['example.de', 'has, a comma'],
    ['other.de', 'says "hello"'],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('csvToSites maps a sheet export onto site records', () => {
  const { sites, skipped } = csvToSites(
    'PRIO,Domain,STATUS (video),STATUS (display),CMP,Demand partner approval\n' +
      '7,https://www.example.de/article,1 - LIVE,4 - Tags prep,NEW CMP,Approved\n' +
      ',not a domain,,,,'
  );

  assert.equal(sites.length, 1);
  assert.equal(skipped.length, 1);
  assert.deepEqual(
    { ...sites[0] },
    {
      domain: 'example.de',
      priority: 7,
      test_url: '',
      status_video: 'live',
      status_display: 'tag_prep',
      status_ads_txt: 'na',
      status_ad_tag: 'na',
      status_mcm: 'na',
      cmp: 'new',
      approval: 'approved',
      rpm_previous: null,
      rpm_previous_currency: 'EUR',
      rpm_primis: null,
      rpm_primis_currency: 'USD',
      managed_by: '',
      notes: '',
    }
  );
});

test('csvToSites reads the revenue sheet, currency symbol and all', () => {
  const { sites } = csvToSites('Domain,PERF\nmaikikii.de,€3.13\nspeedxtc.com/magazin/,$5.80');

  assert.deepEqual(
    sites.map((s) => [s.domain, s.rpm_previous, s.rpm_previous_currency]),
    [
      ['maikikii.de', 3.13, 'EUR'],
      ['speedxtc.com', 5.8, 'USD'],
    ]
  );
});

test('csvToSites refuses a CSV without a domain column', () => {
  assert.throws(() => csvToSites('Foo,Bar\n1,2'), /Domain/);
});
