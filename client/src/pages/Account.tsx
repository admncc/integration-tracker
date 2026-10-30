import { useSession } from '../lib/session';
import { ROLES } from '@shared/domain.js';
import { Badge, type Tone } from '../components/ui';

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
