import {
  choosePartSize,
  DEFAULT_PART_SIZE,
  expectedPartSize,
  GiB,
  InitUploadRequestSchema,
  isAcceptableVideoFile,
  MiB,
  partCount,
  S3_MAX_PARTS,
  SignPartsRequestSchema,
} from './upload';

describe('part sizing', () => {
  it('uses 16 MiB parts for a 10 GB file (~600 parts)', () => {
    const size = 10 * 1000 ** 3;
    expect(choosePartSize(size)).toBe(DEFAULT_PART_SIZE);
    expect(partCount(size, DEFAULT_PART_SIZE)).toBe(597);
  });

  it('grows parts so huge files stay within 10,000 parts', () => {
    const size = 500 * GiB;
    const partSize = choosePartSize(size);
    expect(partSize % MiB).toBe(0);
    expect(partCount(size, partSize)).toBeLessThanOrEqual(S3_MAX_PARTS);
  });

  it('gives the remainder to the last part', () => {
    const size = 2 * DEFAULT_PART_SIZE + 123;
    expect(partCount(size, DEFAULT_PART_SIZE)).toBe(3);
    expect(expectedPartSize(1, size, DEFAULT_PART_SIZE)).toBe(DEFAULT_PART_SIZE);
    expect(expectedPartSize(3, size, DEFAULT_PART_SIZE)).toBe(123);
  });

  it('treats a file smaller than one part as a single part', () => {
    expect(partCount(1, DEFAULT_PART_SIZE)).toBe(1);
    expect(expectedPartSize(1, 1, DEFAULT_PART_SIZE)).toBe(1);
  });
});

describe('file type pre-check', () => {
  it('accepts video extensions with a video, empty or generic MIME type', () => {
    expect(isAcceptableVideoFile('set.mp4', 'video/mp4')).toBe(true);
    expect(isAcceptableVideoFile('set.MKV', '')).toBe(true);
    expect(isAcceptableVideoFile('set.mkv', 'application/octet-stream')).toBe(true);
  });

  it('rejects non-video extensions and non-video MIME types', () => {
    expect(isAcceptableVideoFile('notes.pdf', 'application/pdf')).toBe(false);
    expect(isAcceptableVideoFile('set.mp4', 'application/pdf')).toBe(false);
    expect(isAcceptableVideoFile('noextension', 'video/mp4')).toBe(false);
  });
});

describe('InitUploadRequestSchema', () => {
  const valid = { title: 'Set', fileName: 'set.mp4', fileSize: 10 * GiB, mimeType: 'video/mp4' };

  it('strips client paths from the file name and defaults the description', () => {
    expect(InitUploadRequestSchema.parse({ ...valid, fileName: 'C:\\fakepath\\set.mp4' })).toMatchObject({
      fileName: 'set.mp4',
      description: '',
    });
  });

  it('rejects oversized, empty and non-video files', () => {
    expect(InitUploadRequestSchema.safeParse({ ...valid, fileSize: 51 * GiB }).success).toBe(false);
    expect(InitUploadRequestSchema.safeParse({ ...valid, fileSize: 0 }).success).toBe(false);
    expect(InitUploadRequestSchema.safeParse({ ...valid, fileName: 'x.exe', mimeType: '' }).success).toBe(false);
  });
});

describe('SignPartsRequestSchema', () => {
  it('de-duplicates and sorts part numbers', () => {
    expect(SignPartsRequestSchema.parse({ partNumbers: [3, 1, 3, 2] }).partNumbers).toEqual([1, 2, 3]);
  });

  it('rejects out-of-range and oversized batches', () => {
    expect(SignPartsRequestSchema.safeParse({ partNumbers: [0] }).success).toBe(false);
    expect(SignPartsRequestSchema.safeParse({ partNumbers: [10_001] }).success).toBe(false);
    expect(SignPartsRequestSchema.safeParse({ partNumbers: Array.from({ length: 101 }, (_, i) => i + 1) }).success).toBe(
      false,
    );
  });
});
