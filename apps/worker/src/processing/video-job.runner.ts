import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  HLS_MASTER_PLAYLIST,
  POSTER_FILE,
  storageKeys,
  type Rendition,
  type VideoEvent,
} from '@ugn/contracts';
import { encodeHls, extractPoster, posterTime } from '../media/ffmpeg';
import { estimateOutputBytes, planLadder, variantBandwidth } from '../media/ladder';
import { InvalidMediaError, probe } from '../media/probe';
import type { StorageService } from '../storage.service';
import { outputHeaders } from './output-headers';
import { ProgressReporter } from './progress-reporter';
import type { VideoRepository } from './video.repository';

/** The abort reasons a job can be stopped with from outside the pipeline. */
export class ShutdownError extends Error {
  constructor() {
    super('Worker is shutting down');
    this.name = 'ShutdownError';
  }
}
class OwnershipLostError extends Error {
  constructor() {
    super('Video was deleted or retried while processing');
    this.name = 'OwnershipLostError';
  }
}
class InsufficientDiskError extends Error {}

export interface RunJob {
  videoId: string;
  run: number;
  /** True on the last attempt BullMQ will make, so a failure now is final. */
  isFinalAttempt: boolean;
  /** Aborted on worker shutdown. */
  signal: AbortSignal;
  /** Mirrors progress onto the BullMQ job (handy in queue dashboards). */
  onProgress?: (progress: number) => void;
}

/**
 * What happened, for the BullMQ glue to translate. The database is already updated in every case.
 * - ready: output published, video READY.
 * - skipped: nothing to do (deleted, superseded by a retry, already done). The job just completes.
 * - interrupted: worker shutting down; video set back to UPLOADED, the job must go back to the queue.
 * - failed: `permanent` means the video is now FAILED; otherwise it's UPLOADED and BullMQ retries.
 */
export type RunResult =
  | { kind: 'ready' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'interrupted' }
  | { kind: 'failed'; permanent: boolean; error: Error };

/** The external tools, injectable so the state machine is testable without ffmpeg or S3. */
export interface MediaTools {
  probe: typeof probe;
  extractPoster: typeof extractPoster;
  encodeHls: typeof encodeHls;
  freeBytes: (dir: string) => Promise<number>;
}

export const realMediaTools: MediaTools = {
  probe,
  extractPoster,
  encodeHls,
  freeBytes: async (dir) => {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  },
};

export interface RunnerDeps {
  repo: Pick<VideoRepository, 'find' | 'claim' | 'heartbeat' | 'finish' | 'requeue' | 'fail'>;
  storage: Pick<StorageService, 'presignGet' | 'download' | 'uploadFile' | 'listChildPrefixes' | 'deletePrefix'>;
  publish: (event: VideoEvent) => Promise<void>;
  media: MediaTools;
  workDir: string;
  ffmpeg: { preset: string; threads: number };
  log: { log: (msg: string) => void; warn: (msg: string) => void };
  /** Progress write cadence; tests shorten it. */
  progressTiming?: { tickMs: number; heartbeatMs: number };
}

/** Headroom on top of source + estimated output, for ffmpeg temp files and estimate error. */
const DISK_MARGIN_BYTES = 1024 ** 3;
const UPLOAD_CONCURRENCY = 8;
const MAX_REASON_LENGTH = 500;

/**
 * Processes one video: probe, download, poster, HLS ladder, upload, publish. Owns every status
 * change the worker makes. Each run writes to a fresh storage prefix and publishes it with one
 * conditional row update, so a crash, a retry or a duplicate run can never leave a video pointing
 * at a half-written or mixed rendition set.
 */
export class VideoJobRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(job: RunJob): Promise<RunResult> {
    const { repo, storage, publish, media, log } = this.deps;
    const { videoId, run } = job;

    const video = await repo.find(videoId);
    if (!video) return { kind: 'skipped', reason: 'video was deleted' };
    if (video.attempts !== run) return { kind: 'skipped', reason: `superseded by run ${video.attempts}` };
    if (!(await repo.claim(videoId, run))) return { kind: 'skipped', reason: `video is ${video.status}` };
    await publish({ kind: 'changed', videoId, status: 'PROCESSING', progress: 0 });

    // Our own abort controller: stops on shutdown (from outside) or when the video stops being ours.
    const controller = new AbortController();
    const onShutdown = () => controller.abort(new ShutdownError());
    if (job.signal.aborted) onShutdown();
    job.signal.addEventListener('abort', onShutdown, { once: true });
    const signal = controller.signal;

    const progress = new ProgressReporter({
      write: async (pct, changed) => {
        const ours = await repo.heartbeat(videoId, run, pct);
        if (ours && changed) {
          job.onProgress?.(pct);
          await publish({ kind: 'changed', videoId, status: 'PROCESSING', progress: pct });
        }
        return ours;
      },
      onLost: () => controller.abort(new OwnershipLostError()),
      ...this.deps.progressTiming,
    });

    const outputId = randomUUID();
    const prefix = storageKeys.outputPrefix(videoId, outputId);
    const jobDir = join(this.deps.workDir, `${videoId}-${outputId}`);
    const outDir = join(jobDir, 'out');
    const sourcePath = join(jobDir, 'source');

