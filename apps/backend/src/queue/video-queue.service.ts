import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { processJobId, VIDEO_QUEUE, VideoJobName, type ProcessVideoJob } from '@ugn/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { createRedis } from './redis';

/** Producer side of the processing queue. The worker app consumes it. */
@Injectable()
export class VideoQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(VideoQueueService.name);
  private readonly queue: Queue<ProcessVideoJob>;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.queue = new Queue<ProcessVideoJob>(VIDEO_QUEUE, { connection: createRedis(config.REDIS_URL, 'producer') });
  }

  /** Idempotent per run: re-adding the same (video, run) while its job exists is a no-op. */
  async enqueueProcessing(videoId: string, sourceKey: string, run: number): Promise<void> {
    const jobId = processJobId(videoId, run);
    await this.queue.add(
      VideoJobName.PROCESS,
      { videoId, sourceKey },
      {
        jobId,
        // Transient failures (S3 blip, worker OOM-killed) get a few spaced-out retries; a file
        // ffprobe can't read fails permanently on the first attempt (worker marks it unrecoverable).
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        // Keep history long enough to debug, but don't let Redis grow forever.
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    );
    this.logger.log(`enqueued ${jobId}`);
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
