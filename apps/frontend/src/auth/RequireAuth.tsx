import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './AuthContext';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status">
        <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
        <span className="sr-only">Checking your session…</span>
      </div>
    );
  }
  if (state.status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
