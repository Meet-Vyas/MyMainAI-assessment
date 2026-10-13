import { overallProgress, ProgressReporter } from './progress-reporter';

describe('overallProgress', () => {
  it('maps each phase onto its slice of the bar', () => {
    expect(overallProgress('download', 0)).toBe(0);
    expect(overallProgress('download', 1)).toBe(5);
    expect(overallProgress('encode', 0.5)).toBe(47);
    expect(overallProgress('upload', 1)).toBe(99);
    expect(overallProgress('encode', 7)).toBe(90); // clamped
  });
});

describe('ProgressReporter', () => {
  function setup(stillOurs = true) {
    let now = 0;
    const writes: [number, boolean][] = [];
    const onLost = jest.fn();
    const reporter = new ProgressReporter({
      write: async (p, changed) => {
        writes.push([p, changed]);
        return stillOurs;
      },
      onLost,
      heartbeatMs: 10_000,
      now: () => now,
    });
    return { reporter, writes, onLost, advance: (ms: number) => (now += ms) };
  }

  it('writes when the percentage moves, and not again until it moves', async () => {
    const { reporter, writes } = setup();
    reporter.report('encode', 0.5);
    await reporter.tick();
    await reporter.tick();
    expect(writes).toEqual([[47, true]]);
  });

  it('sends a heartbeat write when nothing has moved for a while', async () => {
    const { reporter, writes, advance } = setup();
    reporter.report('encode', 0.5);
    await reporter.tick();
    advance(10_000);
    await reporter.tick();
    expect(writes).toEqual([
      [47, true],
      [47, false],
    ]);
  });

  it('never goes backwards', async () => {
    const { reporter, writes } = setup();
    reporter.report('encode', 0.5);
    reporter.report('download', 1);
    await reporter.tick();
    expect(writes).toEqual([[47, true]]);
  });

  it('reports a lost video once and stops', async () => {
    const { reporter, onLost } = setup(false);
    reporter.report('encode', 0.1);
    await reporter.tick();
    expect(onLost).toHaveBeenCalledTimes(1);
  });
});
