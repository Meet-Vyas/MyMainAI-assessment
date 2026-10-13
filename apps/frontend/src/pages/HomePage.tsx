import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { ui } from '../components/ui';

/** Placeholder until the public library and player (milestone 6). */
export function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col items-start justify-center gap-6 px-4 py-16">
      <Logo />
      <p className="text-lg">Full sets, festival recordings and live sessions. The public library is coming soon.</p>
      <Link to="/admin" className={ui.btnSecondary}>
        Admin
      </Link>
    </main>
  );
}
