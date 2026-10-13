import { BadRequestException, ConflictException, GoneException } from '@nestjs/common';
import { NoSuchUpload } from '@aws-sdk/client-s3';
import { MiB } from '@ugn/contracts';
import type { Video } from '@ugn/db';
import type { AppConfig } from '../config/config';
import type { VideoEventsService } from '../events/video-events.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { VideoQueueService } from '../queue/video-queue.service';
import type { StorageService, UploadedPart } from '../storage/storage.service';
import type { VideosService } from '../videos/videos.service';
import { UploadsService } from './uploads.service';

const ID = '7d3c9a52-3f1e-4c55-9a43-1f0a8a1c2b10';
const PART = 16 * MiB;
const FILE_SIZE = 2 * PART + 100;

function uploadingVideo(): Video {
  return {
    id: ID,
    title: 'Set',
    description: '',
    status: 'UPLOADING',
    fileName: 'set.mp4',
    fileSize: BigInt(FILE_SIZE),
    mimeType: 'video/mp4',
    sourceKey: `uploads/${ID}/source`,
    uploadId: 'mpu-1',
    partSize: PART,
    customThumbnailKey: null,
    progress: 0,
    attempts: 0,
    failureReason: null,
    durationSec: null,
    width: null,
    height: null,
    hlsPrefix: null,
    posterKey: null,
    renditions: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const allParts: UploadedPart[] = [
  { partNumber: 1, size: PART, etag: '"a"' },
  { partNumber: 2, size: PART, etag: '"b"' },
  { partNumber: 3, size: 100, etag: '"c"' },
];

/** In-memory fakes: one video row, S3 calls recorded as jest mocks. */
function setup(row: Video | null = uploadingVideo()) {
  let video = row;
  const prisma = {
    video: {
      findUnique: jest.fn(async () => (video ? { ...video } : null)),
      create: jest.fn(async ({ data }) => (video = { ...uploadingVideo(), ...data })),
      update: jest.fn(async ({ data }) => (video = { ...video!, ...data })),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!video || video.status !== where.status) return { count: 0 };
        video = { ...video, ...data };
        return { count: 1 };
      }),
    },
  };
  const storage = {
    createMultipartUpload: jest.fn(async () => 'mpu-new'),
    presignUploadPart: jest.fn(async (_k: string, _u: string, n: number) => `https://s3/part${n}`),
    listParts: jest.fn(async () => allParts),
    completeMultipartUpload: jest.fn(async () => undefined),
    abortMultipartUpload: jest.fn(async () => undefined),
    // Source object exists with the right size after completion; no custom thumbnail.
    objectSize: jest.fn(async (key: string) => (key.endsWith('/source') ? FILE_SIZE : null)),
    presignSmallUpload: jest.fn(),
    publicUrl: (key: string | null) => key,
  };
  const queue = { enqueueProcessing: jest.fn(async () => undefined) };
  const videos = { delete: jest.fn(async () => void (video = null)) };
  const events = { publish: jest.fn(async () => undefined) };
  const config = { UPLOAD_URL_TTL_SECONDS: 3600 } as AppConfig;
  const service = new UploadsService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    queue as unknown as VideoQueueService,
    videos as unknown as VideosService,
    events as unknown as VideoEventsService,
    config,
  );
  return { service, prisma, storage, queue, videos, events, current: () => video };
}

describe('UploadsService.init', () => {
  const req = { title: 'Set', description: '', fileName: 'set.mkv', fileSize: FILE_SIZE, mimeType: '' };

  it('creates the multipart upload and row, and fills in a MIME type the browser left blank', async () => {
    const { service, current } = setup(null);
    const res = await service.init(req);
    expect(res).toMatchObject({ partSize: PART, partCount: 3 });
    expect(current()).toMatchObject({ uploadId: 'mpu-new', mimeType: 'video/x-matroska', status: 'UPLOADING' });
  });

  it('aborts the S3 upload if the row cannot be written', async () => {
    const { service, prisma, storage } = setup(null);
    prisma.video.create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.init(req)).rejects.toThrow('db down');
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(expect.stringMatching(/\/source$/), 'mpu-new');
  });
});

