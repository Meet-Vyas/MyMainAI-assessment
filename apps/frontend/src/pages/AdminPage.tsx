import { AnimatePresence } from 'framer-motion';
import { LogOut, Radio, RefreshCw } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { ActiveUploadCard } from '../components/ActiveUploadCard';
import { Logo } from '../components/Logo';
import { UploadForm } from '../components/UploadForm';
import { VideoList } from '../components/VideoList';
import { ui } from '../components/ui';
import { useUploads } from '../upload/UploadsContext';
import { useAdminVideos } from '../videos/useAdminVideos';

export function AdminPage() {
  const { state, logout } = useAuth();
  const { uploads } = useUploads();
  const { videos, error, live, announcement, refresh, upsert, remove } = useAdminVideos();
  const unfinished = videos?.filter((v) => v.status === 'UPLOADING') ?? [];

  return (
    <div className="min-h-dvh">
      <header className="border-b border-ink-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-baseline gap-3">
            <Logo />
            <span className="hidden text-sm text-ink-500 sm:inline">Admin</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-ink-500 md:inline">
              {state.status === 'authenticated' && state.user.email}
            </span>
            <button type="button" className={ui.btnGhost} onClick={() => void logout()}>
              <LogOut className="size-4" aria-hidden /> Log out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:items-start">
        {/* Not sticky: this column can be taller than the viewport, and a sticky element taller
            than the screen hides its own bottom. Active uploads sit first so they're always in view. */}
        <section aria-labelledby="upload-heading" className="space-y-4">
          <h2 id="upload-heading" className="sr-only">
            Upload
          </h2>
          {uploads.length > 0 && (
            <ul className="space-y-3" aria-label="Uploads in progress">
              <AnimatePresence initial={false}>
                {uploads.map((u) => (
                  <ActiveUploadCard key={u.videoId} upload={u} />
                ))}
              </AnimatePresence>
            </ul>
          )}
          <UploadForm unfinished={unfinished} />
        </section>

        <section aria-labelledby="videos-heading" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id="videos-heading" className="text-3xl">
              Videos
            </h2>
            <span
              className={`inline-flex items-center gap-1.5 text-xs ${live === 'live' ? 'text-emerald-300' : 'text-ink-500'}`}
              title={live === 'live' ? 'Status updates arrive instantly' : 'Live updates unavailable; refreshing every 10 s'}
            >
              {live === 'live' ? <Radio className="size-3.5" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
              {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Polling'}
            </span>
          </div>
          {error && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-red-300" role="alert">
              <span>Couldn’t load videos: {error}</span>
              <button type="button" className={ui.btnGhost} onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          {videos === null && !error ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading videos">
              {[0, 1, 2].map((i) => (
                <div key={i} className={`${ui.card} h-24 animate-pulse motion-reduce:animate-none`} />
              ))}
            </div>
          ) : (
            videos && <VideoList videos={videos} onChanged={upsert} onDeleted={remove} />
          )}
        </section>
      </main>

      {/* Screen readers hear lifecycle changes (e.g. "Boiler Room: Ready") without watching the list. */}
      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>
    </div>
  );
}
