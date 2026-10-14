import type { HlsConfig } from 'hls.js';
import type { PlaybackResponse } from '@ugn/contracts';
import { classifyMediaError, ERRORS, hlsFatalAction, type PlaybackError } from './playbackErrors';
import type { PlaybackMode } from './playbackMode';

/** 'auto' or a rendition name such as "720p". */
export type Quality = string;
export const AUTO: Quality = 'auto';

/** A loaded stream on a <video> element, whichever engine plays it. */
export interface PlaybackSource {
  setQuality(quality: Quality): void;
  destroy(): void;
}

export interface SourceOptions {
  /** Seconds to start from (resume or ?t=); 0 for the beginning. */
  startAt: number;
  onFatal(error: PlaybackError): void;
}

type Playable = Pick<PlaybackResponse, 'renditions'> & { manifestUrl: string };

/**
 * hls.js settings, chosen for very long VOD:
 * - capLevelToPlayerSize: a phone-sized player never downloads 1080p (device pixel ratio counted).
 * - startLevel -1: start on the bandwidth estimate (a low rung on first load), so the first frame
 *   arrives fast, then climb. ABR switching is automatic from there.
 * - maxBufferLength 30 s ahead, backBufferLength 30 s behind: the default keeps everything already
 *   played, which over a 10 h set would grow to gigabytes of memory.
 */
const HLS_CONFIG: Partial<HlsConfig> = {
  capLevelToPlayerSize: true,
  startLevel: -1,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  backBufferLength: 30,
};

export async function attachSource(
  video: HTMLVideoElement,
  playback: Playable,
  mode: Exclude<PlaybackMode, 'unsupported'>,
  options: SourceOptions,
): Promise<PlaybackSource> {
  return mode === 'native' ? attachNative(video, playback, options) : attachHlsJs(video, playback, options);
}

/**
 * Native HLS: the browser does ABR from the master playlist. It has no API to pick a rendition, so a
 * manual choice plays that rendition's own media playlist instead, from the same position.
 */
function attachNative(video: HTMLVideoElement, playback: Playable, { startAt, onFatal }: SourceOptions): PlaybackSource {
  let seekOnLoad = startAt;
  const onLoadedMetadata = () => {
    if (seekOnLoad > 0) video.currentTime = seekOnLoad;
    seekOnLoad = 0;
  };
  const onError = () => {
    const error = classifyMediaError(video.error?.code, navigator.onLine);
    if (error) onFatal(error);
  };
  video.addEventListener('loadedmetadata', onLoadedMetadata);
  video.addEventListener('error', onError);
  video.src = playback.manifestUrl;

  return {
    setQuality(quality) {
      const url =
        quality === AUTO ? playback.manifestUrl : playback.renditions.find((r) => r.name === quality)?.playlistUrl;
      if (!url) return;
      const wasPlaying = !video.paused;
      seekOnLoad = video.currentTime;
      video.src = url;
      // Called from the click handler, so iOS still counts it as user-initiated.
      if (wasPlaying) void video.play().catch(() => undefined);
    },
    destroy() {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load(); // stops the network activity of the old source
    },
  };
}

/**
 * hls.js over Media Source Extensions. Imported on demand so native-HLS devices never download it.
 * The light build leaves out what our streams don't use (subtitle tracks, alternate audio, DRM),
 * which saves about a third. Switch to 'hls.js' if WebVTT captions are added.
 */
async function attachHlsJs(video: HTMLVideoElement, playback: Playable, { startAt, onFatal }: SourceOptions): Promise<PlaybackSource> {
  let Hls: typeof import('hls.js').default;
  try {
    Hls = (await import('hls.js/light')).default;
  } catch {
    // The chunk itself didn't load: almost always the connection.
    onFatal(ERRORS.network);
    return { setQuality: () => undefined, destroy: () => undefined };
  }
  if (!Hls.isSupported()) {
    onFatal(ERRORS.unsupported);
    return { setQuality: () => undefined, destroy: () => undefined };
  }

  const hls = new Hls({ ...HLS_CONFIG, startPosition: startAt > 0 ? startAt : -1 });
  let mediaRecoveries = 0;
  // A clean stretch of playback resets the recovery budget.
  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    mediaRecoveries = 0;
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return; // hls.js is already retrying or switching down
    const action = hlsFatalAction(data.type, data.details, mediaRecoveries, navigator.onLine);
    if (action.do === 'recover-media') {
      mediaRecoveries++;
      hls.recoverMediaError();
    } else {
      onFatal(action.error);
    }
  });
  hls.loadSource(playback.manifestUrl);
  hls.attachMedia(video);

  return {
    setQuality(quality) {
      if (quality === AUTO) {
        hls.currentLevel = -1;
        return;
      }
      const r = playback.renditions.find((x) => x.name === quality);
      const level = r ? hls.levels.findIndex((l) => l.width === r.width && l.height === r.height) : -1;
      // currentLevel (not nextLevel) switches now, flushing the buffer, which is what a person
      // picking a quality expects.
      if (level >= 0) hls.currentLevel = level;
    },
    destroy() {
      hls.destroy();
    },
  };
}
