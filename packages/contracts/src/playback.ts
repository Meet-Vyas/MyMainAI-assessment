import type { Rendition, VideoStatus } from './video';

/**
 * Public, unauthenticated shapes. They deliberately leave out admin-only fields (file name, size,
 * failure details), since anyone with a link can read them.
 */

/** One card in the public library. Only READY videos are listed. */
export interface PublicVideoSummary {
  id: string;
  title: string;
  durationSec: number;
  posterUrl: string | null;
  /** Display size after rotation, so portrait videos can be laid out before anything loads. */
  width: number;
  height: number;
  createdAt: string;
}

export interface PlaybackRendition extends Rendition {
  /**
   * This rendition's own media playlist. Native HLS players (Safari, iOS) give scripts no way to
   * pick a rendition from the master, so a manual quality choice there plays this URL instead.
   */
  playlistUrl: string;
}

/**
 * `GET /videos/:id/playback`. Every field past `status` is null (or empty) until the video is READY,
 * so the page can show "processing" or "failed" from the same response.
 */
export interface PlaybackResponse {
  id: string;
  title: string;
  description: string;
  status: VideoStatus;
  /** 0-100 while PROCESSING. */
  progress: number;
  /** HLS master playlist: the URL to hand to a player (native or hls.js) for automatic switching. */
  manifestUrl: string | null;
  posterUrl: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Highest quality first. */
  renditions: PlaybackRendition[];
}
