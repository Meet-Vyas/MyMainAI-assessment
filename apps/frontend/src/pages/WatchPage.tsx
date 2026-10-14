import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clapperboard, Loader2, MonitorX, SearchX, WifiOff } from 'lucide-react';
import type { PlaybackResponse } from '@ugn/contracts';
import { ProgressBar } from '../components/ProgressBar';
import { SiteHeader } from '../components/SiteHeader';
import { ui } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatDuration, parseTimecode } from '../lib/format';
import { browserEnvironment, detectPlaybackMode } from '../player/playbackMode';
import { VideoPlayer, type PlayerHandle, type ReadyPlayback } from '../player/VideoPlayer';
import { watchProgress } from '../player/watchProgress';

/** While a video is still being prepared, check this often. Viewers have no SSE (admin-only). */
const POLL_MS = 5000;

type State =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; playback: PlaybackResponse };

function isReady(p: PlaybackResponse): p is ReadyPlayback {
  return p.status === 'READY' && p.manifestUrl !== null && p.durationSec !== null && p.width !== null && p.height !== null;
}

export function WatchPage() {
  const { id = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setState({ kind: 'loading' });
      try {
        setState({ kind: 'loaded', playback: await api.playback(id) });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setState({ kind: 'not-found' });
        // A failed background poll keeps showing what we had and tries again next tick.
        else if (!quiet) setState({ kind: 'error', message: (err as Error).message });
      }
    },
    [id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Poll until the video is playable or has failed, so the page turns into the player by itself.
  const waiting = state.kind === 'loaded' && state.playback.status !== 'READY' && state.playback.status !== 'FAILED';
  useEffect(() => {
    if (!waiting) return;
    const t = window.setTimeout(() => void load(true), POLL_MS);
    return () => window.clearTimeout(t);
  }, [waiting, state, load]);

  const title = state.kind === 'loaded' ? state.playback.title : null;
  useEffect(() => {
    document.title = title ? `${title} · Underground Nights` : 'Underground Nights';
  }, [title]);

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-0 py-0 sm:px-4 sm:py-6">
        {state.kind === 'loading' && (
          <div className="aspect-video w-full animate-pulse bg-ink-900 motion-reduce:animate-none sm:rounded-xl" aria-busy="true" aria-label="Loading video" />
        )}
        {state.kind === 'not-found' && (
          <Notice icon={<SearchX />} title="Video not found">
            This video doesn’t exist or has been removed.
          </Notice>
        )}
        {state.kind === 'error' && (
          <Notice
            icon={<WifiOff />}
            title="Couldn’t load this video"
            action={
              <button type="button" className={ui.btnPrimary} onClick={() => void load(false)}>
                Try again
              </button>
            }
          >
            {state.message}
          </Notice>
        )}
        {state.kind === 'loaded' &&
          (isReady(state.playback) ? (
            <ReadyView playback={state.playback} />
          ) : state.playback.status === 'FAILED' ? (
            <Notice icon={<AlertTriangle />} title={state.playback.title}>
              This video couldn’t be processed, so it can’t be played.
            </Notice>
          ) : (
            <Preparing playback={state.playback} />
          ))}
      </main>
    </div>
  );
}

