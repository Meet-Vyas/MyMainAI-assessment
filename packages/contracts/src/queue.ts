/** BullMQ queue shared by the backend (producer) and worker (consumer). */
export const VIDEO_QUEUE = 'video-processing';

export const VideoJobName = {
  PROCESS: 'process-video',
} as const;

export interface ProcessVideoJob {
  videoId: string;
  sourceKey: string;
}

/**
 * One BullMQ job per processing run. A repeated "complete" or a reconciler re-queue for the same
 * run maps to the same id, which BullMQ de-duplicates; an admin retry bumps the run number.
 * (BullMQ forbids ':' in custom ids.)
 */
export function processJobId(videoId: string, run: number): string {
  return `${videoId}-run${run}`;
}