describe('UploadsService.signParts', () => {
  it('signs requested parts and records activity', async () => {
    const { service, prisma } = setup();
    const res = await service.signParts(ID, [1, 2]);
    expect(res.parts).toEqual([
      { partNumber: 1, url: 'https://s3/part1' },
      { partNumber: 2, url: 'https://s3/part2' },
    ]);
    expect(prisma.video.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastActivityAt: expect.any(Date) } }),
    );
  });

  it('rejects part numbers past the end of the file', async () => {
    const { service } = setup();
    await expect(service.signParts(ID, [3, 4])).rejects.toThrow(BadRequestException);
  });
});

describe('UploadsService.status', () => {
  it('reports parts already stored so the client can resume', async () => {
    const { service, storage } = setup();
    storage.listParts.mockResolvedValueOnce([allParts[0]]);
    expect(await service.status(ID)).toMatchObject({
      partCount: 3,
      uploadedParts: [{ partNumber: 1, size: PART }],
    });
  });

  it('returns 410 and cleans up when storage has already expired the upload', async () => {
    const { service, storage, videos } = setup();
    storage.listParts.mockRejectedValueOnce(new NoSuchUpload({ message: 'gone', $metadata: {} }));
    await expect(service.status(ID)).rejects.toThrow(GoneException);
    expect(videos.delete).toHaveBeenCalledWith(ID);
  });
});

describe('UploadsService.complete', () => {
  it('completes, marks UPLOADED, enqueues processing for run 0 and notifies listeners', async () => {
    const { service, storage, queue, events, current } = setup();
    const dto = await service.complete(ID);
    expect(events.publish).toHaveBeenCalledWith({ kind: 'changed', videoId: ID, status: 'UPLOADED' });
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(`uploads/${ID}/source`, 'mpu-1', allParts);
    expect(dto.status).toBe('UPLOADED');
    expect(current()).toMatchObject({ status: 'UPLOADED', uploadId: null });
    expect(queue.enqueueProcessing).toHaveBeenCalledWith(ID, `uploads/${ID}/source`, 0);
  });

  it('refuses with the exact missing parts instead of assembling a broken file', async () => {
    const { service, storage, current } = setup();
    storage.listParts.mockResolvedValueOnce([allParts[0], allParts[2]]);
    const err = await service.complete(ID).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ missingParts: [2], wrongSizeParts: [] });
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(current()!.status).toBe('UPLOADING');
  });

  it('is idempotent: a second call returns the video without touching S3', async () => {
    const { service, storage } = setup();
    await service.complete(ID);
    storage.listParts.mockClear();
    const again = await service.complete(ID);
    expect(again.status).toBe('UPLOADED');
    expect(storage.listParts).not.toHaveBeenCalled();
  });

  it('recovers when S3 completed but the row was never updated (crash between the two)', async () => {
    const { service, storage, queue } = setup();
    storage.listParts.mockRejectedValueOnce(new NoSuchUpload({ message: 'gone', $metadata: {} }));
    const dto = await service.complete(ID);
    expect(dto.status).toBe('UPLOADED');
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(queue.enqueueProcessing).toHaveBeenCalled();
  });

  it('returns 410 when the upload expired and nothing was assembled', async () => {
    const { service, storage, videos } = setup();
    storage.listParts.mockRejectedValueOnce(new NoSuchUpload({ message: 'gone', $metadata: {} }));
    storage.objectSize.mockResolvedValueOnce(null);
    await expect(service.complete(ID)).rejects.toThrow(GoneException);
    expect(videos.delete).toHaveBeenCalledWith(ID);
  });

  it('records a custom thumbnail that was uploaded before completion', async () => {
    const { service, storage, current } = setup();
    storage.objectSize.mockImplementation(async (key: string) => (key.endsWith('/source') ? FILE_SIZE : 1234));
    await service.complete(ID);
    expect(current()!.customThumbnailKey).toBe(`public/videos/${ID}/custom-thumbnail`);
  });
});
