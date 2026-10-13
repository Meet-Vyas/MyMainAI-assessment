import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Video } from '@ugn/db';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { VideosService } from './videos.service';

const ID = '7d3c9a52-3f1e-4c55-9a43-1f0a8a1c2b10';

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: ID,
    title: 'Set',
    description: '',
    status: 'READY',
    fileName: 'set.mp4',
    fileSize: 10n * 1024n ** 3n,
    mimeType: 'video/mp4',
    sourceKey: `uploads/${ID}/source`,
    uploadId: null,
    partSize: null,
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
    ...overrides,
  };
}

function setup(existing: Video | null) {
  const calls: string[] = [];
  const prisma = {
    video: {
      findUnique: jest.fn(async () => existing),
      deleteMany: jest.fn(async () => {
        calls.push('db:delete');
        return { count: 1 };
      }),
    },
  } as unknown as PrismaService;
  const storage = {
    abortMultipartUpload: jest.fn(async () => void calls.push('s3:abort')),
    deletePrefix: jest.fn(async (prefix: string) => {
      calls.push(`s3:delete ${prefix}`);
      return 0;
    }),
    publicUrl: (key: string | null) => key,
  } as unknown as StorageService;
  return { service: new VideosService(prisma, storage), calls, prisma, storage };
}

describe('VideosService.delete', () => {
  it('aborts the multipart upload and clears storage before removing the row', async () => {
    const { service, calls } = setup(video({ status: 'UPLOADING', uploadId: 'mpu-1' }));
    await service.delete(ID);
    expect(calls).toEqual([
      's3:abort',
      `s3:delete uploads/${ID}/`,
      `s3:delete public/videos/${ID}/`,
      'db:delete',
    ]);
  });

  it('keeps the row when storage cleanup fails, so the delete can be retried', async () => {
    const { service, prisma, storage } = setup(video());
    (storage.deletePrefix as jest.Mock).mockRejectedValueOnce(new Error('S3 down'));
    await expect(service.delete(ID)).rejects.toThrow('S3 down');
    expect(prisma.video.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses to delete while processing', async () => {
    const { service, storage } = setup(video({ status: 'PROCESSING' }));
    await expect(service.delete(ID)).rejects.toThrow(ConflictException);
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('404s for an unknown video', async () => {
    const { service } = setup(null);
    await expect(service.delete(ID)).rejects.toThrow(NotFoundException);
  });
});

describe('VideosService.get', () => {
  it('serialises a 10 GB BigInt size as a number', async () => {
    const { service } = setup(video());
    expect((await service.get(ID)).fileSize).toBe(10 * 1024 ** 3);
  });
});
