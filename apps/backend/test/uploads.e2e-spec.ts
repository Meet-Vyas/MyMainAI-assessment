import { createHash, randomBytes } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import {
  MiB,
  processJobId,
  VIDEO_QUEUE,
  type IncompleteUploadError,
  type InitUploadResponse,
  type SignPartsResponse,
  type ThumbnailUploadResponse,
  type UploadStatusResponse,
  type VideoDto,
} from '@ugn/contracts';

const API = process.env.E2E_API_URL ?? 'http://localhost:5173/api';
const ORIGIN = process.env.E2E_ORIGIN ?? 'http://localhost:5173';
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: process.env.E2E_S3_ENDPOINT ?? 'http://localhost:9000',
  forcePathStyle: true,
  credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
});
const BUCKET = 'ugn-videos';

let cookie = '';
const created: string[] = [];

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** Browsers upload Blobs (File.slice); copying into a plain Uint8Array also satisfies the DOM types. */
const toBlob = (bytes: Buffer) => new Blob([new Uint8Array(bytes)]);

/** PUT one part straight to storage, exactly as the browser will (no credentials, just the URL). */
async function putPart(url: string, bytes: Buffer): Promise<number> {
  const res = await fetch(url, { method: 'PUT', body: toBlob(bytes), headers: { origin: ORIGIN } });
  return res.status;
}

async function sign(id: string, partNumbers: number[]) {
  const res = await api<SignPartsResponse>('POST', `/admin/uploads/${id}/parts`, { partNumbers });
  expect(res.status).toBe(200);
  return new Map(res.body.parts.map((p) => [p.partNumber, p.url]));
}

async function objectSha256(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return createHash('sha256')
    .update(Buffer.from(await res.Body!.transformToByteArray()))
    .digest('hex');
}

