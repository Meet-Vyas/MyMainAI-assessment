import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { InitUploadResponse, PlaybackResponse, PublicVideoSummary, SignPartsResponse, VideoDto } from '@ugn/contracts';

/**
 * Upload -> worker -> HLS, against the running Docker stack. Needs the worker container, which is
 * also where the test clip is generated, so the host doesn't need ffmpeg.
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:5173/api';
const ORIGIN = process.env.E2E_ORIGIN ?? 'http://localhost:5173';
const MEDIA_BASE = process.env.E2E_MEDIA_BASE_URL ?? 'http://localhost:9000/ugn-videos';
const BUCKET = 'ugn-videos';
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.E2E_S3_ENDPOINT ?? 'http://localhost:9000',
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});

let cookie = '';

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** A 14 s 720p clip with a tone, as fragmented MP4 so ffmpeg can stream it to stdout. */
function makeClip(): Buffer {
  const compose = resolve(__dirname, '../../../compose.yaml');
  return execFileSync(
    'docker',
    [
      'compose', '-f', compose, 'exec', '-T', 'worker',
      'ffmpeg', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '14', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
      '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}

/** The public API, called without the admin cookie, as a viewer would. */
async function publicGet<T>(path: string): Promise<{ status: number; cacheControl: string | null; body: T }> {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, cacheControl: res.headers.get('cache-control'), body: (await res.json()) as T };
}

async function waitForStatus(id: string, done: (v: VideoDto) => boolean, timeoutMs: number): Promise<VideoDto> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await api<VideoDto>('GET', `/admin/videos/${id}`);
    if (done(body) || Date.now() > deadline) return body;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function listKeys(prefix: string, delimiter?: string) {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: delimiter }));
  return { keys: (res.Contents ?? []).map((o) => o.Key!), prefixes: (res.CommonPrefixes ?? []).map((p) => p.Prefix!) };
}

beforeAll(async () => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@ugn.local', password: 'admin12345' }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

describe('processing a real video into HLS', () => {
  let id: string;
  let video: VideoDto;
  let outputPrefix: string;
  let master: string;

  it('uploads a 14 s 720p clip', async () => {
    const clip = makeClip();
    const init = await api<InitUploadResponse>('POST', '/admin/uploads', {
      title: 'E2E processing',
      fileName: 'clip.mp4',
      fileSize: clip.length,
      mimeType: 'video/mp4',
    });
    expect(init.status).toBe(201);
    id = init.body.video.id;
    const signed = await api<SignPartsResponse>('POST', `/admin/uploads/${id}/parts`, { partNumbers: [1] });
    const put = await fetch(signed.body.parts[0].url, { method: 'PUT', body: new Blob([new Uint8Array(clip)]) });
    expect(put.status).toBe(200);
    expect((await api('POST', `/admin/uploads/${id}/complete`)).status).toBe(200);
  });

  it('is public but not playable (and not cached) before processing finishes', async () => {
    const res = await publicGet<PlaybackResponse>(`/videos/${id}/playback`);
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe('no-store');
    expect(['UPLOADED', 'PROCESSING']).toContain(res.body.status);
    expect(res.body).toMatchObject({ manifestUrl: null, renditions: [] });
    const library = await publicGet<PublicVideoSummary[]>('/videos');
    expect(library.body.map((v) => v.id)).not.toContain(id);
  });

  it('becomes READY with the real duration and a poster', async () => {
    video = await waitForStatus(id, (v) => v.status === 'READY' || v.status === 'FAILED', 120_000);
    expect(video).toMatchObject({ status: 'READY', progress: 100, failureReason: null });
    expect(video.durationSec).toBeCloseTo(14, 0);
    expect(video.posterUrl).toMatch(/\/poster\.jpg$/);
  }, 130_000);

  it('wrote exactly one output set', async () => {
    const { prefixes } = await listKeys(`public/videos/${id}/hls/`, '/');
    expect(prefixes).toHaveLength(1);
    outputPrefix = prefixes[0];
  });

  it('serves a master playlist with three renditions, never upscaled', async () => {
    const res = await fetch(`${MEDIA_BASE}/${outputPrefix}master.m3u8`, { headers: { origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    // Players on another origin (the web app, a CDN domain) must be allowed to read it.
    expect(res.headers.get('access-control-allow-origin')).toMatch(new RegExp(`^(\\*|${ORIGIN})$`));
    master = await res.text();
    const resolutions = [...master.matchAll(/RESOLUTION=(\d+x\d+)/g)].map((m) => m[1]);
    expect(resolutions).toEqual(['1280x720', '854x480', '640x360']);
    expect(master).toContain('CODECS="avc1.');
  });

  it('serves 6 s VOD segments as immutable MPEG-TS', async () => {
    const playlist = await (await fetch(`${MEDIA_BASE}/${outputPrefix}720p/index.m3u8`)).text();
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    // Cut exactly on the 6 s keyframe grid; the last segment holds the remainder.
    expect(durations.slice(0, 2)).toEqual([6, 6]);
    expect(durations.reduce((a, b) => a + b)).toBeCloseTo(14, 0);

    const segment = await fetch(`${MEDIA_BASE}/${outputPrefix}720p/seg_00000.ts`);
    expect(segment.headers.get('content-type')).toBe('video/mp2t');
    expect(segment.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('serves the poster as a JPEG', async () => {
    const res = await fetch(video.posterUrl!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('GET /videos/:id/playback gives a viewer everything the player needs', async () => {
    const res = await publicGet<PlaybackResponse>(`/videos/${id}/playback`);
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe('public, max-age=0, s-maxage=60');
    expect(res.body).toMatchObject({
      id,
      status: 'READY',
      manifestUrl: `${MEDIA_BASE}/${outputPrefix}master.m3u8`,
      posterUrl: video.posterUrl,
      width: 1280,
      height: 720,
    });
    expect(res.body.durationSec).toBeCloseTo(14, 0);
    expect(res.body.renditions.map((r) => r.name)).toEqual(['720p', '480p', '360p']);
    // Every advertised rendition playlist exists, for the native-player quality switch.
    for (const r of res.body.renditions) {
      const playlist = await fetch(r.playlistUrl, { headers: { origin: ORIGIN } });
      expect(playlist.status).toBe(200);
      expect(playlist.headers.get('access-control-allow-origin')).toBeTruthy();
    }
  });

  it('lists the READY video in the public library', async () => {
    const library = await publicGet<PublicVideoSummary[]>('/videos');
    expect(library.status).toBe(200);
    expect(library.body.find((v) => v.id === id)).toMatchObject({ title: 'E2E processing', width: 1280, height: 720 });
  });

  it('404s for unknown and malformed ids', async () => {
    expect((await publicGet('/videos/0b7e6a62-1111-4c55-9a43-1f0a8a1c2b10/playback')).status).toBe(404);
    expect((await publicGet('/videos/not-a-uuid/playback')).status).toBe(404);
  });

  it('delete removes the source and every processed object', async () => {
    expect((await api('DELETE', `/admin/videos/${id}`)).status).toBe(204);
    expect((await listKeys(`uploads/${id}/`)).keys).toEqual([]);
    expect((await listKeys(`public/videos/${id}/`)).keys).toEqual([]);
    expect((await publicGet(`/videos/${id}/playback`)).status).toBe(404);
  });
});
