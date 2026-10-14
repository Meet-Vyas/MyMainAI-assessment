import { Link } from 'react-router-dom';
import { Logo } from './Logo';

/** Header for the public pages. */
export function SiteHeader() {
  return (
    <header className="border-b border-ink-800">
      <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
        <Logo />
        <div className="flex items-center gap-4 text-sm">
          <Link to="/" className="font-semibold text-white hover:text-primary">
            Library
          </Link>
          <Link to="/admin" className="text-ink-500 hover:text-white">
            Admin
          </Link>
        </div>
      </nav>
    </header>
  );
}
