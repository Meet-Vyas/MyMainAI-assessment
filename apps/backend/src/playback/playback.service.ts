import { Injectable, NotFoundException } from '@nestjs/common';
import type { PlaybackResponse, PublicVideoSummary } from '@ugn/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { toPlaybackResponse, toPublicSummary } from './playback.mapper';

/** Newest first. Enough for this assessment; a real library would paginate with a cursor. */
export const LIBRARY_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PlaybackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async library(): Promise<PublicVideoSummary[]> {
    const videos = await this.prisma.video.findMany({
      where: { status: 'READY' },
      orderBy: { createdAt: 'desc' },
      take: LIBRARY_LIMIT,
    });
    return videos.flatMap((v) => toPublicSummary(v, this.publicUrl) ?? []);
  }

  async playback(id: string): Promise<PlaybackResponse> {
    // A malformed id in a shared link is just "not found" to a viewer, not a 400.
    const video = UUID.test(id) ? await this.prisma.video.findUnique({ where: { id } }) : null;
    if (!video) throw new NotFoundException('Video not found');
    return toPlaybackResponse(video, this.publicUrl);
  }

  private readonly publicUrl = (key: string | null) => this.storage.publicUrl(key);
}
