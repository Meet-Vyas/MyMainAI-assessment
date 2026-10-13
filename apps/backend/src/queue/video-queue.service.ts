import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PROCESS_JOB_OPTIONS, processJobId, VIDEO_QUEUE, VideoJobName, type ProcessVideoJob } from '@ugn/contracts';
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
    await this.queue.add(VideoJobName.PROCESS, { videoId, sourceKey, run }, { ...PROCESS_JOB_OPTIONS, jobId });
    this.logger.log(`enqueued ${jobId}`);
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
