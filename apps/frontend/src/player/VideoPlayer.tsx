import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import {
  AlertTriangle,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import type { PlaybackResponse } from '@ugn/contracts';
import { formatDuration } from '../lib/format';
import { enterFullscreen, exitFullscreen, FULLSCREEN_EVENTS, fullscreenElement } from './fullscreen';
import type { PlaybackError } from './playbackErrors';
import type { PlaybackMode } from './playbackMode';
import { attachSource, AUTO, type PlaybackSource, type Quality } from './playbackSource';
import { QualityMenu, qualityName } from './QualityMenu';
import { useMediaState } from './useMediaState';
import { watchProgress } from './watchProgress';

export type ReadyPlayback = PlaybackResponse & { manifestUrl: string; durationSec: number; width: number; height: number };

/** Imperative handle for the page (the "jump to time" form). */
export interface PlayerHandle {
  seekTo(seconds: number): void;
}

interface Props {
  playback: ReadyPlayback;
  mode: Exclude<PlaybackMode, 'unsupported'>;
  /** Where to start (a saved position or a ?t= link); 0 for the beginning. */
  startAt: number;
  /** True when startAt came from "resume watching", to offer "Start over". */
  resumed: boolean;
  handleRef?: (handle: PlayerHandle | null) => void;
}

const SEEK_STEP = 5;
const SEEK_JUMP = 10;
const SEEK_PAGE = 60;
const HIDE_CONTROLS_MS = 3000;
const SAVE_EVERY_MS = 5000;

const ctrl =
  'inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-white/90 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white';

export function VideoPlayer({ playback, mode, startAt, resumed, handleRef }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const source = useRef<PlaybackSource | null>(null);
  const media = useMediaState(videoRef);

  const [quality, setQuality] = useState<Quality>(AUTO);
  const [error, setError] = useState<PlaybackError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const restartAt = useRef(startAt);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recentlyActive, setRecentlyActive] = useState(true);
  const [keyboardInside, setKeyboardInside] = useState(false);
  /** Where the seek-bar thumb is while being dragged; null when not dragging. */
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubbing = useRef(false);
  const scrubTo = useRef<number | null>(null);
  const [showResume, setShowResume] = useState(resumed && startAt > 0);
  const [announcement, setAnnouncement] = useState('');
  const hideTimer = useRef<number | undefined>(undefined);

  const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : playback.durationSec;
  const landscape = playback.width >= playback.height;

  // Attach the stream. Re-runs on retry (attempt), resuming from where playback stopped.
  useEffect(() => {
    const video = videoRef.current!;
    let cancelled = false;
    let attached: PlaybackSource | null = null;
    setError(null);
    void attachSource(video, playback, mode, {
      startAt: restartAt.current,
      onFatal: (e) => {
        if (cancelled) return;
        setError(e);
        video.pause(); // so the controls show Play, not a Pause that does nothing
      },
    }).then((s) => {
      if (cancelled) s.destroy();
      else source.current = attached = s;
    });
    return () => {
      cancelled = true;
      attached?.destroy();
      source.current = null;
    };
    // Keyed on the URL, not the object: a re-fetched but identical playback mustn't reload the stream.
  }, [playback.manifestUrl, mode, attempt]);

  const retry = useCallback(() => {
    const t = videoRef.current?.currentTime ?? 0;
    if (t > 0) restartAt.current = t;
    setQuality(AUTO);
    setAttempt((a) => a + 1);
  }, []);

  // Offline banner, and an automatic retry when the connection comes back. Only on the actual
  // offline -> online event: retrying a network error that happened while online would just fail
  // again in a loop (a CDN outage, a blocked request), so that one waits for "Try again".
  const errorRef = useRef(error);
  errorRef.current = error;
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      if (errorRef.current?.kind === 'network') retry();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [retry]);

  // Resume watching: save the position every few seconds, on pause/seek, and when the page is hidden
  // (mobile browsers may never fire unload). Only after real playback, so a page that loaded and sat
  // at 0:00 can't overwrite a saved position.
  useEffect(() => {
    const video = videoRef.current!;
    let played = false;
    let lastSave = 0;
    const save = () => {
      if (!played || video.seeking || video.readyState < 1) return;
      const total = Number.isFinite(video.duration) ? video.duration : playback.durationSec;
      watchProgress.save(playback.id, video.currentTime, total);
      lastSave = Date.now();
    };
    const onPlaying = () => (played = true);
    const onTimeUpdate = () => Date.now() - lastSave > SAVE_EVERY_MS && save();
    const onEnded = () => watchProgress.clear(playback.id);
    const onHidden = () => document.visibilityState === 'hidden' && save();
    video.addEventListener('playing', onPlaying);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('pause', save);
    video.addEventListener('seeked', save);
    video.addEventListener('ended', onEnded);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      save();
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('pause', save);
      video.removeEventListener('seeked', save);
      video.removeEventListener('ended', onEnded);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [playback.id, playback.durationSec]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(fullscreenElement() === container.current);
    for (const e of FULLSCREEN_EVENTS) document.addEventListener(e, onChange);
    return () => {
      for (const e of FULLSCREEN_EVENTS) document.removeEventListener(e, onChange);
    };
  }, []);

  // Lock screen / notification controls on phones.
  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: playback.title,
      artist: 'Underground Nights',
      artwork: playback.posterUrl ? [{ src: playback.posterUrl }] : [],
    });
    return () => {
      navigator.mediaSession.metadata = null;
    };
  }, [playback.title, playback.posterUrl]);

  useEffect(() => {
    if (!showResume || !media.started) return;
    const t = window.setTimeout(() => setShowResume(false), 8000);
    return () => window.clearTimeout(t);
  }, [showResume, media.started]);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const poke = useCallback(() => {
    setRecentlyActive(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setRecentlyActive(false), HIDE_CONTROLS_MS);
  }, []);

  const announce = (text: string) => setAnnouncement(text);

  // ---- actions -------------------------------------------------------------------------------

  const togglePlay = () => {
    const v = videoRef.current!;
    if (v.paused || v.ended) void v.play().catch(() => undefined);
    else v.pause();
  };

  const seekTo = useCallback(
    (t: number) => {
      const v = videoRef.current!;
      v.currentTime = Math.max(0, Math.min(t, duration - 0.5));
    },
    [duration],
  );

  useEffect(() => {
    handleRef?.({ seekTo });
    return () => handleRef?.(null);
  }, [handleRef, seekTo]);

  const seekBy = (delta: number) => {
    const v = videoRef.current!;
    seekTo(v.currentTime + delta);
    announce(`${delta > 0 ? 'Forward' : 'Back'} ${Math.abs(delta)} seconds`);
  };

  const setVolume = (value: number) => {
    const v = videoRef.current!;
    v.volume = Math.max(0, Math.min(1, value));
    v.muted = v.volume === 0;
  };

  const toggleMute = () => {
    const v = videoRef.current!;
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.5;
    announce(v.muted ? 'Muted' : 'Unmuted');
  };

  const toggleFullscreen = () => {
    if (fullscreenElement()) void exitFullscreen().catch(() => undefined);
    else void enterFullscreen(container.current!, videoRef.current!, landscape).catch(() => undefined);
  };

  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true;
  const togglePip = () => {
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    else void videoRef.current!.requestPictureInPicture().catch(() => undefined);
  };

  const chooseQuality = (q: Quality) => {
    setQuality(q);
    source.current?.setQuality(q);
    announce(`Quality ${q === AUTO ? 'automatic' : q}`);
  };

  const startOver = () => {
    watchProgress.clear(playback.id);
    seekTo(0);
    setShowResume(false);
    container.current?.focus();
  };

  // ---- input ---------------------------------------------------------------------------------

  /**
   * Shortcuts work while focus is anywhere in the player (YouTube's keys): Space/K play, ←/→ 5 s,
   * J/L 10 s, ↑/↓ volume, M mute, F fullscreen, 0-9 jump to 0-90%, Home/End. Keys a focused
   * control already uses (Space on a button, arrows on a slider) are left to it.
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    const onButton = target.tagName === 'BUTTON';
    const onSlider = target.tagName === 'INPUT';
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case ' ':
        if (onButton) return;
        togglePlay();
        break;
      case 'k':
        togglePlay();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (onSlider) return;
        seekBy(key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP);
        break;
      case 'j':
      case 'l':
        seekBy(key === 'j' ? -SEEK_JUMP : SEEK_JUMP);
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        if (onSlider) return;
        setVolume(videoRef.current!.volume + (key === 'ArrowUp' ? 0.1 : -0.1));
        break;
      case 'm':
        toggleMute();
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'Home':
      case 'End':
        if (onSlider) return;
        seekTo(key === 'Home' ? 0 : duration);
        break;
      default:
        if (/^[0-9]$/.test(key)) seekTo((duration * Number(key)) / 10);
        else return;
    }
    e.preventDefault();
    poke();
  };

  /** Mouse: click plays/pauses. Touch: a tap shows or hides the controls (YouTube/iOS behaviour). */
  const onSurfacePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      togglePlay();
      poke();
    } else if (controlsVisible && !media.paused) {
      window.clearTimeout(hideTimer.current);
      setRecentlyActive(false);
    } else {
      poke();
    }
  };

  const commitScrub = () => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    if (scrubTo.current !== null) seekTo(scrubTo.current);
    scrubTo.current = null;
    setScrub(null);
  };

  /** The seek bar's own keys: steps sized for a 10 h video rather than the browser's 1% default. */
  const onSeekKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const t = videoRef.current!.currentTime;
    const steps: Record<string, number> = {
      ArrowLeft: t - SEEK_STEP,
      ArrowDown: t - SEEK_STEP,
      ArrowRight: t + SEEK_STEP,
      ArrowUp: t + SEEK_STEP,
      PageDown: t - SEEK_PAGE,
      PageUp: t + SEEK_PAGE,
      Home: 0,
      End: duration,
    };
    if (!(e.key in steps)) return;
    e.preventDefault();
    e.stopPropagation();
    seekTo(steps[e.key]);
    poke();
  };

  // ---- render --------------------------------------------------------------------------------

  const controlsVisible =
    !media.started || media.paused || recentlyActive || menuOpen || keyboardInside || scrub !== null || error !== null;
  const shownTime = scrub ?? media.currentTime;
  const playedPct = duration > 0 ? (shownTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (Math.max(media.bufferedEnd, shownTime) / duration) * 100 : 0;
  const VolumeIcon = media.muted || media.volume === 0 ? VolumeX : media.volume < 0.5 ? Volume1 : Volume2;
  const playing = qualityName(media.videoWidth, media.videoHeight);

  const sizeStyle: CSSProperties | undefined = isFullscreen
    ? undefined
    : {
        aspectRatio: `${playback.width} / ${playback.height}`,
        // Fit a portrait video in the viewport height instead of letting it run off-screen, but never
        // narrower than 20rem (a portrait video on a phone held sideways), or the controls can't fit.
        width: `min(100%, max(calc(75vh * ${playback.width / playback.height}), 20rem))`,
      };

  return (
    <div
      ref={container}
      role="region"
      aria-label={`Video player: ${playback.title}`}
      aria-roledescription="video player"
      tabIndex={0}
      data-playback-mode={mode}
      data-quality={playing ?? undefined}
      onKeyDown={onKeyDown}
      onPointerMove={(e) => e.pointerType === 'mouse' && poke()}
      onFocus={(e) => {
        if (e.target.matches(':focus-visible')) {
          setKeyboardInside(true);
          poke();
        }
      }}
      onBlur={(e) => {
        if (!container.current?.contains(e.relatedTarget as Node)) setKeyboardInside(false);
      }}
      className={`group @container relative mx-auto overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        isFullscreen ? 'size-full' : 'sm:rounded-xl'
      } ${!controlsVisible && isFullscreen ? 'cursor-none' : ''}`}
      style={sizeStyle}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 size-full object-contain"
        poster={playback.posterUrl ?? undefined}
        // Inline on iPhone instead of jumping straight to the system fullscreen player. The prefixed
        // attribute covers older iOS webviews (Facebook, Instagram).
        playsInline
        webkit-playsinline="true"
        x-webkit-airplay="allow"
        preload="metadata"
        tabIndex={-1}
      />

      {/* Click/tap target over the picture, under the controls. */}
      <div className="absolute inset-0" onPointerUp={onSurfacePointerUp} onDoubleClick={toggleFullscreen} aria-hidden />

      {/* Centre: big play icon, spinner, or error. Purely visual except the error's buttons. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {error ? (
          <div className="pointer-events-auto mx-4 flex max-w-sm flex-col items-center gap-3 rounded-xl bg-black/80 p-5 text-center" role="alert">
            {error.kind === 'network' ? (
              <WifiOff className="size-8 text-primary" aria-hidden />
            ) : (
              <AlertTriangle className="size-8 text-primary" aria-hidden />
            )}
            <p className="text-sm text-white">{error.message}</p>
            {error.kind !== 'unsupported' && (
              <button type="button" className={`${ctrl} w-auto gap-2 bg-primary px-4 hover:bg-primary-hover`} onClick={retry}>
                <RefreshCw className="size-4" aria-hidden /> Try again
              </button>
            )}
          </div>
        ) : media.buffering ? (
          <Loader2 className="size-12 animate-spin text-white/90 motion-reduce:animate-none" aria-hidden />
        ) : media.paused ? (
          <span className="flex size-16 items-center justify-center rounded-full bg-primary/90 shadow-lg sm:size-20" aria-hidden>
            <Play className="ml-1 size-8 fill-white text-white sm:size-10" />
          </span>
        ) : null}
      </div>

      {(!online || showResume) && (
        <div className="absolute left-3 top-3 flex flex-col items-start gap-2">
          {!online && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1 text-xs text-white">
              <WifiOff className="size-3.5" aria-hidden /> Offline: playback continues when you reconnect
            </span>
          )}
          {showResume && (
            <span className="inline-flex items-center gap-2 rounded-full bg-black/75 py-1 pl-3 pr-1 text-xs text-white">
              Resumed at {formatDuration(startAt)}
              <button type="button" className="rounded-full bg-white/15 px-2 py-0.5 font-semibold hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" onClick={startOver}>
                Start over
              </button>
            </span>
          )}
        </div>
      )}

      {/* Control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2 pb-1 pt-12 transition-opacity duration-200 sm:px-3 ${
          controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        style={{ paddingBottom: isFullscreen ? 'max(0.25rem, env(safe-area-inset-bottom))' : undefined }}
      >
        <div className="relative px-1">
          {scrub !== null && (
            <span
              className="absolute bottom-full mb-1 -translate-x-1/2 rounded bg-black/85 px-2 py-0.5 text-xs tabular-nums text-white"
              style={{ left: `${playedPct}%` }}
              aria-hidden
            >
              {formatDuration(scrub)}
            </span>
          )}
          <input
            type="range"
            className="ugn-range w-full"
            min={0}
            max={duration}
            step="any"
            value={Math.min(shownTime, duration)}
            aria-label="Seek"
            aria-valuetext={`${formatDuration(shownTime)} of ${formatDuration(duration)}`}
            aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown Home End"
            style={{ '--played': `${playedPct}%`, '--buffered': `${bufferedPct}%` } as CSSProperties}
            onPointerDown={() => (scrubbing.current = true)}
            onPointerUp={commitScrub}
            onPointerCancel={commitScrub}
            onLostPointerCapture={commitScrub}
            onBlur={commitScrub}
            onChange={(e) => {
              const t = Number(e.target.value);
              // While dragging, only move the thumb; seek once on release so a drag across a 10 h
              // timeline doesn't fire hundreds of segment requests. Screen readers and clicks seek at once.
              if (scrubbing.current) {
                scrubTo.current = t;
                setScrub(t);
              } else {
                seekTo(t);
              }
              poke();
            }}
            onKeyDown={onSeekKeyDown}
          />
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1">
          <button type="button" className={ctrl} onClick={togglePlay} aria-label={media.paused ? 'Play' : 'Pause'} aria-keyshortcuts="k">
            {media.paused ? <Play className="size-5 fill-current" aria-hidden /> : <Pause className="size-5 fill-current" aria-hidden />}
          </button>
          {/* Optional controls drop out by the *player's* width (container queries), not the screen's:
              a portrait video on a laptop is a narrow player on a wide screen. Thresholds are sized for
              a 10 h timestamp ("7:42:10 / 10:00:00"); the full set needs about 610 px. Play, mute,
              time, quality and fullscreen always fit; J/L, arrows and the seek bar cover what's hidden. */}
          <button type="button" className={`${ctrl} @max-xl:hidden`} onClick={() => seekBy(-SEEK_JUMP)} aria-label="Back 10 seconds" aria-keyshortcuts="j">
            <RotateCcw className="size-5" aria-hidden />
          </button>
          <button type="button" className={`${ctrl} @max-xl:hidden`} onClick={() => seekBy(SEEK_JUMP)} aria-label="Forward 10 seconds" aria-keyshortcuts="l">
            <RotateCw className="size-5" aria-hidden />
          </button>

          <div className="flex items-center">
            <button type="button" className={ctrl} onClick={toggleMute} aria-label={media.muted ? 'Unmute' : 'Mute'} aria-keyshortcuts="m">
              <VolumeIcon className="size-5" aria-hidden />
            </button>
            {/* Phones ignore page-set volume (hardware buttons only), so no slider on touch screens. */}
            <input
              type="range"
              className="ugn-range w-20 @max-2xl:hidden pointer-coarse:hidden"
              min={0}
              max={1}
              step={0.05}
              value={media.muted ? 0 : media.volume}
              aria-label="Volume"
              aria-valuetext={`${Math.round((media.muted ? 0 : media.volume) * 100)}%`}
              style={{ '--played': `${(media.muted ? 0 : media.volume) * 100}%`, '--buffered': '0%' } as CSSProperties}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>

          <span className="ml-1 min-w-0 truncate whitespace-nowrap text-xs tabular-nums text-white/90 sm:ml-2 sm:text-sm">
            {formatDuration(shownTime)}
            <span className="text-white/50 @max-sm:hidden"> / {formatDuration(duration)}</span>
          </span>

          <span className="flex-1" />

          {playback.renditions.length > 0 && (
            <QualityMenu
              renditions={playback.renditions}
              selected={quality}
              playingWidth={media.videoWidth}
              playingHeight={media.videoHeight}
              onSelect={chooseQuality}
              onOpenChange={setMenuOpen}
              buttonClassName={ctrl}
            />
          )}
          {pipSupported && (
            <button type="button" className={`${ctrl} @max-xl:hidden`} onClick={togglePip} aria-label="Picture in picture">
              <PictureInPicture2 className="size-5" aria-hidden />
            </button>
          )}
          <button
            type="button"
            className={ctrl}
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
            aria-keyshortcuts="f"
          >
            {isFullscreen ? <Minimize className="size-5" aria-hidden /> : <Maximize className="size-5" aria-hidden />}
          </button>
        </div>
      </div>

      <div className="sr-only" aria-live="polite" role="status">
        {announcement}
      </div>
    </div>
  );
}
