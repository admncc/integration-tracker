import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { ActivityEntry, RpmRow, Stats } from '../lib/types';
import { BASE_CURRENCY, ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, SEVERITY, TRACK_STATUS, daysSince, formatMoney, formatUplift, formatWaiting } from '@shared/domain.js';
import { Badge, Empty, Spinner, TONE_BG, TONE_TEXT, Timestamp, type Tone } from '../components/ui';

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<Stats>('/stats').then(setStats).catch((err) => setError(err.message));
  }, []);

  if (error) return <Empty>{error}</Empty>;
  if (!stats) return <Spinner />;

  const { totals } = stats;

  const cards = [
    { label: 'Sites tracked', value: totals.sites, to: '/sites' },
    { label: 'All five tracks live', value: totals.fully_live, to: '/sites', tone: 'green' as Tone },
    { label: 'Not active (prio 99)', value: totals.inactive, to: '/sites', tone: 'muted' as Tone },
    { label: 'Open issues', value: totals.open_issues, to: '/issues?status=open', tone: totals.open_issues > 0 ? ('red' as Tone) : ('green' as Tone) },
    { label: 'Waiting on partner re-check', value: totals.awaiting_qa, to: '/issues?status=ready_for_qa', tone: 'blue' as Tone },
    { label: 'Blocked on someone else', value: totals.blocked ?? 0, to: '/issues?status=blocked', tone: totals.blocked ? ('purple' as Tone) : ('muted' as Tone) },
    { label: 'Verified fixes', value: totals.verified, to: '/issues?status=verified', tone: 'green' as Tone },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Rollout overview</h1>
        <p className="text-sm text-ink-soft">Where every site stands, and what is blocking the ones that are not live yet.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {cards.map((card) => (
          <Link key={card.label} to={card.to} className="card p-4 transition hover:border-line-strong">
            <div className={`text-2xl font-semibold tabular-nums ${card.tone ? TONE_TEXT[card.tone] : ''}`}>{card.value}</div>
            <div className="mt-0.5 text-xs text-ink-soft">{card.label}</div>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Integration tracks</h2>
          <div className="space-y-3">
            {Object.entries(stats.trackBreakdown).map(([key, track]) => {
              const total = track.counts.reduce((sum, entry) => sum + entry.n, 0) || 1;
              return (
                <div key={key}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-medium">{track.label}</span>
                    <span className="text-ink-faint">
                      {track.counts.find((c) => c.status === 'live')?.n ?? 0} of {total} live
                    </span>
                  </div>
                  <div className="flex h-2 overflow-hidden rounded-full bg-line">
                    {track.counts.map((entry) => (
                      <div
                        key={entry.status}
                        title={`${TRACK_STATUS[entry.status]?.label ?? entry.status}: ${entry.n}`}
                        className={TONE_BG[(TRACK_STATUS[entry.status]?.tone ?? 'slate') as Tone]}
                        style={{ width: `${(entry.n / total) * 100}%` }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {/* The bars are colour only; without this the blue and purple slices meant nothing. */}
          <ul className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
            {Object.entries(TRACK_STATUS).map(([key, meta]) => (
              <li key={key} className="flex items-center gap-1.5">
                <span aria-hidden className={`size-2 rounded-full ${TONE_BG[meta.tone as Tone]}`} />
                {meta.label}
              </li>
            ))}
          </ul>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Open issues</h2>

          <div className="mb-4 flex flex-wrap gap-2">
            {stats.issuesByType.map((entry) => (
              <Link key={entry.type} to={`/issues?status=open&type=${entry.type}`}>
                <Badge tone={(ISSUE_TYPE[entry.type]?.tone ?? 'slate') as Tone}>
                  {ISSUE_TYPE[entry.type]?.label ?? entry.type}: {entry.n}
                </Badge>
              </Link>
            ))}
            {stats.issuesBySeverity.map((entry) => (
              <Link key={entry.severity} to={`/issues?status=open&severity=${entry.severity}`}>
                <Badge tone={(SEVERITY[entry.severity]?.tone ?? 'slate') as Tone}>
                  {SEVERITY[entry.severity]?.label}: {entry.n}
                </Badge>
              </Link>
            ))}
          </div>

          <h3 className="mb-2 text-xs font-medium text-ink-soft">By category</h3>
          <ul className="space-y-1.5">
            {stats.issuesByCategory.map((entry) => (
              <li key={entry.category} className="flex items-center gap-2 text-sm">
                <Link to={`/issues?status=open&category=${entry.category}`} className="text-ink-soft hover:text-brand hover:underline">
                  {ISSUE_CATEGORY[entry.category as keyof typeof ISSUE_CATEGORY] ?? entry.category}
                </Link>
                <span className="ml-auto tabular-nums">{entry.n}</span>
              </li>
            ))}
            {stats.issuesByCategory.length === 0 && <li className="text-sm text-ink-faint">Nothing open.</li>}
          </ul>
        </section>

        <section className="card p-4 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-baseline gap-2">
            <h2 className="text-sm font-semibold">Primis vs. the previous setup</h2>
            <span className="text-xs text-ink-faint">
              Session RPM, converted to EUR at {stats.revenue.eur_usd} USD/EUR · {stats.revenue.with_figures} site(s) with both figures
              {stats.revenue.missing > 0 && ` · ${stats.revenue.missing} still missing a value`}
            </span>
          </div>

          {stats.revenue.with_figures === 0 ? (
            <p className="text-sm text-ink-faint">
              Enter "Previous Session RPM" and "Primis Session RPM" on the Sites page and the comparison appears here.
            </p>
          ) : (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-4">
                <Metric label="Sites Primis beats" value={String(stats.revenue.better ?? 0)} tone="green" />
                <Metric label="Sites below the old setup" value={String(stats.revenue.worse ?? 0)} tone={stats.revenue.worse ? 'red' : 'slate'} />
                <Metric label="Avg. previous RPM" value={formatMoney(stats.revenue.avg_previous, BASE_CURRENCY)} />
                <Metric label="Avg. Primis RPM" value={formatMoney(stats.revenue.avg_primis, BASE_CURRENCY)} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <RpmList title="Biggest gains" rows={stats.revenue.best} />
                <RpmList title="Needs attention" rows={stats.revenue.worst} />
              </div>
            </>
          )}
        </section>

        {stats.blockedIssues?.length > 0 && (
          <section className="card p-4 lg:col-span-2">
            <div className="mb-3 flex flex-wrap items-baseline gap-2">
              <h2 className="text-sm font-semibold">Blocked, and on whom</h2>
              <span className="text-xs text-ink-faint">
                Nobody here can move these. Longest wait first.
              </span>
            </div>
            <ul className="space-y-1.5">
              {stats.blockedIssues.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link to={`/issues/${entry.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-brand hover:underline">
                    {entry.title}
                  </Link>
                  {entry.domain && (
                    <Link to={`/sites/${entry.site_id}`} className="shrink-0 text-xs text-ink-soft hover:text-brand hover:underline">
                      {entry.domain}
                    </Link>
                  )}
                  <span className="shrink-0 text-xs text-ink-faint">
                    on <span className="text-ink-soft">{entry.blocked_on || 'someone outside the team'}</span>
                  </span>
                  <Badge tone={(daysSince(entry.blocked_since) ?? 0) > 21 ? 'red' : 'purple'}>
                    {formatWaiting(entry.blocked_since) || 'just now'}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Sites needing the most work</h2>
          <ul className="space-y-1.5">
            {stats.hotSites.map((site) => (
              <li key={site.id} className="flex items-center gap-2 text-sm">
                <Link to={`/sites/${site.id}`} className="font-medium hover:text-brand hover:underline">
                  {site.domain}
                </Link>
                <span className="text-xs text-ink-faint">prio {site.priority}</span>
                <Badge tone={site.open_issues > 2 ? 'red' : 'amber'} className="ml-auto">
                  {site.open_issues} open
                </Badge>
              </li>
            ))}
            {stats.hotSites.length === 0 && <li className="text-sm text-ink-faint">No site has open issues.</li>}
          </ul>
        </section>

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Latest activity</h2>
          <ol className="space-y-2.5">
            {stats.recent.map((entry) => (
              <li key={entry.id} className="border-l border-line pl-3 text-xs">
                <div className="text-ink-soft [overflow-wrap:anywhere]">
                  <span className="font-medium text-ink">{entry.actor_name ?? 'System'}</span>{' '}
                  <ActivityLine entry={entry} />
                  {entry.domain && (
                    <>
                      {' on '}
                      <Link to={`/sites/${entry.site_id}`} className="text-ink hover:text-brand hover:underline">
                        {entry.domain}
                      </Link>
                    </>
                  )}
                </div>
                <Timestamp iso={entry.created_at} className="text-ink-faint" />
              </li>
            ))}
            {stats.recent.length === 0 && <li className="text-sm text-ink-faint">Nothing yet.</li>}
          </ol>
        </section>
      </div>
    </div>
  );
}

/** Column headings as they read on screen, for the site-edit entries. */
const FIELD_LABELS: Record<string, string> = {
  priority: 'the priority',
  domain: 'the domain',
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
  owner_id: 'the responsible',
  archived: 'the archived flag',
};

/** The same for edits to an issue. */
const ISSUE_FIELD_LABELS: Record<string, string> = {
  title: 'the title',
  description: 'the description',
  type: 'the type',
  severity: 'the severity',
  category: 'the category',
  assignee_id: 'the assignee',
  due_date: 'the due date',
  blocked_on: 'who it is blocked on',
  test_url: 'the test URL',
};

/** And for the settings page. */
const SETTING_LABELS: Record<string, string> = {
  fx_eur_usd: 'the EUR/USD rate',
  fx_auto: 'the automatic ECB rate',
  digest_webhook_url: 'the daily digest channel',
  digest_hour: 'the daily digest time',
};

/** "6 potential project(s) added" -> 6, for a sentence that reads properly. */
const countIn = (value: string | null) => Number.parseInt(value ?? '', 10) || 0;
const domains = (n: number) => `${n} domain${n === 1 ? '' : 's'}`;

const TRACK_FIELDS = new Set(['status_video', 'status_display', 'status_ads_txt', 'status_ad_tag', 'status_mcm']);

/**
 * One line of the feed, in words.
 *
 * The old version printed the raw stored value with no subject: an issue move
 * read "moved In progress" without saying which issue, and a site edit fell
 * through to "changed live" - five identical lines for one domain going live.
 */
function ActivityLine({ entry }: { entry: ActivityEntry }) {
  const issueLink = entry.issue_id ? (
    <Link to={`/issues/${entry.issue_id}`} className="text-ink hover:text-brand hover:underline">
      {entry.issue_title ?? `#${entry.issue_id}`}
    </Link>
  ) : null;

  switch (entry.kind) {
    case 'issue_created':
      return <>raised {issueLink ?? entry.new_value}</>;
    case 'issue_deleted':
      return <>deleted the issue {issueLink ?? entry.new_value}</>;
    case 'issue_restored':
      return <>restored the issue {issueLink ?? entry.new_value}</>;
    case 'attachment_added':
      return <>attached {entry.new_value} to {issueLink ?? 'an issue'}</>;
    case 'message_posted':
      return <>wrote in the discussion: "{entry.new_value}"</>;
    case 'message_deleted':
      return <>deleted a discussion message</>;
    case 'message_restored':
      return <>restored a discussion message</>;
    case 'site_created':
      return <>added the domain</>;
    case 'site_deleted':
      return <>deleted the domain {entry.new_value}</>;
    case 'import':
      return <>imported sites ({entry.new_value})</>;
    case 'issue_status':
      return (
        <>
          moved {issueLink ?? 'an issue'} to{' '}
          {ISSUE_STATUS[entry.new_value as keyof typeof ISSUE_STATUS]?.label ?? entry.new_value}
        </>
      );
    case 'prospects_imported':
      return <>added {domains(countIn(entry.new_value))} to <Link to="/sites?view=potentials" className="text-ink hover:text-brand hover:underline">Potential projects</Link></>;
    case 'prospects_deleted':
      return <>deleted {domains(countIn(entry.new_value))} from Potential projects</>;
    case 'setting_changed': {
      const label = SETTING_LABELS[entry.field ?? ''] ?? 'a setting';
      // The webhook URL is a secret of sorts; the feed says that it changed, not what to.
      if (entry.field === 'digest_webhook_url') return <>{entry.new_value === 'test sent' ? 'sent a test digest' : `changed ${label}`}</>;
      return <>set {label} to {entry.new_value}</>;
    }
    case 'issue_updated': {
      const field = entry.field ?? '';
      const label = ISSUE_FIELD_LABELS[field] ?? field;
      const target = issueLink ?? 'an issue';
      if (field === 'assignee_id') return <>assigned {target} to {entry.new_person ?? 'nobody'}</>;
      if (field === 'description' || field === 'title') return <>edited {label} of {target}</>;
      return <>set {label} of {target} to {entry.new_value || 'nothing'}</>;
    }
    default: {
      const field = entry.field ?? '';
      if (field === 'owner_id') return <>made {entry.new_person ?? 'nobody'} responsible</>;
      if (field === 'demand_block') {
        if (entry.new_value === 'mostly_blocked') return <span className="font-medium text-tone-red">flagged as mostly blocked by demand partners</span>;
        if (entry.new_value === 'offline') return <>took the site offline (mostly blocked by demand partners)</>;
        return <>cleared the demand-partner flag</>;
      }
      const label = FIELD_LABELS[field] ?? field;
      const value = TRACK_FIELDS.has(field)
        ? (TRACK_STATUS[entry.new_value as keyof typeof TRACK_STATUS]?.label ?? entry.new_value)
        : entry.new_value;
      if (!field) return <>changed {value}</>;
      return <>set {label} to {value || 'nothing'}</>;
    }
  }
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="rounded-lg bg-raised px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${tone ? TONE_TEXT[tone] : ''}`}>{value || '-'}</div>
      <div className="text-xs text-ink-soft">{label}</div>
    </div>
  );
}

function RpmList({ title, rows }: { title: string; rows: RpmRow[] }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-ink-soft">{title}</h3>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2 text-sm">
            <Link to={`/sites/${row.id}`} className="truncate hover:text-brand hover:underline">
              {row.domain}
            </Link>
            <span className="ml-auto shrink-0 text-xs text-ink-faint tabular-nums">
              {formatMoney(row.rpm_previous, row.rpm_previous_currency)} → {formatMoney(row.rpm_primis, row.rpm_primis_currency)}
            </span>
            <Badge tone={row.uplift > 0 ? 'green' : row.uplift < 0 ? 'red' : 'slate'}>
              {formatUplift(row.uplift)}
            </Badge>
          </li>
        ))}
        {rows.length === 0 && <li className="text-sm text-ink-faint">No figures yet.</li>}
      </ul>
    </div>
  );
}
