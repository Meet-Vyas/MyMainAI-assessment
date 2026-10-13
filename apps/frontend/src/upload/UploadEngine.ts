import {
  expectedPartSize,
  MAX_SIGN_BATCH,
  type IncompleteUploadError,
  type SignPartsResponse,
  type UploadStatusResponse,
  type VideoDto,
} from '@ugn/contracts';
import { ApiError } from '../lib/api';

export type UploadPhase =
  | 'preparing' // asking the server which parts it already has
  | 'uploading'
  | 'reconnecting' // network is down; waiting and retrying on its own
  | 'paused'
  | 'completing'
  | 'done'
  | 'error' // needs the user (resume, or start over)
  | 'cancelled';

export interface UploadSnapshot {
  phase: UploadPhase;
  uploadedBytes: number;
  totalBytes: number;
  partsDone: number;
  partCount: number;
  /** Bytes/s over the last few seconds; null until there's enough data. */
  speedBps: number | null;
  etaSec: number | null;
  error: string | null;
}

/** The server calls the engine needs. Injected so tests can fake them. */
export interface UploadApi {
  status(videoId: string): Promise<UploadStatusResponse>;
  signParts(videoId: string, partNumbers: number[]): Promise<SignPartsResponse>;
  complete(videoId: string): Promise<VideoDto>;
}

/** Thrown by PutPart. status 0 = no response (offline, reset, stalled). */
export class PartUploadError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? 'Network error' : `Storage responded ${status}`);
  }
}

/** Sends one part's bytes to a presigned URL, reporting bytes sent so far. */
export type PutPart = (url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) => Promise<void>;

export interface EngineOptions {
  /**
   * Parts in flight at once. 4 x 16 MiB keeps a typical home uplink saturated (one TCP stream
   * rarely does on its own) while capping what a pause or a drop throws away at 64 MiB.
   */
  concurrency: number;
  /** Attempts per part for server-side failures. Network failures retry indefinitely. */
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  /** Re-sign a URL if it expires within this window, so a slow part never starts on a dying URL. */
  resignMarginMs: number;
  speedWindowMs: number;
  emitIntervalMs: number;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  isOnline: () => boolean;
  /** Resolves when the browser reports it's back online (or after `ms` as a fallback probe). */
  waitForOnline: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

export const defaultOptions: EngineOptions = {
  concurrency: 4,
  maxAttempts: 6,
  baseRetryMs: 1000,
  maxRetryMs: 30_000,
  resignMarginMs: 5 * 60_000,
  speedWindowMs: 8_000,
  emitIntervalMs: 200,
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(t), reject(abortError())), { once: true });
    }),
  isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine),
  waitForOnline: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const done = () => {
        clearTimeout(t);
        window.removeEventListener('online', done);
        resolve();
      };
      const t = setTimeout(done, ms);
      window.addEventListener('online', done, { once: true });
      signal.addEventListener('abort', () => (done(), reject(abortError())), { once: true });
    }),
};

/**
 * Uploads one file to an existing multipart upload. The server's part list is the source of truth:
 * every (re)start asks it what's stored, so resuming after a pause, a crash or a page reload is
 * the same code path as starting fresh. File.slice() is lazy, so a 10 GB file is never read into
 * memory; at most `concurrency` parts are being read at a time.
 */
export class UploadEngine {
  private readonly opts: EngineOptions;
  private readonly listeners = new Set<(s: UploadSnapshot) => void>();

  private phase: UploadPhase = 'paused';
  private error: string | null = null;
  private partSize = 0;
  private partCount = 0;
  /** Completed part number -> bytes. */
  private done = new Map<number, number>();
  /** In-flight part number -> bytes sent so far. */
  private inflight = new Map<number, number>();
  private urls = new Map<number, { url: string; expiresAt: number }>();
  private signing: Promise<void> | null = null;

  /** Bumped on every start/pause so stragglers from an old run can tell they're stale. */
  private runId = 0;
  private controller = new AbortController();

