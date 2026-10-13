/**
 * Content-Type and Cache-Control for each processed file, set on the object itself so S3/MinIO
 * and CloudFront serve the right headers with no extra config.
 *
 * Every run writes under a fresh prefix, so nothing is ever overwritten in place. Segments and
 * posters are therefore cached for a year as immutable. Playlists get a short TTL anyway: they're
 * tiny, and it means a deleted or re-processed video stops being served from CDN edges within a
 * minute rather than a year.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PLAYLIST = 'public, max-age=60';

const BY_EXTENSION: Record<string, { contentType: string; cacheControl: string }> = {
  // The MIME type Apple's HLS spec registers; some Android/TV players refuse anything else.
  m3u8: { contentType: 'application/vnd.apple.mpegurl', cacheControl: PLAYLIST },
  ts: { contentType: 'video/mp2t', cacheControl: IMMUTABLE },
  jpg: { contentType: 'image/jpeg', cacheControl: IMMUTABLE },
};

export function outputHeaders(fileName: string): { contentType: string; cacheControl: string } {
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  const headers = BY_EXTENSION[ext];
  if (!headers) throw new Error(`Unexpected output file type: ${fileName}`);
  return headers;
}
