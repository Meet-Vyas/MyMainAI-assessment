import type { VideoStatus } from './video';

/** Redis pub/sub channel carrying VideoEvent JSON from the backend and worker to SSE clients. */
export const VIDEO_EVENTS_CHANNEL = 'video-events';

/**
 * Small, frequent events. `status`/`progress` let the UI update a progress bar without a refetch;
 * the client refetches the full video when the status changes or the video is new to it.
 */
export type VideoEvent =
  | { kind: 'changed'; videoId: string; status?: VideoStatus; progress?: number }
  | { kind: 'deleted'; videoId: string };
