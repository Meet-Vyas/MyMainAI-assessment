import { z } from 'zod';

/** Lifecycle of a video. Transitions are enforced by the backend and worker. */
export const VideoStatus = {
  UPLOADING: 'UPLOADING',
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
} as const;
export type VideoStatus = (typeof VideoStatus)[keyof typeof VideoStatus];

/**
 * Allowed status transitions. Anything not listed is a bug or a race (e.g. a stale worker
 * finishing a job for a video that was already retried), and is rejected.
 */
const TRANSITIONS: Record<VideoStatus, readonly VideoStatus[]> = {
  UPLOADING: ['UPLOADED'],
  UPLOADED: ['PROCESSING', 'FAILED'],
  // Back to UPLOADED when a crashed job is re-queued by the reconciler.
  PROCESSING: ['READY', 'FAILED', 'UPLOADED'],
  READY: [],
  // Admin "retry" re-queues processing.
  FAILED: ['UPLOADED'],
};

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** One HLS variant, as stored in Video.renditions. */
export interface Rendition {
  /** e.g. "720p"; also the variant's directory name inside the output prefix. */
  name: string;
  width: number;
  height: number;
  /** Peak video + audio bits per second, as advertised in the master playlist. */
  bandwidth: number;
}

/** Shape the API returns for a video. Dates are ISO strings, sizes are bytes. */
export interface VideoDto {
  id: string;
  title: string;
  description: string;
  status: VideoStatus;
  fileName: string;
  fileSize: number;
  mimeType: string;
  /** 0-100 while PROCESSING. */
  progress: number;
  failureReason: string | null;
  durationSec: number | null;
  posterUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export const VIDEO_TITLE_MAX = 120;
export const VIDEO_DESCRIPTION_MAX = 5000;

export const UpdateVideoRequestSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(VIDEO_TITLE_MAX),
    description: z.string().trim().max(VIDEO_DESCRIPTION_MAX),
  })
  .partial()
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateVideoRequest = z.infer<typeof UpdateVideoRequestSchema>;
