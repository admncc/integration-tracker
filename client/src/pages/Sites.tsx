import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { Site, TrackStatus } from '../lib/types';
import { APPROVAL, CMP, READINESS, TRACKS, TRACK_STATUS, formatMoney, missingTracks, rpmUplift, siteReadiness } from '@shared/domain.js';
import { Badge, Button, CurrencyToggle, Empty, Field, InlineSelect, InlineText, Modal, Spinner, type Tone } from '../components/ui';
import IssueModal from '../components/IssueModal';

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
  /** Dropped on a narrow screen, where twelve columns cannot all stay readable. */
  secondary?: boolean;
};

/** The checkbox column has no descriptor but still needs a share. */
const SELECT_COLUMN_WEIGHT = 2.5;

/**
 * 1280 is the widest viewport where all thirteen columns still render their
 * labels in full; below it the revenue columns are hidden rather than squeezed
 * until "New" and "None" both read "N...".
 */
const NARROW_VIEWPORT = 1280;

const tonesOf = (map: Record<string, { tone: string }>) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.tone as Tone]));

/*
 * Widths are percentages that add up to 100 and the table is `table-fixed`, so
 * the grid always fits the viewport - no horizontal scrolling, whatever the
 * screen. Anything that does not survive that budget (managed by, notes) lives
 * on the site's detail page instead.
 */
const COLUMNS: Column[] = [
  { key: 'priority', label: 'Prio', kind: 'number', weight: 3.5 },
  { key: 'domain', label: 'Domain', kind: 'text', weight: 16 },
  ...TRACKS.map((track) => ({
    key: track.key,
    label: track.label,
    kind: 'enum' as const,
    options: STATUS_OPTIONS,
    tones: tonesOf(TRACK_STATUS),
    weight: 8.1,
  })),
  { key: 'cmp', label: 'CMP', kind: 'enum', options: CMP_OPTIONS, tones: tonesOf(CMP), weight: 5.5 },
  { key: 'approval', label: 'Approval', kind: 'enum', options: APPROVAL_OPTIONS, tones: tonesOf(APPROVAL), weight: 8 },
  { key: 'open_issues', label: 'Issues', kind: 'issues', weight: 6 },
  { key: 'rpm_previous', label: 'Prev. RPM', kind: 'money', weight: 6.5, secondary: true },
  { key: 'rpm_primis', label: 'Primis RPM', kind: 'money', weight: 6.5, secondary: true },
  { key: 'rpm_uplift', label: 'Δ', kind: 'uplift', weight: 5, secondary: true },
];

/** Fields the partner may change; everything else is publisher-owned. */
const PARTNER_WRITABLE = new Set(['approval', 'rpm_primis', 'rpm_primis_currency', 'notes']);

