import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import IORedis from 'ioredis';
import { VIDEO_EVENTS_CHANNEL, type VideoEvent } from '@ugn/contracts';
import { WORKER_CONFIG, type WorkerConfig } from './config';

/** Publishes status/progress changes to the backend's SSE stream over Redis pub/sub. */
@Injectable()
export class EventsService implements OnApplicationShutdown {
  private readonly logger = new Logger(EventsService.name);
  private readonly redis: IORedis;

  constructor(@Inject(WORKER_CONFIG) config: WorkerConfig) {
    this.redis = new IORedis(config.REDIS_URL);
    // Without a listener ioredis logs every reconnect attempt as an "Unhandled error event".
    this.redis.on('error', (err) => this.logger.warn(`redis: ${err.message}`));
  }

  /** Best effort: a lost event only delays a UI update (the UI refetches on reconnect). */
  async publish(event: VideoEvent): Promise<void> {
    try {
      await this.redis.publish(VIDEO_EVENTS_CHANNEL, JSON.stringify(event));
    } catch (err) {
      this.logger.warn(`failed to publish video event: ${(err as Error).message}`);
    }
  }

  // After every onModuleDestroy, so a job stopped on shutdown can still announce its re-queue.
  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }
}
