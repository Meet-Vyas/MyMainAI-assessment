import type { AppConfig } from '../config/config';
import type { PrismaService } from '../prisma/prisma.service';
import type { VideosService } from '../videos/videos.service';
import { UploadSweeperService } from './upload-sweeper.service';

describe('UploadSweeperService.sweep', () => {
  const now = new Date('2026-10-14T12:00:00Z');

  function setup(ids: string[]) {
    const prisma = { video: { findMany: jest.fn(async () => ids.map((id) => ({ id }))) } };
    const videos = { delete: jest.fn(async (_id: string) => undefined) };
    const sweeper = new UploadSweeperService(
      prisma as unknown as PrismaService,
      videos as unknown as VideosService,
      { ABANDONED_UPLOAD_TTL_HOURS: 24 } as AppConfig,
    );
    return { sweeper, prisma, videos };
  }

  it('only selects UPLOADING videos idle for longer than the TTL', async () => {
    const { sweeper, prisma } = setup([]);
    await sweeper.sweep(now);
    expect(prisma.video.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'UPLOADING', lastActivityAt: { lt: new Date('2026-10-13T12:00:00Z') } },
      }),
    );
  });

  it('deletes each stale upload and keeps going when one fails', async () => {
    const { sweeper, videos } = setup(['a', 'b', 'c']);
    videos.delete.mockRejectedValueOnce(new Error('S3 blip'));
    await expect(sweeper.sweep(now)).resolves.toBe(2);
    expect(videos.delete).toHaveBeenCalledTimes(3);
  });
});
