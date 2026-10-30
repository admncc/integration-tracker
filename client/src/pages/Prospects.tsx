import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { DomainStatus, ProjectStatus, Prospect, ProspectImport } from '../lib/types';
import { DOMAIN_STATUS, PROJECT_STATUS } from '@shared/domain.js';
import { Button, Empty, InlineSelect, Modal, Spinner, type Tone } from '../components/ui';

type StatusMap = Record<string, { label: string; tone: string }>;

const optionsOf = <T extends string>(map: StatusMap) =>
  Object.entries(map).map(([value, meta]) => ({ value: value as T, label: meta.label }));

const PROJECT_OPTIONS = optionsOf<ProjectStatus>(PROJECT_STATUS);
const DOMAIN_OPTIONS = optionsOf<DomainStatus>(DOMAIN_STATUS);

/**
 * A drawn star rather than the ★ character: on some systems that glyph comes
 * from a symbol font that ignores the text colour, so a marked row showed a
 * black star instead of an amber one.
 */
function Star({ filled, className = '' }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={`inline-block size-4 ${className}`}>
      <path
        d="M10 1.8l2.47 5.3 5.78.62-4.3 3.92 1.2 5.7L10 14.4l-5.15 2.94 1.2-5.7-4.3-3.92 5.78-.62L10 1.8z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The two statuses, described once so the table, filters and bulk bar agree. */
const FIELDS = [
  { key: 'project_status', label: 'Project status', map: PROJECT_STATUS as StatusMap, options: PROJECT_OPTIONS },
  { key: 'domain_status', label: 'Domain status', map: DOMAIN_STATUS as StatusMap, options: DOMAIN_OPTIONS },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

/**
 * Potential projects: candidate domains and where each one stands.
 *
 * Two questions, kept apart because they move independently: where the project
 * stands with us (new, live, removed) and how the domain itself came out of the
 * check (submitted for approval, good, mostly blocked). A domain that works out
 * is added on the Sites tab, where the rollout columns are.
 */
export default function Prospects() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<FieldKey, string>>({ project_status: 'all', domain_status: 'all' });
  const [onlyHigh, setOnlyHigh] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkField, setBulkField] = useState<FieldKey>('project_status');
  const [bulkValue, setBulkValue] = useState<string>('removed');

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

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return prospects.filter(
      (p) =>
        (filters.project_status === 'all' || p.project_status === filters.project_status) &&
        (filters.domain_status === 'all' || p.domain_status === filters.domain_status) &&
        (!onlyHigh || p.high_potential === 1) &&
        (!term || p.domain.includes(term))
    );
  }, [prospects, search, filters, onlyHigh]);

  const highCount = prospects.filter((p) => p.high_potential === 1).length;

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

  async function setStatus(ids: number[], field: FieldKey, value: string) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.patch<{ changed: number; prospects: Prospect[] }>('/prospects/bulk', { ids, [field]: value });
      setProspects(r.prospects);
      if (ids.length > 1) {
        const meta = FIELDS.find((f) => f.key === field)!;
        setNotice({ tone: 'green', text: `${meta.label} set to ${meta.map[value].label} on ${r.changed} domain(s)` });
        setSelected(new Set());
      }
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  /** Marks or unmarks high potential; the server re-sorts, so they move to the top. */
  async function setHighPotential(ids: number[], value: boolean) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.patch<{ changed: number; prospects: Prospect[] }>('/prospects/bulk', { ids, high_potential: value });
      setProspects(r.prospects);
      if (ids.length > 1) {
        setNotice({
          tone: 'green',
          text: value ? `${r.changed} domain(s) marked as high potential` : `High potential removed from ${r.changed} domain(s)`,
        });
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
    if (!window.confirm(`Delete ${ids.length} domain(s) from the list for good?\n\nA project status of REMOVED keeps the record instead.`)) return;
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

  const bulkMeta = FIELDS.find((f) => f.key === bulkField)!;

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

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="w-28 shrink-0 text-ink-faint">Potential</span>
          <button
            onClick={() => setOnlyHigh(!onlyHigh)}
            aria-pressed={onlyHigh}
            className={`rounded-full border px-2.5 py-1 font-medium transition ${
              onlyHigh ? 'border-tone-amber bg-tone-amber-bg text-tone-amber' : 'border-line text-ink-soft hover:bg-raised'
            }`}
          >
            <Star filled className="mr-1 -mt-0.5 size-3.5" />
            High potential only ({highCount})
          </button>
        </div>
        {FIELDS.map((field) => (
          <div key={field.key} className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="w-28 shrink-0 text-ink-faint">{field.label}</span>
            {['all', ...Object.keys(field.map)].map((value) => {
              const n = value === 'all' ? prospects.length : prospects.filter((p) => p[field.key] === value).length;
              const active = filters[field.key] === value;
              return (
                <button
                  key={value}
                  onClick={() => setFilters((current) => ({ ...current, [field.key]: value }))}
                  aria-pressed={active}
                  className={`rounded-full border px-2.5 py-1 font-medium transition ${
                    active ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line text-ink-soft hover:bg-raised'
                  }`}
                >
                  {value === 'all' ? 'All' : field.map[value].label} ({n})
                </button>
              );
            })}
          </div>
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
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-brand-ink">Set</span>
            <select
              className="field !w-auto !py-1 text-xs"
              aria-label="Which status to set"
              value={bulkField}
              onChange={(event) => {
                const next = event.target.value as FieldKey;
                setBulkField(next);
                // A value from one list means nothing in the other.
                setBulkValue(FIELDS.find((f) => f.key === next)!.options[0].value);
              }}
            >
              {FIELDS.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-brand-ink">to</span>
            <select
              className="field !w-auto !py-1 text-xs"
              aria-label="Status to set"
              value={bulkValue}
              onChange={(event) => setBulkValue(event.target.value)}
            >
              {bulkMeta.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button size="sm" disabled={busy} onClick={() => setStatus([...selected], bulkField, bulkValue)}>
              Apply to {selected.size}
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" disabled={busy} onClick={() => setHighPotential([...selected], true)}>
              <Star filled className="size-3.5 text-tone-amber" />
              Mark high potential
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setHighPotential([...selected], false)}>
              Unmark
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
        // The domain-status labels are long; on a phone the table scrolls
        // inside its card rather than pushing the whole page sideways.
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] table-fixed border-collapse text-sm">
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
                <th className="w-10 px-1 py-2 text-center font-medium text-ink-soft" title="High potential">
                  <Star filled={false} className="text-ink-faint" />
                  <span className="sr-only">High potential</span>
                </th>
                <th className="px-3 py-2 font-medium text-ink-soft">Domain</th>
                <th className="w-40 px-3 py-2 font-medium text-ink-soft">Project status</th>
                <th className="w-80 px-3 py-2 font-medium text-ink-soft">Domain status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((prospect) => (
                <tr
                  key={prospect.id}
                  className={`border-b border-line last:border-0 ${
                    selected.has(prospect.id)
                      ? 'bg-brand-soft/40'
                      : prospect.high_potential
                        ? 'bg-tone-amber-bg/50'
                        : ''
                  }`}
                >
                  <td className={`px-3 py-1.5 ${prospect.high_potential ? 'border-l-4 border-l-tone-amber' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${prospect.domain}`}
                      checked={selected.has(prospect.id)}
                      onChange={() => toggle(prospect.id)}
                    />
                  </td>
                  <td className="px-1 py-1.5 text-center">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setHighPotential([prospect.id], !prospect.high_potential)}
                      aria-pressed={prospect.high_potential === 1}
                      aria-label={`${prospect.high_potential ? 'Unmark' : 'Mark'} ${prospect.domain} as high potential`}
                      title={prospect.high_potential ? 'High potential - click to unmark' : 'Mark as high potential'}
                      className={`grid place-items-center rounded p-0.5 transition ${
                        prospect.high_potential ? 'text-tone-amber' : 'text-ink-faint hover:text-tone-amber'
                      }`}
                    >
                      <Star filled={prospect.high_potential === 1} className="size-[18px]" />
                    </button>
                  </td>
                  <td className="truncate px-3 py-1.5" title={prospect.domain}>
                    <span
                      className={
                        prospect.project_status === 'removed' ? 'text-ink-faint line-through decoration-1' : 'font-medium'
                      }
                    >
                      {prospect.domain}
                    </span>
                    {prospect.site_id != null && (
                      <Link to={`/sites/${prospect.site_id}`} className="ml-2 text-xs text-brand hover:underline">
                        now a tracked site
                      </Link>
                    )}
                  </td>
                  {FIELDS.map((field) => (
                    <td key={field.key} className="px-3 py-1.5">
                      <InlineSelect
                        value={prospect[field.key]}
                        options={field.options as { value: string; label: string }[]}
                        tone={field.map[prospect[field.key]].tone as Tone}
                        disabled={busy}
                        title={`${field.label} of ${prospect.domain}`}
                        onChange={(next) => setStatus([prospect.id], field.key, next)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-sm text-ink-faint">
                    No domain matches these filters.
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
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>('new');
  const [domainStatus, setDomainStatus] = useState<DomainStatus>('new');
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
      onImported(
        await api.post<ProspectImport>('/prospects/import', { text, project_status: projectStatus, domain_status: domainStatus })
      );
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
          <span className="ml-auto text-xs text-ink-faint">
            {count} entr{count === 1 ? 'y' : 'ies'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm text-ink-soft">
          <label className="flex items-center gap-1.5">
            Project status
            <select
              className="field !w-auto !py-1 text-sm"
              value={projectStatus}
              onChange={(event) => setProjectStatus(event.target.value as ProjectStatus)}
            >
              {PROJECT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Domain status
            <select
              className="field !w-auto !py-1 text-sm"
              value={domainStatus}
              onChange={(event) => setDomainStatus(event.target.value as DomainStatus)}
            >
              {DOMAIN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
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
