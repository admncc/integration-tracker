import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Issue, Site, User } from '../lib/types';
import { ISSUE_CATEGORY, ISSUE_TYPE, REVENUE_CATEGORIES, SEVERITY } from '@shared/domain.js';
import { FILE_GLYPH, fileKind, formatBytes, isInlineType } from '@shared/files.js';
import { Button, Field, Modal } from './ui';
import { uploadAttachment } from './IssueCard';

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
  network = false,
  activeSiteCount = 0,
  onClose,
  onCreated,
}: {
  siteIds: number[];
  domains: string[];
  /** When given, the dialog lets the reporter pick the affected domains itself. */
  selectableSites?: Site[];
  /** Opens the dialog in network mode, where the two network scopes are offered. */
  network?: boolean;
  /** How many domains "For each domain" would hit; prio 99 is not among them. */
  activeSiteCount?: number;
  onClose: () => void;
  /** `uploadErrors` is non-empty when the issues exist but a file did not attach. */
  onCreated: (count: number, issue?: Issue, uploadErrors?: string[]) => void;
}) {
  const [picked, setPicked] = useState<number[]>(preselected);
  /*
   * The two things a network issue can mean, and they are genuinely different:
   * "network" is one row that is ticked off once, "each_domain" is one row per
   * active domain, so the work has to be signed off on every single site.
   */
  const [scope, setScope] = useState<'network' | 'each_domain'>('network');
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
    if (!network && siteIds.length === 0) {
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
      /*
       * The issues are created first and the files follow, so an upload
       * failure must not leave the dialog open over issues that already exist -
       * pressing Create again then made a second set.
       */
      let created: Issue[] = [];
      if (network && scope === 'network') {
        // site_id: null is what makes it network-wide - no domain, ticked once.
        const result = await api.post<{ issue: Issue }>('/issues', { ...payload, site_id: null });
        created = [result.issue];
      } else if (network) {
        // The server resolves "every active domain", so the count is the real
        // one at that moment and not whatever the table last showed.
        const result = await api.post<{ created: number; issues: Issue[] }>('/issues/bulk', { ...payload, all_active: true });
        created = result.issues;
      } else if (bulk) {
        const result = await api.post<{ created: number; issues: Issue[] }>('/issues/bulk', { ...payload, site_ids: siteIds });
        created = result.issues;
      } else {
        const result = await api.post<{ issue: Issue }>('/issues', { ...payload, site_id: siteIds[0] });
        created = [result.issue];
      }

      const failed: string[] = [];
      for (const issue of created) {
        // The same file is attached to every issue in the batch.
        for (const file of files) {
          try {
            await uploadAttachment(issue.id, file);
          } catch (err) {
            failed.push(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
          }
        }
      }

      onCreated(created.length, created[0], failed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the issue');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        network
          ? 'New network-wide issue'
          : selectableSites
          ? 'New issue'
          : bulk
            ? `New issue on ${siteIds.length} sites`
            : `New issue on ${domains[0] ?? 'this site'}`
      }
      onClose={onClose}
      wide
    >
      <form onSubmit={submit} className="space-y-3">
        {network && (
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-ink-soft">Scope</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                {
                  value: 'network' as const,
                  label: 'Network-wide, ticked off once',
                  hint: 'One item in the band above the sites table. Nothing appears on the individual domains.',
                },
                {
                  value: 'each_domain' as const,
                  label: 'For each domain',
                  hint: `Creates the same item on all ${activeSiteCount || ''} active domains (priority 99 excluded), to be ticked off on every one of them.`,
                },
              ]).map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                    scope === option.value ? 'border-brand bg-brand-soft' : 'border-line hover:bg-raised'
                  }`}
                >
                  <input
                    type="radio"
                    name="issue-scope"
                    className="mt-1"
                    checked={scope === option.value}
                    onChange={() => setScope(option.value)}
                  />
                  <span>
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-ink-soft">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {!network && selectableSites && (
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

        {!network && bulk && !selectableSites && (
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

        <Field label="Attachments" hint="Any file type - screenshots, ads.txt snippets, tag exports, logs. Up to 25 MB each.">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
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
          {files.length > 0 && <FilePreview files={files} />}
        </Field>

        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy
              ? 'Creating...'
              : network && scope === 'each_domain'
                ? `Create on ${activeSiteCount || 'all'} domains`
                : network
                  ? 'Create network-wide issue'
                  : bulk
                    ? `Create ${siteIds.length} issues`
                    : 'Create issue'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Thumbnails for pictures, a chip for everything else. The old version fed
 * every file to URL.createObjectURL and rendered it as an image, so a .txt
 * attachment showed up as a broken-image icon - and the URLs were never revoked.
 */
function FilePreview({ files }: { files: File[] }) {
  const [previews, setPreviews] = useState<Record<string, string>>({});

  useEffect(() => {
    const urls: Record<string, string> = {};
    for (const file of files) {
      if (isInlineType(file.type)) urls[`${file.name}:${file.size}`] = URL.createObjectURL(file);
    }
    setPreviews(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  return (
    <ul className="mt-2 flex flex-wrap gap-2">
      {files.map((file) => {
        const key = `${file.name}:${file.size}`;
        return previews[key] ? (
          <li key={key}>
            <img src={previews[key]} alt={file.name} title={file.name} className="size-16 rounded border border-line object-cover" />
          </li>
        ) : (
          <li key={key} className="flex max-w-56 items-center gap-2 rounded-lg border border-line bg-raised px-2.5 py-1.5">
            <span aria-hidden className="text-base leading-none">
              {FILE_GLYPH[fileKind(file.type, file.name) as keyof typeof FILE_GLYPH] ?? FILE_GLYPH.file}
            </span>
            <span className="min-w-0 truncate text-xs" title={file.name}>{file.name}</span>
            <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{formatBytes(file.size)}</span>
          </li>
        );
      })}
    </ul>
  );
}
