import { describe, expect, it, vi } from 'vitest';
import { expectedPartSize, type VideoDto } from '@ugn/contracts';
import { ApiError } from '../lib/api';
import { PartUploadError, UploadEngine, type PutPart, type UploadApi, type UploadPhase } from './UploadEngine';

const PART = 10;
const FILE_SIZE = 25; // parts: 10, 10, 5
const file = new Blob([new Uint8Array(FILE_SIZE)]);

/** Fake server + storage that behaves like the real API (409 on gaps, 403 on stale URLs). */
function fakeServer(initial: Record<number, number> = {}) {
  const stored = new Map(Object.entries(initial).map(([n, s]) => [Number(n), s]));
  let urlVersion = 0;
  const validUrls = new Set<string>();
  const api: UploadApi = {
    status: vi.fn(async () => ({
      videoId: 'v1',
      fileName: 'set.mp4',
      fileSize: FILE_SIZE,
      partSize: PART,
      partCount: 3,
      uploadedParts: [...stored].map(([partNumber, size]) => ({ partNumber, size })),
    })),
    signParts: vi.fn(async (_id: string, nums: number[]) => {
      urlVersion++;
      const parts = nums.map((n) => ({ partNumber: n, url: `part${n}-v${urlVersion}` }));
      parts.forEach((p) => validUrls.add(p.url));
      return { parts, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    }),
    complete: vi.fn(async () => {
      const missing = [1, 2, 3].filter((n) => stored.get(n) !== expectedPartSize(n, FILE_SIZE, PART));
      if (missing.length) {
        throw new ApiError(409, { message: 'incomplete', missingParts: missing, wrongSizeParts: [] }, 'incomplete');
      }
      return { id: 'v1', status: 'UPLOADED' } as VideoDto;
    }),
  };
  /** Per-call behaviour override; default stores the part. */
  let behaviour: (n: number, call: number) => 'ok' | number | 'hang' = () => 'ok';
  const calls: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const putPart: PutPart = vi.fn(async (url, body, onProgress, signal) => {
    const n = Number(/part(\d+)/.exec(url)![1]);
    calls.push(n);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const outcome = behaviour(n, calls.filter((c) => c === n).length);
      if (outcome === 'hang') {
        onProgress(body.size / 2);
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))));
      }
      if (typeof outcome === 'number') throw new PartUploadError(outcome);
      if (!validUrls.has(url)) throw new PartUploadError(403);
      await Promise.resolve();
      onProgress(body.size);
      stored.set(n, body.size);
    } finally {
      inFlight--;
    }
  });
  return {
    api,
    putPart,
    stored,
    calls,
    maxInFlight: () => maxInFlight,
    expireUrls: () => validUrls.clear(),
    setBehaviour: (b: typeof behaviour) => (behaviour = b),
  };
}

function engine(server: ReturnType<typeof fakeServer>, opts: Partial<ConstructorParameters<typeof UploadEngine>[4]> = {}) {
  const e = new UploadEngine('v1', file, server.api, server.putPart, {
    sleep: async (_ms, signal) => {
      if (signal.aborted) throw new DOMException('', 'AbortError');
    },
    waitForOnline: async () => undefined,
    isOnline: () => true,
    emitIntervalMs: 0,
    ...opts,
  });
  const phases: UploadPhase[] = [];
  e.subscribe((s) => phases.at(-1) !== s.phase && phases.push(s.phase));
  return { e, phases };
}

