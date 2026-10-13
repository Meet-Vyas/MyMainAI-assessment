import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Validated once at startup so a bad env fails fast instead of on the first job. */
const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // One ffmpeg ladder encode already uses every core it's given; scale with more containers.
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  WORK_DIR: z.string().default('/tmp/ugn'),
  // Threads per rendition encoder. Bounds CPU and, more importantly, x264's per-thread frame memory.
  FFMPEG_THREADS: z.coerce.number().int().min(1).max(32).default(4),
  FFMPEG_PRESET: z
    .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'])
    .default('veryfast'),
  // Same meaning as in the backend; omit S3_ENDPOINT for real AWS S3.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('false'),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}
