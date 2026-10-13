/**
 * How each phase maps onto the 0-100 bar the admin sees. Encoding dominates the wall-clock time
 * (hours for a 10 h video); download and upload are minutes on a cloud network.
 */
const PHASES = {
  download: [0, 5],
  encode: [5, 90],
  upload: [90, 99],
} as const;
export type Phase = keyof typeof PHASES;

export function overallProgress(phase: Phase, fraction: number): number {
  const [from, to] = PHASES[phase];
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.floor(from + (to - from) * clamped);
}

export interface ProgressReporterOptions {
  /**
   * Writes progress. Returns false when the video no longer belongs to this run (deleted or
   * retried), which stops the reporter and calls onLost.
   */
  write: (progress: number, changed: boolean) => Promise<boolean>;
  onLost: () => void;
  /** How often to check for something to write. */
  tickMs?: number;
  /** Write even when the number hasn't moved, so the row's updatedAt works as a liveness signal. */
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * Throttles progress writes: ffmpeg reports twice a second, but the DB and SSE clients only need
 * an update when the percentage moves, at most every couple of seconds. A slow phase still gets a
 * heartbeat write, which also checks the video hasn't been deleted in the meantime.
 */
export class ProgressReporter {
  private latest = 0;
  private written = -1;
  private lastWriteAt: number;
  private timer?: NodeJS.Timeout;
  private writing = false;
  private readonly tickMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: ProgressReporterOptions) {
    this.tickMs = opts.tickMs ?? 2_000;
    this.heartbeatMs = opts.heartbeatMs ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.lastWriteAt = this.now();
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  report(phase: Phase, fraction: number) {
    // Never move backwards (e.g. a late download callback after encoding started).
    this.latest = Math.max(this.latest, overallProgress(phase, fraction));
  }

  /** Exposed for tests; normally driven by the interval. */
  async tick(): Promise<void> {
    if (this.writing) return; // a slow DB write shouldn't pile up behind itself
    const changed = this.latest !== this.written;
    if (!changed && this.now() - this.lastWriteAt < this.heartbeatMs) return;
    this.writing = true;
    try {
      const progress = this.latest;
      const stillOurs = await this.opts.write(progress, changed);
      this.written = progress;
      this.lastWriteAt = this.now();
      if (!stillOurs) {
        this.stop();
        this.opts.onLost();
      }
    } catch {
      // A failed progress write isn't worth failing a multi-hour job over; try again next tick.
    } finally {
      this.writing = false;
    }
  }
}
