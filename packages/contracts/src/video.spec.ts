import { canTransition, UpdateVideoRequestSchema, VideoStatus } from './video';

describe('canTransition', () => {
  it('follows the happy path', () => {
    expect(canTransition('UPLOADING', 'UPLOADED')).toBe(true);
    expect(canTransition('UPLOADED', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSING', 'READY')).toBe(true);
  });

  it('allows retry and crash recovery paths', () => {
    expect(canTransition('FAILED', 'UPLOADED')).toBe(true);
    expect(canTransition('PROCESSING', 'UPLOADED')).toBe(true);
  });

  it('treats READY as terminal', () => {
    for (const to of Object.values(VideoStatus)) {
      expect(canTransition('READY', to)).toBe(false);
    }
  });

  it('rejects skipping steps', () => {
    expect(canTransition('UPLOADING', 'READY')).toBe(false);
    expect(canTransition('UPLOADING', 'PROCESSING')).toBe(false);
    expect(canTransition('UPLOADED', 'READY')).toBe(false);
  });
});

describe('UpdateVideoRequestSchema', () => {
  it('trims and accepts a partial update', () => {
    expect(UpdateVideoRequestSchema.parse({ title: '  Boiler Room  ' })).toEqual({ title: 'Boiler Room' });
  });

  it('rejects an empty body and a blank title', () => {
    expect(UpdateVideoRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateVideoRequestSchema.safeParse({ title: '   ' }).success).toBe(false);
  });
});
