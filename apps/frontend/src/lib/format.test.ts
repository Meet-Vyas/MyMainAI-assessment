import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatEta, parseTimecode } from './format';

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

  it('parses typed and linked timecodes', () => {
    expect(parseTimecode('7:42:10')).toBe(27_730);
    expect(parseTimecode(' 07:42:10 ')).toBe(27_730);
    expect(parseTimecode('42:10')).toBe(2_530);
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('90:00')).toBe(5_400); // 90 minutes is a fine way to say 1:30:00
    expect(parseTimecode('7h42m10s')).toBe(27_730);
    expect(parseTimecode('2m')).toBe(120);
    expect(parseTimecode('1H')).toBe(3_600);
  });

  it('rejects things that are not times', () => {
    for (const bad of ['', 'abc', '1:75:00', '1:2:3:4', '-5', '7h 42m', '1:', ':30']) {
      expect(parseTimecode(bad)).toBeNull();
    }
  });
});
