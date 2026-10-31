import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Button } from '../components/ui';
import { Logo } from '../components/Logo';

interface Info {
  name: string;
  site: { id: number; domain: string; watching: boolean } | null;
  all_enabled: boolean;
}

/**
 * The page behind "Stop updates" in an update e-mail. It asks for one click
 * rather than acting on being opened: mail filters open every link in a
 * message before the recipient does, and would sign everybody out of their
 * updates without them ever knowing.
 */
export default function Unsubscribe() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('u') ?? '';
  const siteId = Number(params.get('site')) || null;
  const wantsAll = params.get('all') === '1' || !siteId;

  const [info, setInfo] = useState<Info | null>(null);
  const [done, setDone] = useState<'site' | 'all' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams({ u: token, ...(siteId ? { site: String(siteId) } : {}) });
    api
      .get<Info>(`/notifications/unsubscribe?${query}`)
      .then(setInfo)
      .catch((err) => setError(err instanceof Error ? err.message : 'This link does not work'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(scope: 'site' | 'all', resubscribe = false) {
    setBusy(true);
    setError('');
    try {
      await api.post('/notifications/unsubscribe', {
        u: token,
        ...(scope === 'site' && siteId ? { site: siteId } : { all: true }),
        ...(resubscribe ? { resubscribe: true } : {}),
      });
      setDone(resubscribe ? null : scope);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change it');
    } finally {
      setBusy(false);
    }
  }

  const domain = info?.site?.domain;

  return (
    <div className="grid min-h-full place-items-center px-4">
      <div className="card w-full max-w-md space-y-5 p-6 shadow-sm">
        <Logo size="lg" />

        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}

        {info && !done && (
          <div className="space-y-4">
            <p className="text-sm">
              Hi {info.name}, {domain && !wantsAll ? (
                <>
                  stop the update e-mails about <span className="font-semibold">{domain}</span>?
                </>
              ) : (
                <>stop all update e-mails from the Integration Tracker?</>
              )}
            </p>
            <Button variant="danger" className="w-full !py-2.5 text-base" disabled={busy} onClick={() => change(domain && !wantsAll ? 'site' : 'all')}>
              {domain && !wantsAll ? `Stop updates for ${domain}` : 'Stop all update e-mails'}
            </Button>
            {domain && !wantsAll && (
              <button type="button" className="w-full text-center text-xs text-ink-soft hover:text-ink hover:underline" onClick={() => change('all')}>
                Stop all update e-mails instead
              </button>
            )}
          </div>
        )}

        {done && (
          <div className="space-y-3">
            <p className="rounded-lg bg-tone-green-bg px-3 py-2.5 text-sm text-tone-green">
              {done === 'site' ? `Done - no more update e-mails about ${domain}.` : 'Done - no more update e-mails.'}
            </p>
            <p className="text-xs text-ink-soft">
              Sign-in e-mails still arrive when you ask for one.{' '}
              {done === 'site'
                ? 'To follow this site again, switch it back on on its page in the tracker.'
                : 'To get updates again, switch them back on under your name in the tracker.'}
            </p>
            <button type="button" className="text-xs text-brand hover:underline" disabled={busy} onClick={() => change(done, true)}>
              Undo
            </button>
          </div>
        )}

        {!info && !error && <p className="text-sm text-ink-faint">Loading...</p>}
      </div>
    </div>
  );
}
