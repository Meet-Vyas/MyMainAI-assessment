const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Decimal units (1 GB = 10^9 B), matching how OSes and ISPs label sizes and speeds. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let i = 0;
  let value = bytes;
  while (value >= 1000 && i < UNITS.length - 1) {
    value /= 1000;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(digits)} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "1 h 05 min", "4 min 10 s", "12 s". */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m > 0) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${s} s`;
}

/** Media duration as H:MM:SS (or M:SS under an hour). */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Parses a time a person typed or a `?t=` link carries: "7:42:10", "07:42:10", "42:10", "90",
 * "7h42m10s", "2m". Returns seconds, or null if it isn't a time. After the first colon field,
 * minutes and seconds must be under 60 ("1:75:00" is a typo, not 2:15:00).
 */
export function parseTimecode(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

  const colon = /^(\d+)(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(text);
  if (colon) {
    const fields = colon.slice(1).filter((f) => f !== undefined).map(Number);
    if (fields.slice(1).some((f) => f >= 60)) return null;
    return fields.reduce((total, f) => total * 60 + f, 0);
  }

  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (units && text !== '') {
    const [h, m, s] = units.slice(1).map((f) => Number(f ?? 0));
    return h * 3600 + m * 60 + s;
  }
  return null;
}
