import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { interval, map, merge, type Observable } from 'rxjs';
import { UpdateVideoRequestSchema, type UpdateVideoRequest, type VideoDto } from '@ugn/contracts';
import { AdminGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { VideoEventsService } from '../events/video-events.service';
import { VideosService } from './videos.service';

/** Keeps idle SSE connections from being cut by proxies/load balancers (often 60 s timeouts). */
const HEARTBEAT_MS = 25_000;

/** Admin video management. Videos are created by the upload flow (milestone 3), not here. */
@Controller('admin/videos')
@UseGuards(AdminGuard)
export class AdminVideosController {
  constructor(
    private readonly videos: VideosService,
    private readonly events: VideoEventsService,
  ) {}

  /**
   * Live lifecycle updates (Server-Sent Events). SSE over WebSockets: one-way is all we need, it's
   * plain HTTP (cookie auth and the /api proxy just work) and EventSource reconnects by itself.
   * Declared before `:id` so "events" isn't parsed as a video id.
   */
  @Sse('events')
  stream(): Observable<MessageEvent> {
    return merge(
      this.events.events$.pipe(map((event) => ({ type: 'video', data: event }))),
      interval(HEARTBEAT_MS).pipe(map(() => ({ type: 'ping', data: '' }))),
    );
  }

  @Get()
  list(): Promise<VideoDto[]> {
    return this.videos.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VideoDto> {
    return this.videos.get(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateVideoRequestSchema)) body: UpdateVideoRequest,
  ): Promise<VideoDto> {
    return this.videos.update(id, body);
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(@Param('id', ParseUUIDPipe) id: string): Promise<VideoDto> {
    return this.videos.retry(id);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.videos.delete(id);
  }
}
