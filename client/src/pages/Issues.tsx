import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Issue, Site, User } from '../lib/types';
import { ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, SEVERITY } from '@shared/domain.js';
import { Button, Empty, Spinner } from '../components/ui';
import IssueCard from '../components/IssueCard';
import IssueModal from '../components/IssueModal';

const FILTERS = [
  {
    key: 'status',
    label: 'Status',
    // "all" is a real value rather than the empty option: an absent parameter
    // means "the default view", which is open issues.
    options: [
      ['open', 'All open'],
      ...Object.entries(ISSUE_STATUS).map(([v, m]) => [v, m.label] as [string, string]),
      ['deleted', 'Deleted'],
      ['all', 'Everything'],
    ],
    noBlank: true,
    fallback: 'open',
  },
  { key: 'type', label: 'Type', options: Object.entries(ISSUE_TYPE).map(([v, m]) => [v, m.label] as [string, string]) },
  { key: 'severity', label: 'Severity', options: Object.entries(SEVERITY).map(([v, m]) => [v, m.label] as [string, string]) },
  { key: 'category', label: 'Category', options: Object.entries(ISSUE_CATEGORY) as [string, string][] },
] as const;

export default function Issues() {
  const [params, setParams] = useSearchParams();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [notice, setNotice] = useState('');

  // The URL is the source of truth for filters, so a view can be shared as a link.
  const query = params.toString();

  const load = useCallback(() => {
    setLoading(true);
    const search = new URLSearchParams(params);
    if (!search.has('status')) search.set('status', 'open');
    return api
      .get<{ issues: Issue[]; total: number; truncated: boolean }>(`/issues?${search.toString()}`)
      .then((r) => {
        setIssues(r.issues);
        setTotal(r.total ?? r.issues.length);
        setTruncated(Boolean(r.truncated));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * A stale or mistyped link used to show an empty tracker while every dropdown
   * read as its default. Unknown values are dropped and named.
   */
  const [ignored, setIgnored] = useState<string[]>([]);
  useEffect(() => {
    const allowed: Record<string, string[]> = Object.fromEntries(
      FILTERS.map((filter) => [filter.key, filter.options.map(([value]) => value)])
    );
    const next = new URLSearchParams(params);
    const dropped: string[] = [];
    for (const [key, values] of Object.entries(allowed)) {
      const value = next.get(key);
      if (value && !values.includes(value)) {
        dropped.push(`${key}=${value}`);
        next.delete(key);
      }
    }
    if (dropped.length) {
      setIgnored(dropped);
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    api.get<{ sites: Site[] }>('/sites?archived=1').then((r) => setSites(r.sites));
    api.get<{ users: User[] }>('/users').then((r) => setUsers(r.users.filter((u) => u.role !== 'partner' && u.active !== 0)));
  }, []);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    setParams(next, { replace: true });
  }

  // The export mirrors the list exactly, filters and all.
  const exportHref = useMemo(() => {
    const search = new URLSearchParams(params);
    if (!search.has('status')) search.set('status', 'open');
    return `/api/issues/export.csv?${search.toString()}`;
  }, [params]);

  const siteId = params.get('site_id');
  const activeSite = sites.find((s) => String(s.id) === siteId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">Issues</h1>
          <p className="text-sm text-ink-soft">
            {truncated ? `${issues.length} of ${total} shown` : `${issues.length} shown`}
            {activeSite && ` on ${activeSite.domain}`}
            {siteId === 'network' && ' · network-wide only'}
            {params.get('batch_id') && ' · one batch'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            className="field w-56"
            placeholder="Search title, domain..."
            value={params.get('q') ?? ''}
            onChange={(event) => setFilter('q', event.target.value)}
          />
          <a href={exportHref} className="rounded-lg border border-line-strong px-3 py-1.5 text-sm hover:bg-raised">
            Export CSV
          </a>
          <Button variant="primary" onClick={() => setComposing(true)} disabled={sites.length === 0}>
            + New issue
          </Button>
        </div>
      </div>

      {notice && <p className="rounded-lg bg-tone-amber-bg px-3 py-2 text-sm text-tone-amber">{notice}</p>}

      {ignored.length > 0 && (
        <p className="rounded-lg bg-tone-amber-bg px-3 py-2 text-sm text-tone-amber">
          Ignored an unknown filter in the link: {ignored.join(', ')}
        </p>
      )}

      {truncated && (
        <p className="rounded-lg bg-tone-amber-bg px-3 py-2 text-sm text-tone-amber">
          Only the first {issues.length} of {total} issues are listed. Narrow the filters to see the rest, or export the
          full list as CSV.
        </p>
      )}

      <div className="card flex flex-wrap items-end gap-3 p-3">
        {FILTERS.map((filter) => (
          <label key={filter.key} className="text-xs">
            <span className="mb-1 block text-ink-faint">{filter.label}</span>
            <select
              className="field !w-auto !py-1"
              value={params.get(filter.key) ?? ('fallback' in filter ? filter.fallback : '')}
              onChange={(event) => setFilter(filter.key, event.target.value)}
            >
              {!('noBlank' in filter) && <option value="">All</option>}
              {filter.options.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        ))}

        <label className="text-xs">
          <span className="mb-1 block text-ink-faint">Site</span>
          <select className="field !w-auto !py-1" value={siteId ?? ''} onChange={(event) => setFilter('site_id', event.target.value)}>
            <option value="">All sites</option>
            <option value="network">Network-wide only</option>
            <option value="per_site">Domain issues only</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.domain}
                {site.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs">
          <span className="mb-1 block text-ink-faint">Assignee</span>
          <select className="field !w-auto !py-1" value={params.get('assignee_id') ?? ''} onChange={(event) => setFilter('assignee_id', event.target.value)}>
            <option value="">Anyone</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>{user.name}</option>
            ))}
          </select>
        </label>

        {query && (
          <Button size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Reset
          </Button>
        )}
      </div>

      {loading ? (
        <Spinner />
      ) : issues.length === 0 ? (
        <div className="card">
          <Empty>No issue matches these filters.</Empty>
        </div>
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              users={users}
              showDomain
              onChanged={(updated) =>
                setIssues((current) => {
                  // A card that no longer matches the active view leaves the list
                  // instead of sitting there contradicting the header count.
                  const viewingDeleted = params.get('status') === 'deleted';
                  if (Boolean(updated.deleted_at) !== viewingDeleted && params.get('status') !== 'all') {
                    return current.filter((i) => i.id !== updated.id);
                  }
                  return current.map((i) => (i.id === updated.id ? { ...i, ...updated } : i));
                })
              }
            />
          ))}
        </div>
      )}

      {composing && (
        <IssueModal
          siteIds={siteId ? [Number(siteId)] : []}
          domains={activeSite ? [activeSite.domain] : []}
          selectableSites={siteId ? undefined : sites}
          onClose={() => setComposing(false)}
          onCreated={(_count, _issue, uploadErrors) => {
            setComposing(false);
            if (uploadErrors?.length) setNotice(`The issue was created, but a screenshot did not attach: ${uploadErrors[0]}`);
            load();
          }}
        />
      )}
    </div>
  );
}
