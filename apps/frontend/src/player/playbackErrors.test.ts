import { describe, expect, it } from 'vitest';
import { classifyMediaError, ERRORS, hlsFatalAction, MAX_MEDIA_RECOVERIES } from './playbackErrors';

describe('classifyMediaError (native HLS)', () => {
  it('ignores aborted loads', () => {
    expect(classifyMediaError(1, true)).toBeNull();
  });

  it('maps network and decode errors', () => {
    expect(classifyMediaError(2, true)).toBe(ERRORS.network);
    expect(classifyMediaError(3, true)).toBe(ERRORS.media);
  });

  it('treats "source not supported" while offline as a network problem', () => {
    expect(classifyMediaError(4, true)).toBe(ERRORS.media);
    expect(classifyMediaError(4, false)).toBe(ERRORS.network);
  });
});

describe('hlsFatalAction (hls.js)', () => {
  it('goes to the retry state once hls.js has given up on the network', () => {
    expect(hlsFatalAction('networkError', 'fragLoadError', 0, true)).toEqual({ do: 'fail', error: ERRORS.network });
  });

  it('recovers media errors a limited number of times', () => {
    expect(hlsFatalAction('mediaError', 'bufferStalledError', 0, true)).toEqual({ do: 'recover-media' });
    expect(hlsFatalAction('mediaError', 'bufferStalledError', MAX_MEDIA_RECOVERIES, true)).toEqual({
      do: 'fail',
      error: ERRORS.media,
    });
  });

  it('reports codecs the browser cannot decode as unsupported', () => {
    expect(hlsFatalAction('mediaError', 'manifestIncompatibleCodecsError', 0, true)).toEqual({
      do: 'fail',
      error: ERRORS.unsupported,
    });
  });

  it('blames the network for other fatal errors while offline', () => {
    expect(hlsFatalAction('otherError', 'internalException', 0, false)).toEqual({ do: 'fail', error: ERRORS.network });
  });
});
