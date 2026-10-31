import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { Site, TrackStatus, User } from '../lib/types';
import { APPROVAL, CMP, DEMAND_BLOCK, READINESS, TRACKS, TRACK_STATUS, formatMoney, formatUplift, missingTracks, rpmUplift, siteReadiness } from '@shared/domain.js';
import { DemandFlagButton, flaggedBy } from '../components/DemandFlag';
import { Badge, Button, CurrencyToggle, Empty, Field, InlineSelect, InlineText, Modal, Spinner, type Tone } from '../components/ui';
import IssueModal from '../components/IssueModal';
import NetworkIssues from '../components/NetworkIssues';

type FilterMap = Record<string, string>;
type SortState = { key: string; dir: 1 | -1 };

// The table shows the short forms; the dropdown itself still spells them out.
const STATUS_OPTIONS = Object.entries(TRACK_STATUS).map(([value, meta]) => ({ value: value as TrackStatus, label: meta.label, short: meta.short }));
const CMP_OPTIONS = Object.entries(CMP).map(([value, meta]) => ({ value, label: meta.label, short: meta.short }));
const APPROVAL_OPTIONS = Object.entries(APPROVAL).map(([value, meta]) => ({ value, label: meta.label, short: meta.short }));

/** Column descriptors drive the header, the filter row and the cell renderer alike. */
type Column = {
  key: string;
  label: string;
  kind: 'number' | 'money' | 'uplift' | 'text' | 'enum' | 'issues';
  options?: { value: string; label: string; short?: string }[];
  tones?: Record<string, Tone>;
  /** Relative share of the table width; the percentages are computed from these. */
  weight: number;
  /** Dropped below NARROW_VIEWPORT. */
  secondary?: boolean;
  /** Dropped below TIGHT_VIEWPORT, where even the short labels stop fitting. */
  tier?: 2;
};

/** The checkbox column has no descriptor but still needs a share. */
const SELECT_COLUMN_WEIGHT = 2.5;

/**
 * 1280 is the widest viewport where all thirteen columns still render their
 * labels in full; below it the revenue columns are hidden rather than squeezed
 * until "New" and "None" both read "N...".
 */
const NARROW_VIEWPORT = 1280;

/**
 * Below this even "New" and "Approved" stop fitting their columns. Both are on
 * the domain's own page, so they give way rather than render as "N..." where
 * New and None become the same thing.
 */
const TIGHT_VIEWPORT = 1120;

const tonesOf = (map: Record<string, { tone: string }>) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.tone as Tone]));

/*
 * Widths are percentages that add up to 100 and the table is `table-fixed`, so
 * the grid always fits the viewport - no horizontal scrolling, whatever the
 * screen. Anything that does not survive that budget (managed by, notes) lives
 * on the site's detail page instead.
 */
const COLUMNS: Column[] = [
  { key: 'priority', label: 'Prio', kind: 'number', weight: 4.7 },
  { key: 'domain', label: 'Domain', kind: 'text', weight: 16 },
  ...TRACKS.map((track) => ({
    key: track.key,
    label: track.label,
    kind: 'enum' as const,
    options: STATUS_OPTIONS,
    tones: tonesOf(TRACK_STATUS),
    weight: 7.8,
  })),
  { key: 'cmp', label: 'CMP', kind: 'enum', options: CMP_OPTIONS, tones: tonesOf(CMP), weight: 5.5, tier: 2 },
  { key: 'approval', label: 'Approval', kind: 'enum', options: APPROVAL_OPTIONS, tones: tonesOf(APPROVAL), weight: 8.5, tier: 2 },
  { key: 'open_issues', label: 'Issues', kind: 'issues', weight: 6.3 },
  { key: 'rpm_previous', label: 'Prev. RPM', kind: 'money', weight: 6.5, secondary: true },
  { key: 'rpm_primis', label: 'Primis RPM', kind: 'money', weight: 6.5, secondary: true },
  { key: 'rpm_uplift', label: 'Δ', kind: 'uplift', weight: 4.5, secondary: true },
];

/**
 * Accepts what a person actually types or pastes out of a spreadsheet:
 * "3,14", "1 234,56", "1.234,56" and "1,234.56" all mean the same figure.
 * Returns null when the text is not a number at all, so the caller can say so
 * instead of storing nothing.
 */