function ReadyView({ playback }: { playback: ReadyPlayback }) {
  const [params] = useSearchParams();
  const player = useRef<PlayerHandle | null>(null);
  const setHandle = useCallback((h: PlayerHandle | null) => (player.current = h), []);

  // Decided once per page. `?player=hlsjs|native` forces an engine for testing.
  const [mode] = useState(() =>
    detectPlaybackMode(browserEnvironment(document.createElement('video')), params.get('player')),
  );

  // A shared link's ?t= wins over this device's saved position.
  const [{ startAt, resumed }] = useState(() => {
    const linked = parseTimecode(params.get('t') ?? '');
    if (linked !== null && linked < playback.durationSec) return { startAt: linked, resumed: false };
    const saved = watchProgress.get(playback.id);
    return saved !== null ? { startAt: saved, resumed: true } : { startAt: 0, resumed: false };
  });

  return (
    <>
      {mode === 'unsupported' ? (
        <Notice icon={<MonitorX />} title="This browser can’t play this video" heading="h2">
          It needs HLS streaming, which recent versions of Chrome, Edge, Firefox, Safari and Samsung Internet all support. You
          can also open the{' '}
          <a href={playback.manifestUrl} className="text-primary underline">
            stream URL
          </a>{' '}
          in a player app such as VLC.
        </Notice>
      ) : (
        <VideoPlayer playback={playback} mode={mode} startAt={startAt} resumed={resumed} handleRef={setHandle} />
      )}

      <div className="mt-4 grid gap-6 px-4 sm:px-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <h1 className="text-4xl sm:text-5xl">{playback.title}</h1>
          <p className="mt-1 text-sm text-ink-500">
            {formatDuration(playback.durationSec)} · up to {playback.renditions[0]?.name ?? 'HD'}
          </p>
          {playback.description && <p className="mt-4 whitespace-pre-line">{playback.description}</p>}
        </div>
        {mode !== 'unsupported' && (
          <aside className="space-y-4">
            <JumpToTime duration={playback.durationSec} onJump={(t) => player.current?.seekTo(t)} />
            <Shortcuts />
          </aside>
        )}
      </div>
    </>
  );
}

/** Long sets are navigated by timestamp ("the drop at 7:42:10"), which a seek bar can't hit precisely. */
function JumpToTime({ duration, onJump }: { duration: number; onJump: (seconds: number) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = parseTimecode(value);
    if (t === null) return setError('Use a time like 7:42:10, 42:10 or 1h5m.');
    if (t >= duration) return setError(`The video is ${formatDuration(duration)} long.`);
    setError(null);
    onJump(t);
  };

  return (
    <form onSubmit={submit} className={ui.card} noValidate>
      <label htmlFor="jump-to" className={ui.label}>
        Jump to time
      </label>
      <div className="flex gap-2">
        <input
          id="jump-to"
          className={ui.input}
          inputMode="numeric"
          placeholder="7:42:10"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? 'jump-to-error' : undefined}
        />
        <button type="submit" className={ui.btnSecondary}>
          Go
        </button>
      </div>
      {error && (
        <p id="jump-to-error" className={ui.error} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Shortcuts() {
  const keys: [string, string][] = [
    ['Space / K', 'Play or pause'],
    ['← / →', 'Back / forward 5 s'],
    ['J / L', 'Back / forward 10 s'],
    ['↑ / ↓', 'Volume'],
    ['M', 'Mute'],
    ['F', 'Full screen'],
    ['0–9', 'Jump to 0–90%'],
  ];
  return (
    <details className={`${ui.card} text-sm`}>
      <summary className="cursor-pointer font-semibold text-white">Keyboard shortcuts</summary>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        {keys.map(([k, what]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="rounded border border-ink-700 bg-ink-800 px-1.5 py-0.5 text-xs text-white">{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Preparing({ playback }: { playback: PlaybackResponse }) {
  const processing = playback.status === 'PROCESSING';
  return (
    <Notice icon={processing ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Clapperboard />} title={playback.title}>
      <span role="status">
        {playback.status === 'UPLOADING'
          ? 'This video is still uploading.'
          : processing
            ? `Getting this video ready to stream: ${playback.progress}%.`
            : 'This video is queued for processing.'}
      </span>{' '}
      This page will start playing it once it’s ready.
      {processing && (
        <span className="mt-4 block">
          <ProgressBar value={playback.progress} label="Processing progress" />
        </span>
      )}
    </Notice>
  );
}

interface NoticeProps {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  /** h2 when the page already has its own h1. */
  heading?: 'h1' | 'h2';
}

/** A full-width panel where the player would be: not found, failed, processing, unsupported. */
function Notice({ icon, title, children, action, heading: Heading = 'h1' }: NoticeProps) {
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-ink-900 px-6 text-center sm:rounded-xl">
      <span className="text-primary [&>svg]:size-10" aria-hidden>
        {icon}
      </span>
      <Heading className="text-3xl sm:text-4xl">{title}</Heading>
      <div className="max-w-lg text-sm sm:text-base">{children}</div>
      {action}
      <Link to="/" className="text-sm text-ink-500 underline hover:text-white">
        Back to the library
      </Link>
    </div>
  );
}
