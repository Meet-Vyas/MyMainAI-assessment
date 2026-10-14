import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PlaybackResponse, PublicVideoSummary } from '@ugn/contracts';
import { PlaybackService } from './playback.service';

/**
 * Browsers always revalidate (Express sends an ETag, so that's usually a 304); a CDN in front may
 * serve the same answer for 60 s, the same window as the playlists, so a deleted or renamed video
 * is gone everywhere within a minute.
 */
const CACHE_READY = 'public, max-age=0, s-maxage=60';
/** Status and progress change by the second while a page polls them. */
const CACHE_NONE = 'no-store';

/** Public and unauthenticated: the library and what a player needs. */
@Controller('videos')
export class PlaybackController {
  constructor(private readonly playback: PlaybackService) {}

  @Get()
  @Header('Cache-Control', CACHE_READY)
  library(): Promise<PublicVideoSummary[]> {
    return this.playback.library();
  }

  @Get(':id/playback')
  async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<PlaybackResponse> {
    const body = await this.playback.playback(id);
    res.setHeader('Cache-Control', body.status === 'READY' ? CACHE_READY : CACHE_NONE);
    return body;
  }
}