beforeAll(async () => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@ugn.local', password: 'admin12345' }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});

afterAll(async () => {
  for (const id of created) await api('DELETE', `/admin/videos/${id}`);
});

describe('multipart upload (browser -> storage)', () => {
  // 3 parts: 16 MiB, 16 MiB, 1 MiB. Random bytes so a mis-ordered assembly would change the hash.
  const file = randomBytes(33 * MiB);
  const fileHash = createHash('sha256').update(file).digest('hex');
  let init: InitUploadResponse;
  const slice = (n: number, size = init.partSize) => file.subarray((n - 1) * init.partSize, (n - 1) * init.partSize + size);

  it('rejects a non-video file before any upload starts', async () => {
    const res = await api('POST', '/admin/uploads', { title: 'x', fileName: 'x.exe', fileSize: 10, mimeType: '' });
    expect(res.status).toBe(400);
  });

  it('starts an upload', async () => {
    const res = await api<InitUploadResponse>('POST', '/admin/uploads', {
      title: 'E2E set',
      fileName: 'e2e.mp4',
      fileSize: file.length,
      mimeType: 'video/mp4',
    });
    expect(res.status).toBe(201);
    init = res.body;
    created.push(init.video.id);
    expect(init).toMatchObject({ partSize: 16 * MiB, partCount: 3, video: { status: 'UPLOADING' } });
  });

  it('lets the browser origin PUT to presigned URLs (CORS preflight)', async () => {
    const urls = await sign(init.video.id, [1]);
    const res = await fetch(urls.get(1)!, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'PUT' },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toMatch(new RegExp(`^(\\*|${ORIGIN})$`));
  });

  it('simulates a dropped connection: part 1 is truncated, part 2 never sent', async () => {
    const urls = await sign(init.video.id, [1, 3]);
    expect(await putPart(urls.get(1)!, slice(1, MiB))).toBe(200); // cut short
    expect(await putPart(urls.get(3)!, file.subarray(2 * init.partSize))).toBe(200);
  });

  it('reports exactly which parts are stored, for resume', async () => {
    const res = await api<UploadStatusResponse>('GET', `/admin/uploads/${init.video.id}`);
    expect(res.status).toBe(200);
    expect(res.body.uploadedParts).toEqual([
      { partNumber: 1, size: MiB },
      { partNumber: 3, size: MiB },
    ]);
  });

  it('refuses to complete, naming the missing and truncated parts', async () => {
    const res = await api<IncompleteUploadError>('POST', `/admin/uploads/${init.video.id}/complete`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ missingParts: [2], wrongSizeParts: [1] });
  });

  it('resumes: re-sends only the bad parts, then completes', async () => {
    const urls = await sign(init.video.id, [1, 2]);
    expect(await putPart(urls.get(1)!, slice(1))).toBe(200); // re-upload replaces the truncated part
    expect(await putPart(urls.get(2)!, slice(2))).toBe(200);

    const res = await api<VideoDto>('POST', `/admin/uploads/${init.video.id}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('UPLOADED');
  });

  it('assembled the parts byte-for-byte in order', async () => {
    expect(await objectSha256(`uploads/${init.video.id}/source`)).toBe(fileHash);
  });

  it('queued exactly one processing job for run 0', async () => {
    const queue = new Queue(VIDEO_QUEUE, { connection: { url: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379' } });
    try {
      const job = await queue.getJob(processJobId(init.video.id, 0));
      expect(job?.data).toEqual({ videoId: init.video.id, sourceKey: `uploads/${init.video.id}/source`, run: 0 });
    } finally {
      await queue.close();
    }
  });

  it('treats a repeated complete as a no-op', async () => {
    const res = await api<VideoDto>('POST', `/admin/uploads/${init.video.id}/complete`);
    expect(res.status).toBe(200);
    // The worker may already have picked it up; the point is it's not back to UPLOADING.
    expect(res.body.status).not.toBe('UPLOADING');
  });

  it('stops signing once the upload is finished', async () => {
    const res = await api('POST', `/admin/uploads/${init.video.id}/parts`, { partNumbers: [1] });
    expect(res.status).toBe(409);
  });

  it('the worker rejects the random bytes (named .mp4) as not a video, without retrying', async () => {
    let video: VideoDto | undefined;
    for (let i = 0; i < 30 && video?.status !== 'FAILED'; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      video = (await api<VideoDto>('GET', `/admin/videos/${init.video.id}`)).body;
    }
    expect(video).toMatchObject({ status: 'FAILED', failureReason: 'Not a readable video file' });
  });
});

describe('custom thumbnail and cancel', () => {
  let id: string;

  beforeAll(async () => {
    const res = await api<InitUploadResponse>('POST', '/admin/uploads', {
      title: 'To cancel',
      fileName: 'cancel.mov',
      fileSize: 20 * MiB,
      mimeType: 'video/quicktime',
    });
    id = res.body.video.id;
    created.push(id);
    const urls = await sign(id, [1]);
    await putPart(urls.get(1)!, randomBytes(16 * MiB));
  });

  /** `declaredSize` lets a test lie to the API about the size, as a malicious client could. */
  async function postThumbnail(bytes: Buffer, contentType: string, declaredSize = bytes.length) {
    const presign = await api<ThumbnailUploadResponse>('POST', `/admin/uploads/${id}/thumbnail`, {
      contentType: 'image/jpeg',
      size: declaredSize,
    });
    expect(presign.status).toBe(200);
    const form = new FormData();
    for (const [k, v] of Object.entries(presign.body.fields)) form.append(k, v);
    form.set('Content-Type', contentType);
    form.append('file', toBlob(bytes));
    return (await fetch(presign.body.url, { method: 'POST', body: form })).status;
  }

  it('accepts a small JPEG through the presigned POST', async () => {
    expect(await postThumbnail(randomBytes(1000), 'image/jpeg')).toBe(204);
  });

  it('the API refuses to presign a thumbnail declared over 5 MiB', async () => {
    const res = await api('POST', `/admin/uploads/${id}/thumbnail`, { contentType: 'image/jpeg', size: 5 * MiB + 1 });
    expect(res.status).toBe(400);
  });

  it('storage itself rejects a client that lies about size or content type', async () => {
    expect(await postThumbnail(randomBytes(5 * MiB + 1), 'image/jpeg', 1000)).toBe(400);
    expect(await postThumbnail(randomBytes(1000), 'text/html')).toBe(403);
  });

  it('cancel aborts the multipart upload and removes every object', async () => {
    expect((await api('DELETE', `/admin/videos/${id}`)).status).toBe(204);
    expect((await api('GET', `/admin/uploads/${id}`)).status).toBe(404);
    const thumb = await fetch(`http://localhost:9000/${BUCKET}/public/videos/${id}/custom-thumbnail`);
    expect(thumb.status).toBe(404);
  });
});
