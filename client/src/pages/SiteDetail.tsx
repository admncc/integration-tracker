import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { ActivityEntry, Issue, Site, SiteMessage, User } from '../lib/types';
import { APPROVAL, CMP, CURRENCIES, ISSUE_STATUS, READINESS, TRACKS, TRACK_STATUS, formatMoney, formatUplift, missingTracks, rpmUplift, siteCompletion, siteReadiness } from '@shared/domain.js';
import { Badge, Button, Empty, InlineSelect, InlineText, Modal, Spinner, Timestamp, type Tone } from '../components/ui';
import IssueCard from '../components/IssueCard';
import IssueModal from '../components/IssueModal';
import { parseDecimal } from './Sites';
import SiteChat from '../components/SiteChat';

const STATUS_OPTIONS = Object.entries(TRACK_STATUS).map(([value, meta]) => ({ value, label: meta.label }));
const CMP_OPTIONS = Object.entries(CMP).map(([value, meta]) => ({ value, label: meta.label }));
const APPROVAL_OPTIONS = Object.entries(APPROVAL).map(([value, meta]) => ({ value, label: meta.label }));
const PARTNER_WRITABLE = new Set(['approval', 'rpm_primis', 'rpm_primis_currency', 'notes']);
const CURRENCY_OPTIONS = CURRENCIES.map((value: string) => ({ value, label: value }));

type IssueFilter = 'open' | 'all' | 'verified' | 'deleted';

