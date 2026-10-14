import { NotFoundException } from '@nestjs/common';
import type { Video } from '@ugn/db';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { LIBRARY_LIMIT, PlaybackService } from './playback.service';

const ID = '7d3c9a52-3f1e-4c55-9a43-1f0a8a1c2b10';
const PREFIX = `public/videos/${ID}/hls/run-a/`;
const CDN = 'https://cdn.example.com';

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: ID,
    title: 'Warehouse set',
    description: 'All night long',
    status: 'READY',
    fileName: 'set.mov',
    fileSize: 10n * 1024n ** 3n,
    mimeType: 'video/quicktime',
    sourceKey: `uploads/${ID}/source`,
    uploadId: null,
    partSize: null,
    customThumbnailKey: null,
    progress: 100,
    attempts: 0,
    failureReason: null,
    durationSec: 36_000.5,
    width: 1080,
    height: 1920,
    hlsPrefix: PREFIX,
    posterKey: `${PREFIX}poster.jpg`,
    // Stored in encode order; deliberately not highest-first.
    renditions: [
      { name: '480p', width: 480, height: 854, bandwidth: 1_800_000 },
      { name: '1080p', width: 1080, height: 1920, bandwidth: 5_600_000 },
      { name: '720p', width: 720, height: 1280, bandwidth: 3_500_000 },
    ],
    lastActivityAt: new Date(),
    createdAt: new Date('2026-10-13T10:00:00Z'),
    updatedAt: new Date(),
    ...overrides,
  };
}

function setup(rows: Video[]) {
  const prisma = {
    video: {
      findUnique: jest.fn(async ({ where }) => rows.find((r) => r.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }) => rows.filter((r) => r.status === where.status)),
    },
  } as unknown as PrismaService;
  const storage = { publicUrl: (key: string | null) => (key ? `${CDN}/${key}` : null) } as unknown as StorageService;
  return { service: new PlaybackService(prisma, storage), prisma };
}

describe('PlaybackService.playback', () => {
  it('returns the master playlist, poster and duration of a READY video', async () => {
    const { service } = setup([video()]);
    expect(await service.playback(ID)).toMatchObject({
      id: ID,
      title: 'Warehouse set',
      status: 'READY',
      manifestUrl: `${CDN}/${PREFIX}master.m3u8`,
      posterUrl: `${CDN}/${PREFIX}poster.jpg`,
      durationSec: 36_000.5,
      width: 1080,
      height: 1920,
    });
  });

  it('lists renditions highest first, each with its own media playlist', async () => {
    const { service } = setup([video()]);
    const { renditions } = await service.playback(ID);
    expect(renditions.map((r) => r.name)).toEqual(['1080p', '720p', '480p']);
    expect(renditions[1]).toEqual({
      name: '720p',
      width: 720,
      height: 1280,
      bandwidth: 3_500_000,
      playlistUrl: `${CDN}/${PREFIX}720p/index.m3u8`,
    });
  });

  it('ignores malformed rendition entries instead of passing them to the player', async () => {
    const { service } = setup([video({ renditions: [{ name: '720p' }, 'junk', null] })]);
    expect((await service.playback(ID)).renditions).toEqual([]);
  });

  it.each(['UPLOADING', 'UPLOADED', 'PROCESSING', 'FAILED'] as const)(
    'reports %s with nothing playable',
    async (status) => {
      // A custom thumbnail and an older run's prefix can exist before READY; neither is exposed.
      const { service } = setup([video({ status, progress: 42, posterKey: 'x', hlsPrefix: PREFIX })]);
      expect(await service.playback(ID)).toMatchObject({
        status,
        progress: 42,
        manifestUrl: null,
        posterUrl: null,
        durationSec: null,
        renditions: [],
      });
    },
  );

  it('never exposes admin-only fields', async () => {
    const { service } = setup([video({ status: 'FAILED', failureReason: 'ffmpeg exited 1: /tmp/ugn/…' })]);
    const body = await service.playback(ID);
    for (const field of ['failureReason', 'fileName', 'fileSize', 'sourceKey', 'hlsPrefix']) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('404s for an unknown id', async () => {
    const { service } = setup([]);
    await expect(service.playback('0b7e6a62-1111-4c55-9a43-1f0a8a1c2b10')).rejects.toThrow(NotFoundException);
  });

  it('404s for a malformed id without querying the database', async () => {
    const { service, prisma } = setup([video()]);
    await expect(service.playback('not-a-uuid')).rejects.toThrow(NotFoundException);
    expect(prisma.video.findUnique).not.toHaveBeenCalled();
  });
});

describe('PlaybackService.library', () => {
  it('lists only READY videos, newest first and capped', async () => {
    const other = '0b7e6a62-1111-4c55-9a43-1f0a8a1c2b10';
    const { service, prisma } = setup([video(), video({ id: other, status: 'PROCESSING' })]);
    const list = await service.library();
    expect(list).toEqual([
      {
        id: ID,
        title: 'Warehouse set',
        durationSec: 36_000.5,
        posterUrl: `${CDN}/${PREFIX}poster.jpg`,
        width: 1080,
        height: 1920,
        createdAt: '2026-10-13T10:00:00.000Z',
      },
    ]);
    expect(prisma.video.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'READY' }, orderBy: { createdAt: 'desc' }, take: LIBRARY_LIMIT }),
    );
  });

  it('skips a READY row that is missing its output (never links to a dead player)', async () => {
    const { service } = setup([video({ hlsPrefix: null })]);
    expect(await service.library()).toEqual([]);
  });
});
