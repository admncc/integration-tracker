import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { ActivityEntry, Issue, User } from '../lib/types';
import { ISSUE_STATUS } from '@shared/domain.js';
import { Badge, Empty, Spinner, Timestamp, type Tone } from '../components/ui';
import IssueCard from '../components/IssueCard';

type Payload = {
  issue: Issue;
  activity: ActivityEntry[];
  siblings: { id: number; status: keyof typeof ISSUE_STATUS; domain: string }[];
};

export default function IssueDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Payload | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<Payload>(`/issues/${id}`)
      .then(setData)
      .catch((err) => setError(err.message));
    api.get<{ users: User[] }>('/users').then((r) => setUsers(r.users.filter((u) => u.role !== 'partner' && u.active !== 0)));
  }, [id]);

  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Spinner />;

  const { issue, activity, siblings } = data;

  return (
    <div className="space-y-4">
      <div>
        <Link to={`/sites/${issue.site_id}`} className="text-xs text-ink-faint hover:text-brand">
          ← {issue.domain}
        </Link>
        <h1 className="text-lg font-semibold">
          #{issue.id} {issue.title}
        </h1>
      </div>

      <IssueCard issue={issue} users={users} defaultOpen showDomain />

      <div className="grid gap-4 lg:grid-cols-2">
        {siblings.length > 0 && (
          <section className="card p-4">
            <h2 className="text-sm font-semibold">Same finding on other domains</h2>
            <p className="mb-3 text-xs text-ink-faint">{issue.batch_title}</p>
            <ul className="space-y-1.5">
              {siblings.map((sibling) => (
                <li key={sibling.id} className="flex items-center gap-2 text-sm">
                  <Badge tone={(ISSUE_STATUS[sibling.status]?.tone ?? 'slate') as Tone}>{ISSUE_STATUS[sibling.status]?.label}</Badge>
                  <Link to={`/issues/${sibling.id}`} className="hover:text-brand hover:underline">
                    {sibling.domain}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">History</h2>
          <ol className="space-y-2">
            {activity.map((entry) => (
              <li key={entry.id} className="border-l border-line pl-3 text-xs">
                <div className="text-ink-soft">
                  <span className="font-medium text-ink">{entry.actor_name ?? 'System'}</span>{' '}
                  {entry.kind === 'issue_created'
                    ? 'raised this issue'
                    : entry.kind === 'attachment_added'
                      ? `attached ${entry.new_value}`
                      : entry.field === 'status'
                        ? `changed status to ${ISSUE_STATUS[entry.new_value as keyof typeof ISSUE_STATUS]?.label ?? entry.new_value}`
                        : `changed ${entry.field}`}
                </div>
                <Timestamp iso={entry.created_at} className="text-ink-faint" />
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
