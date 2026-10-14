import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Film, RefreshCw } from 'lucide-react';
import type { PublicVideoSummary } from '@ugn/contracts';
import { SiteHeader } from '../components/SiteHeader';
import { ui } from '../components/ui';
import { api } from '../lib/api';
import { formatDuration } from '../lib/format';
import { watchProgress } from '../player/watchProgress';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'loaded'; videos: PublicVideoSummary[] };

/** The public library: every READY video, newest first. */
export function HomePage() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'loaded', videos: await api.library() });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    document.title = 'Underground Nights';
    void load();
  }, [load]);

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-1 text-5xl">Sets & sessions</h1>
        <p className="mb-8 text-ink-500">Full-length recordings from the floor. Pick up where you left off on any device you’ve watched on.</p>

        {state.kind === 'loading' && (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading videos">
            {[0, 1, 2].map((i) => (
              <li key={i} className="aspect-video animate-pulse rounded-xl bg-ink-900 motion-reduce:animate-none" />
            ))}
          </ul>
        )}

        {state.kind === 'error' && (
          <div className={`${ui.card} flex flex-col items-start gap-3`} role="alert">
            <p className="text-white">Couldn’t load the library.</p>
            <p className="text-sm text-ink-500">{state.message}</p>
            <button type="button" className={ui.btnSecondary} onClick={() => void load()}>
              <RefreshCw className="size-4" aria-hidden /> Try again
            </button>
          </div>
        )}

        {state.kind === 'loaded' && state.videos.length === 0 && (
          <div className={`${ui.card} flex flex-col items-center gap-2 py-12 text-center`}>
            <Film className="size-8 text-ink-500" aria-hidden />
            <p className="text-white">Nothing to watch yet</p>
            <p className="text-sm text-ink-500">Videos appear here as soon as they finish processing.</p>
          </div>
        )}

        {state.kind === 'loaded' && state.videos.length > 0 && (
          <ul className="grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {state.videos.map((v) => (
              <VideoCard key={v.id} video={v} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function VideoCard({ video }: { video: PublicVideoSummary }) {
  const watched = watchProgress.fraction(video.id);
  const portrait = video.height > video.width;
  return (
    <li>
      <Link to={`/videos/${video.id}`} className={`group block rounded-xl ${ui.focus}`}>
        <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
          {video.posterUrl ? (
            <img
              src={video.posterUrl}
              alt=""
              loading="lazy"
              // Portrait posters are shown whole rather than cropped to a 16:9 strip.
              className={`size-full transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none ${
                portrait ? 'object-contain' : 'object-cover'
              }`}
            />
          ) : (
            <div className="flex size-full items-center justify-center">
              <Film className="size-8 text-ink-500" aria-hidden />
            </div>
          )}
          <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-white">
            {formatDuration(video.durationSec)}
          </span>
          {watched !== null && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
              <div className="h-full bg-primary" style={{ width: `${watched * 100}%` }} />
            </div>
          )}
        </div>
        <h2 className="mt-3 font-sans text-base font-semibold tracking-normal text-white group-hover:text-primary">
          {video.title}
        </h2>
        {watched !== null && <p className="text-xs text-ink-500">Continue watching</p>}
      </Link>
    </li>
  );
}
