import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { canTransition, storageKeys, type UpdateVideoRequest, type VideoDto } from '@ugn/contracts';
import type { Video } from '@ugn/db';
import { VideoEventsService } from '../events/video-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { toVideoDto } from './video.mapper';

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: VideoQueueService,
    private readonly events: VideoEventsService,
  ) {}

  async list(): Promise<VideoDto[]> {
    const videos = await this.prisma.video.findMany({ orderBy: { createdAt: 'desc' } });
    return videos.map((v) => this.toDto(v));
  }

  async get(id: string): Promise<VideoDto> {
    return this.toDto(await this.findOrThrow(id));
  }

  async update(id: string, data: UpdateVideoRequest): Promise<VideoDto> {
    await this.findOrThrow(id);
    const video = await this.prisma.video.update({ where: { id }, data });
    await this.events.publish({ kind: 'changed', videoId: id });
    return this.toDto(video);
  }

  /**
   * FAILED -> UPLOADED and queue a new processing run. The run number (attempts) is part of the
   * job id, so this can't collide with the failed run's job that BullMQ still keeps for debugging.
   */
  async retry(id: string): Promise<VideoDto> {
    const video = await this.findOrThrow(id);
    if (video.status !== 'FAILED' || !canTransition(video.status, 'UPLOADED')) {
      throw new ConflictException(`Only failed videos can be retried (status ${video.status})`);
    }
    // Conditional, so a double-click can't queue two runs.
    const { count } = await this.prisma.video.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'UPLOADED', attempts: { increment: 1 }, failureReason: null, progress: 0 },
    });
    if (count === 0) throw new ConflictException('Video was already retried');
    const fresh = await this.findOrThrow(id);
    await this.queue.enqueueProcessing(id, fresh.sourceKey, fresh.attempts);
    await this.events.publish({ kind: 'changed', videoId: id, status: fresh.status, progress: 0 });
    return this.toDto(fresh);
  }

  /**
   * Storage first, row last: if storage cleanup fails part-way, the row still exists and the
   * delete can simply be retried. Deleting the row first would orphan objects nobody tracks.
   *
   * A video can be deleted while the worker is processing it. The worker notices the row is gone
   * within seconds, stops ffmpeg and removes its own output. One race remains: the worker may
   * upload its last files after our first sweep and then finish just before the row goes. Every
   * worker upload happens before that final row update, so a second sweep after the row delete
   * catches whatever it wrote.
   */
  async delete(id: string): Promise<void> {
    const video = await this.findOrThrow(id);
    if (video.uploadId) {
      await this.storage.abortMultipartUpload(video.sourceKey, video.uploadId);
    }
    await this.storage.deletePrefix(storageKeys.uploadPrefix(id));
    await this.storage.deletePrefix(storageKeys.publicPrefix(id));
    // deleteMany so a concurrent double-delete is a no-op rather than a 500.
    await this.prisma.video.deleteMany({ where: { id } });
    if (video.status === 'UPLOADED' || video.status === 'PROCESSING') {
      await this.storage.deletePrefix(storageKeys.publicPrefix(id));
    }
    await this.events.publish({ kind: 'deleted', videoId: id });
  }

  private async findOrThrow(id: string): Promise<Video> {
    const video = await this.prisma.video.findUnique({ where: { id } });
    if (!video) throw new NotFoundException('Video not found');
    return video;
  }

  private toDto(video: Video): VideoDto {
    return toVideoDto(video, (key) => this.storage.publicUrl(key));
  }
}
