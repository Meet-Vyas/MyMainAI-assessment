import { MiB } from '@ugn/contracts';
import { checkParts } from './part-check';

const PART = 16 * MiB;
const part = (partNumber: number, size: number) => ({ partNumber, size, etag: `"e${partNumber}"` });

describe('checkParts', () => {
  const fileSize = 2 * PART + 100; // parts: 16 MiB, 16 MiB, 100 B

  it('passes a complete upload and returns parts in order', () => {
    const { missingParts, wrongSizeParts, ordered } = checkParts(
      [part(3, 100), part(1, PART), part(2, PART)],
      fileSize,
      PART,
    );
    expect(missingParts).toEqual([]);
    expect(wrongSizeParts).toEqual([]);
    expect(ordered.map((p) => p.partNumber)).toEqual([1, 2, 3]);
  });

  it('reports missing parts (e.g. the tab closed mid-upload)', () => {
    const res = checkParts([part(1, PART)], fileSize, PART);
    expect(res.missingParts).toEqual([2, 3]);
    expect(res.ordered).toEqual([]);
  });

  it('reports truncated parts (e.g. a part cut short by a dropped connection)', () => {
    const res = checkParts([part(1, PART), part(2, PART - 1), part(3, 100)], fileSize, PART);
    expect(res.wrongSizeParts).toEqual([2]);
    expect(res.ordered).toEqual([]);
  });

  it('ignores stray parts beyond the expected count', () => {
    const res = checkParts([part(1, PART), part(2, PART), part(3, 100), part(4, 5)], fileSize, PART);
    expect(res.ordered.map((p) => p.partNumber)).toEqual([1, 2, 3]);
  });
});
