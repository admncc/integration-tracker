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
  const [editing, setEditing] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [notice, setNotice] = useState('');
  /** What the dropdown shows while a change is pending or has been declined. */
  const [roleDraft, setRoleDraft] = useState<Record<number, User['role']>>({});

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
    /*
     * A confirmation, because this dropdown is one arrow key away from handing
     * an internal account to the external partner's role - and a plain <select>
     * commits on every arrow key in Chromium, which is exactly why InlineSelect
     * defers a keyboard change elsewhere in the app.
     */
    if (role === target.role) return;
    const label = ROLE_ENTRIES.find(([value]) => value === role)?.[1].label ?? role;
    const self = target.id === user?.id ? ' This is your own account.' : '';
    if (!window.confirm(`Make ${target.name} a ${label}?${self}`)) {
      setRoleDraft((current) => ({ ...current, [target.id]: target.role }));
      return;
    }

    try {
      const { user: saved } = await api.patch<{ user: User }>(`/users/${target.id}`, { role });
      setUsers((current) => current.map((u) => (u.id === saved.id ? saved : u)));
      setRoleDraft((current) => ({ ...current, [saved.id]: saved.role }));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not change the role');
      setRoleDraft((current) => ({ ...current, [target.id]: target.role }));
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      {notice && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{notice}</p>}

      <section className="card">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
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

        {/* Seven columns do not fit a phone; the table scrolls inside its card instead of the page. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">E-mail</th>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Last sign-in</th>
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
                  <td className="px-4 py-2 text-ink-soft">
                    {/* The address is the only way in now; one nobody can receive mail at is worth flagging. */}
                    {row.email && !/\.test$/i.test(row.email) ? (
                      <span className="[overflow-wrap:anywhere]">{row.email}</span>
                    ) : (
                      <Badge tone="amber">{row.email ? `${row.email} - placeholder` : 'No e-mail'} · cannot sign in</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-soft">{row.company || '-'}</td>
                  <td className="px-4 py-2">
                    <select
                      className="field !w-auto !py-1 text-xs"
                      value={roleDraft[row.id] ?? row.role}
                      onChange={(event) => {
                        const next = event.target.value as User['role'];
                        setRoleDraft((current) => ({ ...current, [row.id]: next }));
                        changeRole(row, next);
                      }}
                    >
                      {ROLE_ENTRIES.map(([value, meta]) => (
                        <option key={value} value={value}>{meta.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-xs text-ink-soft whitespace-nowrap">
                    {row.last_login_at ? formatDateTime(row.last_login_at) : <span className="text-ink-faint">Never</span>}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={row.active ? 'green' : 'muted'}>{row.active ? 'Active' : 'Disabled'}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <Button size="sm" onClick={() => setEditing(row)}>Edit</Button>{' '}
                    <Button size="sm" variant={row.active ? 'danger' : 'secondary'} onClick={() => toggleActive(row)}>
                      {row.active ? 'Disable' : 'Enable'}
                    </Button>
                    {/* Only a disabled account, never your own: deleting is a second, deliberate step. */}
                    {!row.active && row.id !== user?.id && (
                      <>
                        {' '}
                        <Button size="sm" variant="danger" onClick={() => setDeleting(row)}>
                          Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {users.length === 0 && <Empty>No users yet.</Empty>}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ExchangeRatePanel />
        <ImportPanel />
      </div>

      <MailPanel />

      <BlocksPanel />

      <DigestPanel />

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

      {deleting && (
        <DeleteUserModal
          target={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(id) => {
            setUsers((current) => current.filter((u) => u.id !== id));
            setDeleting(null);
          }}
        />
      )}

      {editing && (
        <EditUserModal
          target={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setUsers((current) => current.map((u) => (u.id === saved.id ? saved : u)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (user: User) => void }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'partner' as User['role'], company: '' });
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
        <Field label="Full name">
          <input className="field" required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="E-mail" hint="What they sign in with: they enter it on the sign-in page and get a link and a code.">
          <input className="field" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
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

interface Usage {
  issues_raised: number;
  issues_assigned: number;
  comments: number;
  messages: number;
  sites_responsible: number;
  history_entries: number;
}

/**
 * Deleting a disabled account for good. It says first what the person is
 * attached to, and wants their name typed - the same weight as deleting a site.
 */
function DeleteUserModal({ target, onClose, onDeleted }: { target: User; onClose: () => void; onDeleted: (id: number) => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .post<{ usage: Usage }>(`/users/${target.id}/delete`, { dry_run: true })
      .then((r) => setUsage(r.usage))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not check the account'));
  }, [target.id]);

  const confirmed = typed.trim() === target.name.trim();

  async function remove() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/users/${target.id}/delete`, {});
      onDeleted(target.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the account');
      setBusy(false);
    }
  }

  const lines = usage
    ? ([
        [usage.issues_raised, 'issue(s) raised - they stay, without a name'],
        [usage.comments, 'comment(s) - they stay, without a name'],
        [usage.messages, 'discussion message(s) - they stay, without a name'],
        [usage.history_entries, 'history entries - they stay, without a name'],
        [usage.sites_responsible, 'site(s) they are responsible for - back to nobody'],
        [usage.issues_assigned, 'open issue(s) assigned to them - become unassigned'],
      ] as [number, string][]).filter(([n]) => n > 0)
    : [];

  return (
    <Modal title={`Delete ${target.name}?`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">
          This deletes the account of <span className="font-medium text-ink">{target.name}</span>
          {target.email ? ` (${target.email})` : ''} for good. It cannot be undone - a disabled account can simply stay
          disabled instead.
        </p>
        {usage &&
          (lines.length ? (
            <ul className="space-y-0.5 rounded-lg bg-raised px-3 py-2 text-xs text-ink-soft">
              {lines.map(([n, text]) => (
                <li key={text}>
                  <span className="font-semibold text-ink tabular-nums">{n}</span> {text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg bg-raised px-3 py-2 text-xs text-ink-soft">The account has nothing attached to it.</p>
          ))}
        <label className="block">
          <span className="text-xs text-ink-soft">
            Type <span className="font-medium text-ink">{target.name}</span> to confirm
          </span>
          <input className="field mt-1" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-tone-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!usage || !confirmed || busy} onClick={remove}>
            {busy ? 'Deleting...' : 'Delete account for good'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Name, address and company. Role and enabling have their own controls in the row. */
function EditUserModal({ target, onClose, onSaved }: { target: User; onClose: () => void; onSaved: (user: User) => void }) {
  const [form, setForm] = useState({ name: target.name, email: target.email ?? '', company: target.company });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const addressChanged = form.email.trim().toLowerCase() !== String(target.email ?? '').toLowerCase();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api.patch<{ user: User }>(`/users/${target.id}`, form);
      onSaved(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit ${target.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Full name">
          <input className="field" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="E-mail" hint="What they sign in with.">
          <input className="field" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Company">
          <input className="field" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
        </Field>
        {addressChanged && (
          <p className="rounded-lg bg-tone-amber-bg px-3 py-2 text-xs text-tone-amber">
            A new address signs {target.name} out everywhere; they sign in again with the new one.
          </p>
        )}
        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

interface Block {
  ip: string;
  blocked_at: string;
  until: string;
  failures: number;
}

/**
 * Connections locked out of signing in after repeated failures. A whole office
 * behind one address shares the count, so this is where a colleague who mistyped
 * a code three times gets let back in.
 */
function BlocksPanel() {
  const [data, setData] = useState<{ blocks: Block[]; max_failures: number; block_hours: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<{ blocks: Block[]; max_failures: number; block_hours: number }>('/settings/blocks').then(setData).catch(() => setData(null));
  }, []);

  async function lift(ip: string) {
    if (!window.confirm(`Let ${ip === 'all' ? 'every blocked connection' : ip} sign in again?`)) return;
    setError('');
    try {
      const r = await api.post<{ blocks: Block[] }>('/settings/blocks/unblock', { ip });
      setData((current) => (current ? { ...current, blocks: r.blocks } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not lift the block');
    }
  }

  if (!data) return null;
  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Blocked connections</h2>
        {data.blocks.length > 1 && (
          <Button size="sm" className="ml-auto" onClick={() => lift('all')}>
            Lift all
          </Button>
        )}
      </div>
      <p className="mt-1 mb-3 max-w-3xl text-xs text-ink-soft">
        {data.max_failures} failed sign-ins - a wrong code, or a link that was never sent - lock that connection out for{' '}
        {data.block_hours} hours. Everybody behind the same address, a whole office for instance, is locked out with it.
      </p>
      {error && <p className="mb-2 rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}
      {data.blocks.length === 0 ? (
        <p className="text-sm text-ink-faint">None right now.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {data.blocks.map((block) => (
            <li key={block.ip} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="font-mono text-xs">{block.ip}</span>
              <span className="text-xs text-ink-soft">
                {block.failures} failures · blocked {formatDateTime(block.blocked_at)} · until {formatDateTime(block.until)}
              </span>
              <Button size="sm" className="ml-auto" onClick={() => lift(block.ip)}>
                Lift
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface MailStatus {
  configured: boolean;
  host: string;
  port: number;
  from: string;
  public_url: string;
}

/**
 * Sign-in depends on e-mail arriving, so whether it does is worth a button.
 * The setup itself lives in .env on the server (docs/deploy.md).
 */
function MailPanel() {
  const { user } = useSession();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [state, setState] = useState<{ error?: string; done?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<MailStatus>('/settings/mail').then(setStatus).catch(() => setStatus(null));
  }, []);

  async function test() {
    setBusy(true);
    setState({});
    try {
      const sent = await api.post<{ to: string }>('/settings/mail/test');
      setState({ done: `Sent to ${sent.to}. If it does not arrive within a minute, look in spam, then at the server log.` });
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : 'Sending failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">Sign-in e-mails</h2>
      <p className="mt-1 mb-3 max-w-3xl text-xs text-ink-soft">
        Everybody signs in with a link and a code sent to their address. The mail server is set in <code>.env</code> on the
        server - see docs/deploy.md.
      </p>
      {status && (
        <dl className="mb-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-ink-faint">Sending</dt>
          <dd>
            {status.configured ? (
              <Badge tone="green">Set up</Badge>
            ) : (
              <Badge tone="red">Not set up - nobody can sign in</Badge>
            )}{' '}
            {status.configured && (
              <span className="text-ink-soft">
                via {status.host}:{status.port} as {status.from}
              </span>
            )}
          </dd>
          <dt className="text-ink-faint">Links point to</dt>
          <dd className="[overflow-wrap:anywhere]">
            {status.public_url || <span className="text-tone-amber">nowhere yet - set PUBLIC_URL; until then the e-mail carries only the code</span>}
          </dd>
        </dl>
      )}
      <Button onClick={test} disabled={busy || !status?.configured}>
        {busy ? 'Sending...' : `Send a test e-mail to ${user?.email ?? 'me'}`}
      </Button>
      {state.done && <p className="mt-3 rounded-lg bg-tone-green-bg px-3 py-2 text-sm text-tone-green">{state.done}</p>}
      {state.error && <p className="mt-3 rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{state.error}</p>}
    </section>
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

interface DigestSettings {
  url: string;
  hour: number;
  public_url: string;
  last_sent_at: string | null;
  last_error: string | null;
  last_status: string | null;
}

interface DigestPreview {
  quiet: boolean;
  payload: { text: string };
}

/**
 * A daily summary posted into Slack or Teams.
 *
 * Without something that reaches people where they already are, each side has
 * to remember to open the tracker to find out it is their turn - and the mail
 * thread survives as the notification layer, which is what this tool exists to
 * replace. One webhook needs no SMTP, no address list and no per-person
 * settings.
 */
function DigestPanel() {
  const [digest, setDigest] = useState<DigestSettings | null>(null);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [url, setUrl] = useState('');
  const [hour, setHour] = useState('8');
  const [publicUrl, setPublicUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'red' | 'green'; text: string } | null>(null);

  useEffect(() => {
    api
      .get<{ digest: DigestSettings | null }>('/settings')
      .then((r) => {
        if (!r.digest) return;
        setDigest(r.digest);
        setUrl(r.digest.url);
        setHour(String(r.digest.hour));
        setPublicUrl(r.digest.public_url);
      })
      .catch(() => {});
    api.get<DigestPreview>('/settings/digest/preview').then(setPreview).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const body = { digest_webhook_url: url.trim(), digest_hour: Number(hour), public_url: publicUrl.trim() };
      const r = await api.patch<{ digest: DigestSettings }>('/settings', body);
      setDigest(r.digest);
      setNotice({ tone: 'green', text: url.trim() ? 'Saved. The next digest goes out at the hour you chose.' : 'Saved. The daily digest is off.' });
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.post<{ digest: DigestSettings }>('/settings/digest/test');
      setDigest(r.digest);
      setNotice({ tone: 'green', text: 'Sent. Check the channel.' });
    } catch (err) {
      setNotice({ tone: 'red', text: err instanceof Error ? err.message : 'Could not send' });
    } finally {
      setBusy(false);
    }
  }

  if (!digest) return null;

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">Daily digest</h2>
      <p className="mt-1 mb-3 max-w-3xl text-xs text-ink-soft">
        Posts one summary a day into a Slack or Teams channel: what was raised, handed back and verified, what is waiting
        on whom, and what is blocked. A quiet day sends nothing. Leave the URL empty to switch it off.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Field label="Incoming webhook URL" hint="Slack: Apps → Incoming Webhooks. Teams: channel → Connectors → Incoming Webhook.">
          <input
            className="field"
            type="url"
            placeholder="https://hooks.slack.com/services/..."
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field label="Send at">
          <select className="field !w-auto" value={hour} onChange={(event) => setHour(event.target.value)}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tracker address" hint="Optional. Makes the counts in the message clickable.">
          <input
            className="field"
            type="url"
            placeholder="https://tracker.example.com"
            value={publicUrl}
            onChange={(event) => setPublicUrl(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving...' : 'Save'}
        </Button>
        <Button onClick={sendNow} disabled={busy || !digest.url}>
          Send one now
        </Button>
        {digest.last_sent_at && (
          <span className="text-xs text-ink-faint">
            Last attempt {formatDateTime(digest.last_sent_at)} - {digest.last_status ?? 'unknown'}
          </span>
        )}
      </div>

      {digest.last_error && <p className="mt-2 text-xs text-tone-red">Last error: {digest.last_error}</p>}
      {notice && (
        <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${notice.tone === 'red' ? 'bg-tone-red-bg text-tone-red' : 'bg-tone-green-bg text-tone-green'}`}>
          {notice.text}
        </p>
      )}

      {preview && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-ink-soft hover:text-ink">
            What today's message would say{preview.quiet ? ' (a quiet day - nothing would be sent)' : ''}
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-raised p-3 text-xs whitespace-pre-wrap text-ink-soft">
            {preview.payload.text}
          </pre>
        </details>
      )}
    </section>
  );
}