export default function Sites() {
  const { user, can, eurUsd } = useSession();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterMap>({});
  const [sort, setSort] = useState<SortState>({ key: 'priority', dir: 1 });
  const [showArchived, setShowArchived] = useState(false);
  const [readiness, setReadiness] = useState<'all' | 'live' | 'incomplete' | 'inactive'>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Hiding the revenue columns beats rendering "N..." where "New" and "None"
  // become indistinguishable; the figures are still on each domain's page.
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_VIEWPORT);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_VIEWPORT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const columns = useMemo(() => COLUMNS.filter((column) => !(narrow && column.secondary)), [narrow]);
  const widthOf = useMemo(() => {
    const total = SELECT_COLUMN_WEIGHT + columns.reduce((sum, column) => sum + column.weight, 0);
    return (weight: number) => `${((weight / total) * 100).toFixed(3)}%`;
  }, [columns]);

  const readOnly = (field: string) => (user?.role === 'partner' ? !PARTNER_WRITABLE.has(field) : !can('edit_site'));

  useEffect(() => {
    setLoading(true);
    api
      .get<{ sites: Site[] }>(`/sites${showArchived ? '?archived=1' : ''}`)
      .then((r) => setSites(r.sites))
      .catch((err) => setNotice({ tone: 'red', text: err.message }))
      .finally(() => setLoading(false));
  }, [showArchived]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Optimistic cell edit - the row snaps back if the API rejects the change. */
  async function patchSite(site: Site, field: string, raw: string) {
    // Only the amounts are numeric - `rpm_*_currency` is a code and must stay a string.
    const numeric = field === 'priority' || field === 'rpm_previous' || field === 'rpm_primis';
    const value = numeric ? (raw === '' ? null : Number(String(raw).replace(',', '.'))) : raw;
    const previous = sites;
    setSites((current) => current.map((s) => (s.id === site.id ? { ...s, [field]: value } : s)));
    try {
      const { site: saved } = await api.patch<{ site: Site }>(`/sites/${site.id}`, { [field]: value });
      setSites((current) => current.map((s) => (s.id === site.id ? { ...s, ...saved } : s)));
    } catch (err) {
      setSites(previous);
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not save' });
    }
  }

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = sites.filter((site) => {
      if (term && !`${site.domain} ${site.notes} ${site.managed_by}`.toLowerCase().includes(term)) return false;
      if (readiness !== 'all' && siteReadiness(site) !== readiness) return false;

      return Object.entries(filters).every(([key, value]) => {
        if (!value) return true;
        if (key === 'rpm_uplift') {
          const uplift = rpmUplift(site, eurUsd);
          if (value === 'up') return uplift != null && uplift > 0;
          if (value === 'down') return uplift != null && uplift <= 0;
          if (value === 'missing') return uplift == null;
          return true;
        }
        if (key === 'open_issues') {
          const open = site.open_issues ?? 0;
          if (value === 'any') return open > 0;
          if (value === 'none') return open === 0;
          if (value === 'qa') return (site.awaiting_qa ?? 0) > 0;
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

  const activeFilters = Object.values(filters).filter(Boolean).length + (search ? 1 : 0) + (readiness === 'all' ? 0 : 1);

  const readinessCounts = useMemo(() => {
    const counts = { live: 0, incomplete: 0, inactive: 0 };
    for (const site of sites) counts[siteReadiness(site)] += 1;
    return counts;
  }, [sites]);

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
            className="field w-56"
            placeholder="Search domain, notes..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {narrow && (
            <span className="text-xs text-ink-faint" title="Open a domain to see and edit its RPM figures">
              RPM columns hidden on this width
            </span>
          )}
          {activeFilters > 0 && (
            <Button size="sm" onClick={() => { setFilters({}); setSearch(''); setReadiness('all'); }}>
              Clear filters ({activeFilters})
            </Button>
          )}
          <label className="flex items-center gap-1.5 text-sm text-ink-soft">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <a href="/api/export.csv" className="rounded-lg border border-line-strong px-3 py-1.5 text-sm hover:bg-raised">
            Export CSV
          </a>
          {can('manage_sites') && (
            <Button variant="primary" size="md" onClick={() => setAdding(true)}>
              + Add domain
            </Button>
          )}
        </div>
      </div>

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
      </div>

      {notice && (
        <div className={`rounded-lg px-3 py-2 text-sm ${notice.tone === 'red' ? 'bg-tone-red-bg text-tone-red' : 'bg-tone-green-bg text-tone-green'}`}>
          {notice.text}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-sm">
          <span className="font-medium text-brand-ink">{selected.size} selected</span>
          <Button size="sm" variant="primary" onClick={() => setBulkOpen(true)}>
            Raise one issue on all
          </Button>
          <Button size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full table-fixed border-collapse text-sm">
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
                <th key={column.key} className="overflow-hidden px-1.5 py-1.5">
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
                className={`border-b border-line last:border-0 hover:bg-raised/60 ${
                  (site.open_issues ?? 0) > 0 ? 'bg-tone-red-bg/25' : ''
                } ${siteReadiness(site) === 'inactive' ? 'opacity-55' : ''} ${
                  site.archived ? 'bg-tone-slate-bg/40 italic' : ''
                }`}
              >
                <td className="px-2 py-1.5">
                  <input type="checkbox" aria-label={`Select ${site.domain}`} checked={selected.has(site.id)} onChange={() => toggleRow(site.id)} />
                </td>

                {columns.map((column) => (
                  <td
                    key={column.key}
                    className="overflow-hidden px-2 py-1.5 align-middle"
                  >
                    <Cell
                      site={site}
                      column={column}
                      disabled={readOnly(column.key)}
                      eurUsd={eurUsd}
                      onCommit={(field, value) => patchSite(site, field, value)}
                    />
                  </td>
                ))}

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
            api.get<{ sites: Site[] }>(`/sites${showArchived ? '?archived=1' : ''}`).then((r) => setSites(r.sites));
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
        title={`Primis vs. the previous setup, converted to EUR`}
      >
        {uplift > 0 ? '+' : ''}
        {uplift.toFixed(0)}%
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
    return (
      <Link
        to={`/issues?site_id=${site.id}`}
        className="inline-flex items-center gap-1"
        title={qa > 0 ? `${open} open, ${qa} waiting on the partner's re-check` : `${open} open issue(s)`}
      >
        <Badge tone={open === 0 ? 'muted' : open > 2 ? 'red' : 'amber'} className="!px-1.5">
          {open} open
        </Badge>
        {qa > 0 && <span aria-hidden className="size-1.5 rounded-full bg-tone-blue" />}
      </Link>
    );
  }

  if (column.key === 'domain') {
    const readiness = siteReadiness(site);
    const missing = missingTracks(site);
    const title =
      readiness === 'inactive'
        ? 'Priority 99 - not part of the active rollout'
        : readiness === 'live'
          ? 'All five tracks are Live'
          : `Not live yet: ${missing.join(', ')}`;

    return (
      <Link
        to={`/sites/${site.id}`}
        className={`group flex items-center gap-1.5 font-medium hover:text-brand ${
          readiness === 'inactive' ? 'text-ink-faint' : ''
        }`}
        title={title}
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
      <select className="field !py-1 text-xs" value={value} onChange={(event) => onChange(event.target.value)} aria-label={`Filter ${column.label}`}>
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
      <select className="field !py-1 text-xs" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Filter uplift">
        <option value="">All</option>
        <option value="up">Better with Primis</option>
        <option value="down">Worse or flat</option>
        <option value="missing">No figures yet</option>
      </select>
    );
  }

  if (column.kind === 'issues') {
    return (
      <select className="field !py-1 text-xs" value={value} onChange={(event) => onChange(event.target.value)} aria-label="Filter issues">
        <option value="">All</option>
        <option value="any">Has open</option>
        <option value="qa">Awaiting re-check</option>
        <option value="none">None open</option>
      </select>
    );
  }

  return (
    <input
      className="field !py-1 text-xs"
      placeholder={column.kind === 'number' ? '#' : 'Filter...'}
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
      const { site } = await api.post<{ site: Site }>('/sites', {
        ...form,
        domain: form.domain.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0],
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
