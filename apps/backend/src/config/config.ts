import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Validated once at startup so a bad env fails fast instead of on the first request. */
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 60 * 60),
  // Must be true behind HTTPS in production; false locally because localhost is plain HTTP.
  COOKIE_SECURE: bool.default('false'),
  // Omit S3_ENDPOINT (and set S3_FORCE_PATH_STYLE=false) to talk to real AWS S3.
  S3_ENDPOINT: z.string().url().optional(),
  // Host the *browser* uses to reach storage. Presigned URLs are signed for a specific host, so in
  // Docker (backend sees http://minio:9000, browser sees http://localhost:9000) they must differ.
  // Defaults to S3_ENDPOINT; leave both unset for AWS.
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  // Optional so production can use an IAM role instead of static keys.
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('false'),
  // Where browsers fetch public/ objects from: the bucket URL locally, the CloudFront domain in production.
  PUBLIC_MEDIA_BASE_URL: z.string().url(),
  // Presigned part URLs expire after this; the client re-signs anything unsent.
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(3600),
  // UPLOADING videos with no activity for this long are aborted and deleted. Comfortably longer
  // than a laptop closed overnight, shorter than the storage-level 48h abort rule (the backstop).
  ABANDONED_UPLOAD_TTL_HOURS: z.coerce.number().positive().default(24),
});

export type AppConfig = z.infer<typeof EnvSchema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}
