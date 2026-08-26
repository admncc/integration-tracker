import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { Site, TrackStatus } from '../lib/types';
import { APPROVAL, CMP, CURRENCIES, TRACKS, TRACK_STATUS, formatMoney, rpmUplift } from '@shared/domain.js';
import { Badge, Button, Empty, Field, InlineSelect, InlineText, Modal, Spinner, type Tone } from '../components/ui';
import IssueModal from '../components/IssueModal';

type FilterMap = Record<string, string>;
type SortState = { key: string; dir: 1 | -1 };

const STATUS_OPTIONS = Object.entries(TRACK_STATUS).map(([value, meta]) => ({ value: value as TrackStatus, label: meta.label }));
const CMP_OPTIONS = Object.entries(CMP).map(([value, meta]) => ({ value, label: meta.label }));
const APPROVAL_OPTIONS = Object.entries(APPROVAL).map(([value, meta]) => ({ value, label: meta.label }));

/** Column descriptors drive the header, the filter row and the cell renderer alike. */
type Column = {
  key: string;
  label: string;
  kind: 'number' | 'money' | 'uplift' | 'text' | 'enum' | 'issues';
  options?: { value: string; label: string }[];
  tones?: Record<string, Tone>;
  width?: string;
  sticky?: string;
};

const tonesOf = (map: Record<string, { tone: string }>) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.tone as Tone]));

/*
 * Widths are explicit because the table is `table-fixed`: the sticky left offsets
 * below are the running sum of the columns before them (checkbox 40px, prio 80px),
 * and an auto layout would silently drift out of that alignment.
 */
const COLUMNS: Column[] = [
  { key: 'priority', label: 'Prio', kind: 'number', width: 'w-20', sticky: 'left-10' },
  { key: 'domain', label: 'Domain', kind: 'text', width: 'w-64', sticky: 'left-30' },
  ...TRACKS.map((track) => ({
    key: track.key,
    label: track.label,
    kind: 'enum' as const,
    options: STATUS_OPTIONS,
    tones: tonesOf(TRACK_STATUS),
    width: 'w-40',
  })),
  { key: 'cmp', label: 'CMP', kind: 'enum', options: CMP_OPTIONS, tones: tonesOf(CMP), width: 'w-32' },
  { key: 'approval', label: 'Approval', kind: 'enum', options: APPROVAL_OPTIONS, tones: tonesOf(APPROVAL), width: 'w-40' },
  { key: 'open_issues', label: 'Issues', kind: 'issues', width: 'w-32' },
  { key: 'managed_by', label: 'Managed by', kind: 'text', width: 'w-36' },
  { key: 'notes', label: 'Notes', kind: 'text', width: 'w-48' },
  // Revenue sits at the far right: useful to have, but not what the rollout is steered by.
  { key: 'rpm_previous', label: 'Previous Session RPM', kind: 'money', width: 'w-44' },
  { key: 'rpm_primis', label: 'Primis Session RPM', kind: 'money', width: 'w-44' },
  { key: 'rpm_uplift', label: 'Δ vs. previous', kind: 'uplift', width: 'w-28' },
];

/** Fields the partner may change; everything else is publisher-owned. */
const PARTNER_WRITABLE = new Set(['approval', 'rpm_primis', 'rpm_primis_currency', 'notes']);
const CURRENCY_OPTIONS = CURRENCIES.map((value: string) => ({ value, label: value }));

