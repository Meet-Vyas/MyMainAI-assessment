import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  NoSuchUpload,
  NotFound,
  S3Client,
  UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG, type AppConfig } from '../config/config';

export interface UploadedPart {
  partNumber: number;
  size: number;
  etag: string;
}

/** Thin wrapper over S3. Works against MinIO or AWS depending only on env vars. */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  /** For calls the backend makes itself. */
  readonly s3: S3Client;
  /** Only for signing URLs the browser will use (see S3_PUBLIC_ENDPOINT). Never sends requests. */
  private readonly presigner: S3Client;
  readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.bucket = config.S3_BUCKET;
    const base: S3ClientConfig = {
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined, // fall back to the default AWS chain (IAM role, profile, ...)
      // Newer SDKs add a CRC32 checksum to every request by default. On a presigned UploadPart URL
      // that checksum is computed over an empty body, so the browser's real upload would fail.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.s3 = new S3Client({ ...base, endpoint: config.S3_ENDPOINT });
    this.presigner = new S3Client({ ...base, endpoint: config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT });
  }

  /** Public URL for an object under public/, or null. */
  publicUrl(key: string | null): string | null {
    return key ? `${this.config.PUBLIC_MEDIA_BASE_URL.replace(/\/$/, '')}/${key}` : null;
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error(`S3 returned no UploadId for ${key}`);
    return res.UploadId;
  }

  /** Short-lived URL the browser PUTs one part's bytes to. Grants nothing else. */
  presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: this.config.UPLOAD_URL_TTL_SECONDS },
    );
  }

  /** Every part S3 has for an upload, following pagination (1,000 parts per page). */
  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.s3.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
      );
      for (const p of page.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, size: p.Size ?? 0, etag: p.ETag });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
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

  /** Object size in bytes, or null if it doesn't exist. */
  async objectSize(key: string): Promise<number | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ContentLength ?? 0;
    } catch (err) {
      if (err instanceof NotFound) return null;
      throw err;
    }
  }

  /**
   * Presigned POST for a small file. Unlike a presigned PUT, the policy lets storage itself enforce
   * the size limit and exact content type, so the browser can't upload something else.
   */
  presignSmallUpload(key: string, contentType: string, maxBytes: number) {
    return createPresignedPost(this.presigner, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: 15 * 60,
    });
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
}