    try {
      progress.start();
      await mkdir(outDir, { recursive: true });

      // 1. Probe over a presigned URL: rejects non-video without downloading it.
      const meta = await media.probe(await storage.presignGet(video.sourceKey), signal);
      const ladder = planLadder(meta.width, meta.height);
      log.log(
        `${videoId}: ${meta.formatName}/${meta.videoCodec} ${meta.width}x${meta.height} ` +
          `${meta.durationSec.toFixed(1)}s -> ${ladder.map((r) => r.name).join(', ')}`,
      );

      // 2. Enough scratch disk for the source and the whole encoded ladder?
      const fileSize = Number(video.fileSize);
      const needed = fileSize + estimateOutputBytes(ladder, meta.durationSec, meta.hasAudio) + DISK_MARGIN_BYTES;
      const free = await media.freeBytes(this.deps.workDir);
      if (free < needed) {
        throw new InsufficientDiskError(`Not enough scratch disk: need ${gb(needed)}, ${gb(free)} free`);
      }

      // 3. Download (local reads are far faster and more reliable for a multi-hour encode).
      await storage.download(video.sourceKey, sourcePath, (bytes) => progress.report('download', bytes / fileSize), signal);

      // 4. Poster and 5. HLS ladder.
      await media.extractPoster(sourcePath, join(outDir, POSTER_FILE), posterTime(meta.durationSec), signal);
      await media.encodeHls(
        { input: sourcePath, outDir, ladder, hasAudio: meta.hasAudio, ...this.deps.ffmpeg },
        (doneSec) => progress.report('encode', doneSec / meta.durationSec),
        signal,
      );

      // 6. Upload everything under our fresh prefix.
      await this.uploadOutput(outDir, prefix, (fraction) => progress.report('upload', fraction), signal);

      // 7. Publish: one conditional update flips the video to READY with the new prefix.
      signal.throwIfAborted();
      progress.stop();
      const renditions: Rendition[] = ladder.map((r) => ({
        name: r.name,
        width: r.width,
        height: r.height,
        bandwidth: variantBandwidth(r, meta.hasAudio),
      }));
      const published = await repo.finish(videoId, run, {
        durationSec: meta.durationSec,
        width: meta.width,
        height: meta.height,
        hlsPrefix: prefix,
        posterKey: video.customThumbnailKey ?? prefix + POSTER_FILE,
        renditions,
      });
      if (!published) throw new OwnershipLostError();
      await publish({ kind: 'changed', videoId, status: 'READY', progress: 100 });
      await this.removeOtherOutputs(videoId, prefix);
      return { kind: 'ready' };
    } catch (caught) {
      // If we aborted ffmpeg/S3 ourselves, the abort reason says why; the error is just the symptom.
      const error = signal.aborted && signal.reason instanceof Error ? signal.reason : asError(caught);
      // This run's output is never going to be published.
      await storage.deletePrefix(prefix).catch((e) => log.warn(`${videoId}: could not clean ${prefix}: ${asError(e).message}`));

      if (error instanceof OwnershipLostError) return { kind: 'skipped', reason: error.message };
      if (error instanceof ShutdownError) {
        await repo.requeue(videoId, run, null);
        await publish({ kind: 'changed', videoId, status: 'UPLOADED', progress: 0 });
        return { kind: 'interrupted' };
      }

      const permanent = error instanceof InvalidMediaError || job.isFinalAttempt;
      if (permanent) {
        await repo.fail(videoId, run, failureReason(error));
        await publish({ kind: 'changed', videoId, status: 'FAILED' });
      } else {
        await repo.requeue(videoId, run, `Retrying after: ${failureReason(error)}`);
        await publish({ kind: 'changed', videoId, status: 'UPLOADED', progress: 0 });
      }
      return { kind: 'failed', permanent, error };
    } finally {
      progress.stop();
      job.signal.removeEventListener('abort', onShutdown);
      await rm(jobDir, { recursive: true, force: true });
    }
  }

  /**
   * Segments first and playlists last, master very last. Nobody can see this prefix until the
   * row points at it, but this way even a partial upload never has a playlist naming a missing
   * segment.
   */
  private async uploadOutput(dir: string, prefix: string, onFraction: (f: number) => void, signal: AbortSignal) {
    const files = (await listFiles(dir)).sort((a, b) => uploadRank(a) - uploadRank(b));
    let done = 0;
    await forEachLimit(files, UPLOAD_CONCURRENCY, signal, async (file) => {
      const key = prefix + relative(dir, file).split('\\').join('/');
      await this.deps.storage.uploadFile(key, file, outputHeaders(file), signal);
      onFraction(++done / files.length);
    });
  }

  /** Leftovers of earlier runs that crashed before cleaning up. Best effort. */
  private async removeOtherOutputs(videoId: string, keep: string) {
    try {
      const runs = await this.deps.storage.listChildPrefixes(storageKeys.outputsPrefix(videoId));
      for (const p of runs) if (p !== keep) await this.deps.storage.deletePrefix(p);
    } catch (err) {
      this.deps.log.warn(`${videoId}: could not remove old outputs: ${asError(err).message}`);
    }
  }
}

function uploadRank(file: string): number {
  if (file.endsWith(HLS_MASTER_PLAYLIST)) return 2;
  if (file.endsWith('.m3u8')) return 1;
  return 0;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/**
 * Runs fn over items with at most `limit` in flight. After the first failure (or an abort) no new
 * items start, and it waits for the in-flight ones to settle before throwing, so nothing is still
 * uploading while the caller cleans up.
 */
async function forEachLimit<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T) => Promise<void>) {
  let next = 0;
  let failure: unknown;
  const lane = async () => {
    while (failure === undefined && next < items.length) {
      try {
        signal.throwIfAborted();
        await fn(items[next++]);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== undefined) throw failure;
}

function failureReason(error: Error): string {
  return error.message.slice(0, MAX_REASON_LENGTH);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
