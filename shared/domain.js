/**
 * Vocabulary shared by API and UI. Values mirror the columns of the Google Sheet
 * this tool replaces, so the team can map old rows onto new records at a glance.
 */

export const TRACK_STATUS = {
  live:     { label: '1 – Live',                short: 'Live',      tone: 'green'  },
  qa:       { label: '2 – Site under QA',       short: 'QA',        tone: 'blue'   },
  tag_impl: { label: '3 – Tag implementation',  short: 'Impl.',     tone: 'amber'  },
  tag_prep: { label: '4 – Tags prep',           short: 'Prep',      tone: 'purple' },
  pending:  { label: '5 – Pending',             short: 'Pending',   tone: 'slate'  },
  na:       { label: '– n/a',                   short: 'n/a',       tone: 'muted'  },
};

/** The five integration tracks every site moves through, in reporting order. */
export const TRACKS = [
  { key: 'status_video',   label: 'Video' },
  { key: 'status_display', label: 'Display' },
  { key: 'status_ads_txt', label: 'ads.txt' },
  { key: 'status_ad_tag',  label: 'Ad tag' },
  { key: 'status_mcm',     label: 'MCM' },
];

export const CMP = {
  none: { label: 'No CMP',  tone: 'red'   },
  old:  { label: 'Old CMP', tone: 'amber' },
  new:  { label: 'New CMP', tone: 'green' },
};

export const APPROVAL = {
  none:     { label: 'Not submitted',    tone: 'slate' },
  sent:     { label: 'Sent to approval', tone: 'blue'  },
  approved: { label: 'Approved',         tone: 'green' },
  rejected: { label: 'Rejected',         tone: 'red'   },
};

/**
 * QA loop: the partner opens an issue, a dev picks it up and pushes a fix,
 * the partner re-checks. `verified` and `wont_fix` are terminal.
 */
export const ISSUE_STATUS = {
  open:         { label: 'Open',            tone: 'red',    terminal: false },
  in_progress:  { label: 'In progress',     tone: 'amber',  terminal: false },
  ready_for_qa: { label: 'Ready for re-check', tone: 'blue', terminal: false },
  verified:     { label: 'Verified',        tone: 'green',  terminal: true  },
  wont_fix:     { label: "Won't fix",       tone: 'muted',  terminal: true  },
};

export const OPEN_ISSUE_STATUSES = Object.keys(ISSUE_STATUS).filter((s) => !ISSUE_STATUS[s].terminal);

/**
 * Technical issues are implementation defects; revenue issues are yield problems
 * (RPM/CPM below benchmark, negative revenue, fill rate) where nothing is
 * strictly "broken" but the setup is not earning what it should.
 */
export const ISSUE_TYPE = {
  technical: { label: 'Technical', tone: 'blue',   hint: 'Tag, layout or consent defect on the page' },
  revenue:   { label: 'Revenue',   tone: 'purple', hint: 'RPM/CPM below benchmark, negative revenue, weak fill' },
};

/** Categories that are yield problems rather than implementation defects. */
export const REVENUE_CATEGORIES = new Set(['performance']);

export const ISSUE_CATEGORY = {
  video_tag:     'Video tag',
  display_tag:   'Display tag',
  ads_txt:       'ads.txt / MCM',
  cmp:           'CMP / consent',
  layout:        'Layout & placement',
  duplicate_ids: 'Duplicate tag IDs',
  old_units:     'Legacy ad units',
  amp:           'AMP',
  performance:   'RPM / revenue',
  fill_rate:     'Fill rate / demand',
  other:         'Other',
};

export const SEVERITY = {
  blocker: { label: 'Blocker', tone: 'red',   rank: 0 },
  high:    { label: 'High',    tone: 'amber', rank: 1 },
  medium:  { label: 'Medium',  tone: 'blue',  rank: 2 },
  low:     { label: 'Low',     tone: 'slate', rank: 3 },
};

export const ROLES = {
  admin:   { label: 'Admin',          hint: 'Full access, manages sites and users' },
  dev:     { label: 'Developer',      hint: 'Works off issues, updates site status' },
  partner: { label: 'Demand partner', hint: 'Primis: raises QA issues and verifies fixes' },
};

/**
 * The two RPM figures the team enters by hand, both in EUR: what the site earned
 * before the switch, and what it earns through Primis now.
 */
export const CURRENCIES = ['EUR', 'USD'];

/** Both figures are converted into this before any comparison is shown. */
export const BASE_CURRENCY = 'EUR';
export const DEFAULT_EUR_USD = 1.08;
export const FX_SETTING_KEY = 'fx_eur_usd';

export const RPM_FIELDS = [
  { key: 'rpm_previous', currencyKey: 'rpm_previous_currency', label: 'Previous Session RPM', short: 'Prev. RPM' },
  { key: 'rpm_primis', currencyKey: 'rpm_primis_currency', label: 'Primis Session RPM', short: 'Primis RPM' },
];

export function formatMoney(value, currency = BASE_CURRENCY) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || BASE_CURRENCY, minimumFractionDigits: 2 }).format(
    Number(value)
  );
}

/**
 * The two sides report in different currencies, so everything comparable runs
 * through the single EUR/USD rate an admin maintains under Settings.
 */
export function toBase(value, currency, eurUsd = DEFAULT_EUR_USD) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return null;
  const rate = Number(eurUsd) > 0 ? Number(eurUsd) : DEFAULT_EUR_USD;
  return currency === 'USD' ? Number(value) / rate : Number(value);
}

/**
 * Relative change from the previous setup to Primis, both normalised to EUR.
 * Null when a figure is missing or the old value was zero.
 */
export function rpmUplift(site, eurUsd = DEFAULT_EUR_USD) {
  const previous = toBase(site.rpm_previous, site.rpm_previous_currency ?? BASE_CURRENCY, eurUsd);
  const primis = toBase(site.rpm_primis, site.rpm_primis_currency ?? BASE_CURRENCY, eurUsd);
  if (previous == null || primis == null || previous <= 0) return null;
  return ((primis - previous) / previous) * 100;
}

/** Priority 99 is the parking lot: listed, but not part of the active rollout. */
export const INACTIVE_PRIORITY = 99;

/**
 * The traffic light on a domain, and the single definition of "live" the whole
 * tool uses:
 *
 *   inactive   – priority 99, parked rather than being worked on
 *   live       – all five integration tracks are Live
 *   incomplete – anything else
 *
 * Note this is about the integration, not about open issues — those are shown
 * by the issue count and the row highlight.
 */
export function siteReadiness(site) {
  if (Number(site.priority) >= INACTIVE_PRIORITY) return 'inactive';
  return TRACKS.every(({ key }) => site[key] === 'live') ? 'live' : 'incomplete';
}

export const READINESS = {
  live: { tone: 'green', label: 'Live', dot: 'bg-tone-green' },
  incomplete: { tone: 'red', label: 'Not fully live', dot: 'bg-tone-red' },
  inactive: { tone: 'muted', label: 'Not active', dot: 'bg-tone-muted' },
};

/** The tracks still standing between a site and a green light. */
export function missingTracks(site) {
  return TRACKS.filter(({ key }) => site[key] !== 'live').map(({ label }) => label);
}

/** Share of tracks that are Live — the same yardstick as the traffic light. */
export function siteCompletion(site) {
  const done = TRACKS.filter(({ key }) => site[key] === 'live').length;
  return Math.round((done / TRACKS.length) * 100);
}
