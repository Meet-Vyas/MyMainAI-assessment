import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Video } from '@ugn/db';
import type { VideoEventsService } from '../events/video-events.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { VideoQueueService } from '../queue/video-queue.service';
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
  let row = existing;
  const prisma = {
    video: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!row || row.status !== where.status) return { count: 0 };
        row = { ...row, ...data, attempts: row.attempts + (data.attempts?.increment ?? 0) };
        return { count: 1 };
      }),
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
  const queue = { enqueueProcessing: jest.fn(async () => undefined) };
  const events = { publish: jest.fn(async () => undefined) };
  const service = new VideosService(
    prisma,
    storage,
    queue as unknown as VideoQueueService,
    events as unknown as VideoEventsService,
  );
  return { service, calls, prisma, storage, queue, events };
}

describe('VideosService.delete', () => {
  it('aborts the multipart upload and clears storage before removing the row', async () => {
    const { service, calls, events } = setup(video({ status: 'UPLOADING', uploadId: 'mpu-1' }));
    await service.delete(ID);
    expect(events.publish).toHaveBeenCalledWith({ kind: 'deleted', videoId: ID });
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

  it('deletes while processing and sweeps public output again after the row is gone', async () => {
    const { service, calls } = setup(video({ status: 'PROCESSING' }));
    await service.delete(ID);
    expect(calls).toEqual([
      `s3:delete uploads/${ID}/`,
      `s3:delete public/videos/${ID}/`,
      'db:delete',
      `s3:delete public/videos/${ID}/`,
    ]);
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

describe('VideosService.retry', () => {
  it('moves a FAILED video back to UPLOADED and queues the next run', async () => {
    const { service, queue, events } = setup(video({ status: 'FAILED', attempts: 0, failureReason: 'boom' }));
    const dto = await service.retry(ID);
    expect(dto).toMatchObject({ status: 'UPLOADED', failureReason: null, progress: 0 });
    // Run 1, so its job id differs from the failed run 0 that BullMQ still keeps.
    expect(queue.enqueueProcessing).toHaveBeenCalledWith(ID, `uploads/${ID}/source`, 1);
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'changed', status: 'UPLOADED' }));
  });

  it('refuses anything that is not FAILED', async () => {
    for (const status of ['UPLOADING', 'UPLOADED', 'PROCESSING', 'READY'] as const) {
      const { service, queue } = setup(video({ status }));
      await expect(service.retry(ID)).rejects.toThrow(ConflictException);
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    }
  });

  it('lets only one of two concurrent retries through', async () => {
    const { service, queue } = setup(video({ status: 'FAILED' }));
    const results = await Promise.allSettled([service.retry(ID), service.retry(ID)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(queue.enqueueProcessing).toHaveBeenCalledTimes(1);
  });
});
