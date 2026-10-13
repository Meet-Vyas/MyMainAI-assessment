import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { UpdateVideoRequestSchema, type UpdateVideoRequest, type VideoDto } from '@ugn/contracts';
import { AdminGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { VideosService } from './videos.service';

/** Admin video management. Videos are created by the upload flow (milestone 3), not here. */
@Controller('admin/videos')
@UseGuards(AdminGuard)
export class AdminVideosController {
  constructor(private readonly videos: VideosService) {}

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

  @Delete(':id')
  @HttpCode(204)
  delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.videos.delete(id);
  }
}
