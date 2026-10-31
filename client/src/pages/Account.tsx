import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ROLES } from '@shared/domain.js';
import { Badge, Button, type Tone } from '../components/ui';

const ROLE_TONE: Record<string, Tone> = { admin: 'blue', dev: 'slate', partner: 'purple' };

/** Who you are signed in as. Reachable from your own name in the header. */
export default function Account() {
  const { user } = useSession();
  if (!user) return null;

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <h1 className="text-lg font-semibold">Your account</h1>

      <section className="card p-4">
        <dl className="space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-ink-faint">Name</dt>
            <dd className="font-medium">{user.name}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-ink-faint">Username</dt>
            <dd className="font-mono text-xs">{user.username}</dd>
          </div>
          {user.email && (
            <div className="flex gap-3">
              <dt className="w-28 shrink-0 text-ink-faint">E-mail</dt>
              <dd>{user.email}</dd>
            </div>
          )}
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-ink-faint">Company</dt>
            <dd>{user.company || '-'}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-ink-faint">Role</dt>
            <dd>
              <Badge tone={ROLE_TONE[user.role]}>{ROLES[user.role].label}</Badge>{' '}
              <span className="text-ink-soft">{ROLES[user.role].hint}</span>
            </dd>
          </div>
        </dl>
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-faint">
          Name, e-mail and role are managed by an admin. Ask them if something here is wrong.
        </p>
      </section>

      <UpdatesPanel />

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold">Signing in</h2>
        <p className="text-sm text-ink-soft">
          There is no password. On the sign-in page you enter your e-mail address and get a link and a code, valid for one
          hour. A sign-in lasts seven days on that device, then you ask for a new e-mail.
        </p>
        <p className="mt-2 text-xs text-ink-faint">
          If your address changes, ask an admin to update it here - it is the only way into your account.
        </p>
      </section>
    </div>
  );
}

interface Updates {
  enabled: boolean;
  every_site: boolean;
  watching: { id: number; domain: string; reason: string }[];
  muted: { id: number; domain: string }[];
}

const REASON: Record<string, string> = {
  active: 'you worked on it',
  responsible: 'you are responsible',
  assigned: 'work assigned to you',
  chosen: 'you switched it on',
};

/** Your update e-mails: on or off altogether, and which sites they cover. */
function UpdatesPanel() {
  const [data, setData] = useState<Updates | null>(null);
  const [error, setError] = useState('');

  const load = () =>
    api
      .get<Updates>('/notifications/me')
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load'));
  useEffect(() => {
    load();
  }, []);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change it');
    }
  }

  if (!data) return null;
  return (
    <section className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Update e-mails</h2>
        <Badge tone={data.enabled ? 'green' : 'muted'}>{data.enabled ? 'On' : 'Off'}</Badge>
        <Button size="sm" className="ml-auto" onClick={() => run(() => api.patch('/notifications/me', { enabled: !data.enabled }))}>
          {data.enabled ? 'Turn all off' : 'Turn on'}
        </Button>
      </div>
      <p className="text-sm text-ink-soft">
        {data.every_site
          ? 'You get an e-mail when something changes on any site - a few minutes of changes at a time, never your own.'
          : 'You get an e-mail when something changes on a site you worked on, are responsible for or have work assigned on - a few minutes of changes at a time, never your own.'}{' '}
        Every e-mail has a link to stop it for that site.
      </p>
      {error && <p className="mt-2 rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

      {data.enabled && !data.every_site && (
        <ul className="mt-3 divide-y divide-line text-sm">
          {data.watching.length === 0 && <li className="py-1.5 text-ink-faint">No sites yet.</li>}
          {data.watching.map((site) => (
            <li key={site.id} className="flex items-center gap-2 py-1.5">
              <Link to={`/sites/${site.id}`} className="font-medium hover:text-brand hover:underline">{site.domain}</Link>
              <span className="text-xs text-ink-faint">{REASON[site.reason] ?? ''}</span>
              <button
                type="button"
                className="ml-auto text-xs text-ink-soft hover:text-tone-red hover:underline"
                onClick={() => run(() => api.put(`/notifications/sites/${site.id}`, { watching: false }))}
              >
                Stop
              </button>
            </li>
          ))}
        </ul>
      )}

      {data.enabled && data.muted.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-medium text-ink-faint">Stopped for</h3>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {data.muted.map((site) => (
              <li key={site.id}>
                <button
                  type="button"
                  title="Get updates about this site again"
                  className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-soft hover:border-brand hover:text-brand"
                  onClick={() => run(() => api.put(`/notifications/sites/${site.id}`, { watching: true }))}
                >
                  {site.domain} · turn back on
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
