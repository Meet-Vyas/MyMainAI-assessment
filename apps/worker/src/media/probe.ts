import { ProcessError, runProcess } from './run-process';

/**
 * The upload isn't a video we can process. Retrying won't help, so the job fails permanently and
 * the message is shown to the admin as the failure reason.
 */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

export interface ProbeResult {
  durationSec: number;
  /** Display size: after applying rotation metadata and non-square pixels. */
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string;
  formatName: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  sample_aspect_ratio?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string };
}

/** ffprobe errors that mean "these bytes aren't media", as opposed to a network or storage problem. */
const NOT_MEDIA = [
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /EBML header parsing failed/i,
  /could not find codec parameters/i,
];

/**
 * Reads the container and stream headers. Runs against a presigned URL rather than a local copy,
 * so a renamed non-video is rejected before we download 10 GB of it, and the duration is known
 * before we check there's enough disk for the job.
 */
export async function probe(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  let stdout: string;
  try {
    stdout = await runProcess(
      'ffprobe',
      ['-v', 'error', '-rw_timeout', '30000000', '-print_format', 'json', '-show_format', '-show_streams', url],
      { signal },
    );
  } catch (err) {
    if (err instanceof ProcessError && NOT_MEDIA.some((re) => re.test(err.stderrTail))) {
      throw new InvalidMediaError('Not a readable video file');
    }
    throw err; // possibly transient (storage unreachable): let the job retry
  }
  return parseProbe(JSON.parse(stdout) as FfprobeOutput);
}

export function parseProbe(data: FfprobeOutput): ProbeResult {
  const streams = data.streams ?? [];
  const formatName = data.format?.format_name ?? '';
  // Cover art in an audio file shows up as a one-frame "video" stream flagged attached_pic.
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new InvalidMediaError('No video stream found (is this an audio file?)');
  if (formatName === 'image2' || formatName.endsWith('_pipe')) {
    throw new InvalidMediaError('This is an image, not a video');
  }

  const durationSec = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new InvalidMediaError('Could not determine the video duration');
  }
  if (!video.width || !video.height) throw new InvalidMediaError('Video has no frame size');

  // Non-square pixels (e.g. anamorphic DV): display width = stored width x SAR.
  const [sarNum, sarDen] = (video.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  const sar = sarNum > 0 && sarDen > 0 ? sarNum / sarDen : 1;
  let width = Math.round(video.width * sar);
  let height = video.height;
  // Phones record landscape pixels plus a rotation flag. ffmpeg applies it when decoding, so the
  // ladder must be planned for the rotated (display) shape.
  const rotation = video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(video.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

  return {
    durationSec,
    width,
    height,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    videoCodec: video.codec_name ?? 'unknown',
    formatName,
  };
}
