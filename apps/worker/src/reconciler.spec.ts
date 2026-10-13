import { decideReconcile } from './reconciler.service';

describe('decideReconcile', () => {
  it('leaves active and normally queued jobs alone', () => {
    expect(decideReconcile('PROCESSING', 'active')).toEqual({ action: 'none' });
    expect(decideReconcile('UPLOADED', 'waiting')).toEqual({ action: 'none' });
    expect(decideReconcile('UPLOADED', 'delayed')).toEqual({ action: 'none' });
  });

  it('shows a PROCESSING video as queued once its job is back in the queue', () => {
    expect(decideReconcile('PROCESSING', 'waiting')).toEqual({ action: 'mark-queued' });
    expect(decideReconcile('PROCESSING', 'delayed')).toEqual({ action: 'mark-queued' });
  });

  it('re-enqueues when the job is gone from Redis', () => {
    expect(decideReconcile('UPLOADED', 'unknown')).toEqual({ action: 'enqueue' });
    expect(decideReconcile('PROCESSING', 'unknown')).toEqual({ action: 'enqueue' });
  });

  it('fails the video, with the job reason, when the job failed or ended without a result', () => {
    expect(decideReconcile('PROCESSING', 'failed', 'job stalled more than allowable limit')).toEqual({
      action: 'mark-failed',
      reason: 'job stalled more than allowable limit',
    });
    expect(decideReconcile('UPLOADED', 'completed')).toMatchObject({ action: 'mark-failed' });
  });
});