describe('UploadEngine', () => {
  it('uploads every part, completes, and reports 100%', async () => {
    const server = fakeServer();
    const { e, phases } = engine(server);
    await e.start();
    expect(e.snapshot()).toMatchObject({ phase: 'done', uploadedBytes: FILE_SIZE, partsDone: 3 });
    expect(server.calls.sort()).toEqual([1, 2, 3]);
    expect(server.api.complete).toHaveBeenCalledOnce();
    expect(phases).toEqual(['paused', 'preparing', 'uploading', 'completing', 'done']);
  });

  it('signs URLs in a batch instead of once per part', async () => {
    const server = fakeServer();
    await engine(server).e.start();
    expect(server.api.signParts).toHaveBeenCalledOnce();
    expect(server.api.signParts).toHaveBeenCalledWith('v1', [1, 2, 3]);
  });

  it('resumes from what the server has, re-sending only missing and truncated parts', async () => {
    const server = fakeServer({ 1: 10, 2: 4 /* cut short by a dropped connection */, 3: 5 });
    await engine(server).e.start();
    expect(server.calls).toEqual([2]);
    expect(server.stored.get(2)).toBe(10);
    // Caught up front from the status sizes, not later via a 409 from /complete.
    expect(server.api.complete).toHaveBeenCalledOnce();
  });

  it('never more than `concurrency` parts in flight', async () => {
    const server = fakeServer();
    await engine(server, { concurrency: 2 }).e.start();
    expect(server.maxInFlight()).toBeLessThanOrEqual(2);
  });

  it('keeps retrying through network errors instead of failing', async () => {
    const server = fakeServer();
    server.setBehaviour((n, call) => (n === 1 && call <= 8 ? 0 : 'ok'));
    const { e, phases } = engine(server);
    await e.start();
    expect(e.snapshot().phase).toBe('done');
    expect(phases).toContain('reconnecting');
    expect(server.calls.filter((n) => n === 1)).toHaveLength(9);
  });

  it('re-signs and retries when a presigned URL has expired (403)', async () => {
    const server = fakeServer();
    server.expireUrls();
    let expired = false;
    server.setBehaviour(() => {
      if (!expired) {
        expired = true;
        server.expireUrls();
      }
      return 'ok';
    });
    const { e } = engine(server);
    await e.start();
    expect(e.snapshot().phase).toBe('done');
    expect((server.api.signParts as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it('gives up on a part after repeated server errors and explains why', async () => {
    const server = fakeServer();
    server.setBehaviour((n) => (n === 2 ? 500 : 'ok'));
    const { e } = engine(server, { maxAttempts: 3 });
    await e.start();
    expect(e.snapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('Part 2 failed 3 times') });
    expect(server.api.complete).not.toHaveBeenCalled();
  });

  it('re-uploads parts the server reports missing at completion', async () => {
    const server = fakeServer();
    // Part 3 "succeeds" from the client's view, but storage lost it before completion.
    const realComplete = server.api.complete;
    let first = true;
    server.api.complete = vi.fn(async (id: string) => {
      if (first) {
        first = false;
        server.stored.delete(3);
      }
      return realComplete(id);
    });
    const { e } = engine(server);
    await e.start();
    expect(e.snapshot().phase).toBe('done');
    expect(server.calls.filter((n) => n === 3)).toHaveLength(2);
  });

  it('pause aborts in-flight parts; resume asks the server and finishes the rest', async () => {
    const server = fakeServer();
    server.setBehaviour((n, call) => (n === 2 && call === 1 ? 'hang' : 'ok'));
    const { e } = engine(server);
    const run = e.start();
    await vi.waitFor(() => expect(server.stored.size).toBe(2)); // parts 1 and 3 done, 2 hanging
    e.pause();
    await run;
    expect(e.snapshot()).toMatchObject({ phase: 'paused', uploadedBytes: 15 }); // half-sent part 2 discarded

    await e.start();
    expect(e.snapshot().phase).toBe('done');
    expect(server.api.status).toHaveBeenCalledTimes(2);
    expect(server.calls.filter((n) => n === 1)).toHaveLength(1); // not re-sent
  });

  it('turns an expired session into an actionable message', async () => {
    const server = fakeServer();
    server.api.status = vi.fn(async () => {
      throw new ApiError(401, {}, 'Unauthorized');
    });
    const { e } = engine(server);
    await e.start();
    expect(e.snapshot()).toMatchObject({ phase: 'error', error: expect.stringMatching(/session expired/i) });
  });

  it('cancel stops for good', async () => {
    const server = fakeServer();
    server.setBehaviour(() => 'hang');
    const { e } = engine(server);
    const run = e.start();
    await vi.waitFor(() => expect(server.calls.length).toBeGreaterThan(0));
    e.cancel();
    await run;
    await e.start();
    expect(e.snapshot().phase).toBe('cancelled');
    expect(server.api.status).toHaveBeenCalledOnce();
  });
});
