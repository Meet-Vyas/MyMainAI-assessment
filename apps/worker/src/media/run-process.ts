import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** A child process (ffmpeg/ffprobe) that exited non-zero, was killed, or stopped making progress. */
export class ProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    /** Last few KB of stderr: where ffmpeg explains what went wrong. */
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export interface RunOptions {
  /** Aborting kills the process (job cancelled, video deleted, worker shutting down). */
  signal?: AbortSignal;
  /** Called per stdout line. When set, stdout isn't collected. */
  onLine?: (line: string) => void;
  /**
   * Kill the process if it prints nothing on stdout for this long. ffmpeg with `-progress` reports
   * twice a second, so silence means it's hung; without this a hung encode would hold its job
   * lock forever and the video would sit in PROCESSING.
   */
  idleTimeoutMs?: number;
  /**
   * Run at lower CPU priority (`nice`). The encoder saturates every core the container has; at
   * equal priority it starved the Node process for ~1 min in testing, long enough to miss a BullMQ
   * lock renewal and have the job handed out twice. Niced, the encoder only gets what's left over.
   */
  nice?: number;
}

const STDERR_TAIL_BYTES = 4096;

export function runProcess(command: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(opts.signal.reason);
    const child = opts.nice
      ? spawn('nice', ['-n', String(opts.nice), command, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killedFor: Error | undefined;

    const kill = (reason: Error) => {
      killedFor ??= reason;
      child.kill('SIGKILL');
    };
    const onAbort = () => kill(opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error('aborted'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = () => {
      if (!opts.idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => kill(new ProcessError(`${command} made no progress for ${opts.idleTimeoutMs! / 1000}s`, null, stderr)),
        opts.idleTimeoutMs,
      );
    };
    resetIdle();

    if (opts.onLine) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        resetIdle();
        opts.onLine!(line);
      });
    } else {
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        resetIdle();
        stdout += chunk;
      });
    }
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });

    const finish = () => {
      clearTimeout(idleTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      finish();
      reject(err); // e.g. ENOENT: binary not installed
    });
    child.on('close', (code, signal) => {
      finish();
      if (killedFor) return reject(killedFor);
      if (code === 0) return resolve(stdout);
      const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      reject(new ProcessError(`${command} ${how}: ${lastLine(stderr)}`, code, stderr));
    });
  });
}

/** The last non-empty stderr line, which is usually ffmpeg's actual error. */
export function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1]?.trim() ?? '';
}
