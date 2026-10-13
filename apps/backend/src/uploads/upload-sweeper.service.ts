import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { createRedis } from '../queue/redis';
import { VideosService } from '../videos/videos.service';

const MAINTENANCE_QUEUE = 'maintenance';
const SWEEP_JOB = 'sweep-abandoned-uploads';
const SWEEP_EVERY_MS = 15 * 60 * 1000;
const BATCH = 50;

/**
 * Deletes uploads nobody has touched for ABANDONED_UPLOAD_TTL_HOURS: aborts the S3 multipart
 * upload (freeing its parts) and removes the row. Runs as a BullMQ job scheduler, so with several
 * backend instances only one sweep runs per interval. The bucket lifecycle rule is the backstop.
 */
@Injectable()
export class UploadSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadSweeperService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly videos: VideosService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: createRedis(this.config.REDIS_URL, 'producer') });
    await this.queue.upsertJobScheduler(SWEEP_JOB, { every: SWEEP_EVERY_MS }, { name: SWEEP_JOB });
    this.worker = new Worker(MAINTENANCE_QUEUE, async () => this.sweep(), {
      connection: createRedis(this.config.REDIS_URL, 'worker'),
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.config.ABANDONED_UPLOAD_TTL_HOURS * 3600 * 1000);
    const stale = await this.prisma.video.findMany({
      where: { status: 'UPLOADING', lastActivityAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { lastActivityAt: 'asc' },
      take: BATCH,
    });
    let swept = 0;
    for (const { id } of stale) {
      try {
        await this.videos.delete(id);
        swept++;
      } catch (err) {
        // One bad upload shouldn't block the rest; it'll be retried next sweep.
        this.logger.error(`failed to sweep upload ${id}: ${(err as Error).message}`);
      }
    }
    if (swept) this.logger.log(`swept ${swept} abandoned upload(s)`);
    return swept;
  }
}
