import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from './api';
import type { User } from './types';
import { DEFAULT_EUR_USD, FX_SETTING_KEY } from '@shared/domain.js';

interface SessionValue {
  user: User | null;
  loading: boolean;
  /** Instance-wide settings; today just the EUR/USD rate used for RPM comparisons. */
  eurUsd: number;
  setEurUsd: (rate: number) => void;
  /** Redeems a sign-in e-mail: its code (with the address) or its link token. */
  signIn: (proof: { email: string; code: string } | { token: string }) => Promise<void>;
  /** Set when a request came back 401 mid-visit, so the form can explain itself. */
  expired: boolean;
  signOut: () => Promise<void>;
  can: (action: Action) => boolean;
}

/** Capability checks the UI reads from; the API enforces the same rules server-side. */
export type Action = 'edit_site' | 'manage_sites' | 'delete_site' | 'manage_users' | 'raise_issue' | 'work_issue' | 'verify_issue' | 'import';

const CAPABILITIES: Record<User['role'], Action[]> = {
  admin: ['edit_site', 'manage_sites', 'delete_site', 'manage_users', 'raise_issue', 'work_issue', 'verify_issue', 'import'],
  dev: ['edit_site', 'manage_sites', 'raise_issue', 'work_issue'],
  // The partner edits the sites table like anybody else; only archiving and
  // deleting a domain stay with the publisher. See the note in routes/sites.js.
  partner: ['edit_site', 'raise_issue', 'verify_issue'],
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [eurUsd, setEurUsd] = useState(DEFAULT_EUR_USD);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    api
      .get<{ user: User | null }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onSignedOut = () => {
      setUser((current) => {
        if (current) setExpired(true);
        return null;
      });
    };
    window.addEventListener('tracker:signed-out', onSignedOut);
    return () => window.removeEventListener('tracker:signed-out', onSignedOut);
  }, []);

  /*
   * Refetched on every navigation, not once per sign-in: a rate changed in
   * Settings used to leave every delta on an open Sites list reading the old
   * number until a full browser reload.
   */
  const location = useLocation();
  useEffect(() => {
    if (!user) return;
    api
      .get<{ settings: Record<string, unknown> }>('/settings')
      .then((r) => setEurUsd(Number(r.settings[FX_SETTING_KEY]) || DEFAULT_EUR_USD))
      .catch(() => setEurUsd(DEFAULT_EUR_USD));
  }, [user, location.pathname]);

  const signIn = useCallback(async (proof: { email: string; code: string } | { token: string }) => {
    setExpired(false);
    await api.post<{ user: User }>('token' in proof ? '/auth/login/link' : '/auth/login/code', proof);

    /*
     * The code was right, but that only means the server issued a cookie -
     * the browser may still have refused to keep it. Confirm the session actually
     * exists before showing the app, otherwise every page loads empty with no
     * explanation of why.
     */
    const { user: confirmed } = await api.get<{ user: User | null }>('/auth/me');
    if (!confirmed) {
      throw new Error(
        'Signed in, but your browser did not keep the session cookie. This happens when the tracker is served over plain HTTP - use HTTPS, or set INSECURE_COOKIES=1 on the server for testing.'
      );
    }
    setUser(confirmed);
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  const can = useCallback((action: Action) => (user ? CAPABILITIES[user.role].includes(action) : false), [user]);

  const value = useMemo(
    () => ({ user, loading, expired, eurUsd, setEurUsd, signIn, signOut, can }),
    [user, loading, expired, eurUsd, signIn, signOut, can]
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
