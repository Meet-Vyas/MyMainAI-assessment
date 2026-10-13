import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  NoSuchUpload,
  S3Client,
} from '@aws-sdk/client-s3';
import { APP_CONFIG, type AppConfig } from '../config/config';

/** Thin wrapper over S3. Works against MinIO or AWS depending only on env vars. */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  readonly s3: S3Client;
  readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.bucket = config.S3_BUCKET;
    this.s3 = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined, // fall back to the default AWS chain (IAM role, profile, ...)
    });
  }

  /** Public URL for an object under public/, or null. */
  publicUrl(key: string | null): string | null {
    return key ? `${this.config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, '')}/${key}` : null;
  }

  /** Deletes every object under a prefix, a page (max 1000 keys) at a time. Returns the count. */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        const res = await this.s3.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        if (res.Errors?.length) {
          throw new Error(`Failed to delete ${res.Errors.length} objects under ${prefix}: ${res.Errors[0].Message}`);
        }
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  /** Aborts a multipart upload so its parts stop costing storage. Already-gone uploads are fine. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
      if (err instanceof NoSuchUpload) return;
      throw err;
    }
    this.logger.log(`aborted multipart upload for ${key}`);
  }
}
