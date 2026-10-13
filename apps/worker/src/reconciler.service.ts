import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type JobState } from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';
import { PROCESS_JOB_OPTIONS, processJobId, VIDEO_QUEUE, VideoJobName, type ProcessVideoJob } from '@ugn/contracts';
import { WORKER_CONFIG, type WorkerConfig } from './config';
import { EventsService } from './events.service';
import { VideoRepository } from './processing/video.repository';

const RECONCILE_QUEUE = 'video-reconcile';
const RECONCILE_JOB = 'reconcile';
const RECONCILE_EVERY_MS = 5 * 60 * 1000;
/** A live job heartbeats its row every 10 s; 5 minutes of silence means nobody is working on it. */
export const STALE_AFTER_MS = 5 * 60 * 1000;
const BATCH = 100;

type QueueJobState = JobState | 'unknown';
export type ReconcileAction =
  | { action: 'none' }
  /** Put the job back in the queue (it's gone from Redis). */
  | { action: 'enqueue' }
  /** The job is queued again (stall recovery): show the video as queued, not processing. */
  | { action: 'mark-queued' }
  | { action: 'mark-failed'; reason: string };

/**
 * What to do with a video whose row has been quiet for STALE_AFTER_MS, given its job's state in
 * BullMQ. BullMQ's stalled-job check already re-queues jobs whose worker died; this covers what it
 * can't see: the job vanished (Redis data loss, a crash between DB write and enqueue), the job
 * failed without the worker updating the row (stall limit), or the row says PROCESSING for a job
 * that's back in the queue.
 */
export function decideReconcile(
  status: 'UPLOADED' | 'PROCESSING',
  jobState: QueueJobState,
  failedReason?: string,
): ReconcileAction {
  switch (jobState) {
    case 'active':
      // Running, or its worker just died and BullMQ's stall check will re-queue it shortly.
      return { action: 'none' };
    case 'waiting':
    case 'delayed':
    case 'prioritized':
    case 'waiting-children':
      return status === 'PROCESSING' ? { action: 'mark-queued' } : { action: 'none' };
    case 'unknown':
      return { action: 'enqueue' };
    case 'failed':
      return { action: 'mark-failed', reason: failedReason || 'Processing failed' };
    case 'completed':
      // The job ended without moving the video on. Can't re-add the same job id while BullMQ
      // keeps the completed one, so surface it for an admin retry (which starts a new run).
      return { action: 'mark-failed', reason: 'Processing ended without a result; retry to process again' };
  }
}

/**
 * Periodic safety net so no video is stuck in UPLOADED or PROCESSING forever. Runs as a BullMQ job
 * scheduler, so with several worker containers only one reconcile runs per interval.
 */
@Injectable()
export class ReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcilerService.name);
  private videoQueue?: Queue<ProcessVideoJob>;
  private queue?: Queue;
  private worker?: Worker;
  private readonly connections: IORedis[] = [];

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly repo: VideoRepository,
    private readonly events: EventsService,
  ) {}

  async onModuleInit() {
    this.videoQueue = new Queue<ProcessVideoJob>(VIDEO_QUEUE, { connection: this.connect() });
    this.queue = new Queue(RECONCILE_QUEUE, { connection: this.connect() });
    await this.queue.upsertJobScheduler(RECONCILE_JOB, { every: RECONCILE_EVERY_MS }, { name: RECONCILE_JOB });
    this.worker = new Worker(RECONCILE_QUEUE, () => this.reconcile(), {
      connection: this.connect({ maxRetriesPerRequest: null }),
    });
    this.worker.on('error', (err) => this.logger.error(`reconcile worker error: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await Promise.all([this.queue?.close(), this.videoQueue?.close()]);
    // BullMQ doesn't close connections it was handed; open sockets would keep the process alive.
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }

  private connect(options: RedisOptions = {}): IORedis {
    const connection = new IORedis(this.config.REDIS_URL, options);
    connection.on('error', (err) => this.logger.warn(`redis: ${err.message}`));
    this.connections.push(connection);
    return connection;
  }

  async reconcile(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const stale = await this.repo.findStale(cutoff, BATCH);
    let fixed = 0;
    for (const video of stale) {
      try {
        if (await this.reconcileOne(video, cutoff)) fixed++;
      } catch (err) {
        this.logger.error(`could not reconcile ${video.id}: ${(err as Error).message}`);
      }
    }
    if (fixed) this.logger.log(`reconciled ${fixed} video(s)`);
    return fixed;
  }

  private async reconcileOne(
    video: { id: string; status: string; attempts: number; sourceKey: string },
    cutoff: Date,
  ): Promise<boolean> {
    const status = video.status as 'UPLOADED' | 'PROCESSING';
    const jobId = processJobId(video.id, video.attempts);
    const job = await this.videoQueue!.getJob(jobId);
    const state: QueueJobState = job ? await job.getState() : 'unknown';
    const decision = decideReconcile(status, state, job?.failedReason);
    if (decision.action === 'none') return false;
    this.logger.warn(`${video.id} is ${status} but job ${jobId} is ${state}: ${decision.action}`);

    switch (decision.action) {
      case 'enqueue':
        if (status === 'PROCESSING' && !(await this.repo.requeueIfStale(video.id, video.attempts, cutoff))) return false;
        await this.videoQueue!.add(
          VideoJobName.PROCESS,
          { videoId: video.id, sourceKey: video.sourceKey, run: video.attempts },
          { ...PROCESS_JOB_OPTIONS, jobId },
        );
        await this.events.publish({ kind: 'changed', videoId: video.id, status: 'UPLOADED', progress: 0 });
        return true;
      case 'mark-queued':
        if (!(await this.repo.requeueIfStale(video.id, video.attempts, cutoff))) return false;
        await this.events.publish({ kind: 'changed', videoId: video.id, status: 'UPLOADED', progress: 0 });
        return true;
      case 'mark-failed':
        if (!(await this.repo.failIfStale(video.id, video.attempts, decision.reason, cutoff))) return false;
        await this.events.publish({ kind: 'changed', videoId: video.id, status: 'FAILED' });
        return true;
    }
  }
}
