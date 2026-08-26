import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { User } from './types';
import { DEFAULT_EUR_USD, FX_SETTING_KEY } from '@shared/domain.js';

interface SessionValue {
  user: User | null;
  loading: boolean;
  /** Instance-wide settings; today just the EUR/USD rate used for RPM comparisons. */
  eurUsd: number;
  setEurUsd: (rate: number) => void;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (action: Action) => boolean;
}

/** Capability checks the UI reads from; the API enforces the same rules server-side. */
export type Action = 'edit_site' | 'manage_sites' | 'manage_users' | 'raise_issue' | 'work_issue' | 'verify_issue' | 'import';

const CAPABILITIES: Record<User['role'], Action[]> = {
  admin: ['edit_site', 'manage_sites', 'manage_users', 'raise_issue', 'work_issue', 'verify_issue', 'import'],
  dev: ['edit_site', 'manage_sites', 'raise_issue', 'work_issue', 'import'],
  partner: ['raise_issue', 'verify_issue'],
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [eurUsd, setEurUsd] = useState(DEFAULT_EUR_USD);

  useEffect(() => {
    api
      .get<{ user: User | null }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    api
      .get<{ settings: Record<string, unknown> }>('/settings')
      .then((r) => setEurUsd(Number(r.settings[FX_SETTING_KEY]) || DEFAULT_EUR_USD))
      .catch(() => setEurUsd(DEFAULT_EUR_USD));
  }, [user]);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const { user: next } = await api.post<{ user: User }>('/auth/login', { identifier, password });
    setUser(next);
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  const can = useCallback((action: Action) => (user ? CAPABILITIES[user.role].includes(action) : false), [user]);

  const value = useMemo(
    () => ({ user, loading, eurUsd, setEurUsd, signIn, signOut, can }),
    [user, loading, eurUsd, signIn, signOut, can]
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
