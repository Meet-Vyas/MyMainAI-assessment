import { useEffect, useState } from 'react';
import type { HealthResponse } from '@ugn/contracts';

/** Temporary landing page: proves frontend -> API proxy -> backend wiring. Replaced in milestone 4. */
export function App() {
  const [health, setHealth] = useState<HealthResponse | 'error' | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setHealth)
      .catch(() => setHealth('error'));
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-6xl">
        Underground <span className="text-primary">Nights</span>
      </h1>
      <p className="mt-4">
        API:{' '}
        {health === null ? 'checking…' : health === 'error' ? 'unreachable' : `${health.status} (${health.service})`}
      </p>
    </main>
  );
}
