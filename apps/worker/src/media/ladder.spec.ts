import { estimateOutputBytes, MAX_RENDITIONS, planLadder } from './ladder';

const sizes = (w: number, h: number) => planLadder(w, h).map((r) => `${r.name} ${r.width}x${r.height}`);

describe('planLadder', () => {
  it('gives a 1080p source the 1080/720/480 ladder', () => {
    expect(sizes(1920, 1080)).toEqual(['1080p 1920x1080', '720p 1280x720', '480p 854x480']);
  });

  it('never upscales: a 720p source tops out at 720p', () => {
    expect(sizes(1280, 720)).toEqual(['720p 1280x720', '480p 854x480', '360p 640x360']);
  });

  it('caps a 4K source at 1080p and at most three variants', () => {
    const ladder = planLadder(3840, 2160);
    expect(ladder).toHaveLength(MAX_RENDITIONS);
    expect(ladder[0]).toMatchObject({ name: '1080p', width: 1920, height: 1080 });
  });

  it('keeps portrait sources portrait', () => {
    expect(sizes(1080, 1920)).toEqual(['1080p 1080x1920', '720p 720x1280', '480p 480x854']);
  });

  it('treats an ultra-wide or slightly short frame as its width class, with even dimensions', () => {
    expect(sizes(1920, 800)[0]).toBe('1080p 1920x800');
    expect(sizes(1920, 1072)[0]).toBe('1080p 1920x1072');
    for (const r of planLadder(1918, 817)) {
      expect(r.width % 2).toBe(0);
      expect(r.height % 2).toBe(0);
    }
  });

  it('gives a tiny source a single variant at its own size', () => {
    expect(sizes(320, 240)).toEqual(['240p 320x240']);
  });
});

describe('estimateOutputBytes', () => {
  it('bounds a 10 h 1080p ladder output (for the disk check)', () => {
    const bytes = estimateOutputBytes(planLadder(1920, 1080), 10 * 3600, true);
    // (5000 + 3000 + 1500 + 3 x 128) kbit/s x 36,000 s x 1.1 TS overhead ~= 49 GB
    expect(bytes / 1e9).toBeCloseTo(48.9, 0);
  });
});
