import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Issue, Site, User } from '../lib/types';
import { ISSUE_CATEGORY, ISSUE_TYPE, REVENUE_CATEGORIES, SEVERITY } from '@shared/domain.js';
import { Button, Field, Modal } from './ui';
import { uploadImage } from './IssueCard';

const CATEGORIES = Object.entries(ISSUE_CATEGORY) as [string, string][];
const SEVERITIES = Object.entries(SEVERITY) as [string, { label: string }][];
const TYPES = Object.entries(ISSUE_TYPE) as [string, { label: string; hint: string }][];

/**
 * Raises one issue, or the same issue across many domains at once.
 * The bulk path is what replaces "the player is in <head> on these 13 sites"
 * mails: one write, one grouped batch, thirteen independently tickable items.
 */
export default function IssueModal({
  siteIds: preselected,
  domains,
  selectableSites,
  onClose,
  onCreated,
}: {
  siteIds: number[];
  domains: string[];
  /** When given, the dialog lets the reporter pick the affected domains itself. */
  selectableSites?: Site[];
  onClose: () => void;
  onCreated: (count: number, issue?: Issue) => void;
}) {
  const [picked, setPicked] = useState<number[]>(preselected);
  const [siteSearch, setSiteSearch] = useState('');
  const siteIds = selectableSites ? picked : preselected;
  const bulk = siteIds.length > 1;
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({
    title: '',
    description: '',
    type: 'technical',
    category: 'other',
    severity: 'medium',
    assignee_id: '',
    due_date: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ users: User[] }>('/users').then((r) => setUsers(r.users.filter((u) => u.role !== 'partner' && u.active !== 0)));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (siteIds.length === 0) {
      setError('Pick at least one domain');
      return;
    }
    setBusy(true);
    setError('');
    const payload = {
      ...form,
      assignee_id: form.assignee_id ? Number(form.assignee_id) : null,
      due_date: form.due_date || null,
    };
    try {
      if (bulk) {
        const result = await api.post<{ created: number; issues: Issue[] }>('/issues/bulk', { ...payload, site_ids: siteIds });
        // The same screenshot is attached to every issue in the batch.
        for (const created of result.issues) {
          for (const file of files) await uploadImage(created.id, file);
        }
        onCreated(result.created);
      } else {
        const result = await api.post<{ issue: Issue }>('/issues', { ...payload, site_id: siteIds[0] });
        for (const file of files) await uploadImage(result.issue.id, file);
        onCreated(1, result.issue);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the issue');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        selectableSites
          ? 'New issue'
          : bulk
            ? `New issue on ${siteIds.length} sites`
            : `New issue on ${domains[0] ?? 'this site'}`
      }
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="space-y-3">
        {selectableSites && (
          <Field label="Affected domains" hint="Tick every domain showing this problem - each one becomes its own tickable item.">
            <div className="space-y-2">
              <input
                className="field"
                placeholder="Filter domains..."
                value={siteSearch}
                onChange={(event) => setSiteSearch(event.target.value)}
              />
              <div className="max-h-44 overflow-y-auto rounded-lg border border-line">
                {selectableSites
                  .filter((site) => site.domain.includes(siteSearch.trim().toLowerCase()))
                  .map((site) => (
                    <label key={site.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-raised">
                      <input
                        type="checkbox"
                        checked={picked.includes(site.id)}
                        onChange={(event) =>
                          setPicked((current) =>
                            event.target.checked ? [...current, site.id] : current.filter((id) => id !== site.id)
                          )
                        }
                      />
                      <span>{site.domain}</span>
                      {(site.open_issues ?? 0) > 0 && <span className="ml-auto text-xs text-ink-faint">{site.open_issues} open</span>}
                    </label>
                  ))}
              </div>
              <p className="text-xs text-ink-faint">{picked.length} selected</p>
            </div>
          </Field>
        )}

        {bulk && !selectableSites && (
          <div className="rounded-lg bg-brand-soft px-3 py-2 text-xs text-brand-ink">
            One issue will be created per domain and grouped under a shared batch, so each site can be fixed and ticked off on its own:{' '}
            <span className="font-medium">{domains.join(', ')}</span>
          </div>
        )}

        <Field label="Title" hint="What a developer needs to recognise the problem at a glance.">
          <input
            className="field"
            required
            minLength={3}
            maxLength={300}
            placeholder="Video player embedded in <head> instead of <body>"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>

        <Field label="Description" hint="Steps, tag IDs, screenshots links - everything that used to live in the mail thread.">
          <textarea
            className="field min-h-32"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>

        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-ink-soft">Type</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {TYPES.map(([value, meta]) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                  form.type === value ? 'border-brand bg-brand-soft' : 'border-line hover:bg-raised'
                }`}
              >
                <input
                  type="radio"
                  name="issue-type"
                  className="mt-1"
                  checked={form.type === value}
                  onChange={() => setForm({ ...form, type: value })}
                />
                <span>
                  <span className="block font-medium">{meta.label}</span>
                  <span className="block text-xs text-ink-soft">{meta.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Category">
            <select
              className="field"
              value={form.category}
              onChange={(e) =>
                setForm({
                  ...form,
                  category: e.target.value,
                  // Picking a yield category implies a revenue issue; the radio stays editable.
                  type: REVENUE_CATEGORIES.has(e.target.value) ? 'revenue' : form.type,
                })
              }
            >
              {CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>
          <Field label="Severity">
            <select className="field" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
              {SEVERITIES.map(([value, meta]) => (
                <option key={value} value={value}>{meta.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Assign to">
            <select className="field" value={form.assignee_id} onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
              <option value="">Unassigned</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>{user.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Due date">
            <input className="field" type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </Field>
        </div>

        <Field label="Screenshots" hint="PNG, JPEG, GIF, WebP or AVIF - up to 10 MB each.">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
              multiple
              onChange={(event) => setFiles([...(event.target.files ?? [])])}
              className="text-xs text-ink-soft file:mr-2 file:rounded-lg file:border file:border-line-strong file:bg-raised file:px-2 file:py-1 file:text-xs"
            />
            {files.length > 0 && (
              <>
                <span className="text-xs text-ink-faint">{files.length} selected</span>
                <button
                  type="button"
                  className="text-xs text-ink-faint hover:text-tone-red"
                  onClick={() => {
                    setFiles([]);
                    if (fileInput.current) fileInput.current.value = '';
                  }}
                >
                  clear
                </button>
              </>
            )}
          </div>
          {files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {files.map((file) => (
                <img
                  key={file.name + file.size}
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  className="size-16 rounded border border-line object-cover"
                />
              ))}
            </div>
          )}
        </Field>

        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Creating...' : bulk ? `Create ${siteIds.length} issues` : 'Create issue'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
