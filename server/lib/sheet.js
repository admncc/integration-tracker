/**
 * Translation layer between the legacy Google Sheet and the tracker's vocabulary.
 * The sheet's values are hand-typed and inconsistent ("Tags Implemantion",
 * "Site under QAs"), so matching is fuzzy on purpose.
 */

const STATUS_PATTERNS = [
  // "n/a" first: it is the one label with no number, and the digit patterns
  // below would otherwise never see it and fall through to pending.
  [/n\/?a/i, 'na'],
  [/^1|live/i, 'live'],
  [/^2|qa/i, 'qa'],
  [/^3|implem/i, 'tag_impl'],
  [/^4|prep/i, 'tag_prep'],
  [/^5|pending/i, 'pending'],
];

export function parseStatus(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'na';
  for (const [pattern, status] of STATUS_PATTERNS) {
    if (pattern.test(value)) return status;
  }
  return 'pending';
}

export function parseCmp(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (value.startsWith('NEW')) return 'new';
  if (value.startsWith('OLD')) return 'old';
  return 'none';
}

export function parseApproval(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value.startsWith('approved')) return 'approved';
  if (value.startsWith('sent')) return 'sent';
  if (value.startsWith('reject')) return 'rejected';
  return 'none';
}

export function parseNumber(raw) {
  const value = String(raw ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The revenue sheet writes the currency into the cell itself ("€3.13", "$2.00"),
 * so the symbol decides the currency and an explicit column only overrides it.
 */
export function parseCurrency(raw, explicit, fallback = 'EUR') {
  const declared = String(explicit ?? '').trim().toUpperCase();
  if (declared === 'EUR' || declared === 'USD') return declared;

  const value = String(raw ?? '');
  if (value.includes('$') || /\bUSD\b/i.test(value)) return 'USD';
  if (value.includes('€') || /\bEUR\b/i.test(value)) return 'EUR';
  return fallback;
}

/** RFC 4180 CSV parser: handles quoted fields, embedded commas, and CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

export function toCsv(rows) {
  const escape = (value) => {
    const str = value == null ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return rows.map((row) => row.map(escape).join(',')).join('\r\n');
}

/** Header aliases so an export straight out of the shared sheet imports cleanly. */
const HEADER_ALIASES = {
  prio: 'priority',
  priority: 'priority',
  domain: 'domain',
  site: 'domain',
  'status (video)': 'status_video',
  video: 'status_video',
  'status (display)': 'status_display',
  display: 'status_display',
  'test url': 'test_url',
  'ads.txt (managerdomain)': 'status_ads_txt',
  'ads.txt': 'status_ads_txt',
  'status (ads.txt & ad tag)': 'status_ad_tag',
  'ad tag': 'status_ad_tag',
  mcm: 'status_mcm',
  cmp: 'cmp',
  'demand partner approval': 'approval',
  approval: 'approval',
  'kpis (current display page rpm)': 'rpm_previous',
  'page rpm': 'rpm_previous',
  'rpm benchmark': 'rpm_previous',
  'previous session rpm': 'rpm_previous',
  'previous session rpm (eur)': 'rpm_previous',
  'current rpm': 'rpm_primis',
  'primis session rpm': 'rpm_primis',
  'primis session rpm (eur)': 'rpm_primis',
  'previous rpm currency': 'rpm_previous_currency',
  'primis rpm currency': 'rpm_primis_currency',
  perf: 'rpm_previous',
  notes: 'notes',
  'managed by': 'managed_by',
};

/**
 * Maps CSV rows onto site records.
 *
 * Only the columns the CSV actually carries are returned. Filling in defaults
 * for absent columns and upserting the lot would reset priority, every track
 * status and the test URL of any domain that appears in a two-column revenue
 * sheet - a silent wipe of the rollout state.
 *
 * Returns `{ sites, columns, skipped }`; `columns` is what the caller may write,
 * and rows without a usable domain are reported back rather than dropped.
 */
export function csvToSites(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { sites: [], columns: [], skipped: [] };

  const header = rows[0].map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] ?? null);
  if (!header.includes('domain')) {
    throw new Error('CSV needs a "Domain" column');
  }

  const present = new Set(header.filter(Boolean));
  const parsers = {
    // The API bounds priority to 1-99. `|| 99` also swallowed a legitimate 0,
    // silently parking every domain a sheet marked as top priority.
    priority: (v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n)) return 99;
      return Math.min(99, Math.max(1, n));
    },
    test_url: (v) => String(v ?? '').trim(),
    status_video: parseStatus,
    status_display: parseStatus,
    status_ads_txt: parseStatus,
    status_ad_tag: parseStatus,
    status_mcm: parseStatus,
    cmp: parseCmp,
    approval: parseApproval,
    rpm_previous: parseNumber,
    rpm_primis: parseNumber,
    managed_by: (v) => String(v ?? '').trim(),
    notes: (v) => String(v ?? '').trim(),
  };

  // A currency column follows its amount, and an amount alone still carries one
  // in its symbol, so the two travel together.
  const columns = [...present].filter((field) => field in parsers);
  if (present.has('rpm_previous')) columns.push('rpm_previous_currency');
  if (present.has('rpm_primis')) columns.push('rpm_primis_currency');

  const sites = [];
  const skipped = [];

  for (const row of rows.slice(1)) {
    const record = {};
    header.forEach((field, index) => {
      if (field) record[field] = row[index] ?? '';
    });

    const domain = normaliseDomain(record.domain);
    if (!domain) {
      skipped.push(row.join(','));
      continue;
    }

    const site = { domain };
    for (const field of columns) {
      if (field === 'rpm_previous_currency') {
        site[field] = parseCurrency(record.rpm_previous, record.rpm_previous_currency, 'EUR');
      } else if (field === 'rpm_primis_currency') {
        site[field] = parseCurrency(record.rpm_primis, record.rpm_primis_currency, 'USD');
      } else {
        site[field] = parsers[field](record[field]);
      }
    }
    sites.push(site);
  }

  return { sites, columns, skipped };
}

/**
 * `https://www.Example.de:8080/path`, `Example.de` and `example.de` must all be
 * the same row. The URL parser does the work: it lower-cases, drops the port,
 * the path and the query, and converts an internationalised name to its
 * punycode form, so "münchen.de" and "xn--mnchen-3ya.de" no longer split in two.
 */
export function normaliseDomain(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';

  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }

  host = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ? host : '';
}
