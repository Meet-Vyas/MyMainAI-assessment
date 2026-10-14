/**
 * Fullscreen differs by platform:
 * - Desktop browsers, Android, iPad: the standard API (or its webkit prefix on older Safari) on our
 *   container, so our own controls stay on screen.
 * - iPhone: only a <video> element can go fullscreen, via webkitEnterFullscreen(), and iOS shows its
 *   own player there (which also handles rotation).
 * On Android, a landscape video also locks the screen to landscape while fullscreen. That only works
 * in fullscreen and is refused on desktop, so failures are ignored.
 */
type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void>; unlock?: () => void };

const doc = () => document as WebkitDocument;

export function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? doc().webkitFullscreenElement ?? null;
}

export const FULLSCREEN_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'] as const;

export async function enterFullscreen(container: HTMLElement, video: HTMLVideoElement, landscape: boolean) {
  const el = container as WebkitElement;
  if (document.fullscreenEnabled && el.requestFullscreen) {
    await el.requestFullscreen({ navigationUI: 'hide' });
  } else if (doc().webkitFullscreenEnabled && el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else {
    (video as WebkitVideo).webkitEnterFullscreen?.();
    return;
  }
  if (landscape) {
    await (screen.orientation as LockableOrientation | undefined)?.lock?.('landscape').catch(() => undefined);
  }
}

export async function exitFullscreen() {
  try {
    (screen.orientation as LockableOrientation | undefined)?.unlock?.();
  } catch {
    // Not locked, or not supported.
  }
  if (document.fullscreenElement) await document.exitFullscreen();
  else doc().webkitExitFullscreen?.();
}
