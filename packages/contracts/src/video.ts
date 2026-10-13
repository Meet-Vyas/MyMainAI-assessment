/** Lifecycle of a video. Transitions are enforced by the backend and worker. */
export const VideoStatus = {
  UPLOADING: 'UPLOADING',
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;
export type VideoStatus = (typeof VideoStatus)[keyof typeof VideoStatus];
