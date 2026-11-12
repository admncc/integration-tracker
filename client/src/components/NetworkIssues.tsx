import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { Issue, Site, User } from '../lib/types';
import { ISSUE_STATUS, ISSUE_TYPE, SEVERITY } from '@shared/domain.js';
import IssueCard from './IssueCard';
import IssueModal from './IssueModal';
import { Badge, Button, type Tone } from './ui';

/** One "For each domain" campaign: the same task on every active site. */
export interface Rollout {
  id: number;
  title: string;
  created_at: string;
  created_by_name: string | null;
  total: number;
  still_open: number;
  done: number;
}

/**
 * The band above the sites table. It answers "what applies to everything?" -
 * the question the mail thread never had a place for.
 *
 * Two kinds live here, and they are deliberately not the same thing:
 *
 *  - a network-wide issue has no domain and is ticked off once;
 *  - a "for each domain" rollout is one issue per active site, so it has to be
 *    ticked off on every one of them and shows its progress here.
 */
export default function NetworkIssues({ sites, onIssuesChanged }: { sites: Site[]; onIssuesChanged?: () => void }) {
  const { can } = useSession();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [rollouts, setRollouts] = useState<Rollout[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .get<{ issues: Issue[]; rollouts: Rollout[] }>('/issues/network')
      .then((r) => {
        setIssues(r.issues);
        setRollouts(r.rollouts);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (can('raise_issue')) {
      api
        .get<{ users: User[] }>('/users')
        .then((r) => setUsers(r.users.filter((u) => u.active !== 0)))
        .catch(() => setUsers([]));
    }
  }, [can]);

  const activeSiteCount = sites.filter((site) => site.archived === 0 && site.priority < 99).length;
  const open = (issues ?? []).filter((issue) => !ISSUE_STATUS[issue.status].terminal);
  const closed = (issues ?? []).filter((issue) => ISSUE_STATUS[issue.status].terminal);
  const nothing = open.length === 0 && rollouts.length === 0;

  // An empty band would be permanent furniture, so it collapses to one line.
  if (issues === null) return null;

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-sm font-semibold">Network-wide</h2>
        <p className="text-xs text-ink-soft">
          {nothing
            ? 'Nothing that applies to every site right now.'
            : `${open.length} open across the network${rollouts.length ? `, ${rollouts.length} rollout(s) in progress` : ''}`}
        </p>

        <div className="ml-auto flex items-center gap-2">
          {(open.length > 0 || closed.length > 0) && (
            <Button size="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Collapse' : 'Show details'}
            </Button>
          )}
          {can('raise_issue') && (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              + Network-wide issue
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg bg-tone-red-bg px-3 py-2 text-xs text-tone-red">{error}</p>}

      {/*
       * On the Sites tab this card stays on screen above the table (`pinned:`),
       * so each list keeps to about four lines and scrolls on its own past that.
       */}
      {open.length > 0 && !expanded && (
        <ul className="mt-3 space-y-1.5 pinned:max-h-28 pinned:overflow-y-auto">
          {open.map((issue) => (
            <li key={issue.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={(ISSUE_STATUS[issue.status] as { tone: Tone }).tone}>{ISSUE_STATUS[issue.status].label}</Badge>
              <Badge tone={(SEVERITY[issue.severity] as { tone: Tone }).tone}>{SEVERITY[issue.severity].label}</Badge>
              <Badge tone={(ISSUE_TYPE[issue.type] as { tone: Tone }).tone}>{ISSUE_TYPE[issue.type].label}</Badge>
              <Link to={`/issues/${issue.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-brand hover:underline">
                {issue.title}
              </Link>
              <span className="shrink-0 text-xs text-ink-faint">applies to every site</span>
            </li>
          ))}
        </ul>
      )}

      {expanded && (
        <div className="mt-3 space-y-2 pinned:max-h-[40vh] pinned:overflow-y-auto">
          {[...open, ...closed].map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              users={users}
              // "Show details" means the details, not another row to click open.
              defaultOpen
              onChanged={() => {
                load();
                onIssuesChanged?.();
              }}
            />
          ))}
        </div>
      )}

      {rollouts.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <h3 className="mb-2 text-xs font-medium text-ink-soft">Running on every domain</h3>
          <ul className="space-y-1.5 pinned:max-h-28 pinned:overflow-y-auto">
            {rollouts.map((rollout) => (
              <li key={rollout.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link
                  to={`/issues?status=all&batch_id=${rollout.id}`}
                  className="min-w-0 truncate font-medium hover:text-brand hover:underline max-sm:basis-full max-sm:whitespace-normal sm:flex-1"
                >
                  {rollout.title}
                </Link>
                <div className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-line" title={`${rollout.done} of ${rollout.total} done`}>
                  <div className="h-full bg-tone-green" style={{ width: `${(rollout.done / rollout.total) * 100}%` }} />
                </div>
                <span className="shrink-0 text-xs text-ink-faint tabular-nums">
                  {rollout.done} / {rollout.total} domains done
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {creating && (
        <IssueModal
          network
          activeSiteCount={activeSiteCount}
          siteIds={[]}
          domains={[]}
          onClose={() => setCreating(false)}
          onCreated={(count, _issue, uploadErrors) => {
            setCreating(false);
            load();
            onIssuesChanged?.();
            if (uploadErrors?.length) setError(`Created, but a file did not attach: ${uploadErrors[0]}`);
            else if (count > 1) setError('');
          }}
        />
      )}
    </section>
  );
}
