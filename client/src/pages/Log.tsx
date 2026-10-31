import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Empty, Spinner, Timestamp, relativeTime, type Tone } from '../components/ui';

interface Person {
  id: number;
  name: string;
  company: string;
  role: string;
  active: number;
  last_login_at: string | null;
  last_seen_at: string | null;
  online: boolean;
}

interface Entry {
  id: number;
  created_at: string;
  user_id: number | null;
  user_name: string | null;
  user_company: string | null;
  ip: string | null;
  kind: string;
  detail: string;
  status: number | null;
}

interface LogData {
  people: Person[];
  entries: Entry[];
  keep_days: number;
  online_minutes: number;
}

const KINDS = [
  ['all', 'Everything'],
  ['logins', 'Sign-ins'],
  ['actions', 'Actions'],
  ['failed', 'Failed sign-ins'],
] as const;

const KIND_LABEL: Record<string, [string, Tone]> = {
  login: ['Signed in', 'green'],
  logout: ['Signed out', 'slate'],
  login_requested: ['Asked for e-mail', 'muted'],
  login_failed: ['Failed sign-in', 'red'],
  blocked: ['Blocked', 'red'],
  action: ['Action', 'blue'],
};

/**
 * Who is online, when everybody last signed in, and what they did in the last
 * seven days. Admins only; entries older than that are deleted by the server.
 */
export default function Log() {
  const [data, setData] = useState<LogData | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('all');
  const [person, setPerson] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const query = new URLSearchParams({ kind, ...(person ? { user_id: person } : {}) });
    api
      .get<LogData>(`/log?${query}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the log'));
  }, [kind, person]);

  if (error) return <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>;
  if (!data) return <Spinner />;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Log</h1>
        <p className="text-sm text-ink-soft">
          Sign-ins and actions of the last {data.keep_days} days - older entries are deleted automatically. Online means active in
          the last {data.online_minutes} minutes.
        </p>
      </div>

      <section className="card">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">People</h2>
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Last seen</th>
                <th className="px-4 py-2 font-medium">Last sign-in</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.people.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">
                    <span className="font-medium">{p.name}</span>{' '}
                    <span className="text-xs text-ink-faint">{p.company || p.role}</span>
                  </td>
                  <td className="px-4 py-2">
                    {!p.active ? (
                      <Badge tone="muted">Disabled</Badge>
                    ) : p.online ? (
                      <Badge tone="green">● Online</Badge>
                    ) : (
                      <span className="text-xs text-ink-faint">Offline</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-soft" title={p.last_seen_at ?? ''}>
                    {p.last_seen_at ? relativeTime(p.last_seen_at) : <span className="text-ink-faint">Never</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-soft">
                    {p.last_login_at ? <Timestamp iso={p.last_login_at} /> : <span className="text-ink-faint">Never</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs text-brand hover:underline"
                      onClick={() => setPerson(person === String(p.id) ? '' : String(p.id))}
                    >
                      {person === String(p.id) ? 'Show everyone' : 'Only this person'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="mr-2 text-sm font-semibold">Activity</h2>
          {KINDS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
              className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                kind === value ? 'border-brand bg-brand-soft text-brand-ink' : 'border-line text-ink-soft hover:bg-raised'
              }`}
            >
              {label}
            </button>
          ))}
          {person && (
            <span className="ml-auto text-xs text-ink-soft">
              {data.people.find((p) => String(p.id) === person)?.name} only ·{' '}
              <button type="button" className="text-brand hover:underline" onClick={() => setPerson('')}>
                show everyone
              </button>
            </span>
          )}
        </div>
        {data.entries.length === 0 ? (
          <Empty>Nothing in the last {data.keep_days} days.</Empty>
        ) : (
          <ol className="divide-y divide-line">
            {data.entries.map((entry) => {
              const [label, tone] = KIND_LABEL[entry.kind] ?? [entry.kind, 'slate'];
              const refused = entry.kind === 'action' && entry.status != null && entry.status >= 400;
              return (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <Timestamp iso={entry.created_at} className="shrink-0 text-xs text-ink-faint tabular-nums sm:w-36" />
                  <span className="shrink-0 sm:w-32">
                    <Badge tone={refused ? 'red' : tone}>{refused ? `Refused (${entry.status})` : label}</Badge>
                  </span>
                  {/* On a phone the sentence gets its own line; squeezed beside the time it broke after every letter. */}
                  <span className="min-w-0 basis-full [overflow-wrap:anywhere] sm:basis-0 sm:flex-1">
                    <span className="font-medium">{entry.user_name ?? 'Someone'}</span>{' '}
                    <span className="text-ink-soft">{entry.detail}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-ink-faint">{entry.ip}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
