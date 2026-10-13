/** BullMQ queue shared by the backend (producer) and worker (consumer). */
export const VIDEO_QUEUE = 'video-processing';

export const VideoJobName = {
  PROCESS: 'process-video',
} as const;

export interface ProcessVideoJob {
  videoId: string;
  sourceKey: string;
  /**
   * The video's `attempts` value when this run was queued. The worker only acts while the row
   * still has this run number, so a job left over from before an admin retry is a no-op.
   */
  run: number;
}

/**
 * BullMQ options for every processing job, shared by the backend (on upload complete / retry)
 * and the worker's reconciler (re-queueing a lost job). Plain data, so contracts needn't depend
 * on BullMQ.
 */
export const PROCESS_JOB_OPTIONS = {
  // Transient failures (S3 blip, ffmpeg OOM-killed) get a few spaced-out retries; a file that
  // isn't a video fails permanently on the first attempt (the worker throws UnrecoverableError).
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  // Keep history long enough to debug, but don't let Redis grow forever.
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600 },
} as const;

/**
 * One BullMQ job per processing run. A repeated "complete" or a reconciler re-queue for the same
 * run maps to the same id, which BullMQ de-duplicates; an admin retry bumps the run number.
 * (BullMQ forbids ':' in custom ids.)
 */
export function processJobId(videoId: string, run: number): string {
  return `${videoId}-run${run}`;
}
