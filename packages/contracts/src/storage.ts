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
};
