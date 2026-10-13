import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { VIDEO_QUEUE, type ProcessVideoJob } from '@ugn/contracts';

@Injectable()
export class VideoProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessor.name);
  private worker?: Worker<ProcessVideoJob>;

  onModuleInit() {
    // BullMQ workers require maxRetriesPerRequest: null on their connection.
    const connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<ProcessVideoJob>(VIDEO_QUEUE, (job) => this.process(job), {
      connection,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 1),
    });
    this.logger.log(`listening on queue "${VIDEO_QUEUE}"`);
  }

  async onModuleDestroy() {
    // Graceful close lets the current job finish or be released instead of stalling.
    await this.worker?.close();
  }

  private async process(job: Job<ProcessVideoJob>) {
    // Placeholder until milestone 5 (probe, transcode, thumbnails).
    this.logger.log(`received job ${job.id} for video ${job.data.videoId}`);
  }
}
