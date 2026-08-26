import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ROLES } from '@shared/domain.js';
import { Badge, Button, Field, type Tone } from '../components/ui';

const ROLE_TONE: Record<string, Tone> = { admin: 'blue', dev: 'slate', partner: 'purple' };

/**
 * Everyone needs to be able to change their own password. Settings is admin
 * only, so that one control lives here instead, reachable from your own name
 * in the header.
 */
export default function Account() {
  const { user } = useSession();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [state, setState] = useState<{ error?: string; done?: boolean }>({});
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState({});

    if (form.next !== form.confirm) {
      setState({ error: 'The two new passwords do not match' });
      return;
    }

    setBusy(true);
    try {
      await api.post('/auth/password', { current: form.current, next: form.next });
      setState({ done: true });
      setForm({ current: '', next: '', confirm: '' });
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : 'Could not change the password' });
    } finally {
      setBusy(false);
    }
  }

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
          Name, username and role are managed by an admin. Ask them if something here is wrong.
        </p>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Change your password</h2>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Current password">
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              required
              value={form.current}
              onChange={(e) => setForm({ ...form, current: e.target.value })}
            />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input
              className="field"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={form.next}
              onChange={(e) => setForm({ ...form, next: e.target.value })}
            />
          </Field>
          <Field label="Repeat the new password">
            <input
              className="field"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            />
          </Field>

          {state.error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{state.error}</p>}
          {state.done && <p className="rounded-lg bg-tone-green-bg px-3 py-2 text-sm text-tone-green">Password changed.</p>}

          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Changing...' : 'Change password'}
          </Button>
        </form>
      </section>
    </div>
  );
}
