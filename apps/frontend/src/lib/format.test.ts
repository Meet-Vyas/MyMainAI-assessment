import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatEta } from './format';

describe('format', () => {
  it('formats sizes in decimal units', () => {
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(10_000_000_000)).toBe('10.0 GB');
  });

  it('formats ETAs at a readable granularity', () => {
    expect(formatEta(12)).toBe('12 s');
    expect(formatEta(250)).toBe('4 min 10 s');
    expect(formatEta(3900)).toBe('1 h 05 min');
    expect(formatEta(null)).toBe('—');
  });

  it('formats a 10-hour duration', () => {
    expect(formatDuration(36_000)).toBe('10:00:00');
    expect(formatDuration(27_730)).toBe('7:42:10');
    expect(formatDuration(65)).toBe('1:05');
  });
});
