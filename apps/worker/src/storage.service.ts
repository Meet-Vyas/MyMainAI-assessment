import { Inject, Injectable } from '@nestjs/common';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { WORKER_CONFIG, type WorkerConfig } from './config';

/**
 * The worker's S3 operations. Works against MinIO or AWS depending only on env vars. Unlike the
 * backend it never signs URLs for a browser, so a single client (the in-network endpoint) is enough.
 */
@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(WORKER_CONFIG) config: WorkerConfig) {
    this.bucket = config.S3_BUCKET;
    this.s3 = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined, // default AWS chain (IAM role) in production
      // The SDK retries throttling, 5xx and network errors with backoff; a few more tries than
      // the default 3 because one failed PUT out of ~18,000 segments would fail a 10 h job.
      maxAttempts: 5,
      // Fail a request whose socket goes quiet instead of waiting forever (a dead connection
      // mid-download would otherwise hang the job while BullMQ keeps renewing its lock).
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 },
    });
  }

  /** Short-lived GET URL for ffprobe, which reads only the headers it needs via range requests. */
  presignGet(key: string, expiresInSec = 3600): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSec });
  }

  /** Streams an object to a local file without buffering it in memory. */
  async download(key: string, dest: string, onBytes: (total: number) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    let total = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        total += chunk.length;
        onBytes(total);
        done(null, chunk);
      },
    });
    await pipeline(res.Body as Readable, counter, createWriteStream(dest), { signal });
  }

  async uploadFile(
    key: string,
    path: string,
    headers: { contentType: string; cacheControl: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // A buffer, not a stream: the SDK can only retry a body it can send again. Output files
        // are at most a few MB (a 6 s segment at the 5 Mbit/s cap is ~4 MB).
        Body: await readFile(path),
        ContentType: headers.contentType,
        CacheControl: headers.cacheControl,
      }),
      { abortSignal: signal },
    );
  }

  /** Immediate "sub-directories" of a prefix, e.g. each processing run under .../hls/. */
  async listChildPrefixes(prefix: string): Promise<string[]> {
    const children: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }),
      );
      for (const p of page.CommonPrefixes ?? []) if (p.Prefix) children.push(p.Prefix);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return children;
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