export default function SiteDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, can, eurUsd } = useSession();

  const [site, setSite] = useState<Site | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [messages, setMessages] = useState<SiteMessage[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<IssueFilter>('open');
  const [composing, setComposing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(() => {
    return api
      .get<{ site: Site; issues: Issue[]; activity: ActivityEntry[]; messages: SiteMessage[] }>(`/sites/${id}`)
      .then((r) => {
        setSite(r.site);
        setIssues(r.issues);
        setActivity(r.activity);
        setMessages(r.messages);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    setLoading(true);
    load();
    api.get<{ users: User[] }>('/users').then((r) => setUsers(r.users.filter((u) => u.role !== 'partner' && u.active !== 0)));
  }, [load]);

  const readOnly = (field: string) => (user?.role === 'partner' ? !PARTNER_WRITABLE.has(field) : !can('edit_site'));

  async function patchSite(field: string, raw: string) {
    if (!site) return;
    // Only the amounts are numeric - `rpm_*_currency` is a code and must stay a string.
    const numeric = field === 'priority' || field === 'rpm_previous' || field === 'rpm_primis';
    let value: string | number | boolean | null = raw;
    // `archived` is a real boolean server-side; "1" would be rejected.
    if (field === 'archived') value = raw === '1' || raw === 'true';
    else if (numeric) {
      if (raw.trim() === '') value = null;
      else {
        const parsed = parseDecimal(raw);
        if (parsed == null) {
          setError(`"${raw}" is not a number. The previous value was kept.`);
          setSite({ ...site });
          return;
        }
        value = parsed;
      }
    }
    const previous = site;
    setSite({ ...site, [field]: value } as Site);
    try {
      const { site: saved } = await api.patch<{ site: Site }>(`/sites/${site.id}`, { [field]: value });
      setSite(saved);
      load();
    } catch (err) {
      setSite(previous);
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  }

  const shown = useMemo(() => {
    if (filter === 'deleted') return issues.filter((i) => i.deleted_at);
    const live = issues.filter((i) => !i.deleted_at);
    if (filter === 'all') return live;
    if (filter === 'verified') return live.filter((i) => i.status === 'verified' || i.status === 'wont_fix');
    return live.filter((i) => !ISSUE_STATUS[i.status].terminal);
  }, [issues, filter]);

  const live = issues.filter((i) => !i.deleted_at);
  const openCount = live.filter((i) => !ISSUE_STATUS[i.status].terminal).length;
  const doneCount = live.length - openCount;
  const deletedCount = issues.length - live.length;

  if (loading) return <Spinner />;
  if (!site) return <Empty>{error || 'Site not found.'}</Empty>;

  const progress = siteCompletion(site);
  const readiness = siteReadiness(site);
  const uplift = rpmUplift(site, eurUsd);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <Link to="/sites" className="text-xs text-ink-faint hover:text-brand">← All sites</Link>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <span className={`size-2.5 rounded-full ${READINESS[readiness].dot}`} aria-hidden />
            {site.domain}
          </h1>
          <p className="text-sm text-ink-soft">
            <Badge tone={READINESS[readiness].tone as Tone}>{READINESS[readiness].label}</Badge>{' '}
            {site.archived === 1 && <Badge tone="muted">Archived</Badge>}{' '}
            Priority {site.priority} · {openCount} open issue(s) · {doneCount} closed · added <Timestamp iso={site.created_at} />
          </p>
          {readiness === 'incomplete' && (
            <p className="text-xs text-tone-red">Still to go live: {missingTracks(site).join(', ')}</p>
          )}
          {readiness === 'inactive' && (
            <p className="text-xs text-ink-faint">Priority 99 - parked. Give it a lower number to bring it into the rollout.</p>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setComposing(true)}>+ New issue</Button>
        </div>
      </div>

      <TestUrlBar url={site.test_url} disabled={readOnly('test_url')} onSave={(value) => patchSite('test_url', value)} />

      {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0 space-y-4">
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Integration status</h2>
              <span className="text-xs text-ink-faint">{progress}% of the five tracks live</span>
            </div>

            <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-line">
              <div
                className={`h-full rounded-full transition-all ${progress === 100 ? 'bg-tone-green' : 'bg-tone-amber'}`}
                style={{ width: `${progress}%` }}
              />
            </div>

            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {TRACKS.map((track) => (
                <div key={track.key}>
                  <dt className="text-xs text-ink-faint">{track.label}</dt>
                  <dd className="mt-0.5">
                    <InlineSelect
                      value={String(site[track.key as keyof Site])}
                      options={STATUS_OPTIONS}
                      tone={(TRACK_STATUS[site[track.key as keyof Site] as keyof typeof TRACK_STATUS]?.tone ?? 'slate') as Tone}
                      disabled={readOnly(track.key)}
                      onChange={(value) => patchSite(track.key, value)}
                    />
                  </dd>
                </div>
              ))}
              <div>
                <dt className="text-xs text-ink-faint">CMP</dt>
                <dd className="mt-0.5">
                  <InlineSelect
                    value={site.cmp}
                    options={CMP_OPTIONS}
                    tone={CMP[site.cmp].tone as Tone}
                    disabled={readOnly('cmp')}
                    onChange={(value) => patchSite('cmp', value)}
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-faint">Demand partner approval</dt>
                <dd className="mt-0.5">
                  <InlineSelect
                    value={site.approval}
                    options={APPROVAL_OPTIONS}
                    tone={APPROVAL[site.approval].tone as Tone}
                    disabled={readOnly('approval')}
                    onChange={(value) => patchSite('approval', value)}
                  />
                </dd>
              </div>
            </dl>

            <dl className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
              <Editable label="Domain" value={site.domain} disabled={readOnly('domain')} onCommit={(v) => patchSite('domain', v)} />
              <Editable label="Priority" value={String(site.priority)} type="number" disabled={readOnly('priority')} onCommit={(v) => patchSite('priority', v)} />
              <Editable label="Managed by" value={site.managed_by} disabled={readOnly('managed_by')} onCommit={(v) => patchSite('managed_by', v)} />
            </dl>

            <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-3">
              <MoneyField
                label="Previous Session RPM"
                amount={site.rpm_previous}
                currency={site.rpm_previous_currency}
                disabled={readOnly('rpm_previous')}
                onAmount={(v) => patchSite('rpm_previous', v)}
                onCurrency={(v) => patchSite('rpm_previous_currency', v)}
              />
              <MoneyField
                label="Primis Session RPM"
                amount={site.rpm_primis}
                currency={site.rpm_primis_currency}
                disabled={readOnly('rpm_primis')}
                onAmount={(v) => patchSite('rpm_primis', v)}
                onCurrency={(v) => patchSite('rpm_primis_currency', v)}
              />
              <div>
                <span className="text-xs text-ink-faint">Δ vs. previous setup</span>
                <div className="mt-1">
                  {uplift == null ? (
                    <span className="text-sm text-ink-faint">
                      {site.rpm_previous != null && site.rpm_primis != null
                        ? 'No comparison: the previous RPM is zero'
                        : 'Enter both figures'}
                    </span>
                  ) : (
                    <Badge tone={uplift > 0 ? 'green' : uplift < 0 ? 'red' : 'slate'}>
                      {formatUplift(uplift)}
                    </Badge>
                  )}
                  <p className="mt-1 text-xs text-ink-faint">
                    {formatMoney(site.rpm_previous, site.rpm_previous_currency) || '-'} →{' '}
                    {formatMoney(site.rpm_primis, site.rpm_primis_currency) || '-'}
                    {site.rpm_previous_currency !== site.rpm_primis_currency && ` · converted at ${eurUsd} USD/EUR`}
                  </p>
                </div>
              </div>
            </div>

          </section>

          <SiteChat
            siteId={site.id}
            messages={messages}
            onChange={(next) => {
              setMessages(next);
              // The activity trail is written server-side, so it has to be refetched.
              load();
            }}
          />

          <section className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">Issues</h2>
              <div className="ml-auto flex gap-1 rounded-lg border border-line p-0.5 text-xs">
                {(['open', 'verified', 'all', 'deleted'] as IssueFilter[])
                  .filter((value) => value !== 'deleted' || deletedCount > 0)
                  .map((value) => (
                    <button
                      key={value}
                      onClick={() => setFilter(value)}
                      className={`rounded-md px-2 py-1 capitalize ${filter === value ? 'bg-brand-soft text-brand-ink' : 'text-ink-soft hover:bg-raised'}`}
                    >
                      {value === 'verified' ? 'Closed' : value} (
                      {value === 'open'
                        ? openCount
                        : value === 'verified'
                          ? doneCount
                          : value === 'deleted'
                            ? deletedCount
                            : live.length}
                      )
                    </button>
                  ))}
              </div>
            </div>

            {shown.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                users={users}
                onChanged={(updated) => setIssues((current) => current.map((i) => (i.id === updated.id ? { ...i, ...updated } : i)))}
              />
            ))}

            {shown.length === 0 && (
              <div className="card">
                <Empty>
                  {filter === 'open'
                    ? 'No open issues on this site - everything is ticked off.'
                    : filter === 'deleted'
                      ? 'Nothing deleted on this site.'
                      : 'Nothing here yet.'}
                </Empty>
              </div>
            )}

            <button
              onClick={() => setComposing(true)}
              className="w-full rounded-xl border border-dashed border-line-strong py-3 text-sm text-ink-soft transition hover:border-brand hover:text-brand"
            >
              + Raise an issue on {site.domain}
            </button>
          </section>
        </div>

        <aside className="card h-fit p-4">
          <h2 className="mb-3 text-sm font-semibold">History</h2>
          <ol className="space-y-3">
            {activity.map((entry) => (
              <li key={entry.id} className="border-l border-line pl-3 text-xs">
                <div className="text-ink-soft">
                  <span className="font-medium text-ink">{entry.actor_name ?? 'System'}</span> {describe(entry)}
                </div>
                <Timestamp iso={entry.created_at} className="text-ink-faint" />
              </li>
            ))}
            {activity.length === 0 && <li className="text-xs text-ink-faint">Nothing recorded yet.</li>}
          </ol>
        </aside>
      </div>

      {site.archived === 1 && can('manage_sites') && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold">This site is archived</h2>
          <p className="mt-1 mb-3 max-w-2xl text-sm text-ink-soft">
            It is out of the sites list and out of the dashboard totals, but nothing was lost. Bringing it back restores
            it exactly as it was, issues and discussion included.
          </p>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const { site: saved } = await api.patch<{ site: Site }>(`/sites/${site.id}`, { archived: false });
                setSite(saved);
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not bring this site back');
              }
            }}
          >
            Bring {site.domain} back
          </Button>
        </section>
      )}

      {can('delete_site') && (
        <section className="rounded-xl border border-tone-red/30 bg-tone-red-bg/30 p-4">
          <h2 className="text-sm font-semibold text-tone-red">Remove this site</h2>
          <p className="mt-1 mb-3 max-w-2xl text-sm text-ink-soft">
            Deleting {site.domain} also removes its {issues.length} issue(s) including deleted ones, every comment, every
            attachment and the whole discussion. Archiving keeps the record and takes the domain out of the list instead -
            it can be brought back from this page at any time.
          </p>
          <Button variant="danger" onClick={() => setConfirmRemove(true)}>
            Remove {site.domain}
          </Button>
        </section>
      )}

      {composing && (
        <IssueModal
          siteIds={[site.id]}
          domains={[site.domain]}
          onClose={() => setComposing(false)}
          onCreated={(_count, _issue, uploadErrors) => {
            setComposing(false);
            setFilter('open');
            if (uploadErrors?.length) setError(`The issue was created, but a file did not attach: ${uploadErrors[0]}`);
            load();
          }}
        />
      )}

      {confirmRemove && (
        <Modal title={`Remove ${site.domain}?`} onClose={() => setConfirmRemove(false)}>
          <p className="text-sm text-ink-soft">
            This permanently deletes the site, its {issues.length} issue(s), their comments, screenshots and discussion.
            It cannot be undone.
          </p>

          <div className="mt-3 rounded-lg bg-raised px-3 py-2 text-sm">
            <label className="block">
              <span className="text-xs text-ink-soft">
                Type <span className="font-mono font-medium text-ink">{site.domain}</span> to confirm
              </span>
              <input
                className="field mt-1"
                autoFocus
                value={confirmText}
                onChange={(event) => setConfirmText(event.target.value)}
                placeholder={site.domain}
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button onClick={() => { setConfirmRemove(false); setConfirmText(''); }}>Cancel</Button>
            <Button
              onClick={async () => {
                // It used to navigate away either way, so a rejected archive
                // was indistinguishable from a successful one.
                try {
                  await api.patch(`/sites/${site.id}`, { archived: true });
                  setConfirmRemove(false);
                  navigate('/sites');
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not archive this site');
                  setConfirmRemove(false);
                }
              }}
            >
              Archive instead
            </Button>
            <Button
              variant="danger"
              disabled={confirmText.trim() !== site.domain}
              onClick={async () => {
                try {
                  await api.del(`/sites/${site.id}`);
                  navigate('/sites');
                } catch (err) {
                  // An unhandled rejection here left the dialog open and silent.
                  setError(err instanceof Error ? err.message : 'Could not delete this site');
                  setConfirmRemove(false);
                }
              }}
            >
              Delete permanently
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * The page the partner actually QAs against - the first thing either side needs
 * from a site, so it gets its own bar rather than a cell in a form grid.
 */
function TestUrlBar({ url, disabled, onSave }: { url: string; disabled: boolean; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(url);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);

  useEffect(() => setDraft(url), [url]);

  /**
   * `navigator.clipboard` only exists in a secure context, and this tool is
   * meant to run over plain HTTP too, where the button used to fail silently
   * and sit on "Copy" forever.
   */
  async function copy() {
    const viaExecCommand = () => {
      const field = document.createElement('textarea');
      field.value = url;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(field);
      field.select();
      const done = document.execCommand('copy');
      field.remove();
      return done;
    };

    let done = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        done = true;
      } else {
        done = viaExecCommand();
      }
    } catch {
      try {
        done = viaExecCommand();
      } catch {
        done = false;
      }
    }

    setCopied(done ? 'done' : 'failed');
    setTimeout(() => setCopied(null), 2000);
  }

  if (editing || !url) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft.trim());
          setEditing(false);
        }}
        className="card flex flex-wrap items-center gap-2 p-3"
      >
        <span className="text-xs font-medium text-ink-soft">Test URL</span>
        <input
          className="field min-w-0 flex-1"
          type="url"
          autoFocus={editing}
          disabled={disabled}
          placeholder="https://example.de/an-article-the-partner-can-check"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {!disabled && (
          <>
            <Button type="submit" variant="primary" size="sm">Save</Button>
            {url && (
              <Button type="button" size="sm" onClick={() => { setDraft(url); setEditing(false); }}>
                Cancel
              </Button>
            )}
          </>
        )}
        {disabled && !url && <span className="text-sm text-ink-faint">No test URL set yet.</span>}
      </form>
    );
  }

  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <span className="text-xs font-medium text-ink-soft">Test URL</span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate font-medium text-brand hover:underline"
        title={url}
      >
        {url}
      </a>
      <Button size="sm" onClick={copy} title={copied === 'failed' ? 'Select the link and copy it by hand' : undefined}>
        {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
      </Button>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="rounded-lg bg-brand px-3 py-1 text-xs font-medium text-white hover:brightness-110"
      >
        Open test page ↗
      </a>
      {!disabled && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
    </div>
  );
}

