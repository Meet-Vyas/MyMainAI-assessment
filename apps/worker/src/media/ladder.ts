/**
 * The adaptive-bitrate ladder. H.264 + AAC in MPEG-TS plays on every target (desktop browsers via
 * hls.js or native, iOS/Android, in-app webviews, AVPlayer, ExoPlayer, old smart TVs), so we
 * don't need a second codec family.
 *
 * Rates are caps, not targets: we encode with capped CRF, so simple scenes come out well below
 * them and only complex ones (strobes, crowds) hit the cap. That keeps storage and CDN egress
 * proportional to content, while the cap keeps each variant's BANDWIDTH honest for ABR switching.
 */
const RUNGS = [
  { name: '1080p', long: 1920, short: 1080, maxrateKbps: 5000 },
  { name: '720p', long: 1280, short: 720, maxrateKbps: 3000 },
  { name: '480p', long: 854, short: 480, maxrateKbps: 1500 },
  { name: '360p', long: 640, short: 360, maxrateKbps: 800 },
] as const;

/** Three variants cover phone-on-cellular to desktop; a fourth costs encode time on a 10 h video. */
export const MAX_RENDITIONS = 3;
/** Stereo AAC-LC. Music-heavy content, so we don't go lower on the small variants. */
export const AUDIO_KBPS = 128;
/** A source this close to a rung (e.g. 1920x1072) still counts as that rung. */
const RUNG_TOLERANCE = 1.1;

export interface PlannedRendition {
  name: string;
  width: number;
  height: number;
  maxrateKbps: number;
  /** VBV buffer: 2x maxrate allows short bursts while keeping the peak bounded. */
  bufsizeKbps: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Picks the renditions for a source of the given *display* size (after rotation).
 * Never upscales: a 720p source gets 720p/480p/360p, not a blurry 1080p that costs more to store
 * and stream. Works for portrait and ultra-wide sources by fitting each rung's box in the
 * source's orientation and keeping the aspect ratio.
 */
export function planLadder(sourceWidth: number, sourceHeight: number): PlannedRendition[] {
  const portrait = sourceHeight > sourceWidth;
  const planned: PlannedRendition[] = [];
  for (const rung of RUNGS) {
    const boxW = portrait ? rung.short : rung.long;
    const boxH = portrait ? rung.long : rung.short;
    const fit = Math.min(boxW / sourceWidth, boxH / sourceHeight);
    if (fit > RUNG_TOLERANCE) continue; // source is smaller than this rung
    const scale = Math.min(fit, 1);
    planned.push({
      name: rung.name,
      width: even(sourceWidth * scale),
      height: even(sourceHeight * scale),
      maxrateKbps: rung.maxrateKbps,
      bufsizeKbps: rung.maxrateKbps * 2,
    });
    if (planned.length === MAX_RENDITIONS) break;
  }
  if (planned.length > 0) return planned;

  // Smaller than 360p: one variant at the source size.
  const smallest = RUNGS[RUNGS.length - 1];
  return [
    {
      name: `${even(Math.min(sourceWidth, sourceHeight))}p`,
      width: even(sourceWidth),
      height: even(sourceHeight),
      maxrateKbps: smallest.maxrateKbps,
      bufsizeKbps: smallest.maxrateKbps * 2,
    },
  ];
}

/** Peak bits per second of one variant, as a player sees it. */
export function variantBandwidth(rendition: PlannedRendition, hasAudio: boolean): number {
  return (rendition.maxrateKbps + (hasAudio ? AUDIO_KBPS : 0)) * 1000;
}

/** Upper bound on the encoded output size, for the free-disk check before a job starts. */
export function estimateOutputBytes(ladder: PlannedRendition[], durationSec: number, hasAudio: boolean): number {
  const bitsPerSec = ladder.reduce((sum, r) => sum + variantBandwidth(r, hasAudio), 0);
  const MPEG_TS_OVERHEAD = 1.1;
  return Math.ceil((bitsPerSec / 8) * durationSec * MPEG_TS_OVERHEAD);
}
