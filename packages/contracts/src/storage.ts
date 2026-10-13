/**
 * Object key layout, shared so the backend and worker always agree.
 *
 * uploads/   private: raw sources, reachable only through presigned URLs.
 * public/    anonymously readable (CDN origin): HLS output and posters.
 */
export const storageKeys = {
  uploadPrefix: (videoId: string) => `uploads/${videoId}/`,
  source: (videoId: string) => `uploads/${videoId}/source`,
  publicPrefix: (videoId: string) => `public/videos/${videoId}/`,
  customThumbnail: (videoId: string) => `public/videos/${videoId}/custom-thumbnail`,
  /** Parent of every processing output set for a video. */
  outputsPrefix: (videoId: string) => `public/videos/${videoId}/hls/`,
  /**
   * One processing run's output (master.m3u8, renditions, poster). Each run writes to a fresh
   * prefix and the DB pointer is switched only when the set is complete, so players never see a
   * half-written ladder and a retry can't overwrite files a CDN has already cached.
   */
  outputPrefix: (videoId: string, outputId: string) => `public/videos/${videoId}/hls/${outputId}/`,
};

/** File names inside an output prefix. */
export const HLS_MASTER_PLAYLIST = 'master.m3u8';
export const POSTER_FILE = 'poster.jpg';
