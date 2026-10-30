import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Prospect, ProspectImport, ProspectStatus } from '../lib/types';
import { PROSPECT_STATUS } from '@shared/domain.js';
import { Button, Empty, InlineSelect, Modal, Spinner, type Tone } from '../components/ui';

const STATUS_OPTIONS = (Object.entries(PROSPECT_STATUS) as [ProspectStatus, { label: string; tone: string }][]).map(
  ([value, meta]) => ({ value, label: meta.label })
);

/**
 * Potential projects: candidate domains and where each one stands.
 *
 * Two columns on purpose - a domain and a status - because this is a list to
 * sort through, not a rollout to run. A domain that works out is added on the
 * Sites tab, where the rollout columns are.
 */
export default function Prospects() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProspectStatus | 'all'>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<ProspectStatus>('removed');

  useEffect(() => {
    api
      .get<{ prospects: Prospect[] }>('/prospects')
      .then((r) => setProspects(r.prospects))
      .catch((err) => setNotice({ tone: 'red', text: err.message }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!notice || notice.tone === 'red') return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: prospects.length };
    for (const key of Object.keys(PROSPECT_STATUS)) result[key] = prospects.filter((p) => p.status === key).length;
    return result;
  }, [prospects]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return prospects.filter(
      (p) => (statusFilter === 'all' || p.status === statusFilter) && (!term || p.domain.includes(term))
    );
  }, [prospects, search, statusFilter]);

  // A selection that the filter now hides would be acted on unseen.
  const hiddenSelected = [...selected].filter((id) => !visible.some((p) => p.id === id)).length;
  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id));

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visible.forEach((p) => next.delete(p.id));
      else visible.forEach((p) => next.add(p.id));
      return next;
    });
  }

  async function setStatus(ids: number[], status: ProspectStatus) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.patch<{ changed: number; prospects: Prospect[] }>('/prospects/bulk', { ids, status });
      setProspects(r.prospects);
      if (ids.length > 1) {
        setNotice({ tone: 'green', text: `${PROSPECT_STATUS[status].label} set on ${r.changed} domain(s)` });
        setSelected(new Set());
      }
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    const ids = [...selected];
    if (!window.confirm(`Delete ${ids.length} domain(s) from the list for good?\n\nSetting them to REMOVED keeps the record instead.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.post<{ deleted: number; prospects: Prospect[] }>('/prospects/delete', { ids });
      setProspects(r.prospects);
      setSelected(new Set());
      setNotice({ tone: 'green', text: `${r.deleted} domain(s) deleted from the list` });
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not delete' });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">Potential projects</h1>
          <p className="text-sm text-ink-soft">
            {visible.length} of {prospects.length} domain(s)
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            className="field w-56"
            placeholder="Search domain..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button variant="primary" size="md" onClick={() => setImporting(true)}>
            + Add domains
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {(['all', ...Object.keys(PROSPECT_STATUS)] as (ProspectStatus | 'all')[]).map((key) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            aria-pressed={statusFilter === key}
            className={`rounded-full border px-2.5 py-1 font-medium transition ${
              statusFilter === key ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line text-ink-soft hover:bg-raised'
            }`}
          >
            {key === 'all' ? 'All' : PROSPECT_STATUS[key].label} ({counts[key] ?? 0})
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
          <span className="font-medium text-brand-ink">
            {selected.size} selected
            {hiddenSelected > 0 && `, ${hiddenSelected} of them not in the current filter`}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-brand-ink">Set status to</span>
            <select
              className="field !w-auto !py-1 text-xs"
              value={bulkStatus}
              onChange={(event) => setBulkStatus(event.target.value as ProspectStatus)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={busy} onClick={() => setStatus([...selected], bulkStatus)}>
              Apply to {selected.size}
            </Button>
          </div>
          <Button size="sm" variant="danger" disabled={busy} onClick={deleteSelected}>
            Delete from list
          </Button>
          <Button size="sm" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {prospects.length === 0 ? (
        <Empty>
          No potential projects yet. Use <span className="font-medium">+ Add domains</span> to paste a list or upload a .txt file.
        </Empty>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-raised text-left">
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all visible domains"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                  />
                </th>
                <th className="px-3 py-2 font-medium text-ink-soft">Domain</th>
                <th className="w-48 px-3 py-2 font-medium text-ink-soft">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((prospect) => (
                <tr key={prospect.id} className={`border-b border-line last:border-0 ${selected.has(prospect.id) ? 'bg-brand-soft/40' : ''}`}>
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${prospect.domain}`}
                      checked={selected.has(prospect.id)}
                      onChange={() => toggle(prospect.id)}
                    />
                  </td>
                  <td className="truncate px-3 py-1.5">
                    <span className={prospect.status === 'removed' ? 'text-ink-faint line-through decoration-1' : 'font-medium'}>
                      {prospect.domain}
                    </span>
                    {prospect.site_id != null && (
                      <Link to={`/sites/${prospect.site_id}`} className="ml-2 text-xs text-brand hover:underline">
                        now a tracked site
                      </Link>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <InlineSelect
                      value={prospect.status}
                      options={STATUS_OPTIONS}
                      tone={PROSPECT_STATUS[prospect.status].tone as Tone}
                      disabled={busy}
                      onChange={(next) => setStatus([prospect.id], next)}
                    />
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-sm text-ink-faint">
                    No domain matches this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onImported={(result) => {
            setProspects(result.prospects);
            setImporting(false);
            const parts = [`${result.added} added`];
            if (result.already_listed.length) parts.push(`${result.already_listed.length} already on the list`);
            if (result.already_tracked.length) parts.push(`${result.already_tracked.length} already a tracked site`);
            if (result.repeated.length) parts.push(`${result.repeated.length} repeated in the paste`);
            if (result.invalid_count) {
              const sample = result.invalid.slice(0, 3).join(', ');
              parts.push(`${result.invalid_count} not a domain (${sample}${result.invalid_count > 3 ? ', ...' : ''})`);
            }
            setNotice({ tone: result.added ? 'green' : 'red', text: parts.join(' · ') });
          }}
        />
      )}
    </div>
  );
}

