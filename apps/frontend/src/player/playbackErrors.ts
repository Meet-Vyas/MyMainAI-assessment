export type PlaybackErrorKind = 'network' | 'media' | 'unsupported';

export interface PlaybackError {
  kind: PlaybackErrorKind;
  message: string;
}

export const ERRORS: Record<PlaybackErrorKind, PlaybackError> = {
  network: { kind: 'network', message: 'Couldn’t load the video. Check your connection and try again.' },
  // Native players report a failed segment fetch and a bad stream alike, so this stays neutral.
  media: { kind: 'media', message: 'Playback stopped because of an error.' },
  unsupported: { kind: 'unsupported', message: 'This browser can’t play this video.' },
};

/**
 * What to do with a <video> element error in native mode (MediaError codes). Null means ignore.
 * Code 4 (source not supported) is also what Safari reports when the playlist can't be fetched,
 * so when offline it is treated as a network problem.
 */
export function classifyMediaError(code: number | undefined, online: boolean): PlaybackError | null {
  switch (code) {
    case 1: // MEDIA_ERR_ABORTED: we (or the user) stopped the load.
      return null;
    case 2: // MEDIA_ERR_NETWORK
      return ERRORS.network;
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return online ? ERRORS.media : ERRORS.network;
    default: // 3 MEDIA_ERR_DECODE, or unknown
      return online ? ERRORS.media : ERRORS.network;
  }
}

export type HlsFatalAction = { do: 'recover-media' } | { do: 'fail'; error: PlaybackError };

/** Media-error recoveries allowed in a row before giving up. */
export const MAX_MEDIA_RECOVERIES = 2;

/**
 * hls.js reports an error as fatal only after its own retries with backoff (and switching to a
 * lower rendition) have run out, so a fatal network error goes straight to the "retry" state. A fatal media
 * error (a decoder hiccup or bad buffer) is usually fixed by recoverMediaError(), which rebuilds
 * the MSE buffers in place; we try that a couple of times before failing.
 */
export function hlsFatalAction(
  type: string,
  details: string,
  mediaRecoveriesSoFar: number,
  online: boolean,
): HlsFatalAction {
  if (details === 'manifestIncompatibleCodecsError') return { do: 'fail', error: ERRORS.unsupported };
  if (type === 'networkError') return { do: 'fail', error: ERRORS.network };
  if (type === 'mediaError' && mediaRecoveriesSoFar < MAX_MEDIA_RECOVERIES) return { do: 'recover-media' };
  return { do: 'fail', error: online ? ERRORS.media : ERRORS.network };
}
