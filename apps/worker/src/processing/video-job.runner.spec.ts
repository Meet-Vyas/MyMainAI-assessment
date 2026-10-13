import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageKeys, type VideoEvent, type VideoStatus } from '@ugn/contracts';
import { InvalidMediaError, type ProbeResult } from '../media/probe';
import type { HlsOptions } from '../media/ffmpeg';
import { VideoJobRunner, type MediaTools, type RunJob } from './video-job.runner';
import type { ProcessedVideo } from './video.repository';

const ID = '7d3c9a52-3f1e-4c55-9a43-1f0a8a1c2b10';
const OLD_PREFIX = storageKeys.outputPrefix(ID, 'old-crashed-run');

type Row = {
  id: string;
  status: VideoStatus;
  attempts: number;
  sourceKey: string;
  fileSize: bigint;
  customThumbnailKey: string | null;
  progress: number;
  failureReason: string | null;
} & Partial<ProcessedVideo>;

/**
 * In-memory stand-in for VideoRepository with the same rule: a write only lands while the row
 * still has this run number and is in one of the expected statuses.
 */
class FakeRepo {
  row: Row | null;
  constructor(row: Partial<Row> = {}) {
    this.row = {
      id: ID,
      status: 'UPLOADED',
      attempts: 1,
      sourceKey: storageKeys.source(ID),
      fileSize: 1000n,
      customThumbnailKey: null,
      progress: 0,
      failureReason: null,
      ...row,
    };
  }
  private set(run: number, from: VideoStatus[], data: Partial<Row>) {
    if (!this.row || this.row.attempts !== run || !from.includes(this.row.status)) return Promise.resolve(false);
    Object.assign(this.row, data);
    return Promise.resolve(true);
  }
  find = async () => (this.row ? { ...this.row } : null);
  claim = (_id: string, run: number) =>
    this.set(run, ['UPLOADED', 'PROCESSING'], { status: 'PROCESSING', progress: 0, failureReason: null });
  heartbeat = (_id: string, run: number, progress: number) =>
    this.set(run, ['UPLOADED', 'PROCESSING'], { status: 'PROCESSING', progress });
  finish = (_id: string, run: number, out: ProcessedVideo) =>
    this.set(run, ['PROCESSING'], { status: 'READY', progress: 100, ...out });
  requeue = (_id: string, run: number, note: string | null) =>
    this.set(run, ['PROCESSING'], { status: 'UPLOADED', progress: 0, failureReason: note });
  fail = (_id: string, run: number, reason: string) =>
    this.set(run, ['UPLOADED', 'PROCESSING'], { status: 'FAILED', failureReason: reason });
}

class FakeStorage {
  objects = new Set<string>([OLD_PREFIX + 'master.m3u8']);
  uploadOrder: string[] = [];
  deletedPrefixes: string[] = [];
  beforeUpload?: (key: string) => void;
  presignGet = async (key: string) => `http://storage/${key}`;
  download = async (_key: string, dest: string, onBytes: (n: number) => void) => {
    await writeFile(dest, 'source-bytes');
    onBytes(1000);
  };
  uploadFile = async (key: string) => {
    this.beforeUpload?.(key);
    this.uploadOrder.push(key);
    this.objects.add(key);
  };
  listChildPrefixes = async (prefix: string) => [
    ...new Set([...this.objects].filter((k) => k.startsWith(prefix)).map((k) => k.slice(0, k.indexOf('/', prefix.length) + 1))),
  ];
  deletePrefix = async (prefix: string) => {
    this.deletedPrefixes.push(prefix);
    for (const k of this.objects) if (k.startsWith(prefix)) this.objects.delete(k);
    return 0;
  };
}

const probeResult: ProbeResult = {
  durationSec: 600,
  width: 1920,
  height: 1080,
  hasAudio: true,
  videoCodec: 'h264',
  formatName: 'mp4',
};

/** Writes what ffmpeg would: a master playlist plus a playlist and segments per variant. */
async function fakeEncode(o: HlsOptions, onProgress: (sec: number) => void) {
  for (const r of o.ladder) {
    await mkdir(join(o.outDir, r.name), { recursive: true });
    await writeFile(join(o.outDir, r.name, 'seg_00000.ts'), 'ts');
    await writeFile(join(o.outDir, r.name, 'index.m3u8'), '#EXTM3U');
  }
  await writeFile(join(o.outDir, 'master.m3u8'), '#EXTM3U');
  onProgress(probeResult.durationSec);
}

