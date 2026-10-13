/** BullMQ queue shared by the backend (producer) and worker (consumer). */
export const VIDEO_QUEUE = 'video-processing';

export const VideoJobName = {
  PROCESS: 'process-video',
} as const;

export interface ProcessVideoJob {
  videoId: string;
  sourceKey: string;
}