function MoneyField({
  label,
  amount,
  currency,
  disabled,
  onAmount,
  onCurrency,
}: {
  label: string;
  amount: number | null;
  currency: string;
  disabled: boolean;
  onAmount: (value: string) => void;
  onCurrency: (value: string) => void;
}) {
  return (
    <div>
      <span className="text-xs text-ink-faint">{label}</span>
      <div className="mt-0.5 flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <InlineText value={amount == null ? '' : String(amount)} type="decimal" disabled={disabled} onCommit={onAmount} />
        </div>
        <div className="shrink-0">
          <InlineSelect
            value={currency}
            options={CURRENCY_OPTIONS}
            tone="slate"
            disabled={disabled}
            title={`Currency for ${label}`}
            onChange={onCurrency}
          />
        </div>
      </div>
    </div>
  );
}

function Editable({
  label,
  value,
  onCommit,
  disabled,
  type = 'text',
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  disabled: boolean;
  type?: 'text' | 'number' | 'url';
}) {
  return (
    <div>
      <span className="text-xs text-ink-faint">{label}</span>
      <div className="mt-0.5">
        <InlineText value={value} onCommit={onCommit} disabled={disabled} type={type} />
      </div>
    </div>
  );
}

/** Which vocabulary a stored value belongs to. The field decides, not the value. */
const VALUE_MAPS: Record<string, Record<string, { label: string }>> = {
  status_video: TRACK_STATUS,
  status_display: TRACK_STATUS,
  status_ads_txt: TRACK_STATUS,
  status_ad_tag: TRACK_STATUS,
  status_mcm: TRACK_STATUS,
  cmp: CMP,
  approval: APPROVAL,
  status: ISSUE_STATUS,
};

