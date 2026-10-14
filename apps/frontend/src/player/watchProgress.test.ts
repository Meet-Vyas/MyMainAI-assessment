import { describe, expect, it } from 'vitest';
import { createWatchProgress, MAX_ENTRIES } from './watchProgress';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

function setup() {
  const storage = new MemoryStorage();
  let clock = 1_000;
  const store = createWatchProgress(storage as unknown as Storage, () => clock++);
  return { storage, store };
}

const TEN_HOURS = 36_000;

describe('watch progress', () => {
  it('remembers where a 10 h video was left', () => {
    const { store } = setup();
    store.save('a', 27_730.6, TEN_HOURS);
    expect(store.get('a')).toBe(27_730);
    expect(store.fraction('a')).toBeCloseTo(0.77, 2);
  });

  it('does not resume from the first few seconds', () => {
    const { store } = setup();
    store.save('a', 4, TEN_HOURS);
    expect(store.get('a')).toBeNull();
  });

  it('treats the last 30 s as finished and forgets the position', () => {
    const { store } = setup();
    store.save('a', 600, TEN_HOURS);
    store.save('a', TEN_HOURS - 10, TEN_HOURS);
    expect(store.get('a')).toBeNull();
  });

  it(`keeps only the ${MAX_ENTRIES} most recently watched videos`, () => {
    const { store } = setup();
    for (let i = 0; i <= MAX_ENTRIES; i++) store.save(`v${i}`, 100, TEN_HOURS);
    expect(store.get('v0')).toBeNull();
    expect(store.get('v1')).toBe(100);
    expect(store.get(`v${MAX_ENTRIES}`)).toBe(100);
  });

  it('clears one video', () => {
    const { store } = setup();
    store.save('a', 100, TEN_HOURS);
    store.save('b', 100, TEN_HOURS);
    store.clear('a');
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBe(100);
  });

  it('survives corrupt data and storage that throws', () => {
    const { storage, store } = setup();
    storage.setItem('ugn:watch-progress', '{not json');
    expect(store.get('a')).toBeNull();
    store.save('a', 100, TEN_HOURS);
    expect(store.get('a')).toBe(100);

    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    const broken = createWatchProgress(throwing);
    expect(() => broken.save('a', 100, TEN_HOURS)).not.toThrow();
    expect(broken.get('a')).toBeNull();
  });

  it('works with no storage at all', () => {
    const store = createWatchProgress(null);
    store.save('a', 100, TEN_HOURS);
    expect(store.get('a')).toBeNull();
  });
});
