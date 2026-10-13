import { z } from 'zod';
import { VIDEO_DESCRIPTION_MAX, VIDEO_TITLE_MAX, type VideoDto } from './video';

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;

/** Well above the 10 GB requirement: a 10-hour set at 8 Mbit/s is ~36 GB. */
export const MAX_UPLOAD_BYTES = 50 * GiB;

/** S3 limits: every part except the last must be >= 5 MiB, and an upload has at most 10,000 parts. */
export const S3_MIN_PART_SIZE = 5 * MiB;
export const S3_MAX_PARTS = 10_000;

/**
 * 16 MiB parts: a 10 GB file is ~600 parts. On a 20 Mbit/s home uplink one part takes ~7 s, so a
 * dropped connection loses at most a few seconds of work per in-flight part, while the part count
 * (and therefore signing round-trips and S3 request cost) stays small.
 */
export const DEFAULT_PART_SIZE = 16 * MiB;

/** Max part URLs signed per request, so the client can sign in batches ahead of the uploader. */
export const MAX_SIGN_BATCH = 100;

export function choosePartSize(fileSize: number): number {
  // Grow parts (in whole MiB) only if the default would exceed S3's 10,000-part limit.
  const smallestAllowed = Math.ceil(fileSize / S3_MAX_PARTS / MiB) * MiB;
  return Math.max(DEFAULT_PART_SIZE, smallestAllowed);
}

export function partCount(fileSize: number, partSize: number): number {
  return Math.max(1, Math.ceil(fileSize / partSize));
}

/** Byte size a given part must have: partSize for all but the last, the remainder for the last. */
export function expectedPartSize(partNumber: number, fileSize: number, partSize: number): number {
  const count = partCount(fileSize, partSize);
  return partNumber < count ? partSize : fileSize - partSize * (count - 1);
}

/** Containers ffmpeg handles well. The real check is ffprobe on the uploaded bytes (worker). */
export const VIDEO_EXTENSIONS: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
};

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Cheap pre-upload check on the name and declared type. Browsers often report '' or
 * application/octet-stream for .mkv, so those are accepted when the extension is a video one.
 */
export function isAcceptableVideoFile(fileName: string, mimeType: string): boolean {
  if (!(fileExtension(fileName) in VIDEO_EXTENSIONS)) return false;
  return mimeType === '' || mimeType === 'application/octet-stream' || mimeType.startsWith('video/');
}

export const InitUploadRequestSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(VIDEO_TITLE_MAX),
    description: z.string().trim().max(VIDEO_DESCRIPTION_MAX).default(''),
    // Keep only the base name; some browsers include a fake path.
    fileName: z
      .string()
      .transform((n) => n.split(/[\\/]/).pop()!.trim())
      .pipe(z.string().min(1).max(255)),
    fileSize: z
      .number()
      .int()
      .positive('File is empty')
      .max(MAX_UPLOAD_BYTES, `File is larger than ${MAX_UPLOAD_BYTES / GiB} GiB`),
    mimeType: z.string().max(255).default(''),
  })
  .refine((v) => isAcceptableVideoFile(v.fileName, v.mimeType), {
    message: `Unsupported file type. Allowed: ${Object.keys(VIDEO_EXTENSIONS).join(', ')}`,
    path: ['fileName'],
  });
export type InitUploadRequest = z.input<typeof InitUploadRequestSchema>;

export interface InitUploadResponse {
  video: VideoDto;
  partSize: number;
  partCount: number;
}

export const SignPartsRequestSchema = z.object({
  partNumbers: z
    .array(z.number().int().min(1).max(S3_MAX_PARTS))
    .min(1)
    .max(MAX_SIGN_BATCH)
    .transform((nums) => [...new Set(nums)].sort((a, b) => a - b)),
});
export type SignPartsRequest = z.input<typeof SignPartsRequestSchema>;

export interface SignPartsResponse {
  parts: { partNumber: number; url: string }[];
  /** URLs stop working after this; the client re-signs any part it hasn't sent by then. */
  expiresAt: string;
}

/** What the client needs to resume: which parts are already safely in storage. */
export interface UploadStatusResponse {
  videoId: string;
  fileName: string;
  fileSize: number;
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; size: number }[];
}

/** 409 body from /complete when parts are missing or the wrong size; re-upload these and retry. */
export interface IncompleteUploadError {
  message: string;
  missingParts: number[];
  wrongSizeParts: number[];
}

export const THUMBNAIL_MAX_BYTES = 5 * MiB;
export const THUMBNAIL_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const ThumbnailUploadRequestSchema = z.object({
  contentType: z.enum(THUMBNAIL_TYPES, { message: 'Thumbnail must be JPEG, PNG or WebP' }),
  size: z.number().int().positive().max(THUMBNAIL_MAX_BYTES, 'Thumbnail must be 5 MiB or smaller'),
});
export type ThumbnailUploadRequest = z.infer<typeof ThumbnailUploadRequestSchema>;

/** Presigned POST: send a multipart/form-data POST to `url` with `fields` followed by the file. */
export interface ThumbnailUploadResponse {
  url: string;
  fields: Record<string, string>;
}
