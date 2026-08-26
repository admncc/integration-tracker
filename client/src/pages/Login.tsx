import { useState } from 'react';
import { useSession } from '../lib/session';
import { Button, Field } from '../components/ui';

export default function Login() {
  const { signIn, expired } = useSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await signIn(identifier, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6 shadow-sm">
        <div className="space-y-1">
          <div className="grid size-8 place-items-center rounded-lg bg-brand text-sm font-semibold text-white">IT</div>
          <h1 className="pt-2 text-lg font-semibold">Integration Tracker</h1>
          <p className="text-sm text-ink-soft">Site rollout and QA between the publisher and the demand partner.</p>
        </div>

        <Field label="Username" hint="Your e-mail address works too.">
          <input className="field" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
        </Field>
        <Field label="Password">
          <input className="field" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>

        {expired && !error && (
          <p className="rounded-lg bg-tone-amber-bg px-3 py-2 text-sm text-tone-amber">
            Your session ended. Sign in again to pick up where you were.
          </p>
        )}
        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
