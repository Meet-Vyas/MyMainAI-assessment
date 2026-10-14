import type { Video } from '@ugn/db';
import {
  HLS_MASTER_PLAYLIST,
  HLS_VARIANT_PLAYLIST,
  type PlaybackRendition,
  type PlaybackResponse,
  type PublicVideoSummary,
  type Rendition,
} from '@ugn/contracts';

type PublicUrl = (key: string | null) => string | null;

/** A row is only playable once the worker has switched it to READY with a complete output set. */
function isPlayable(video: Video): video is Video & { hlsPrefix: string; durationSec: number; width: number; height: number } {
  return (
    video.status === 'READY' &&
    video.hlsPrefix !== null &&
    video.durationSec !== null &&
    video.width !== null &&
    video.height !== null
  );
}

/** `renditions` is a JSON column, so check its shape rather than trusting a cast. */
function readRenditions(json: unknown): Rendition[] {
  if (!Array.isArray(json)) return [];
  return json.filter(
    (r): r is Rendition =>
      typeof r === 'object' &&
      r !== null &&
      typeof r.name === 'string' &&
      typeof r.width === 'number' &&
      typeof r.height === 'number' &&
      typeof r.bandwidth === 'number',
  );
}

export function toPlaybackResponse(video: Video, publicUrl: PublicUrl): PlaybackResponse {
  const base = {
    id: video.id,
    title: video.title,
    description: video.description,
    status: video.status,
    progress: video.progress,
  };
  if (!isPlayable(video)) {
    // A poster can exist before READY (a custom thumbnail), but nothing on the page uses it yet.
    return { ...base, manifestUrl: null, posterUrl: null, durationSec: null, width: null, height: null, renditions: [] };
  }
  const renditions: PlaybackRendition[] = readRenditions(video.renditions)
    .sort((a, b) => b.bandwidth - a.bandwidth)
    .map((r) => ({ ...r, playlistUrl: publicUrl(`${video.hlsPrefix}${r.name}/${HLS_VARIANT_PLAYLIST}`)! }));
  return {
    ...base,
    manifestUrl: publicUrl(video.hlsPrefix + HLS_MASTER_PLAYLIST),
    posterUrl: publicUrl(video.posterKey),
    durationSec: video.durationSec,
    width: video.width,
    height: video.height,
    renditions,
  };
}

/** Null for anything that isn't playable, so the list can never link to a dead player. */
export function toPublicSummary(video: Video, publicUrl: PublicUrl): PublicVideoSummary | null {
  if (!isPlayable(video)) return null;
  return {
    id: video.id,
    title: video.title,
    durationSec: video.durationSec,
    posterUrl: publicUrl(video.posterKey),
    width: video.width,
    height: video.height,
    createdAt: video.createdAt.toISOString(),
  };
}
