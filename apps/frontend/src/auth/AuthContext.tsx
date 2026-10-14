import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthUser, LoginRequest } from '@ugn/contracts';
import { api, ApiError, setUnauthorizedHandler } from '../lib/api';

type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: AuthUser };

interface AuthContextValue {
  state: AuthState;
  /** Starts the session check; called by useAuth, so only admin screens ever make it. */
  requestCheck(): void;
  login(body: LoginRequest): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The session lives in an httpOnly cookie the page can't read, so /auth/me is how we learn who we
 * are. The check waits until an admin screen asks for it: public viewers have no session, and every
 * page view would otherwise send a request that 401s.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [checkRequested, setCheckRequested] = useState(false);

  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous' }));
  }, []);

  useEffect(() => {
    if (!checkRequested) return;
    api
      .me()
      .then((user) => setState({ status: 'authenticated', user }))
      .catch((err) => {
        // A network error isn't "logged out", but there's nothing useful to show either way.
        if (!(err instanceof ApiError) || err.status === 401 || err.isNetworkError) setState({ status: 'anonymous' });
      });
  }, [checkRequested]);

  const requestCheck = useCallback(() => setCheckRequested(true), []);

  const login = useCallback(async (body: LoginRequest) => {
    const user = await api.login(body);
    setState({ status: 'authenticated', user });
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, requestCheck, login, logout }), [state, requestCheck, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  const { requestCheck } = ctx;
  useEffect(() => requestCheck(), [requestCheck]);
  return ctx;
}
