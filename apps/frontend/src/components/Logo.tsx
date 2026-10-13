import { Link } from 'react-router-dom';

export function Logo() {
  return (
    <Link to="/" className="font-display text-2xl tracking-wider text-white sm:text-3xl">
      Underground <span className="text-primary">Nights</span>
    </Link>
  );
}