/**
 * Paste a list or pick a .txt file - one domain per line is the usual shape,
 * but commas, semicolons and spaces separate too, and full URLs are reduced to
 * their domain on the server.
 */
function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (result: ProspectImport) => void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<ProspectStatus>('new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const count = text.split(/[\s,;]+/).filter(Boolean).length;

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError(`${file.name} is larger than 2 MB - that is not a list of domains.`);
      return;
    }
    const content = await file.text();
    // A second file adds to what is there rather than replacing it.
    setText((current) => (current.trim() ? `${current.trim()}\n${content}` : content));
    if (fileInput.current) fileInput.current.value = '';
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!count) return;
    setBusy(true);
    setError('');
    try {
      onImported(await api.post<ProspectImport>('/prospects/import', { text, status }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import the list');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add potential projects" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-ink-soft">
          Paste domains, one per line, or load a .txt file. Full URLs work too - only the domain is kept. Duplicates and
          domains that are already on the list or already a tracked site are skipped and reported.
        </p>

        <textarea
          className="field min-h-56 font-mono text-xs"
          placeholder={'example.de\nhttps://www.another-example.com/some/article\nthird-example.net'}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            onChange={(event) => readFile(event.target.files?.[0])}
            className="text-xs text-ink-soft file:mr-2 file:rounded-lg file:border file:border-line-strong file:bg-raised file:px-2 file:py-1 file:text-xs"
          />
          <label className="flex items-center gap-1.5 text-sm text-ink-soft">
            Add them as
            <select className="field !w-auto !py-1 text-sm" value={status} onChange={(event) => setStatus(event.target.value as ProspectStatus)}>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <span className="ml-auto text-xs text-ink-faint">{count} entr{count === 1 ? 'y' : 'ies'}</span>
        </div>

        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || count === 0}>
            {busy ? 'Adding...' : `Add ${count || ''} domain${count === 1 ? '' : 's'}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
