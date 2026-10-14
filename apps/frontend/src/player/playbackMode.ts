/**
 * How a browser will play our HLS:
 *
 * - `native`: the browser plays .m3u8 itself. Safari (macOS, iOS, iPadOS), every iOS browser and
 *   in-app webview (they are all WebKit), Android Chrome and Samsung Internet. Preferred: it is the
 *   only option on iPhone before iOS 17.1, it hands the stream to AirPlay and the system's
 *   fullscreen player, and it costs less battery than JavaScript demuxing.
 * - `hlsjs`: hls.js turns the stream into Media Source Extensions buffers. Desktop Chrome, Edge,
 *   Firefox, and Android browsers without native HLS. Only these browsers download hls.js.
 * - `unsupported`: neither (very old browsers, some smart-TV and kiosk engines).
 */
export type PlaybackMode = 'native' | 'hlsjs' | 'unsupported';

export const HLS_MIME = 'application/vnd.apple.mpegurl';
/** H.264 High + AAC-LC, what the worker encodes. */
const MSE_CODECS = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';

interface MseLike {
  isTypeSupported(type: string): boolean;
}

export interface PlaybackEnvironment {
  /** HTMLMediaElement.canPlayType: '' (no), 'maybe' or 'probably'. */
  canPlayType(type: string): string;
  /** ManagedMediaSource (iOS 17.1+ Safari), MediaSource, or the old WebKit prefix; whichever exists. */
  mediaSource?: MseLike;
}

/**
 * Native first, then hls.js. `override` (from `?player=native|hlsjs`) forces one path for testing,
 * but only if the browser can actually do it.
 */
export function detectPlaybackMode(env: PlaybackEnvironment, override?: string | null): PlaybackMode {
  const native = env.canPlayType(HLS_MIME) !== '';
  let mse = false;
  try {
    mse = env.mediaSource?.isTypeSupported(MSE_CODECS) ?? false;
  } catch {
    // Some embedded engines expose MediaSource but throw on isTypeSupported.
  }
  if (override === 'hlsjs' && mse) return 'hlsjs';
  if (override === 'native' && native) return 'native';
  if (native) return 'native';
  if (mse) return 'hlsjs';
  return 'unsupported';
}

/** The real environment, from a <video> element and window. */
export function browserEnvironment(video: HTMLVideoElement): PlaybackEnvironment {
  const w = window as unknown as Record<string, MseLike | undefined>;
  return {
    canPlayType: (type) => video.canPlayType(type),
    mediaSource: w.ManagedMediaSource ?? w.MediaSource ?? w.WebKitMediaSource,
  };
}
