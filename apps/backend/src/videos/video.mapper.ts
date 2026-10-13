import type { Video } from '@ugn/db';
import type { VideoDto } from '@ugn/contracts';

export function toVideoDto(video: Video, publicUrl: (key: string | null) => string | null): VideoDto {
  return {
    id: video.id,
    title: video.title,
    description: video.description,
    status: video.status,
    fileName: video.fileName,
    // BigInt doesn't serialise to JSON. Number is exact up to 9 PB, far above any upload.
    fileSize: Number(video.fileSize),
    mimeType: video.mimeType,
    progress: video.progress,
    failureReason: video.failureReason,
    durationSec: video.durationSec,
    posterUrl: publicUrl(video.posterKey),
    createdAt: video.createdAt.toISOString(),
    updatedAt: video.updatedAt.toISOString(),
  };
}
