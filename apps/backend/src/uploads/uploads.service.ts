import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NoSuchUpload } from '@aws-sdk/client-s3';
import {
  choosePartSize,
  fileExtension,
  partCount,
  storageKeys,
  THUMBNAIL_MAX_BYTES,
  VIDEO_EXTENSIONS,
  type IncompleteUploadError,
  type InitUploadRequest,
  type InitUploadResponse,
  type SignPartsResponse,
  type ThumbnailUploadRequest,
  type ThumbnailUploadResponse,
  type UploadStatusResponse,
  type VideoDto,
} from '@ugn/contracts';
import type { Video } from '@ugn/db';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService, type UploadedPart } from '../storage/storage.service';
import { toVideoDto } from '../videos/video.mapper';
import { VideosService } from '../videos/videos.service';
import { checkParts } from './part-check';

type UploadingVideo = Video & { uploadId: string; partSize: number };

const expiredError = () => new GoneException('This upload expired. Please start it again.');

/**
 * Orchestrates browser -> S3 multipart uploads. Bytes never pass through this server: it only
 * creates the upload, signs short-lived per-part URLs, and verifies/finishes the upload in S3.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: VideoQueueService,
    private readonly videos: VideosService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async init(req: Required<InitUploadRequest>): Promise<InitUploadResponse> {
    const id = randomUUID();
    const sourceKey = storageKeys.source(id);
    // Browsers often send '' for .mkv; store a real type so S3 serves the object sensibly.
    const mimeType = req.mimeType.startsWith('video/') ? req.mimeType : VIDEO_EXTENSIONS[fileExtension(req.fileName)];
    const partSize = choosePartSize(req.fileSize);

    const uploadId = await this.storage.createMultipartUpload(sourceKey, mimeType);
    let video: Video;
    try {
      video = await this.prisma.video.create({
        data: {
          id,
          title: req.title,
          description: req.description,
          fileName: req.fileName,
          fileSize: BigInt(req.fileSize),
          mimeType,
          sourceKey,
          uploadId,
          partSize,
        },
      });
    } catch (err) {
      // Don't leave an S3 upload that no row points at.
      await this.storage.abortMultipartUpload(sourceKey, uploadId).catch(() => undefined);
      throw err;
    }
    return { video: this.toDto(video), partSize, partCount: partCount(req.fileSize, partSize) };
  }

  async signParts(id: string, partNumbers: number[]): Promise<SignPartsResponse> {
    const video = await this.findUploading(id);
    const count = partCount(Number(video.fileSize), video.partSize);
    const outOfRange = partNumbers.filter((n) => n > count);
    if (outOfRange.length) throw new BadRequestException(`This upload has ${count} parts; got ${outOfRange.join(', ')}`);

    const expiresAt = new Date(Date.now() + this.config.UPLOAD_URL_TTL_SECONDS * 1000).toISOString();
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await this.storage.presignUploadPart(video.sourceKey, video.uploadId, partNumber),
      })),
    );
    await this.touch(id);
    return { parts, expiresAt };
  }

  /** Resume support: which parts S3 already has, so the client only sends the rest. */
  async status(id: string): Promise<UploadStatusResponse> {
    const video = await this.findUploading(id);
    const parts = await this.listPartsOrExpire(video);
    await this.touch(id);
    return {
      videoId: id,
      fileName: video.fileName,
      fileSize: Number(video.fileSize),
      partSize: video.partSize,
      partCount: partCount(Number(video.fileSize), video.partSize),
      uploadedParts: parts.map(({ partNumber, size }) => ({ partNumber, size })),
    };
  }

  async thumbnail(id: string, req: ThumbnailUploadRequest): Promise<ThumbnailUploadResponse> {
    await this.findUploading(id);
    return this.storage.presignSmallUpload(storageKeys.customThumbnail(id), req.contentType, THUMBNAIL_MAX_BYTES);
  }

  /**
   * Verifies every part against S3's own list, completes the upload, and queues processing.
   * Safe to call repeatedly: a second call after success just returns the video.
   */
  async complete(id: string): Promise<VideoDto> {
    const video = await this.findOrThrow(id);
    if (video.status !== 'UPLOADING') return this.toDto(video);
    const uploading = this.assertUploading(video);
    const fileSize = Number(video.fileSize);

    let parts: UploadedPart[];
    try {
      parts = await this.storage.listParts(video.sourceKey, uploading.uploadId);
    } catch (err) {
      if (!(err instanceof NoSuchUpload)) throw err;
      // Either an earlier /complete finished in S3 but died before updating the row, or the
      // upload expired. The object itself tells us which.
      if ((await this.storage.objectSize(video.sourceKey)) === fileSize) return this.markUploaded(video);
      await this.deleteExpired(id);
      throw expiredError();
    }

    const { missingParts, wrongSizeParts, ordered } = checkParts(parts, fileSize, uploading.partSize);
    if (missingParts.length || wrongSizeParts.length) {
      const body: IncompleteUploadError = {
        message: 'Upload is incomplete; send the listed parts again, then retry',
        missingParts,
        wrongSizeParts,
      };
      throw new ConflictException(body);
    }

    await this.storage.completeMultipartUpload(video.sourceKey, uploading.uploadId, ordered);
    const size = await this.storage.objectSize(video.sourceKey);
    if (size !== fileSize) {
      throw new InternalServerErrorException(`Assembled object is ${size} bytes, expected ${fileSize}`);
    }
    return this.markUploaded(video);
  }

  private async markUploaded(video: Video): Promise<VideoDto> {
    const thumbKey = storageKeys.customThumbnail(video.id);
    const hasThumbnail = (await this.storage.objectSize(thumbKey)) !== null;
    // Conditional on UPLOADING, so concurrent completes can't both "win" the transition.
    await this.prisma.video.updateMany({
      where: { id: video.id, status: 'UPLOADING' },
      data: {
        status: 'UPLOADED',
        uploadId: null,
        lastActivityAt: new Date(),
        customThumbnailKey: hasThumbnail ? thumbKey : null,
      },
    });
    const fresh = await this.findOrThrow(video.id);
    // Enqueue even if another request did the transition: the job id is per run, so this is
    // de-duplicated, and it covers a crash between the row update and the enqueue.
    if (fresh.status === 'UPLOADED') {
      await this.queue.enqueueProcessing(fresh.id, fresh.sourceKey, fresh.attempts);
    }
    return this.toDto(fresh);
  }

  private async listPartsOrExpire(video: UploadingVideo): Promise<UploadedPart[]> {
    try {
      return await this.storage.listParts(video.sourceKey, video.uploadId);
    } catch (err) {
      if (!(err instanceof NoSuchUpload)) throw err;
      await this.deleteExpired(video.id);
      throw expiredError();
    }
  }

  /** The multipart upload is gone from storage (lifecycle rule or manual abort): drop the video too. */
  private async deleteExpired(id: string): Promise<void> {
    this.logger.warn(`upload ${id} no longer exists in storage; deleting the video`);
    await this.videos.delete(id);
  }

  private async touch(id: string) {
    await this.prisma.video.update({ where: { id }, data: { lastActivityAt: new Date() } });
  }

  private async findUploading(id: string): Promise<UploadingVideo> {
    const video = await this.findOrThrow(id);
    if (video.status !== 'UPLOADING') throw new ConflictException(`Upload already finished (status ${video.status})`);
    return this.assertUploading(video);
  }

  private assertUploading(video: Video): UploadingVideo {
    if (!video.uploadId || !video.partSize) {
      throw new ConflictException('Video has no active upload');
    }
    return video as UploadingVideo;
  }

  private async findOrThrow(id: string): Promise<Video> {
    const video = await this.prisma.video.findUnique({ where: { id } });
    if (!video) throw new NotFoundException('Upload not found');
    return video;
  }

  private toDto(video: Video): VideoDto {
    return toVideoDto(video, (key) => this.storage.publicUrl(key));
  }
}