/** An encode that runs until it's aborted, like a long ffmpeg process being killed. */
function hangingEncode(started: () => void) {
  return (_o: HlsOptions, _p: (sec: number) => void, signal?: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      started();
      signal!.addEventListener('abort', () => reject(new Error('ffmpeg was killed by SIGKILL')));
    });
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ugn-runner-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function setup(opts: { row?: Partial<Row>; media?: Partial<MediaTools>; free?: number } = {}) {
  const repo = new FakeRepo(opts.row);
  const storage = new FakeStorage();
  const events: VideoEvent[] = [];
  const media: MediaTools = {
    probe: jest.fn(async () => probeResult),
    extractPoster: jest.fn(async (_input: string, output: string) => writeFile(output, 'jpg')),
    encodeHls: jest.fn(fakeEncode),
    freeBytes: async () => opts.free ?? 1e15,
    ...opts.media,
  };
  const runner = new VideoJobRunner({
    repo,
    storage,
    publish: async (e) => void events.push(e),
    media,
    workDir,
    ffmpeg: { preset: 'veryfast', threads: 1 },
    log: { log: () => undefined, warn: () => undefined },
    progressTiming: { tickMs: 5, heartbeatMs: 20 },
  });
  const shutdown = new AbortController();
  const job = (overrides: Partial<RunJob> = {}): RunJob => ({
    videoId: ID,
    run: 1,
    isFinalAttempt: false,
    signal: shutdown.signal,
    ...overrides,
  });
  return { runner, repo, storage, events, media, shutdown, job };
}

describe('VideoJobRunner: success', () => {
  it('publishes a complete ladder under a fresh prefix and marks the video READY', async () => {
    const { runner, repo, storage, events, job } = setup();
    expect(await runner.run(job())).toEqual({ kind: 'ready' });

    const row = repo.row!;
    expect(row.status).toBe('READY');
    expect(row.hlsPrefix).toMatch(new RegExp(`^public/videos/${ID}/hls/[0-9a-f-]{36}/$`));
    expect(row.posterKey).toBe(`${row.hlsPrefix}poster.jpg`);
    expect(row.durationSec).toBe(600);
    expect(row.renditions!.map((r) => r.name)).toEqual(['1080p', '720p', '480p']);
    expect(row.renditions![0]).toEqual({ name: '1080p', width: 1920, height: 1080, bandwidth: 5_128_000 });

    // Segments before playlists, master last.
    const order = storage.uploadOrder;
    expect(order[order.length - 1]).toBe(`${row.hlsPrefix}master.m3u8`);
    const lastSegment = Math.max(...order.flatMap((k, i) => (k.endsWith('.ts') ? [i] : [])));
    expect(order.findIndex((k) => k.endsWith('.m3u8'))).toBeGreaterThan(lastSegment);

    expect(events[0]).toEqual({ kind: 'changed', videoId: ID, status: 'PROCESSING', progress: 0 });
    expect(events[events.length - 1]).toEqual({ kind: 'changed', videoId: ID, status: 'READY', progress: 100 });
  });

  it('removes leftovers of earlier crashed runs and its own scratch files', async () => {
    const { runner, storage, job } = setup();
    await runner.run(job());
    expect(storage.deletedPrefixes).toEqual([OLD_PREFIX]);
    expect(await readdir(workDir)).toEqual([]);
  });

  it("uses the admin's custom thumbnail as the poster when there is one", async () => {
    const custom = storageKeys.customThumbnail(ID);
    const { runner, repo, job } = setup({ row: { customThumbnailKey: custom } });
    await runner.run(job());
    expect(repo.row!.posterKey).toBe(custom);
  });

  it('recovers a video left PROCESSING by a crashed worker (stalled job re-run)', async () => {
    const { runner, repo, job } = setup({ row: { status: 'PROCESSING', progress: 63 } });
    expect(await runner.run(job())).toEqual({ kind: 'ready' });
    expect(repo.row!.status).toBe('READY');
  });
});

describe('VideoJobRunner: jobs with nothing to do', () => {
  it('skips a job whose video was deleted after it was queued', async () => {
    const { runner, repo, media, job } = setup();
    repo.row = null;
    expect(await runner.run(job())).toMatchObject({ kind: 'skipped' });
    expect(media.probe).not.toHaveBeenCalled();
  });

  it('skips a stale job left over from before an admin retry', async () => {
    const { runner, repo, media, job } = setup({ row: { attempts: 2 } });
    expect(await runner.run(job({ run: 1 }))).toMatchObject({ kind: 'skipped' });
    expect(repo.row!.status).toBe('UPLOADED');
    expect(media.probe).not.toHaveBeenCalled();
  });

  it('skips an already READY video (duplicate delivery is harmless)', async () => {
    const { runner, repo, job } = setup({ row: { status: 'READY', hlsPrefix: 'public/videos/x/hls/a/' } });
    expect(await runner.run(job())).toMatchObject({ kind: 'skipped' });
    expect(repo.row!.hlsPrefix).toBe('public/videos/x/hls/a/');
  });
});

