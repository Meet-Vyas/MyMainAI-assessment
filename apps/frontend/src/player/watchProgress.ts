/**
 * "Resume watching", per device. One localStorage entry holds positions for the most recently
 * watched videos, so it stays small however many videos someone opens.
 */
const KEY = 'ugn:watch-progress';
/** Most recent videos remembered; older ones are dropped. */
export const MAX_ENTRIES = 50;
/** Closer to the start than this isn't worth resuming. */
export const MIN_RESUME_SEC = 10;
/** Closer to the end than this counts as finished: the next visit starts from the top. */
export const FINISHED_MARGIN_SEC = 30;

interface Entry {
  t: number;
  duration: number;
  savedAt: number;
}

type Entries = Record<string, Entry>;

export interface WatchProgressStore {
  /** Where to resume, or null to start at the beginning. */
  get(videoId: string): number | null;
  /** 0-1 for a "continue watching" bar, or null. */
  fraction(videoId: string): number | null;
  save(videoId: string, positionSec: number, durationSec: number): void;
  clear(videoId: string): void;
}

/**
 * `storage` is injected for tests. Every access is guarded: private browsing, blocked site data
 * and some in-app webviews throw on localStorage, and resume is a convenience, never a failure.
 */
export function createWatchProgress(storage: Storage | null, now: () => number = Date.now): WatchProgressStore {
  const read = (): Entries => {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}');
      return parsed && typeof parsed === 'object' ? (parsed as Entries) : {};
    } catch {
      return {};
    }
  };
  const write = (entries: Entries) => {
    try {
      storage?.setItem(KEY, JSON.stringify(entries));
    } catch {
      // Quota or access error: forget it.
    }
  };
  const valid = (e: Entry | undefined): e is Entry =>
    !!e && Number.isFinite(e.t) && Number.isFinite(e.duration) && e.duration > 0;

  return {
    get(videoId) {
      const e = read()[videoId];
      return valid(e) ? e.t : null;
    },
    fraction(videoId) {
      const e = read()[videoId];
      return valid(e) ? Math.min(1, e.t / e.duration) : null;
    },
    save(videoId, positionSec, durationSec) {
      const entries = read();
      if (positionSec < MIN_RESUME_SEC || positionSec > durationSec - FINISHED_MARGIN_SEC) {
        if (!(videoId in entries)) return;
        delete entries[videoId];
      } else {
        entries[videoId] = { t: Math.floor(positionSec), duration: durationSec, savedAt: now() };
      }
      const newest = Object.entries(entries)
        .sort(([, a], [, b]) => b.savedAt - a.savedAt)
        .slice(0, MAX_ENTRIES);
      write(Object.fromEntries(newest));
    },
    clear(videoId) {
      const entries = read();
      if (!(videoId in entries)) return;
      delete entries[videoId];
      write(entries);
    },
  };
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const watchProgress = createWatchProgress(typeof window === 'undefined' ? null : localStorageOrNull());
