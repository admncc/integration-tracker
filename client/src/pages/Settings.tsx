import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { User } from '../lib/types';
import { DEFAULT_EUR_USD, FX_SETTING_KEY, ROLES } from '@shared/domain.js';
import { Badge, Button, Empty, Field, Modal, formatDateTime } from '../components/ui';

const ROLE_ENTRIES = Object.entries(ROLES) as [User['role'], { label: string; hint: string }][];

interface FxSettings {
  fx_eur_usd: number;
  updated_at: string | null;
  rate_date: string | null;
  source: 'ecb' | 'manual' | 'default';
  auto: boolean;
  last_error: string | null;
}

export default function Settings() {
  const { user } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.get<{ users: User[] }>('/users').then((r) => setUsers(r.users));
  }, []);

  async function toggleActive(target: User) {
    try {
      const { user: saved } = await api.patch<{ user: User }>(`/users/${target.id}`, { active: target.active ? false : true });
      setUsers((current) => current.map((u) => (u.id === saved.id ? saved : u)));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not update the user');
    }
  }

  async function changeRole(target: User, role: User['role']) {
    try {
      const { user: saved } = await api.patch<{ user: User }>(`/users/${target.id}`, { role });
      setUsers((current) => current.map((u) => (u.id === saved.id ? saved : u)));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not change the role');
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      {notice && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{notice}</p>}

      <section className="card">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">People</h2>
            <p className="text-xs text-ink-soft">
              Create an account for each developer and for the partner's QA contacts.
            </p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            + New user
          </Button>
        </header>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-soft">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Username</th>
              <th className="px-4 py-2 font-medium">Company</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-medium">
                  {row.name}
                  {row.id === user?.id && <span className="ml-2 text-xs text-ink-faint">you</span>}
                </td>
                <td className="px-4 py-2 font-mono text-xs">{row.username}</td>
                <td className="px-4 py-2 text-ink-soft">{row.company || '-'}</td>
                <td className="px-4 py-2">
                  <select className="field !w-auto !py-1 text-xs" value={row.role} onChange={(event) => changeRole(row, event.target.value as User['role'])}>
                    {ROLE_ENTRIES.map(([value, meta]) => (
                      <option key={value} value={value}>{meta.label}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">
                  <Badge tone={row.active ? 'green' : 'muted'}>{row.active ? 'Active' : 'Disabled'}</Badge>
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                    <Button size="sm" onClick={() => setResetting(row)}>Set password</Button>{' '}
                  <Button size="sm" variant={row.active ? 'danger' : 'secondary'} onClick={() => toggleActive(row)}>
                    {row.active ? 'Disable' : 'Enable'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {users.length === 0 && <Empty>No users yet.</Empty>}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ExchangeRatePanel />
        <ImportPanel />
      </div>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Roles</h2>
        <dl className="mt-2 space-y-2 text-sm">
          {ROLE_ENTRIES.map(([value, meta]) => (
            <div key={value} className="flex gap-3">
              <dt className="w-32 shrink-0 font-medium">{meta.label}</dt>
              <dd className="text-ink-soft">{meta.hint}</dd>
            </div>
          ))}
        </dl>
      </section>

      {creating && (
        <NewUserModal
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setUsers((current) => [...current, created]);
            setCreating(false);
          }}
        />
      )}

      {resetting && <ResetPasswordModal target={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (user: User) => void }) {
  const [form, setForm] = useState({ username: '', name: '', email: '', password: '', role: 'dev' as User['role'], company: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api.post<{ user: User }>('/users', form);
      onCreated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the user');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username" hint="Lower case, used to sign in.">
            <input
              className="field"
              required
              minLength={2}
              pattern="[a-zA-Z0-9._\-]+"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label="Full name">
            <input className="field" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
        </div>

        <Field label="Password" hint="At least 8 characters. Share it with the person directly.">
          <input className="field" type="text" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <select className="field" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as User['role'] })}>
              {ROLE_ENTRIES.map(([value, meta]) => (
                <option key={value} value={value}>{meta.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Company">
            <input className="field" placeholder="Primis" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </Field>
        </div>

        <Field label="E-mail (optional)" hint="Only for reference - sign-in works with the username.">
          <input className="field" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>

        <p className="rounded-lg bg-raised px-3 py-2 text-xs text-ink-soft">{ROLES[form.role].hint}</p>
        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Creating...' : 'Create user'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ target, onClose }: { target: User; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [state, setState] = useState<{ error?: string; done?: boolean }>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.patch(`/users/${target.id}`, { password });
      setState({ done: true });
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : 'Could not set the password' });
    }
  }

  return (
    <Modal title={`Set a password for ${target.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="New password" hint="At least 8 characters.">
          <input className="field" type="text" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {state.error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{state.error}</p>}
        {state.done && <p className="rounded-lg bg-tone-green-bg px-3 py-2 text-sm text-tone-green">Password updated.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Close</Button>
          <Button type="submit" variant="primary">Set password</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The two RPM figures come in from two different providers in two currencies,
 * so every comparison in the tool is normalised through this one rate.
 */
function ExchangeRatePanel() {
  const { setEurUsd } = useSession();
  const [settings, setSettings] = useState<FxSettings | null>(null);
  const [rate, setRate] = useState('');
  const [state, setState] = useState<{ error?: string; done?: string }>({});
  const [busy, setBusy] = useState(false);

  const apply = (next: FxSettings) => {
    setSettings(next);
    setRate(String(next[FX_SETTING_KEY]));
    setEurUsd(Number(next[FX_SETTING_KEY]) || DEFAULT_EUR_USD);
  };

  useEffect(() => {
    api.get<{ settings: FxSettings }>('/settings').then((r) => apply(r.settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(body: Record<string, unknown>, done: string) {
    setState({});
    setBusy(true);
    try {
      const { settings: next } = await api.patch<{ settings: FxSettings }>('/settings', body);
      apply(next);
      setState({ done });
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  async function refreshNow() {
    setState({});
    setBusy(true);
    try {
      const { settings: next } = await api.post<{ settings: FxSettings }>('/settings/fx/refresh');
      apply(next);
      setState({ done: `Pulled ${next[FX_SETTING_KEY]} from the ECB` });
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : 'Could not reach the ECB' });
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <section className="card p-4"><h2 className="text-sm font-semibold">EUR / USD rate</h2></section>;

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">EUR / USD rate</h2>
      <p className="mb-3 text-xs text-ink-soft">
        Previous Session RPM and Primis Session RPM are entered in whichever currency the provider reports. Everything
        comparable - the Δ column, the dashboard averages - is converted to EUR with this rate.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          save({ [FX_SETTING_KEY]: Number(rate.replace(',', '.')) }, 'Rate saved');
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <Field label="1 EUR equals ... USD">
          <input
            className="field !w-32 tabular-nums"
            type="number"
            step="0.0001"
            min="0.0001"
            required
            value={rate}
            onChange={(event) => setRate(event.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy}>Save manually</Button>
        <Button type="button" variant="primary" onClick={refreshNow} disabled={busy}>
          {busy ? 'Fetching...' : 'Fetch from ECB now'}
        </Button>
      </form>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.auto}
          disabled={busy}
          onChange={(event) => save({ fx_auto: event.target.checked }, event.target.checked ? 'Daily updates on' : 'Daily updates off')}
        />
        Pull the official ECB reference rate automatically (on start-up and every 12 hours)
      </label>

      <dl className="mt-3 space-y-0.5 text-xs text-ink-faint">
        <div>
          Source:{' '}
          <span className="text-ink-soft">
            {settings.source === 'ecb'
              ? `European Central Bank${settings.rate_date ? `, reference date ${settings.rate_date}` : ''}`
              : settings.source === 'manual'
                ? 'Entered by hand'
                : 'Built-in fallback - not pulled yet'}
          </span>
        </div>
        {settings.updated_at && (
          <div>
            Last updated: <span className="text-ink-soft">{formatDateTime(settings.updated_at)}</span>
          </div>
        )}
        {settings.last_error && <div className="text-tone-amber">Last pull failed: {settings.last_error}</div>}
      </dl>

      {state.done && <p className="mt-2 text-sm text-tone-green">{state.done}</p>}
      {state.error && <p className="mt-2 text-sm text-tone-red">{state.error}</p>}
    </section>
  );
}

function ImportPanel() {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ created: string[]; updated: string[]; skipped: string[]; dry_run?: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      setResult(await api.post('/import', { csv, dry_run: dryRun }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">Import from the Google Sheet</h2>
      <p className="mb-3 text-xs text-ink-soft">
        In Sheets: File → Download → CSV, then paste the contents here. Rows are matched by domain, so re-importing updates
        existing sites instead of duplicating them. Status wording from the sheet ("1 - LIVE", "4 - Tags prep") is recognised.
      </p>
      <textarea className="field min-h-32 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="PRIO,Domain,STATUS (video),..." />
      <div className="mt-2 flex gap-2">
        <Button onClick={() => run(true)} disabled={!csv.trim() || busy}>Preview</Button>
        <Button variant="primary" onClick={() => run(false)} disabled={!csv.trim() || busy}>Import</Button>
        <a href="/api/export.csv" className="ml-auto self-center text-xs text-ink-soft hover:text-brand">Export current data ↗</a>
      </div>

      {error && <p className="mt-2 text-sm text-tone-red">{error}</p>}
      {result && (
        <div className="mt-3 space-y-1 rounded-lg bg-raised p-3 text-xs">
          <p className="font-medium">{result.dry_run ? 'Preview - nothing written yet' : 'Import finished'}</p>
          <p className="text-tone-green">{result.created.length} new: {result.created.join(', ') || '-'}</p>
          <p className="text-ink-soft">{result.updated.length} updated</p>
          {result.skipped.length > 0 && <p className="text-tone-amber">{result.skipped.length} row(s) skipped - no usable domain</p>}
        </div>
      )}
    </section>
  );
}
