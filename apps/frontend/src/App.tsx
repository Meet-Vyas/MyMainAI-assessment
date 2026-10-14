import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { WatchPage } from './pages/WatchPage';
import { UploadsProvider } from './upload/UploadsContext';

// Admin screens are split out, so a viewer opening a shared link doesn't download the uploader,
// forms and validation code. The public pages load eagerly: they're what most visitors open first.
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));

function PageLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status">
      <Loader2 className="size-8 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
        {/* Both providers sit above the routes so an upload keeps running while the admin
            browses the public pages. Neither does any work until an admin screen uses it. */}
        <AuthProvider>
          <UploadsProvider>
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/videos/:id" element={<WatchPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route
                  path="/admin"
                  element={
                    <RequireAuth>
                      <AdminPage />
                    </RequireAuth>
                  }
                />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </UploadsProvider>
        </AuthProvider>
    </BrowserRouter>
  );
}
