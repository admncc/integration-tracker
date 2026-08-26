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

test('normaliseDomain drops a port and punycodes an international name', () => {
  assert.equal(normaliseDomain('https://www.Example-Port.de:8080/a/b?x=1'), 'example-port.de');
  assert.equal(normaliseDomain('example.de:8443'), 'example.de');
  assert.equal(normaliseDomain('HTTP://WWW.Baz.DE/a'), 'baz.de');
  assert.equal(normaliseDomain('example.de.'), 'example.de');
  // The two spellings of one domain must not become two rows.
  assert.equal(normaliseDomain('m\u00fcnchen.de'), normaliseDomain('xn--mnchen-3ya.de'));
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
  const { sites, columns, skipped } = csvToSites(
    'PRIO,Domain,STATUS (video),STATUS (display),CMP,Demand partner approval\n' +
      '7,https://www.example.de/article,1 - LIVE,4 - Tags prep,NEW CMP,Approved\n' +
      ',not a domain,,,,'
  );

  assert.equal(sites.length, 1);
  assert.equal(skipped.length, 1);
  assert.deepEqual(sites[0], {
    domain: 'example.de',
    priority: 7,
    status_video: 'live',
    status_display: 'tag_prep',
    cmp: 'new',
    approval: 'approved',
  });
  assert.deepEqual(columns.sort(), ['approval', 'cmp', 'priority', 'status_display', 'status_video']);
});

test('csvToSites returns only the columns the CSV carries', () => {
  // A two-column revenue sheet used to come back with defaults for everything
  // else, and the importer then wrote those defaults over the rollout state.
  const { sites, columns } = csvToSites('Domain,PERF\nmaikikii.de,€3.13');

  assert.deepEqual(columns.sort(), ['rpm_previous', 'rpm_previous_currency']);
  assert.deepEqual(sites[0], { domain: 'maikikii.de', rpm_previous: 3.13, rpm_previous_currency: 'EUR' });
  for (const field of ['priority', 'status_video', 'status_display', 'test_url', 'approval', 'cmp']) {
    assert.equal(field in sites[0], false, `${field} must not be invented`);
  }
});

test('an exported n/a status survives a re-import', () => {
  // The exporter writes the label, and the parser used to fall through to
  // pending, so every round trip quietly promoted 24 sites.
  assert.equal(parseStatus('- n/a'), 'na');
  assert.equal(parseStatus('n/a'), 'na');
  assert.equal(parseStatus('N/A'), 'na');

  const { sites } = csvToSites('Domain,STATUS (video)\nexample.de,- n/a');
  assert.equal(sites[0].status_video, 'na');
});

test('a currency column travels with its amount', () => {
  const { columns } = csvToSites('Domain,Previous Session RPM,Primis Session RPM\nexample.de,3.13,2.00');
  assert.deepEqual(columns.sort(), ['rpm_previous', 'rpm_previous_currency', 'rpm_primis', 'rpm_primis_currency'].sort());
});

test('csvToSites refuses a CSV without a domain column', () => {
  assert.throws(() => csvToSites('Foo,Bar\n1,2'), /Domain/);
});
