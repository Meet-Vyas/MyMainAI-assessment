import { describe, expect, it } from 'vitest';
import { detectPlaybackMode, type PlaybackEnvironment } from './playbackMode';

function env(canPlayHls: '' | 'maybe' | 'probably', mse: boolean | 'throws' | 'absent'): PlaybackEnvironment {
  return {
    canPlayType: (type) => (type === 'application/vnd.apple.mpegurl' ? canPlayHls : ''),
    mediaSource:
      mse === 'absent'
        ? undefined
        : {
            isTypeSupported: () => {
              if (mse === 'throws') throw new Error('not implemented');
              return mse;
            },
          },
  };
}

describe('detectPlaybackMode', () => {
  it('plays natively where the browser understands HLS (Safari, iOS, Android Chrome)', () => {
    expect(detectPlaybackMode(env('maybe', true))).toBe('native');
    expect(detectPlaybackMode(env('probably', false))).toBe('native');
  });

  it('falls back to hls.js over MSE (desktop Chrome, Edge, Firefox)', () => {
    expect(detectPlaybackMode(env('', true))).toBe('hlsjs');
  });

  it('reports unsupported when neither path exists', () => {
    expect(detectPlaybackMode(env('', false))).toBe('unsupported');
    expect(detectPlaybackMode(env('', 'absent'))).toBe('unsupported');
    expect(detectPlaybackMode(env('', 'throws'))).toBe('unsupported');
  });

  it('honours a ?player= override only when that path works', () => {
    expect(detectPlaybackMode(env('maybe', true), 'hlsjs')).toBe('hlsjs');
    expect(detectPlaybackMode(env('maybe', false), 'hlsjs')).toBe('native');
    expect(detectPlaybackMode(env('', true), 'native')).toBe('hlsjs');
    expect(detectPlaybackMode(env('', true), 'nonsense')).toBe('hlsjs');
  });
});
