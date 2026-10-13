import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Job, UnrecoverableError, WaitingError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { VIDEO_QUEUE, type ProcessVideoJob } from '@ugn/contracts';
import { WORKER_CONFIG, type WorkerConfig } from './config';
import { EventsService } from './events.service';
import { realMediaTools, VideoJobRunner } from './processing/video-job.runner';
import { VideoRepository } from './processing/video.repository';
import { StorageService } from './storage.service';

/**
 * BullMQ side of processing. A job's lock lasts LOCK_MS and BullMQ renews it every LOCK_MS / 2
 * while this process is alive (ffmpeg runs niced in a child process, so the event loop stays free
 * to do that even during a 10 h encode). If the process dies, the lock lapses and the next
 * stalled-job check (every STALLED_INTERVAL_MS, by any worker) puts the job back in the queue: a
 * crashed worker's job restarts within about 3 minutes.
 *
 * 2 minutes rather than BullMQ's 30 s default: a lock that lapses while the job is in fact still
 * running gets the job processed twice (harmless thanks to the run checks, but wasted hours of
 * CPU). We saw a ~1 minute stall under full CPU load before niceing ffmpeg; this keeps margin for
 * that, at the cost of slower recovery, which is noise next to a multi-hour job.
 */
const LOCK_MS = 120_000;
const STALLED_INTERVAL_MS = 60_000;
/**
 * A job that keeps killing its worker (e.g. OOM on a pathological file) fails after the third
 * crash instead of crash-looping forever. Normal errors use the job's own `attempts` instead.
 */
const MAX_STALLED_COUNT = 2;

@Injectable()
export class VideoProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessor.name);
  private readonly shutdown = new AbortController();
  private worker?: Worker<ProcessVideoJob>;
  private connection?: IORedis;
  private runner!: VideoJobRunner;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly repo: VideoRepository,
    private readonly storage: StorageService,
    private readonly events: EventsService,
  ) {}

  async onModuleInit() {
    await this.clearWorkDir();
    this.runner = new VideoJobRunner({
      repo: this.repo,
      storage: this.storage,
      publish: (event) => this.events.publish(event),
      media: realMediaTools,
      workDir: this.config.WORK_DIR,
      ffmpeg: { preset: this.config.FFMPEG_PRESET, threads: this.config.FFMPEG_THREADS },
      log: this.logger,
    });

    // BullMQ workers require maxRetriesPerRequest: null on their connection.
    this.connection = new IORedis(this.config.REDIS_URL, { maxRetriesPerRequest: null });
    this.connection.on('error', (err) => this.logger.warn(`redis: ${err.message}`));
    this.worker = new Worker<ProcessVideoJob>(VIDEO_QUEUE, (job, token) => this.process(job, token), {
      connection: this.connection,
      concurrency: this.config.WORKER_CONCURRENCY,
      lockDuration: LOCK_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    });
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.logger.error(`worker error: ${err.message}`));
    this.logger.log(`listening on queue "${VIDEO_QUEUE}" (concurrency ${this.config.WORKER_CONCURRENCY})`);
  }

  /**
   * SIGTERM (deploy, `docker compose stop`): stop ffmpeg and put the job straight back in the
   * queue without using up one of its attempts, rather than waiting out a multi-hour encode or
   * leaving the lock to expire.
   */
  async onModuleDestroy() {
    this.shutdown.abort();
    await this.worker?.close();
    // BullMQ doesn't close a connection it was handed; an open socket would keep the process alive.
    await this.connection?.quit().catch(() => undefined);
  }

  private async process(job: Job<ProcessVideoJob>, token?: string): Promise<void> {
    const { videoId, run } = job.data;
    this.logger.log(`job ${job.id}: attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1}`);
    const result = await this.runner.run({
      videoId,
      run,
      isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      signal: this.shutdown.signal,
      onProgress: (p) => void job.updateProgress(p).catch(() => undefined),
    });

    switch (result.kind) {
      case 'ready':
        this.logger.log(`job ${job.id}: video ${videoId} is ready`);
        return;
      case 'skipped':
        this.logger.log(`job ${job.id}: skipped (${result.reason})`);
        return;
      case 'interrupted':
        // Back to waiting; WaitingError tells BullMQ we moved it ourselves (not a failure).
        await job.moveToWait(token);
        throw new WaitingError();
      case 'failed':
        this.logger.warn(`job ${job.id}: ${result.permanent ? 'failed permanently' : 'failed, will retry'}: ${result.error.message}`);
        // Unrecoverable stops BullMQ's retries (bad input, or nothing left to retry).
        throw result.permanent ? new UnrecoverableError(result.error.message) : result.error;
    }
  }

  /**
   * Failures the runner never saw, chiefly "stalled more than allowable limit": the job crashed
   * its worker too often. The video must not stay PROCESSING. `fail` is conditional, so for
   * failures the runner already recorded this is a no-op.
   */
  private async onFailed(job: Job<ProcessVideoJob> | undefined, err: Error) {
    if (!job || (await job.getState().catch(() => 'unknown')) !== 'failed') return; // retry pending
    const updated = await this.repo
      .fail(job.data.videoId, job.data.run, `Processing failed: ${err.message}`.slice(0, 500))
      .catch(() => false);
    if (updated) await this.events.publish({ kind: 'changed', videoId: job.data.videoId, status: 'FAILED' });
  }

  /**
   * Scratch files left by a crash (a killed process never reaches its cleanup). WORK_DIR is a
   * per-container volume, so nothing in it can belong to another live worker.
   */
  private async clearWorkDir() {
    const dir = this.config.WORK_DIR;
    await mkdir(dir, { recursive: true });
    const leftovers = await readdir(dir);
    await Promise.all(leftovers.map((name) => rm(join(dir, name), { recursive: true, force: true })));
    if (leftovers.length) this.logger.warn(`removed ${leftovers.length} leftover job folder(s) from ${dir}`);
  }
}
