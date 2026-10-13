import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2, LogIn } from 'lucide-react';
import { LoginRequestSchema, type LoginRequest } from '@ugn/contracts';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { ui } from '../components/ui';
import { ApiError } from '../lib/api';

export function LoginPage() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/admin';
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({ resolver: zodResolver(LoginRequestSchema) });

  if (state.status === 'authenticated') return <Navigate to={from} replace />;

  const onSubmit = async (values: LoginRequest) => {
    setServerError(null);
    try {
      await login(values);
      navigate(from, { replace: true });
    } catch (err) {
      setServerError(err instanceof ApiError && err.status === 401 ? 'Wrong email or password.' : (err as Error).message);
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <form onSubmit={handleSubmit(onSubmit)} className={`${ui.card} w-full max-w-sm space-y-4`} noValidate>
        <h1 className="text-4xl">Admin login</h1>
        <div>
          <label htmlFor="email" className={ui.label}>
            Email
          </label>
          <input id="email" type="email" autoComplete="username" className={ui.input} {...register('email')} aria-invalid={!!errors.email} />
          {errors.email && <p className={ui.error}>{errors.email.message}</p>}
        </div>
        <div>
          <label htmlFor="password" className={ui.label}>
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className={ui.input}
            {...register('password')}
            aria-invalid={!!errors.password}
          />
          {errors.password && <p className={ui.error}>{errors.password.message}</p>}
        </div>
        {serverError && (
          <p className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-red-300" role="alert">
            {serverError}
          </p>
        )}
        <button type="submit" className={`${ui.btnPrimary} w-full`} disabled={isSubmitting}>
          {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <LogIn className="size-4" aria-hidden />}
          Log in
        </button>
      </form>
    </main>
  );
}
