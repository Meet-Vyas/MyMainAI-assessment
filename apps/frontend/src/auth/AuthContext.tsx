import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthUser, LoginRequest } from '@ugn/contracts';
import { api, ApiError, setUnauthorizedHandler } from '../lib/api';

type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: AuthUser };

interface AuthContextValue {
  state: AuthState;
  login(body: LoginRequest): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** The session lives in an httpOnly cookie the page can't read, so /auth/me is how we learn who we are. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous' }));
    api
      .me()
      .then((user) => setState({ status: 'authenticated', user }))
      .catch((err) => {
        // A network error isn't "logged out", but there's nothing useful to show either way.
        if (!(err instanceof ApiError) || err.status === 401 || err.isNetworkError) setState({ status: 'anonymous' });
      });
  }, []);

  const login = useCallback(async (body: LoginRequest) => {
    const user = await api.login(body);
    setState({ status: 'authenticated', user });
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, login, logout }), [state, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
