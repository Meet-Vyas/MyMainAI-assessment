import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import { AuthProvider } from './auth/AuthContext';
import { RequireAuth } from './auth/RequireAuth';
import { AdminPage } from './pages/AdminPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { UploadsProvider } from './upload/UploadsContext';

export function App() {
  return (
    // Honour the OS "reduce motion" setting for every Framer Motion animation.
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        <AuthProvider>
          <UploadsProvider>
            <Routes>
              <Route path="/" element={<HomePage />} />
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
          </UploadsProvider>
        </AuthProvider>
      </BrowserRouter>
    </MotionConfig>
  );
}