  /** Bytes actually sent this session (never decreases), for speed; samples are [time, bytes]. */
  private transferred = 0;
  private samples: [number, number][] = [];
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly videoId: string,
    private readonly file: Blob,
    private readonly api: UploadApi,
    private readonly putPart: PutPart,
    options: Partial<EngineOptions> = {},
  ) {
    this.opts = { ...defaultOptions, ...options };
  }

  subscribe(listener: (s: UploadSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): UploadSnapshot {
    const uploadedBytes = this.uploadedBytes();
    const speedBps = this.speed();
    const remaining = this.file.size - uploadedBytes;
    return {
      phase: this.phase,
      uploadedBytes,
      totalBytes: this.file.size,
      partsDone: this.done.size,
      partCount: this.partCount,
      speedBps: this.phase === 'uploading' ? speedBps : null,
      etaSec: this.phase === 'uploading' && speedBps ? remaining / speedBps : null,
      error: this.error,
    };
  }

  get isActive(): boolean {
    return ['preparing', 'uploading', 'reconnecting', 'completing'].includes(this.phase);
  }

  /** Starts, or resumes from whatever the server already has. Resolves when the run ends. */
  async start(): Promise<void> {
    if (this.isActive || this.phase === 'done' || this.phase === 'cancelled') return;
    const runId = ++this.runId;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.error = null;
    this.samples = [];
    this.setPhase('preparing');

    try {
      const status = await this.callApi(() => this.api.status(this.videoId), signal);
      this.partSize = status.partSize;
      this.partCount = status.partCount;
      this.done.clear();
      for (const p of status.uploadedParts) {
        // A part cut short by a dropped connection is stored but wrong; send it again.
        if (p.size === expectedPartSize(p.partNumber, this.file.size, this.partSize)) {
          this.done.set(p.partNumber, p.size);
        }
      }

      for (let round = 0; ; round++) {
        const pending = this.pendingParts();
        if (pending.length) {
          this.setPhase('uploading');
          await this.uploadAll(pending, signal);
        }
        this.setPhase('completing');
        try {
          await this.callApi(() => this.api.complete(this.videoId), signal);
          this.setPhase('done');
          return;
        } catch (err) {
          // The server checked storage and found gaps we didn't know about: send those parts again.
          const gaps = err instanceof ApiError && err.status === 409 ? (err.body as IncompleteUploadError) : null;
          if (!gaps?.missingParts || round >= 2) throw err;
          for (const n of [...gaps.missingParts, ...gaps.wrongSizeParts]) this.done.delete(n);
        }
      }
    } catch (err) {
      // pause()/cancel() bump runId. Our own abort after a fatal part error does not, so that
      // error still surfaces below instead of leaving the engine stuck in 'uploading'.
      if (runId !== this.runId) return;
      this.controller.abort();
      this.inflight.clear();
      this.error = describeError(err);
      this.setPhase('error');
    }
  }

  /** Stops sending. Bytes of in-flight parts are discarded; those parts are resent on resume. */
  pause() {
    if (!this.isActive || this.phase === 'completing') return;
    this.stop('paused');
  }

  /** Stops for good. Deleting the server-side upload is the caller's job. */
  cancel() {
    this.stop('cancelled');
  }

  private stop(phase: 'paused' | 'cancelled') {
    this.runId++;
    this.controller.abort();
    this.inflight.clear();
    this.signing = null;
    this.setPhase(phase);
  }

  private pendingParts(): number[] {
    const pending: number[] = [];
    for (let n = 1; n <= this.partCount; n++) if (!this.done.has(n)) pending.push(n);
    return pending;
  }

  /** Worker pool: `concurrency` loops pull part numbers from a shared queue. */
  private async uploadAll(pending: number[], signal: AbortSignal) {
    const queue = [...pending];
    const worker = async () => {
      while (queue.length && !signal.aborted) await this.uploadPart(queue.shift()!, signal);
    };
    const workers = Array.from({ length: Math.min(this.opts.concurrency, queue.length) }, worker);
    try {
      await Promise.all(workers);
    } catch (err) {
      this.controller.abort(); // one part failed for good: stop the others too
      throw err;
    }
    if (signal.aborted) throw abortError();
  }

  private async uploadPart(n: number, signal: AbortSignal) {
    const start = (n - 1) * this.partSize;
    const size = expectedPartSize(n, this.file.size, this.partSize);
    const body = this.file.slice(start, start + size);
    let serverFailures = 0;
    let networkFailures = 0;

    for (;;) {
      if (signal.aborted) throw abortError();
      if (!this.opts.isOnline()) {
        // Wait for the 'online' event, but try anyway after maxRetryMs: navigator.onLine can be wrong.
        this.setPhase('reconnecting');
        await this.opts.waitForOnline(this.opts.maxRetryMs, signal);
      }
      const url = await this.urlFor(n, signal);
      let lastLoaded = 0;
      try {
        await this.putPart(
          url,
          body,
          (loaded) => {
            this.transferred += Math.max(0, loaded - lastLoaded);
            lastLoaded = loaded;
            this.inflight.set(n, loaded);
            this.emit();
          },
          signal,
        );
        this.inflight.delete(n);
        this.done.set(n, size);
        if (this.phase === 'reconnecting') this.setPhase('uploading');
        this.emit();
        return;
      } catch (err) {
        this.inflight.delete(n);
        if (signal.aborted) throw abortError();
        const status = err instanceof PartUploadError ? err.status : 0;
        if (status === 0) {
          // Network trouble never fails the upload: back off (capped) and keep trying.
          networkFailures++;
          if (networkFailures >= 2) this.setPhase('reconnecting');
          await this.opts.sleep(this.backoff(networkFailures), signal);
          continue;
        }
        if (status === 403) this.urls.delete(n); // expired/invalid signature: re-sign and retry
        if (++serverFailures >= this.opts.maxAttempts) {
          throw new Error(`Part ${n} failed ${serverFailures} times (storage responded ${status})`);
        }
        await this.opts.sleep(this.backoff(serverFailures), signal);
      }
    }
  }

  /** A valid presigned URL for part n, signing a batch of upcoming parts when needed. */
  private async urlFor(n: number, signal: AbortSignal): Promise<string> {
    for (;;) {
      const cached = this.urls.get(n);
      if (cached && cached.expiresAt - this.opts.now() > this.opts.resignMarginMs) return cached.url;
      if (this.signing) {
        await this.signing; // another worker is already signing; it likely covers n too
        continue;
      }
      this.signing = this.signBatch(n, signal).finally(() => (this.signing = null));
      await this.signing;
      if (!this.urls.get(n)) throw new Error(`Server did not sign part ${n}`);
      return this.urls.get(n)!.url;
    }
  }

  private async signBatch(from: number, signal: AbortSignal) {
    const batch: number[] = [];
    for (let k = from; k <= this.partCount && batch.length < MAX_SIGN_BATCH; k++) {
      const cached = this.urls.get(k);
      const valid = cached && cached.expiresAt - this.opts.now() > this.opts.resignMarginMs;
      if (k === from || (!this.done.has(k) && !this.inflight.has(k) && !valid)) batch.push(k);
    }
    const res = await this.callApi(() => this.api.signParts(this.videoId, batch), signal);
    const expiresAt = new Date(res.expiresAt).getTime();
    for (const p of res.parts) this.urls.set(p.partNumber, { url: p.url, expiresAt });
  }

  /** API calls retry through network blips; real errors (401, 404, 410...) surface immediately. */
  private async callApi<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw abortError();
      try {
        return await fn();
      } catch (err) {
        const retryable = err instanceof ApiError && (err.isNetworkError || err.status >= 500);
        if (!retryable || (!err.isNetworkError && attempt >= this.opts.maxAttempts)) throw err;
        if (err.isNetworkError && attempt >= 2) this.setPhase('reconnecting');
        await this.opts.sleep(this.backoff(attempt), signal);
      }
    }
  }

  /** Exponential backoff with full jitter, so many clients don't retry in lockstep. */
  private backoff(attempt: number): number {
    const ceiling = Math.min(this.opts.maxRetryMs, this.opts.baseRetryMs * 2 ** (attempt - 1));
    return ceiling / 2 + Math.random() * (ceiling / 2);
  }

  private uploadedBytes(): number {
    let total = 0;
    for (const size of this.done.values()) total += size;
    for (const loaded of this.inflight.values()) total += loaded;
    return Math.min(total, this.file.size);
  }

  private speed(): number | null {
    if (this.samples.length < 2) return null;
    const [t0, b0] = this.samples[0];
    const [t1, b1] = this.samples[this.samples.length - 1];
    // Need a couple of seconds of data, or the first burst into the socket buffer looks huge.
    if (t1 - t0 < 2000) return null;
    return ((b1 - b0) / (t1 - t0)) * 1000;
  }

  private setPhase(phase: UploadPhase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit(true);
  }

  /** Throttled to `emitIntervalMs` (phase changes go out immediately) so React isn't flooded. */
  private emit(force = false) {
    const now = this.opts.now();
    this.samples.push([now, this.transferred]);
    while (this.samples.length > 2 && now - this.samples[0][0] > this.opts.speedWindowMs) this.samples.shift();

    if (!force && now - this.lastEmit < this.opts.emitIntervalMs) {
      this.emitTimer ??= setTimeout(() => {
        this.emitTimer = null;
        this.emit(true);
      }, this.opts.emitIntervalMs);
      return;
    }
    this.lastEmit = now;
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session expired. Log in again, then resume.';
    if (err.status === 404) return 'This upload no longer exists.';
    if (err.status === 410) return 'This upload expired. Please start it again.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Upload failed';
}
