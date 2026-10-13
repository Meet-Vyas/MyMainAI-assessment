import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  InitUploadRequestSchema,
  SignPartsRequestSchema,
  ThumbnailUploadRequestSchema,
  type InitUploadRequest,
  type InitUploadResponse,
  type SignPartsResponse,
  type ThumbnailUploadRequest,
  type ThumbnailUploadResponse,
  type UploadStatusResponse,
  type VideoDto,
} from '@ugn/contracts';
import { AdminGuard } from '../auth/auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UploadsService } from './uploads.service';

/**
 * Multipart upload flow:
 *   POST /admin/uploads                  create the video + S3 multipart upload
 *   POST /admin/uploads/:id/parts        presigned URLs for a batch of part numbers
 *   GET  /admin/uploads/:id              parts already in storage (resume after refresh/drop)
 *   POST /admin/uploads/:id/thumbnail    presigned POST for an optional custom thumbnail
 *   POST /admin/uploads/:id/complete     verify parts, assemble, queue processing
 * Cancel = DELETE /admin/videos/:id (aborts the upload and removes its objects).
 */
@Controller('admin/uploads')
@UseGuards(AdminGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  init(
    @Body(new ZodValidationPipe(InitUploadRequestSchema)) body: Required<InitUploadRequest>,
  ): Promise<InitUploadResponse> {
    return this.uploads.init(body);
  }

  @Post(':id/parts')
  @HttpCode(200)
  signParts(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SignPartsRequestSchema)) body: { partNumbers: number[] },
  ): Promise<SignPartsResponse> {
    return this.uploads.signParts(id, body.partNumbers);
  }

  @Get(':id')
  status(@Param('id', ParseUUIDPipe) id: string): Promise<UploadStatusResponse> {
    return this.uploads.status(id);
  }

  @Post(':id/thumbnail')
  @HttpCode(200)
  thumbnail(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ThumbnailUploadRequestSchema)) body: ThumbnailUploadRequest,
  ): Promise<ThumbnailUploadResponse> {
    return this.uploads.thumbnail(id, body);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(@Param('id', ParseUUIDPipe) id: string): Promise<VideoDto> {
    return this.uploads.complete(id);
  }
}
