import { outputHeaders } from './output-headers';

describe('outputHeaders', () => {
  it('serves playlists with the HLS MIME type and a short TTL', () => {
    expect(outputHeaders('/w/out/720p/index.m3u8')).toEqual({
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'public, max-age=60',
    });
  });

  it('caches segments and posters as immutable', () => {
    expect(outputHeaders('seg_00042.ts')).toEqual({
      contentType: 'video/mp2t',
      cacheControl: 'public, max-age=31536000, immutable',
    });
    expect(outputHeaders('poster.jpg').contentType).toBe('image/jpeg');
  });

  it('refuses an unexpected file type rather than serving it with a wrong MIME type', () => {
    expect(() => outputHeaders('notes.txt')).toThrow();
  });
});
