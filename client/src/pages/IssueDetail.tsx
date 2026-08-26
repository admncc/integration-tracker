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

/** Column names are not user-facing wording. */
const FIELD_LABELS: Record<string, string> = {
  title: 'the title',
  description: 'the description',
  type: 'the type',
  category: 'the category',
  severity: 'the severity',
  assignee_id: 'the assignee',
  due_date: 'the due date',
};

/** Same wording as the site history, so an event reads alike wherever it shows. */
function describe(entry: ActivityEntry) {
  switch (entry.kind) {
    case 'issue_created':
      return 'raised this issue';
    case 'issue_deleted':
      return `deleted this issue`;
    case 'issue_restored':
      return `restored this issue`;
    case 'attachment_added':
      return `attached ${entry.new_value}`;
    case 'issue_status':
      return `changed status to ${ISSUE_STATUS[entry.new_value as keyof typeof ISSUE_STATUS]?.label ?? entry.new_value}`;
    default: {
      const label = FIELD_LABELS[entry.field ?? ''] ?? entry.field;
      if (!label) return 'made a change';
      return entry.old_value
        ? `changed ${label} from "${entry.old_value}" to "${entry.new_value ?? 'nothing'}"`
        : `set ${label} to "${entry.new_value ?? 'nothing'}"`;
    }
  }
}

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
        {issue.site_id == null ? (
          <Link to="/sites" className="text-xs text-ink-faint hover:text-brand">
            ← Network-wide, applies to every site
          </Link>
        ) : (
          <Link to={`/sites/${issue.site_id}`} className="text-xs text-ink-faint hover:text-brand">
            ← {issue.domain}
          </Link>
        )}
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
                  {describe(entry)}
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
