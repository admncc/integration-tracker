import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { RpmRow, Stats } from '../lib/types';
import { BASE_CURRENCY, ISSUE_CATEGORY, ISSUE_STATUS, ISSUE_TYPE, SEVERITY, TRACK_STATUS, formatMoney, formatUplift } from '@shared/domain.js';
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
    { label: 'Verified fixes', value: totals.verified, to: '/issues?status=verified', tone: 'green' as Tone },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Rollout overview</h1>
        <p className="text-sm text-ink-soft">Where every site stands, and what is blocking the ones that are not live yet.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
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
                <div className="text-ink-soft">
                  <span className="font-medium text-ink">{entry.actor_name ?? 'System'}</span>{' '}
                  {entry.kind === 'issue_created'
                    ? 'raised'
                    : entry.kind === 'issue_status'
                      ? 'moved'
                      : entry.kind === 'attachment_added'
                        ? 'attached'
                        : entry.kind === 'message_posted'
                          ? 'wrote'
                          : entry.kind === 'issue_deleted'
                            ? 'deleted'
                            : entry.kind === 'issue_restored'
                              ? 'restored'
                              : 'changed'}{' '}
                  {entry.kind === 'issue_status' ? (ISSUE_STATUS[entry.new_value as keyof typeof ISSUE_STATUS]?.label ?? entry.new_value) : entry.new_value ?? entry.field}
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
