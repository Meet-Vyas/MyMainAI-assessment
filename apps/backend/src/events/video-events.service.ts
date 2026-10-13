import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type IORedis from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { VIDEO_EVENTS_CHANNEL, type VideoEvent } from '@ugn/contracts';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { createRedis } from '../queue/redis';

/**
 * Fans video events out to SSE clients. Events travel through Redis pub/sub rather than an
 * in-process emitter so the worker (a separate process) and every backend instance share them.
 * Pub/sub is fire-and-forget: a client that misses events refetches on reconnect.
 */
@Injectable()
export class VideoEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoEventsService.name);
  private readonly subject = new Subject<VideoEvent>();
  private publisher!: IORedis;
  private subscriber!: IORedis;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit() {
    this.publisher = createRedis(this.config.REDIS_URL, 'producer');
    // A connection in subscribe mode can't run other commands, so it gets its own.
    this.subscriber = createRedis(this.config.REDIS_URL, 'worker');
    this.subscriber.on('message', (_channel, message) => {
      try {
        this.subject.next(JSON.parse(message) as VideoEvent);
      } catch {
        this.logger.warn(`ignoring malformed video event: ${message.slice(0, 200)}`);
      }
    });
    await this.subscriber.subscribe(VIDEO_EVENTS_CHANNEL);
  }

  async onModuleDestroy() {
    this.subject.complete();
    await Promise.allSettled([this.subscriber?.quit(), this.publisher?.quit()]);
  }

  get events$(): Observable<VideoEvent> {
    return this.subject.asObservable();
  }

  /** Best effort: a lost event only delays a UI update, so it never fails the caller's request. */
  async publish(event: VideoEvent): Promise<void> {
    try {
      await this.publisher.publish(VIDEO_EVENTS_CHANNEL, JSON.stringify(event));
    } catch (err) {
      this.logger.warn(`failed to publish video event: ${(err as Error).message}`);
    }
  }
}