describe('VideoJobRunner: failures', () => {
  it('fails permanently, without downloading, when the file is not a video', async () => {
    const { runner, repo, storage, events, job } = setup({
      media: { probe: jest.fn(async () => Promise.reject(new InvalidMediaError('Not a readable video file'))) },
    });
    const download = jest.spyOn(storage, 'download');
    const result = await runner.run(job());
    expect(result).toMatchObject({ kind: 'failed', permanent: true });
    expect(repo.row).toMatchObject({ status: 'FAILED', failureReason: 'Not a readable video file' });
    expect(events[events.length - 1]).toEqual({ kind: 'changed', videoId: ID, status: 'FAILED' });
    expect(download).not.toHaveBeenCalled();
  });

  it('re-queues for a retry after a transient error, cleaning up its partial output', async () => {
    const { runner, repo, storage, job } = setup();
    storage.beforeUpload = (key) => {
      if (key.endsWith('index.m3u8')) throw new Error('S3 503 SlowDown');
    };
    const result = await runner.run(job());
    expect(result).toMatchObject({ kind: 'failed', permanent: false });
    expect(repo.row).toMatchObject({ status: 'UPLOADED', failureReason: 'Retrying after: S3 503 SlowDown' });
    expect([...storage.objects].filter((k) => !k.startsWith(OLD_PREFIX))).toEqual([]);
    expect(await readdir(workDir)).toEqual([]);
  });

  it('fails the video when the last attempt hits a transient error', async () => {
    const { runner, repo, job } = setup({
      media: { encodeHls: jest.fn(async () => Promise.reject(new Error('ffmpeg exited with code 1: Conversion failed!'))) },
    });
    expect(await runner.run(job({ isFinalAttempt: true }))).toMatchObject({ kind: 'failed', permanent: true });
    expect(repo.row).toMatchObject({ status: 'FAILED', failureReason: 'ffmpeg exited with code 1: Conversion failed!' });
  });

  it('refuses to start when scratch disk cannot hold the source plus the output', async () => {
    // A 10-minute 1080p ladder needs ~0.8 GB plus 1 GiB of headroom.
    const { runner, repo, job } = setup({ free: 1024 ** 3 });
    expect(await runner.run(job())).toMatchObject({ kind: 'failed', permanent: false });
    expect(repo.row!.failureReason).toMatch(/Not enough scratch disk/);
  });
});

describe('VideoJobRunner: interruptions', () => {
  it('stops ffmpeg and backs off when the video is deleted mid-encode', async () => {
    let started!: () => void;
    const encoding = new Promise<void>((r) => (started = r));
    const { runner, repo, storage, job } = setup({ media: { encodeHls: jest.fn(hangingEncode(() => started())) } });
    const result = runner.run(job());
    await encoding;
    repo.row = null; // admin deleted it; the next heartbeat notices
    expect(await result).toEqual({ kind: 'skipped', reason: 'Video was deleted or retried while processing' });
    expect(storage.uploadOrder).toEqual([]);
  });

  it('does not publish if the video was retried while its output was uploading', async () => {
    const { runner, repo, storage, job } = setup();
    storage.beforeUpload = (key) => {
      if (key.endsWith('master.m3u8')) repo.row!.attempts = 2; // a newer run now owns the video
    };
    expect(await runner.run(job())).toMatchObject({ kind: 'skipped' });
    expect(repo.row!.status).toBe('PROCESSING');
    expect([...storage.objects].filter((k) => !k.startsWith(OLD_PREFIX))).toEqual([]);
  });

  it('re-queues the video on worker shutdown without marking it failed', async () => {
    let started!: () => void;
    const encoding = new Promise<void>((r) => (started = r));
    const { runner, repo, shutdown, job } = setup({ media: { encodeHls: jest.fn(hangingEncode(() => started())) } });
    const result = runner.run(job({ isFinalAttempt: true }));
    await encoding;
    shutdown.abort();
    expect(await result).toEqual({ kind: 'interrupted' });
    expect(repo.row).toMatchObject({ status: 'UPLOADED', failureReason: null });
  });
});
