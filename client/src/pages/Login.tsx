import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Field } from '../components/ui';
import { Logo } from '../components/Logo';

/** The address typed last time, so the next sign-in is one click. Per browser only. */
const REMEMBERED = 'tracker:last-email';
const remembered = () => {
  try {
    return localStorage.getItem(REMEMBERED) ?? '';
  } catch {
    return '';
  }
};

/** Seconds before "send another e-mail" works again, so an impatient double click is not two e-mails. */
const RESEND_AFTER = 30;

type Step = 'email' | 'code' | 'link';

/**
 * Sign-in by e-mail: type the address, get a message with a link and a code.
 *
 * The link lands back here with ?token=, and signs in on a click rather than on
 * opening: mail scanners open every link in a message before the recipient
 * does, and would otherwise spend it.
 */
export default function Login() {
  const { signIn, expired } = useSession();
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') ?? '');
  const [step, setStep] = useState<Step>(token ? 'link' : 'email');
  const [email, setEmail] = useState(remembered);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  useEffect(() => {
    if (step === 'code') codeInput.current?.focus();
  }, [step]);

  /** The token must not stay in the address bar or the history once it has been used or refused. */
  const forgetToken = () => window.history.replaceState(null, '', '/');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const sendEmail = () =>
    run(async () => {
      await api.post('/auth/login/email', { email });
      try {
        localStorage.setItem(REMEMBERED, email.trim().toLowerCase());
      } catch {
        // Private mode: the address is simply not remembered.
      }
      setCode('');
      setStep('code');
      setWait(RESEND_AFTER);
    });

  const submitCode = (value = code) =>
    run(async () => {
      await signIn({ email, code: value });
    });

  const followLink = () =>
    run(async () => {
      try {
        await signIn({ token });
        forgetToken();
      } catch (err) {
        forgetToken();
        setStep('email');
        throw err;
      }
    });

  return (
    <div className="grid min-h-full place-items-center px-4">
      <div className="card w-full max-w-sm space-y-5 p-6 shadow-sm">
        <div className="space-y-3">
          <h1>
            <Logo size="lg" />
          </h1>
          <p className="text-sm text-ink-soft">Site rollout and QA between the publisher and the demand partner.</p>
        </div>

        {expired && !error && step === 'email' && (
          <p className="rounded-lg bg-tone-amber-bg px-3 py-2 text-sm text-tone-amber">
            Your session ended. Sign in again to pick up where you were.
          </p>
        )}

        {step === 'link' && (
          <div className="space-y-4">
            <p className="text-sm">You opened a sign-in link from your e-mail.</p>
            <Button variant="primary" className="w-full" disabled={busy} onClick={followLink} autoFocus>
              {busy ? 'Signing in...' : 'Sign in'}
            </Button>
            <p className="text-xs text-ink-faint">The link works once, within an hour of being sent.</p>
          </div>
        )}

        {step === 'email' && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              sendEmail();
            }}
          >
            <Field label="E-mail address" hint="We send you a link and a code to sign in with. No password needed.">
              <input
                className="field"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? 'Sending...' : 'Send sign-in e-mail'}
            </Button>
          </form>
        )}

        {step === 'code' && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitCode();
            }}
          >
            <div className="rounded-lg bg-brand-soft px-3 py-2.5 text-sm text-brand-ink">
              If <span className="font-medium [overflow-wrap:anywhere]">{email.trim().toLowerCase()}</span> has an account, an
              e-mail is on its way. Click the link in it, or type the code here.
            </div>
            <Field label="Code from the e-mail">
              <input
                ref={codeInput}
                className="field text-center font-mono text-lg tracking-[0.3em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={7}
                required
                value={code}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setCode(digits);
                  // Six digits is the whole code; pasting it should be enough.
                  if (digits.length === 6 && !busy) submitCode(digits);
                }}
              />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={busy || code.length !== 6}>
              {busy ? 'Signing in...' : 'Sign in'}
            </Button>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <button
                type="button"
                className="text-brand hover:underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline"
                disabled={busy || wait > 0}
                onClick={sendEmail}
              >
                {wait > 0 ? `Send another e-mail (${wait}s)` : 'Send another e-mail'}
              </button>
              <button
                type="button"
                className="text-ink-soft hover:text-ink hover:underline"
                onClick={() => {
                  setStep('email');
                  setError('');
                }}
              >
                Use a different address
              </button>
            </div>
            <p className="text-xs text-ink-faint">
              Nothing arrived after a minute? Look in the spam folder. The link signs in the device you open it on - on another
              device, type the code instead.
            </p>
          </form>
        )}

        {error && <p className="rounded-lg bg-tone-red-bg px-3 py-2 text-sm text-tone-red">{error}</p>}
      </div>
    </div>
  );
}
