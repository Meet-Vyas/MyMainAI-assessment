import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { storageKeys, type UpdateVideoRequest, type VideoDto } from '@ugn/contracts';
import type { Video } from '@ugn/db';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { toVideoDto } from './video.mapper';

@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
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
    return this.toDto(await this.prisma.video.update({ where: { id }, data }));
  }

  /**
   * Storage first, row last: if storage cleanup fails part-way, the row still exists and the
   * delete can simply be retried. Deleting the row first would orphan objects nobody tracks.
   */
  async delete(id: string): Promise<void> {
    const video = await this.findOrThrow(id);
    if (video.status === 'PROCESSING') {
      // A running job would keep writing output after we delete it. Cancelling jobs comes with the worker.
      throw new ConflictException('Video is processing; wait for it to finish or fail, then delete it');
    }
    if (video.uploadId) {
      await this.storage.abortMultipartUpload(video.sourceKey, video.uploadId);
    }
    await this.storage.deletePrefix(storageKeys.uploadPrefix(id));
    await this.storage.deletePrefix(storageKeys.publicPrefix(id));
    // deleteMany so a concurrent double-delete is a no-op rather than a 500.
    await this.prisma.video.deleteMany({ where: { id } });
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