export default function Sites() {
  const { user, can, eurUsd } = useSession();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterMap>({});
  const [sort, setSort] = useState<SortState>({ key: 'priority', dir: 1 });
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Site | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

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

  /** Optimistic cell edit — the row snaps back if the API rejects the change. */
  async function patchSite(site: Site, field: string, raw: string) {
    // Only the amounts are numeric — `rpm_*_currency` is a code and must stay a string.
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

    return rows.sort((a, b) => {
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
  }, [sites, filters, search, sort, eurUsd]);

  const activeFilters = Object.values(filters).filter(Boolean).length + (search ? 1 : 0);

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

  async function removeSite(site: Site) {
    try {
      await api.del(`/sites/${site.id}`);
      setSites((current) => current.filter((s) => s.id !== site.id));
      setNotice({ tone: 'green', text: `${site.domain} removed` });
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not remove the site' });
    } finally {
      setRemoving(null);
    }
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
            placeholder="Search domain, notes…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {activeFilters > 0 && (
            <Button size="sm" onClick={() => { setFilters({}); setSearch(''); }}>
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

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[2400px] table-fixed border-collapse text-sm">
          <thead>
            <tr className="border-b border-line bg-raised">
              <th className="sticky left-0 z-20 w-10 bg-raised px-2 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all visible sites"
                  checked={visible.length > 0 && visible.every((s) => selected.has(s.id))}
                  onChange={(event) => setSelected(event.target.checked ? new Set(visible.map((s) => s.id)) : new Set())}
                />
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  className={`px-2 py-2 text-left font-medium text-ink-soft ${column.width ?? ''} ${
                    column.sticky ? `sticky ${column.sticky} z-20 bg-raised` : ''
                  } ${column.key === 'domain' ? 'shadow-[1px_0_0_0_var(--color-line)]' : ''}`}
                >
                  <button onClick={() => toggleSort(column.key)} className="inline-flex items-center gap-1 hover:text-ink">
                    {column.label}
                    <span className={sort.key === column.key ? 'opacity-100' : 'opacity-0'}>{sort.dir === 1 ? '↑' : '↓'}</span>
                  </button>
                </th>
              ))}
              {can('manage_sites') && <th className="w-10 px-2 py-2" />}
            </tr>

            <tr className="border-b border-line bg-surface">
              <th className="sticky left-0 z-20 bg-surface" />
              {COLUMNS.map((column) => (
                <th key={column.key} className={`px-1.5 py-1.5 ${column.sticky ? `sticky ${column.sticky} z-20 bg-surface` : ''}`}>
                  <ColumnFilter
                    column={column}
                    value={filters[column.key] ?? ''}
                    onChange={(value) => setFilters((current) => ({ ...current, [column.key]: value }))}
                  />
                </th>
              ))}
              {can('manage_sites') && <th />}
            </tr>
          </thead>

          <tbody>
            {visible.map((site) => (
              <tr
                key={site.id}
                className={`border-b border-line last:border-0 hover:bg-raised/60 ${
                  (site.open_issues ?? 0) > 0 ? 'bg-tone-red-bg/25' : ''
                }`}
              >
                <td className="sticky left-0 z-10 bg-surface px-2 py-1.5">
                  <input type="checkbox" aria-label={`Select ${site.domain}`} checked={selected.has(site.id)} onChange={() => toggleRow(site.id)} />
                </td>

                {COLUMNS.map((column) => (
                  <td
                    key={column.key}
                    className={`px-2 py-1.5 align-middle ${column.sticky ? `sticky ${column.sticky} z-10 bg-surface` : ''} ${
                      column.key === 'domain' ? 'shadow-[1px_0_0_0_var(--color-line)]' : ''
                    }`}
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

                {can('manage_sites') && (
                  <td className="px-1 py-1.5">
                    <button
                      onClick={() => setRemoving(site)}
                      title={`Remove ${site.domain}`}
                      className="rounded px-1.5 py-0.5 text-ink-faint hover:bg-tone-red-bg hover:text-tone-red"
                    >
                      ✕
                    </button>
                  </td>
                )}
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

      {removing && (
        <Modal title={`Remove ${removing.domain}?`} onClose={() => setRemoving(null)}>
          <p className="text-sm text-ink-soft">
            This deletes the site and its {removing.total_issues ?? 0} issue(s) permanently. To keep the history instead, set the site to
            archived from its detail page.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removeSite(removing)}>Remove permanently</Button>
          </div>
        </Modal>
      )}

      {bulkOpen && (
        <IssueModal
          siteIds={[...selected]}
          domains={sites.filter((s) => selected.has(s.id)).map((s) => s.domain)}
          onClose={() => setBulkOpen(false)}
          onCreated={(count) => {
            setNotice({ tone: 'green', text: `Issue raised on ${count} site(s)` });
            setBulkOpen(false);
            setSelected(new Set());
            api.get<{ sites: Site[] }>('/sites').then((r) => setSites(r.sites));
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
        value={String(value)}
        options={column.options ?? []}
        tone={column.tones?.[String(value)] ?? 'slate'}
        disabled={disabled}
        onChange={(next) => onCommit(column.key, next)}
      />
    );
  }

  if (column.kind === 'uplift') {
    const uplift = rpmUplift(site, eurUsd);
    if (uplift == null) return <span className="text-sm text-ink-faint">—</span>;
    return (
      <Badge tone={uplift > 0 ? 'green' : uplift < 0 ? 'red' : 'slate'}>
        {uplift > 0 ? '+' : ''}
        {uplift.toFixed(0)}%
      </Badge>
    );
  }

  if (column.kind === 'money') {
    const currencyField = `${column.key}_currency`;
    const currency = String(site[currencyField as keyof Site] ?? 'EUR');
    if (disabled) {
      return <span className="text-sm tabular-nums">{formatMoney(value as number | null, currency) || '—'}</span>;
    }
    return (
      <div className="flex items-center gap-1">
        <InlineText
          value={value == null ? '' : String(value)}
          disabled={false}
          onCommit={(next) => onCommit(column.key, next)}
          type="number"
          placeholder="—"
          className="tabular-nums"
        />
        <InlineSelect
          value={currency}
          options={CURRENCY_OPTIONS}
          tone="slate"
          title={`Currency for ${column.label}`}
          onChange={(next) => onCommit(currencyField, next)}
        />
      </div>
    );
  }

  if (column.kind === 'issues') {
    const open = site.open_issues ?? 0;
    const qa = site.awaiting_qa ?? 0;
    return (
      <Link to={`/issues?site_id=${site.id}`} className="inline-flex items-center gap-1">
        <Badge tone={open === 0 ? 'muted' : open > 2 ? 'red' : 'amber'}>{open} open</Badge>
        {qa > 0 && <Badge tone="blue">{qa} QA</Badge>}
      </Link>
    );
  }

  if (column.key === 'domain') {
    const open = site.open_issues ?? 0;
    return (
      <Link
        to={`/sites/${site.id}`}
        className="group flex items-center gap-1.5 font-medium hover:text-brand"
        title={open > 0 ? `${open} open issue(s) — open the site` : 'Open the site'}
      >
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${open > 0 ? 'bg-tone-red' : 'bg-tone-green'}`}
        />
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
      className={column.kind === 'number' ? 'tabular-nums' : ''}
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
      placeholder={column.kind === 'number' ? '#' : 'Filter…'}
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
        <Field label="Domain" hint="Without https:// or www. — every track starts as Pending.">
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
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Adding…' : 'Add domain'}</Button>
        </div>
      </form>
    </Modal>
  );
}
