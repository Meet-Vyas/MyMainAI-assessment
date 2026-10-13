import { HLS_MASTER_PLAYLIST } from '@ugn/contracts';
import { AUDIO_KBPS, type PlannedRendition } from './ladder';
import { runProcess } from './run-process';

/**
 * 6 s segments (Apple's recommendation): small enough for a fast start and a quick seek (a seek to
 * 07:42:10 fetches one ~6 s segment per variant), large enough that a 10 h video stays at ~6,000
 * segments per variant rather than tens of thousands.
 */
export const SEGMENT_SECONDS = 6;
/** Keyframe every 2 s, forced, so every variant can be cut at the same 6 s boundaries. */
const KEYFRAME_SECONDS = 2;
/** ffmpeg prints progress twice a second; a minute of silence means it's stuck. */
const IDLE_TIMEOUT_MS = 60_000;
/** Below the worker's own Node process, which must keep renewing the job lock (see RunOptions.nice). */
const FFMPEG_NICE = 10;

export interface HlsOptions {
  input: string;
  outDir: string;
  ladder: PlannedRendition[];
  hasAudio: boolean;
  preset: string;
  threads: number;
}

/**
 * One ffmpeg process decodes the source once and encodes every variant from it, writing an HLS
 * VOD playlist per variant and a master playlist. Cheaper than one process per variant, which
 * would decode a 10 h source three times.
 */
export function hlsArgs(o: HlsOptions): string[] {
  const n = o.ladder.length;
  const split = `[0:v]split=${n}${o.ladder.map((_, i) => `[s${i}]`).join('')}`;
  // setsar=1: output square pixels at the planned display size, whatever the source's SAR was.
  const scales = o.ladder.map((r, i) => `[s${i}]scale=${r.width}:${r.height},setsar=1[v${i}]`);

  const args = ['-hide_banner', '-nostdin', '-y', '-i', o.input, '-filter_complex', [split, ...scales].join(';')];
  o.ladder.forEach((_, i) => {
    args.push('-map', `[v${i}]`);
    if (o.hasAudio) args.push('-map', '0:a:0');
  });

  args.push(
    '-c:v', 'libx264',
    '-preset', o.preset,
    // High profile + 8-bit 4:2:0: what every hardware decoder (and browser) handles. A 10-bit or
    // 4:2:2 camera file would otherwise play in desktop Chrome and fail on phones.
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    // Capped CRF: quality-targeted, with per-variant peaks below.
    '-crf', '21',
    // Keyframes on a fixed time grid, never on scene cuts, so segments align across variants and
    // a player can switch quality at any segment boundary.
    '-force_key_frames', `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`,
    '-sc_threshold', '0',
    '-threads', String(o.threads),
  );
  o.ladder.forEach((r, i) => {
    args.push(`-maxrate:v:${i}`, `${r.maxrateKbps}k`, `-bufsize:v:${i}`, `${r.bufsizeKbps}k`);
  });
  if (o.hasAudio) {
    // Resample to 48 kHz stereo so every variant carries identical, widely supported audio.
    args.push('-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2', '-ar', '48000');
  }

  const streamMap = o.ladder.map((r, i) => (o.hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`));
  args.push(
    // Sources with sparse audio packets can otherwise overflow the muxing queue.
    '-max_muxing_queue_size', '1024',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    // MPEG-TS rather than fMP4: the most widely playable HLS segment format (older Android stock
    // players and smart TVs included). fMP4 would only pay off with HEVC/AV1 or DASH sharing.
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', `${o.outDir}/%v/seg_%05d.ts`,
    '-master_pl_name', HLS_MASTER_PLAYLIST,
    '-var_stream_map', streamMap.join(' '),
    // Machine-readable progress on stdout; human stats off.
    '-progress', 'pipe:1',
    '-nostats',
    `${o.outDir}/%v/index.m3u8`,
  );
  return args;
}

/** Runs the ladder encode, reporting how many seconds of the source are done. */
export async function encodeHls(o: HlsOptions, onProgress: (doneSec: number) => void, signal?: AbortSignal) {
  await runProcess('ffmpeg', hlsArgs(o), {
    signal,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    nice: FFMPEG_NICE,
    onLine: (line) => {
      const sec = outTimeSeconds(line);
      if (sec !== null) onProgress(sec);
    },
  });
}

/** Parses one `-progress` line; only `out_time_us=` carries the position. */
export function outTimeSeconds(line: string): number | null {
  if (!line.startsWith('out_time_us=')) return null;
  const us = Number(line.slice('out_time_us='.length));
  return Number.isFinite(us) && us >= 0 ? us / 1e6 : null;
}

/**
 * When to grab the poster: 10% in (skipping black intros and fade-ins), but no later than 30 s so
 * a 10 h set doesn't get a poster from an hour in.
 */
export function posterTime(durationSec: number): number {
  return Math.min(durationSec * 0.1, 30);
}

/** One JPEG frame, at most 1280 px wide (enough for a poster on any screen). */
export async function extractPoster(input: string, output: string, atSec: number, signal?: AbortSignal) {
  await runProcess(
    'ffmpeg',
    [
      '-hide_banner', '-nostdin', '-y',
      // -ss before -i seeks by index (instant even 10 h in) instead of decoding up to that point.
      '-ss', atSec.toFixed(3),
      '-i', input,
      '-frames:v', '1',
      '-vf', "scale='min(1280,iw)':-2",
      '-q:v', '3',
      output,
    ],
    // Prints nothing on stdout, so the idle timeout is simply a cap on the whole extraction.
    { signal, idleTimeoutMs: IDLE_TIMEOUT_MS, nice: FFMPEG_NICE },
  );
}