export function parseDecimal(raw: string): number | null {
  let text = raw.trim().replace(/[\s\u00a0']/g, '');
  if (!text) return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    // Whichever comes last is the decimal separator; the other groups thousands.
    const [decimal, grouping] = lastComma > lastDot ? [',', '.'] : ['.', ','];
    text = text.split(grouping).join('').replace(decimal, '.');
  } else if (lastComma !== -1) {
    // A lone comma is a decimal separator unless it groups three digits.
    text = /^\d{1,3}(,\d{3})+$/.test(text) ? text.split(',').join('') : text.replace(',', '.');
  }

  if (!/^-?\d*\.?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Fields the partner may change; everything else is publisher-owned. */

export default function Sites() {
  const { can, eurUsd } = useSession();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterMap>({});
  const [sort, setSort] = useState<SortState>({ key: 'priority', dir: 1 });
  const [showArchived, setShowArchived] = useState(false);
  /** The traffic-light chips, plus the two demand-partner flags, which filter the same way. */
  const [readiness, setReadiness] = useState<'all' | 'live' | 'incomplete' | 'inactive' | 'mostly_blocked' | 'offline'>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Hiding the revenue columns beats rendering "N..." where "New" and "None"
  // become indistinguishable; the figures are still on each domain's page.
  const [width, setWidth] = useState(() => window.innerWidth);
  const [params] = useSearchParams();
  /** Newest save wins per cell, so a slow response cannot undo a later edit. */
  const saveTickets = useRef(new Map<string, number>());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const narrow = width < NARROW_VIEWPORT;
  const tight = width < TIGHT_VIEWPORT;
  const columns = useMemo(
    () => COLUMNS.filter((column) => !(narrow && column.secondary) && !(tight && column.tier === 2)),
    [narrow, tight]
  );
  const widthOf = useMemo(() => {
    const total = SELECT_COLUMN_WEIGHT + columns.reduce((sum, column) => sum + column.weight, 0);
    return (weight: number) => `${((weight / total) * 100).toFixed(3)}%`;
  }, [columns]);

  /*
   * One rule for everybody now: the partner edits the same columns the
   * publisher's team does. Archiving and deleting a domain are separate
   * capabilities and stay with the publisher.
   */
  const readOnly = (_field: string) => !can('edit_site');

  const reload = useCallback(() => {
    setLoading(true);
    api
      .get<{ sites: Site[] }>(`/sites${showArchived ? '?archived=1' : ''}`)
      .then((r) => setSites(r.sites))
      .catch((err) => setNotice({ tone: 'red', text: err.message }))
      .finally(() => setLoading(false));
  }, [showArchived]);

  useEffect(reload, [reload]);

  useEffect(() => {
    // Everyone who can hold a domain - both companies, active accounts only.
    api.get<{ users: User[] }>('/users').then((r) => setUsers(r.users.filter((u) => u.active !== 0))).catch(() => setUsers([]));
  }, []);

  /* `/sites?blocked=1` is where the inbox and the digest send the publisher. */
  const blockedParam = params.get('blocked');
  useEffect(() => {
    if (blockedParam === '1') setReadiness('mostly_blocked');
  }, [blockedParam]);

  /* `/sites?owner=3` is where the header's "N domains of yours" lands. */
  const ownerParam = params.get('owner');
  useEffect(() => {
    if (ownerParam) setFilters((current) => ({ ...current, owner_id: ownerParam }));
  }, [ownerParam]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Optimistic cell edit.
   *
   * Two things this has to get right, both of which it used to get wrong on a
   * slow connection:
   *
   *  - a response that arrives late must not overwrite a newer edit of the same
   *    cell. Every save gets a sequence number and only the newest one for that
   *    cell is allowed to write back;
   *  - a failure must revert that one cell, not the whole table. It used to
   *    snapshot the entire list and restore it, so a rejected edit on row A
   *    also wiped a successful edit on row B off the screen while the server
   *    kept it.
   */
  async function patchSite(site: Site, field: string, raw: string) {
    // Only the amounts are numeric - `rpm_*_currency` is a code and must stay a string.
    const numeric = field === 'priority' || field === 'rpm_previous' || field === 'rpm_primis';
    let value: string | number | null = raw;
    if (numeric) {
      if (raw.trim() === '') value = null;
      else {
        const parsed = parseDecimal(raw);
        if (parsed == null) {
          // NaN used to reach the server as JSON null, wiping the stored figure
          // without a word.
          setNotice({ tone: 'red', text: `"${raw}" is not a number. The previous value was kept.` });
          setSites((current) => [...current]);
          return;
        }
        value = parsed;
      }
    }

    const cell = `${site.id}:${field}`;
    const ticket = (saveTickets.current.get(cell) ?? 0) + 1;
    saveTickets.current.set(cell, ticket);
    const stale = () => saveTickets.current.get(cell) !== ticket;

    const before = site[field as keyof Site];
    setSites((current) => current.map((s) => (s.id === site.id ? { ...s, [field]: value } : s)));
    setSaving((current) => new Set(current).add(cell));

    try {
      const { site: saved } = await api.patch<{ site: Site }>(`/sites/${site.id}`, { [field]: value });
      if (stale()) return;
      setSites((current) => current.map((s) => (s.id === site.id ? { ...s, ...saved } : s)));
    } catch (err) {
      if (stale()) return;
      setSites((current) => current.map((s) => (s.id === site.id ? { ...s, [field]: before } : s)));
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      if (!stale()) {
        setSaving((current) => {
          const next = new Set(current);
          next.delete(cell);
          return next;
        });
      }
    }
  }

  /**
   * One field across every selected domain. The single-cell path is optimistic
   * because it is one row; this one waits, because a sweep over forty domains
   * that half-applies is worse than one that takes a second.
   */
  /** Says whether it went through, so a follow-up (hiding archived rows) only runs when it did. */
  async function applyToSelection(field: string, value: string | number | boolean | null): Promise<boolean> {
    setBulkBusy(true);
    setNotice(null);
    try {
      const result = await api.patch<{ changed: number; unchanged: string[]; skipped: number[]; sites: Site[] }>('/sites/bulk', {
        site_ids: [...selected],
        changes: { [field]: value },
      });

      const bySite = new Map(result.sites.map((site) => [site.id, site]));
      setSites((current) => current.map((site) => bySite.get(site.id) ?? site));

      const label =
        COLUMNS.find((column) => column.key === field)?.label ??
        ({ owner_id: 'Responsible', demand_block: 'Demand partners', managed_by: 'Managed by', archived: 'Archived' } as Record<string, string>)[field] ??
        field;
      const parts = [
        field === 'archived'
          ? `Archived ${result.changed} domain(s) - each can be brought back from its own page`
          : `${label} set on ${result.changed} domain(s)`,
      ];
      if (result.unchanged.length) parts.push(`${result.unchanged.length} already had it`);
      if (result.skipped.length) parts.push(`${result.skipped.length} skipped (archived)`);
      setNotice({ tone: 'green', text: parts.join(' · ') });
      return true;
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not apply the change' });
      return false;
    } finally {
      setBulkBusy(false);
    }
  }

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = sites.filter((site) => {
      if (term && !`${site.domain} ${site.managed_by}`.toLowerCase().includes(term)) return false;
      if (readiness === 'mostly_blocked' || readiness === 'offline') {
        if (site.demand_block !== readiness) return false;
      } else if (readiness !== 'all' && siteReadiness(site) !== readiness) return false;

      return Object.entries(filters).every(([key, value]) => {
        if (!value) return true;
        if (key === 'rpm_uplift') {
          const uplift = rpmUplift(site, eurUsd);
          if (value === 'up') return uplift != null && uplift > 0;
          if (value === 'down') return uplift != null && uplift <= 0;
          if (value === 'missing') return uplift == null;
          return true;
        }
        if (key === 'owner_id') {
          if (value === 'none') return site.owner_id == null;
          return String(site.owner_id ?? '') === value;
        }
        if (key === 'open_issues') {
          const open = site.open_issues ?? 0;
          if (value === 'any') return open > 0;
          if (value === 'none') return open === 0;
          if (value === 'qa') return (site.awaiting_qa ?? 0) > 0;
          if (value === 'blocked') return (site.blocked_issues ?? 0) > 0;
          return true;
        }
        const cell = site[key as keyof Site];
        const column = COLUMNS.find((c) => c.key === key);
        if (column?.kind === 'enum') return String(cell) === value;
        return String(cell ?? '').toLowerCase().includes(value.toLowerCase());
      });
    });

    // Status columns sort in their declared order, not alphabetically on the
    // internal key, so Video reads 1 Live -> 2 QA -> ... -> n/a as in the sheet.
    const ORDERED = {
      ...Object.fromEntries(TRACKS.map(({ key }) => [key, Object.keys(TRACK_STATUS)])),
      cmp: Object.keys(CMP),
      approval: Object.keys(APPROVAL),
    } as Record<string, string[]>;

    return rows.sort((a, b) => {
      const order = ORDERED[sort.key];
      if (order) {
        const left = order.indexOf(String(a[sort.key as keyof Site]));
        const right = order.indexOf(String(b[sort.key as keyof Site]));
        return (left - right) * sort.dir;
      }
      if (sort.key === 'rpm_uplift') {
        const left = rpmUplift(a, eurUsd);
        const right = rpmUplift(b, eurUsd);
        if (left == null && right == null) return 0;
        if (left == null) return 1;
        if (right == null) return -1;
        return (left - right) * sort.dir;
      }
      const left = a[sort.key as keyof Site];
      const right = b[sort.key as keyof Site];
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * sort.dir;
      return String(left).localeCompare(String(right)) * sort.dir;
    });
  }, [sites, filters, search, sort, eurUsd, readiness]);

  // Selecting 62 rows and then filtering to one used to leave a banner saying
  // "62 selected" over a single row, with the bulk issue hitting all 62.
  const hiddenSelected = [...selected].filter((id) => !visible.some((site) => site.id === id)).length;

  const activeFilters = Object.values(filters).filter(Boolean).length + (search ? 1 : 0) + (readiness === 'all' ? 0 : 1);

  const readinessCounts = useMemo(() => {
    const counts = { live: 0, incomplete: 0, inactive: 0, mostly_blocked: 0, offline: 0 };
    for (const site of sites) {
      counts[siteReadiness(site)] += 1;
      if (site.demand_block === 'mostly_blocked' || site.demand_block === 'offline') counts[site.demand_block] += 1;
    }
    return counts;
  }, [sites]);

  /** Still up while the demand side refuses them - what the alert banner lists. */
  const flagged = useMemo(() => sites.filter((site) => site.demand_block === 'mostly_blocked' && !site.archived), [sites]);

  function toggleSort(key: string) {
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }

  function toggleRow(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">Sites</h1>
          <p className="text-sm text-ink-soft">
            {visible.length} of {sites.length} sites{activeFilters > 0 && ' · filtered'}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            className="field w-56 max-sm:w-full"
            placeholder="Search domain or owner..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {narrow && (
            <span className="text-xs text-ink-faint" title="Open a domain to see and edit the hidden columns">
              {tight ? 'RPM, CMP and approval hidden' : 'RPM columns hidden'} on this width
            </span>
          )}
          {activeFilters > 0 && (
            <Button size="sm" onClick={() => { setFilters({}); setSearch(''); setReadiness('all'); }}>
              Clear filters ({activeFilters})
            </Button>
          )}
          {/*
            * Who a domain sits with is edited on the domain's own page - the
            * table has no column for it. But the header's "N domains of yours"
            * links here, so the view it opens has to be visible and clearable.
            */}
          <label className="flex items-center gap-1.5 text-sm text-ink-soft">
            Responsible
            <select
              className="field !w-auto !py-1 text-sm"
              value={filters.owner_id ?? ''}
              onChange={(event) => setFilters((current) => ({ ...current, owner_id: event.target.value }))}
            >
              <option value="">Anyone</option>
              <option value="none">Nobody yet</option>
              {users.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.company ? ` (${candidate.company})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink-soft">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <a href="/api/export.csv" className="whitespace-nowrap rounded-lg border border-line-strong px-3 py-1.5 text-sm hover:bg-raised">
            Export CSV
          </a>
          {can('manage_sites') && (
            <Button variant="primary" size="md" onClick={() => setAdding(true)}>
              + Add domain
            </Button>
          )}
        </div>
      </div>

      <NetworkIssues sites={sites} onIssuesChanged={reload} />

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {(
          [
            ['live', `All five tracks live (${readinessCounts.live})`],
            ['incomplete', `Not fully live (${readinessCounts.incomplete})`],
            ['inactive', `Priority 99 - not active (${readinessCounts.inactive})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setReadiness(readiness === key ? 'all' : key)}
            aria-pressed={readiness === key}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition ${
              readiness === key ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line text-ink-soft hover:bg-raised'
            }`}
          >
            <span aria-hidden className={`size-2 rounded-full ${READINESS[key].dot}`} />
            {label}
          </button>
        ))}
        {(
          [
            ['mostly_blocked', `Mostly blocked by demand partners (${readinessCounts.mostly_blocked})`],
            ['offline', `Taken offline (${readinessCounts.offline})`],
          ] as const
        )
          // The offline record only earns a chip once there is one.
          .filter(([key]) => key === 'mostly_blocked' || readinessCounts[key] > 0)
          .map(([key, label]) => (
            <button
              key={key}
              onClick={() => setReadiness(readiness === key ? 'all' : key)}
              aria-pressed={readiness === key}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition ${
                readiness === key
                  ? 'border-brand bg-brand-soft text-brand-ink'
                  : key === 'mostly_blocked' && readinessCounts.mostly_blocked > 0
                    ? 'border-tone-red/40 bg-tone-red-bg font-medium text-tone-red hover:brightness-95'
                    : 'border-line text-ink-soft hover:bg-raised'
              }`}
            >
              <span aria-hidden className={`size-2 rounded-sm ${key === 'mostly_blocked' ? 'bg-tone-red' : 'bg-tone-slate'}`} />
              {label}
            </button>
          ))}
      </div>

      {flagged.length > 0 && (
        <div role="alert" className="rounded-xl border border-tone-red/40 bg-tone-red-bg px-4 py-3 text-sm text-tone-red">
          <div className="font-semibold">
            ⚠ {flagged.length === 1 ? '1 site is' : `${flagged.length} sites are`} mostly blocked by demand partners
          </div>
          <ul className="mt-1 space-y-0.5">
            {flagged.map((site) => (
              <li key={site.id}>
                <Link to={`/sites/${site.id}`} className="font-medium underline-offset-2 hover:underline">
                  {site.domain}
                </Link>{' '}
                <span className="text-xs opacity-80">{flaggedBy(site)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs opacity-80">
            {can('manage_sites')
              ? `Take ${flagged.length === 1 ? 'it' : 'them'} offline, then mark ${flagged.length === 1 ? 'it' : 'each one'} "Taken offline" with the flag - that ends the alert.`
              : `The publisher has been alerted to take ${flagged.length === 1 ? 'it' : 'them'} offline.`}
          </p>
        </div>
      )}

      {notice && (
        <div className={`rounded-lg px-3 py-2 text-sm ${notice.tone === 'red' ? 'bg-tone-red-bg text-tone-red' : 'bg-tone-green-bg text-tone-green'}`}>
          {notice.text}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-sm">
          <span className="font-medium text-brand-ink">
            {selected.size} selected
            {hiddenSelected > 0 && `, ${hiddenSelected} of them not in the current filter`}
          </span>
          <BulkEdit
            count={selected.size}
            disabled={(field) => readOnly(field)}
            users={users}
            canTakeOffline={can('manage_sites')}
            busy={bulkBusy}
            onApply={applyToSelection}
          />
          <Button size="sm" variant="primary" onClick={() => setBulkOpen(true)}>
            Raise one issue on all
          </Button>
          {hiddenSelected > 0 && (
            <Button
              size="sm"
              onClick={() => setSelected(new Set(visible.filter((site) => selected.has(site.id)).map((site) => site.id)))}
            >
              Keep only the {selected.size - hiddenSelected} visible
            </Button>
          )}
          {(can('manage_sites') || can('delete_site')) && (
            <span className="ml-auto flex flex-wrap gap-2">
              {can('manage_sites') && (
                <Button
                  size="sm"
                  disabled={bulkBusy}
                  title="Takes the domains out of the list; each can be brought back from its own page"
                  onClick={async () => {
                    if (!window.confirm(`Archive ${selected.size} domain(s)? They leave the list but keep everything, and can be brought back.`)) return;
                    if (!(await applyToSelection('archived', true))) return;
                    if (!showArchived) setSites((current) => current.filter((site) => !site.archived));
                    setSelected(new Set());
                  }}
                >
                  Archive
                </Button>
              )}
              {can('delete_site') && (
                <Button size="sm" variant="danger" onClick={() => setDeleting(true)}>
                  Delete...
                </Button>
              )}
            </span>
          )}
          <Button size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {deleting && (
        <BulkDeleteModal
          ids={[...selected]}
          onClose={() => setDeleting(false)}
          onDeleted={(domains) => {
            setSites((current) => current.filter((site) => !selected.has(site.id)));
            setSelected(new Set());
            setDeleting(false);
            setNotice({ tone: 'green', text: `Deleted ${domains.length} domain(s): ${domains.slice(0, 5).join(', ')}${domains.length > 5 ? ', ...' : ''}` });
          }}
        />
      )}

      {/*
       * Below about 1000px even the remaining columns cannot shrink any further
       * without the track selects turning into bare chevrons, so on a tablet or
       * a phone the table keeps that width and scrolls inside its card.
       */}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[980px] table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-raised">
              <th className="bg-raised px-2 py-2" style={{ width: widthOf(SELECT_COLUMN_WEIGHT) }}>
                <input
                  type="checkbox"
                  aria-label="Select all visible sites"
                  checked={visible.length > 0 && visible.every((s) => selected.has(s.id))}
                  onChange={(event) => setSelected(event.target.checked ? new Set(visible.map((s) => s.id)) : new Set())}
                />
              </th>
              {columns.map((column) => (
                <th key={column.key} className="overflow-hidden px-2 py-2 text-left font-medium text-ink-soft" style={{ width: widthOf(column.weight) }}>
                  <button onClick={() => toggleSort(column.key)} className="inline-flex items-center gap-1 hover:text-ink">
                    {column.label}
                    <span className={sort.key === column.key ? 'opacity-100' : 'opacity-0'}>{sort.dir === 1 ? '↑' : '↓'}</span>
                  </button>
                </th>
              ))}
            </tr>

            <tr className="border-b border-line bg-surface">
              <th className="bg-surface" />
              {columns.map((column) => (
                <th key={column.key} className="overflow-hidden px-1.5 py-1.5 font-normal">
                  <ColumnFilter
                    column={column}
                    value={filters[column.key] ?? ''}
                    onChange={(value) => setFilters((current) => ({ ...current, [column.key]: value }))}
                  />
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {visible.map((site) => (
              <tr
                key={site.id}
                className={`border-b border-line last:border-0 ${
                  site.demand_block === 'mostly_blocked'
                    ? 'bg-tone-red-bg hover:brightness-[0.98]'
                    : `hover:bg-raised/60 ${(site.open_issues ?? 0) > 0 ? 'bg-tone-red-bg/25' : ''}`
                } ${siteReadiness(site) === 'inactive' || site.demand_block === 'offline' ? 'opacity-55' : ''} ${
                  site.archived ? 'bg-tone-slate-bg/40 italic' : ''
                }`}
              >
                {/* The red bar on the left is the alarm; it reads even when the row is scrolled sideways. */}
                <td className={`px-2 py-1.5 ${site.demand_block === 'mostly_blocked' ? 'shadow-[inset_4px_0_0_var(--color-tone-red)]' : ''}`}>
                  <input type="checkbox" aria-label={`Select ${site.domain}`} checked={selected.has(site.id)} onChange={() => toggleRow(site.id)} />
                </td>

                {columns.map((column) => {
                  /*
                   * A save in flight is visible. Without it a request that never
                   * came back looked exactly like a saved value, and the cell
                   * quietly held something the server had never seen.
                   */
                  const inFlight = saving.has(`${site.id}:${column.key}`);
                  return (
                    <td
                      key={column.key}
                      className={`overflow-hidden px-2 py-1.5 align-middle transition-opacity ${inFlight ? 'opacity-50' : ''}`}
                      title={inFlight ? 'Saving...' : undefined}
                    >
                      <Cell
                        site={site}
                        column={column}
                        disabled={readOnly(column.key)}
                        eurUsd={eurUsd}
                        onCommit={(field, value) => patchSite(site, field, value)}
                      />
                    </td>
                  );
                })}

              </tr>
            ))}
          </tbody>
        </table>

        {visible.length === 0 && <Empty>No site matches the current filters.</Empty>}
      </div>

      {adding && (
        <AddSiteModal
          onClose={() => setAdding(false)}
          onCreated={(site) => {
            setSites((current) => [...current, site]);
            setNotice({ tone: 'green', text: `${site.domain} added` });
            setAdding(false);
          }}
        />
      )}

      {bulkOpen && (
        <IssueModal
          siteIds={[...selected]}
          domains={sites.filter((s) => selected.has(s.id)).map((s) => s.domain)}
          onClose={() => setBulkOpen(false)}
          onCreated={(count, _issue, uploadErrors) => {
            setNotice(
              uploadErrors?.length
                ? { tone: 'red', text: `Issue raised on ${count} site(s), but a screenshot did not attach: ${uploadErrors[0]}` }
                : { tone: 'green', text: `Issue raised on ${count} site(s)` }
            );
            setBulkOpen(false);
            setSelected(new Set());
            reload();
          }}
        />
      )}
    </div>
  );
}

function Cell({
  site,
  column,
  disabled,
  eurUsd,
  onCommit,
}: {
  site: Site;
  column: Column;
  disabled: boolean;
  eurUsd: number;
  onCommit: (field: string, value: string) => void;
}) {
  const value = site[column.key as keyof Site];

  if (column.kind === 'enum') {
    return (
      <InlineSelect
        compact
        value={String(value)}
        options={column.options ?? []}
        tone={column.tones?.[String(value)] ?? 'slate'}
        disabled={disabled}
        title={column.options?.find((o) => o.value === String(value))?.label}
        onChange={(next) => onCommit(column.key, next)}
      />
    );
  }

  if (column.kind === 'uplift') {
    const uplift = rpmUplift(site, eurUsd);
    if (uplift == null) return <span className="text-sm text-ink-faint">-</span>;
    return (
      <span
        className={`block truncate text-xs font-medium tabular-nums ${
          uplift > 0 ? 'text-tone-green' : uplift < 0 ? 'text-tone-red' : 'text-ink-soft'
        }`}
        title={`Primis vs. the previous setup, converted to EUR: ${formatUplift(uplift)}`}
      >
        {formatUplift(uplift)}
      </span>
    );
  }

  if (column.kind === 'money') {
    const currencyField = `${column.key}_currency`;
    const currency = String(site[currencyField as keyof Site] ?? 'EUR');
    if (disabled) {
      return <span className="truncate text-sm tabular-nums">{formatMoney(value as number | null, currency) || '-'}</span>;
    }
    return (
      <div className="flex items-center gap-0.5">
        <InlineText
          value={value == null ? '' : String(value)}
          disabled={false}
          onCommit={(next) => onCommit(column.key, next)}
          type="decimal"
          placeholder="-"
          className="min-w-0 flex-1 !px-1 text-xs tabular-nums"
        />
        <CurrencyToggle value={currency} onChange={(next) => onCommit(currencyField, next)} />
      </div>
    );
  }

  if (column.kind === 'issues') {
    const open = site.open_issues ?? 0;
    const qa = site.awaiting_qa ?? 0;
    const blocked = site.blocked_issues ?? 0;
    /*
     * Three states in one cell, because the column is narrow: how much is open,
     * a blue dot when the partner owes a re-check, a purple one when something
     * here is waiting on a third party and nobody on either side can move it.
     */
    const parts = [`${open} open issue(s)`];
    if (qa) parts.push(`${qa} waiting on the partner's re-check`);
    if (blocked) parts.push(`${blocked} blocked on somebody outside the team`);
    return (
      <Link to={`/issues?site_id=${site.id}`} className="inline-flex items-center gap-1" title={parts.join(', ')}>
        <Badge tone={open === 0 ? 'muted' : open > 2 ? 'red' : 'amber'} className="!px-1.5">
          {open} open
        </Badge>
        {qa > 0 && <span aria-hidden className="size-1.5 rounded-full bg-tone-blue" />}
        {blocked > 0 && <span aria-hidden className="size-1.5 rounded-full bg-tone-purple" />}
      </Link>
    );
  }

  if (column.key === 'domain') {
    const readiness = siteReadiness(site);
    const missing = missingTracks(site);
    // The name comes first: a truncated domain had no way to be read in full.
    const state =
      readiness === 'inactive'
        ? 'priority 99, not part of the active rollout'
        : readiness === 'live'
          ? 'all five tracks are Live'
          : `not live yet: ${missing.join(', ')}`;
    const title = `${site.domain} - ${state}`;

    const blocked = site.demand_block === 'mostly_blocked';
    return (
      <div className="flex items-center gap-1">
        <Link
          to={`/sites/${site.id}`}
          className={`group flex min-w-0 flex-1 items-center gap-1.5 font-medium hover:text-brand ${
            blocked ? 'text-tone-red' : readiness === 'inactive' ? 'text-ink-faint' : ''
          } ${site.demand_block === 'offline' ? 'line-through' : ''}`}
          title={blocked ? `${site.domain} - mostly blocked by demand partners ${flaggedBy(site)}` : site.demand_block === 'offline' ? `${site.domain} - taken offline` : title}
        >
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${READINESS[readiness].dot}`} />
          {Boolean(site.archived) && (
            <span className="shrink-0 rounded bg-tone-slate-bg px-1 text-[10px] font-medium text-tone-slate not-italic">
              archived
            </span>
          )}
          <span className="sr-only">{READINESS[readiness].label}. </span>
          <span className="truncate group-hover:underline">{site.domain}</span>
        </Link>
        <DemandFlagButton site={site} disabled={disabled || Boolean(site.archived)} onSet={(next) => onCommit('demand_block', next)} />
      </div>
    );
  }

  return (
    <InlineText
      value={value == null ? '' : String(value)}
      disabled={disabled}
      onCommit={(next) => onCommit(column.key, next)}
      type={column.kind === 'number' ? 'number' : 'text'}
      className={column.kind === 'number' ? '!px-1 text-center tabular-nums' : ''}
    />
  );
}

function ColumnFilter({ column, value, onChange }: { column: Column; value: string; onChange: (value: string) => void }) {
  if (column.kind === 'enum') {
    return (
      <select className="field !px-1.5 !py-1 text-xs" value={value} onChange={(event) => onChange(event.target.value)} aria-label={`Filter ${column.label}`}>
        <option value="">All</option>
        {column.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (column.kind === 'uplift') {
    return (
      <select className="field !px-1.5 !py-1 text-xs" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Filter uplift">
        <option value="">All</option>
        <option value="up">Better with Primis</option>
        <option value="down">Worse or flat</option>
        <option value="missing">No figures yet</option>
      </select>
    );
  }

  if (column.kind === 'issues') {
    return (
      <select className="field !px-1.5 !py-1 text-xs" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Filter issues">
        <option value="">All</option>
        <option value="any">Has open</option>
        <option value="qa">Awaiting re-check</option>
        <option value="blocked">Blocked on a third party</option>
        <option value="none">None open</option>
      </select>
    );
  }

  return (
    <input
      className="field !px-1.5 !py-1 text-xs"
      placeholder={column.kind === 'number' ? '#' : 'Filter'}
      value={value}
      aria-label={`Filter ${column.label}`}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function AddSiteModal({ onClose, onCreated }: { onClose: () => void; onCreated: (site: Site) => void }) {
  const [form, setForm] = useState({ domain: '', priority: '99', test_url: '', cmp: 'none', managed_by: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      // The server normalises; the dialog used to do its own case-sensitive
      // version of it and turned "HTTP://WWW.Baz.DE/a" into the string "HTTP:".
      const { site } = await api.post<{ site: Site }>('/sites', {
        ...form,
        domain: form.domain.trim(),
        priority: Number(form.priority) || 99,
      });
      onCreated({ ...site, open_issues: 0, awaiting_qa: 0, total_issues: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the site');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a domain" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Domain" hint="Without https:// or www. - every track starts as Pending.">
          <input className="field" required placeholder="example.de" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <input className="field" type="number" min={1} max={99} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          </Field>
          <Field label="CMP">
            <select className="field" value={form.cmp} onChange={(e) => setForm({ ...form, cmp: e.target.value })}>
              {CMP_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Test URL" hint="An article page the partner can QA against.">
          <input className="field" type="url" placeholder="https://example.de/article" value={form.test_url} onChange={(e) => setForm({ ...form, test_url: e.target.value })} />
        </Field>
        <Field label="Managed by" hint="Leave empty if your own dev team owns the site.">
          <input className="field" placeholder="External team" value={form.managed_by} onChange={(e) => setForm({ ...form, managed_by: e.target.value })} />
        </Field>

        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Adding...' : 'Add domain'}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Sets one column across every selected domain.
 *
 * A field picker plus a value picker rather than a row of buttons: thirteen
 * columns would be thirteen buttons, and the two-step reads as one sentence -
 * "set Display to 1 - Live on 12 domains".
 */
function BulkEdit({
  count,
  disabled,
  users,
  busy,
  canTakeOffline,
  onApply,
}: {
  count: number;
  canTakeOffline: boolean;
  /** The same read-only rules the table cells use, so a partner sees only theirs. */
  disabled: (field: string) => boolean;
  users: User[];
  busy: boolean;
  onApply: (field: string, value: string | number | null) => void;
}) {
  const fields = useMemo(
    () =>
      [
        ...TRACKS.map((track) => ({ key: track.key, label: track.label, options: STATUS_OPTIONS })),
        { key: 'cmp', label: 'CMP', options: CMP_OPTIONS },
        { key: 'approval', label: 'Approval', options: APPROVAL_OPTIONS },
        {
          // Handing a whole rollout to one person, which is the case that
          // actually comes up: "these 35 are Primis's to get live".
          key: 'owner_id',
          label: 'Responsible',
          options: [
            { value: '', label: 'Nobody' },
            ...users.map((candidate) => ({
              value: String(candidate.id),
              label: `${candidate.name}${candidate.company ? ` (${candidate.company})` : ''}`,
            })),
          ],
        },
        {
          key: 'demand_block',
          label: 'Demand partners',
          // "Taken offline" is the publisher's to say; it is what ends the alert.
          options: (Object.entries(DEMAND_BLOCK) as [string, { label: string }][])
            .filter(([value]) => value !== 'offline' || canTakeOffline)
            .map(([value, meta]) => ({ value, label: meta.label })),
        },
        { key: 'priority', label: 'Priority', options: null },
        { key: 'managed_by', label: 'Managed by', options: null },
      ].filter((field) => !disabled(field.key)),
    [disabled, users, canTakeOffline]
  );

  const [field, setField] = useState(fields[0]?.key ?? '');
  const [value, setValue] = useState('');

  const current = fields.find((entry) => entry.key === field) ?? fields[0];
  // Switching column resets the value: "1 - Live" means nothing under Priority.
  useEffect(() => {
    setValue(current?.options ? (current.options[0]?.value ?? '') : '');
  }, [field]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;

  const numeric = current.key === 'priority';
  // "Nobody" is a real choice, so an empty value is a valid one here.
  const person = current.key === 'owner_id';
  const ready = numeric ? /^\d{1,2}$/.test(value.trim()) && Number(value) >= 1 && Number(value) <= 99 : true;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-brand-ink">Set</span>
      <select className="field !w-auto !py-1 text-xs" value={field} onChange={(event) => setField(event.target.value)}>
        {fields.map((entry) => (
          <option key={entry.key} value={entry.key}>
            {entry.label}
          </option>
        ))}
      </select>
      <span className="text-xs text-brand-ink">to</span>
      {current.options ? (
        <select className="field !w-auto !py-1 text-xs" value={value} onChange={(event) => setValue(event.target.value)}>
          {current.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="field !w-32 !py-1 text-xs"
          inputMode={numeric ? 'numeric' : undefined}
          placeholder={numeric ? '1 - 99' : 'a name, or empty'}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      )}
      <Button
        size="sm"
        disabled={busy || !ready}
        onClick={() => {
          const label = current.options?.find((option) => option.value === value)?.label ?? value;
          // A sweep over dozens of rows is worth one question first.
          if (!window.confirm(`Set ${current.label} to "${label || '(empty)'}" on ${count} domain(s)?`)) return;
          onApply(current.key, numeric ? Number(value) : person ? (value ? Number(value) : null) : value);
        }}
      >
        {busy ? 'Applying...' : `Apply to ${count}`}
      </Button>
    </div>
  );
}

interface DeletePreview {
  removed: { sites: number; issues: number; messages: number; attachments: number };
  domains: string[];
}

/**
 * Deleting a selection for good. The same weight as deleting one domain from
 * its own page: it says what goes with them first, and wants the number of
 * domains typed - a tick too many in a list of sixty is easy to miss.
 */
function BulkDeleteModal({ ids, onClose, onDeleted }: { ids: number[]; onClose: () => void; onDeleted: (domains: string[]) => void }) {
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .post<DeletePreview>('/sites/bulk-delete', { site_ids: ids, dry_run: true })
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not count what would be deleted'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const count = preview?.removed.sites ?? ids.length;
  const confirmed = typed.trim() === String(count);

  async function remove() {
    setBusy(true);
    setError('');
    try {
      const result = await api.post<DeletePreview>('/sites/bulk-delete', { site_ids: ids });
      onDeleted(result.domains);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
      setBusy(false);
    }
  }

  return (
    <Modal title={`Delete ${count} domain(s)?`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        {preview ? (
          <>
            <p className="text-ink-soft">
              This permanently deletes these domains with their {preview.removed.issues} issue(s), every comment,{' '}
              {preview.removed.attachments} attached file(s) and {preview.removed.messages} discussion message(s). It cannot be
              undone. <span className="font-medium text-ink">Archive</span> keeps all of it and can be reversed.
            </p>
            <ul className="max-h-40 overflow-y-auto rounded-lg bg-raised px-3 py-2 font-mono text-xs">
              {preview.domains.map((domain) => (
                <li key={domain}>{domain}</li>
              ))}
            </ul>
          </>
        ) : (
          !error && <p className="text-ink-faint">Counting what would be deleted...</p>
        )}

        <label className="block">
          <span className="text-xs text-ink-soft">
            Type <span className="font-mono font-medium text-ink">{count}</span> to confirm
          </span>
          <input className="field mt-1" inputMode="numeric" autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} />
        </label>

        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-tone-red">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!preview || !confirmed || busy} onClick={remove}>
            {busy ? 'Deleting...' : `Delete ${count} domain(s) for good`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