/** Column headings as they read on screen. */
const FIELD_LABELS: Record<string, string> = {
  domain: 'the domain',
  priority: 'the priority',
  test_url: 'the test URL',
  status_video: 'Video',
  status_display: 'Display',
  status_ads_txt: 'ads.txt',
  status_ad_tag: 'Ad tag',
  status_mcm: 'MCM',
  cmp: 'CMP',
  approval: 'the approval',
  rpm_previous: 'Previous Session RPM',
  rpm_primis: 'Primis Session RPM',
  rpm_previous_currency: 'the previous RPM currency',
  rpm_primis_currency: 'the Primis RPM currency',
  managed_by: 'Managed by',
  archived: 'the archived flag',
};

function describe(entry: ActivityEntry) {
  /*
   * "none" means "No CMP" in one column and "Not submitted" in another. The
   * maps used to be merged into one lookup, so approval won and the history
   * said cmp had been set to "Not submitted" - the audit trail stating a fact
   * that never happened.
   */
  const label = (value: string | null) => {
    if (!value) return '-';
    return VALUE_MAPS[entry.field ?? '']?.[value]?.label ?? value;
  };

  switch (entry.kind) {
    case 'site_created':
      return <>added this site</>;
    case 'import':
      return <>imported sites ({entry.new_value})</>;
    case 'issue_created':
      return <>raised "{entry.new_value}"</>;
    case 'attachment_added':
      return <>attached {entry.new_value}</>;
    case 'issue_deleted':
      return <>deleted the issue "{entry.new_value}"</>;
    case 'issue_restored':
      return <>restored the issue "{entry.new_value}"</>;
    case 'message_posted':
      return <>wrote in the discussion: "{entry.new_value}"</>;
    case 'site_deleted':
      return <>deleted the domain {entry.new_value}</>;
    case 'issue_status':
      return (
        <>
          moved an issue to{' '}
          <Badge tone="slate">
            {ISSUE_STATUS[entry.new_value as keyof typeof ISSUE_STATUS]?.label ?? entry.new_value}
          </Badge>
        </>
      );
    default:
      return (
        <>
          changed <span className="text-ink">{FIELD_LABELS[entry.field ?? ''] ?? entry.field}</span> from {label(entry.old_value)} to{' '}
          <span className="text-ink">{label(entry.new_value)}</span>
        </>
      );
  }
}
