import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Prisma, PrismaClient, type VideoStatus } from '@ugn/db';
import type { Rendition } from '@ugn/contracts';

export type VideoRow = {
  id: string;
  status: VideoStatus;
  attempts: number;
  sourceKey: string;
  fileSize: bigint;
  customThumbnailKey: string | null;
};

export interface ProcessedVideo {
  durationSec: number;
  width: number;
  height: number;
  hlsPrefix: string;
  posterKey: string;
  renditions: Rendition[];
}

/** Statuses in which a queued or running job may still act on a video. */
const LIVE: VideoStatus[] = ['UPLOADED', 'PROCESSING'];

/**
 * Every write the worker makes to a video. Each one is a single conditional UPDATE that only
 * matches while the row still belongs to this processing run (same `attempts`, still queued or
 * processing). A `false` return means someone else changed the video first (an admin deleted or
 * retried it, or a newer run finished), and the caller must back off. This is what makes
 * duplicate, stale and racing jobs harmless.
 */
@Injectable()
export class VideoRepository extends PrismaClient implements OnApplicationShutdown {
  // After every onModuleDestroy, so a job stopped on shutdown can still record its re-queue.
  async onApplicationShutdown() {
    await this.$disconnect();
  }

  find(id: string): Promise<VideoRow | null> {
    return this.video.findUnique({
      where: { id },
      select: { id: true, status: true, attempts: true, sourceKey: true, fileSize: true, customThumbnailKey: true },
    });
  }

  /** Queued (or crashed mid-run, still PROCESSING) -> PROCESSING at 0%. */
  claim(id: string, run: number): Promise<boolean> {
    return this.set(id, run, LIVE, { status: 'PROCESSING', progress: 0, failureReason: null });
  }

  /**
   * Progress write, doubling as the job's heartbeat (it bumps updatedAt, which the reconciler
   * watches) and its cancellation check (false once the video is deleted or retried).
   */
  heartbeat(id: string, run: number, progress: number): Promise<boolean> {
    return this.set(id, run, LIVE, { status: 'PROCESSING', progress });
  }

  /** The atomic switch to the new output: players only ever see a complete rendition set. */
  finish(id: string, run: number, out: ProcessedVideo): Promise<boolean> {
    return this.set(id, run, ['PROCESSING'], {
      status: 'READY',
      progress: 100,
      failureReason: null,
      durationSec: out.durationSec,
      width: out.width,
      height: out.height,
      hlsPrefix: out.hlsPrefix,
      posterKey: out.posterKey,
      renditions: out.renditions as unknown as Prisma.InputJsonValue,
    });
  }

  /** Back to the queue: a retry is coming (BullMQ backoff or a re-queue after shutdown). */
  requeue(id: string, run: number, note: string | null): Promise<boolean> {
    return this.set(id, run, ['PROCESSING'], { status: 'UPLOADED', progress: 0, failureReason: note });
  }

  fail(id: string, run: number, reason: string): Promise<boolean> {
    return this.set(id, run, LIVE, { status: 'FAILED', progress: 0, failureReason: reason });
  }

  // ---- Reconciler. Each write also requires the row to still be stale (updatedAt < cutoff): if a
  // worker claimed or heartbeated the video since we looked, it's alive and we leave it alone.

  /** Queued or processing videos nobody has touched since `cutoff`. */
  findStale(cutoff: Date, take: number) {
    return this.video.findMany({
      where: { status: { in: LIVE }, updatedAt: { lt: cutoff } },
      select: { id: true, status: true, attempts: true, sourceKey: true },
      orderBy: { updatedAt: 'asc' },
      take,
    });
  }

  async requeueIfStale(id: string, run: number, cutoff: Date): Promise<boolean> {
    const { count } = await this.video.updateMany({
      where: { id, attempts: run, status: 'PROCESSING', updatedAt: { lt: cutoff } },
      data: { status: 'UPLOADED', progress: 0 },
    });
    return count === 1;
  }

  async failIfStale(id: string, run: number, reason: string, cutoff: Date): Promise<boolean> {
    const { count } = await this.video.updateMany({
      where: { id, attempts: run, status: { in: LIVE }, updatedAt: { lt: cutoff } },
      data: { status: 'FAILED', progress: 0, failureReason: reason },
    });
    return count === 1;
  }

  private async set(id: string, run: number, from: VideoStatus[], data: Prisma.VideoUpdateManyMutationInput) {
    const { count } = await this.video.updateMany({ where: { id, attempts: run, status: { in: from } }, data });
    return count === 1;
  }
}
