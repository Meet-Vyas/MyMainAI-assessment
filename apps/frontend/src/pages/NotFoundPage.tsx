import { Link } from 'react-router-dom';
import { ui } from '../components/ui';

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-start justify-center gap-4 px-4">
      <h1 className="text-6xl">Not found</h1>
      <p>That page doesn’t exist.</p>
      <Link to="/" className={ui.btnSecondary}>
        Go home
      </Link>
    </main>
  );
}
