import type { VideoDto, VideoStatus } from '@ugn/contracts';

const LABELS: Record<VideoStatus, string> = {
  UPLOADING: 'Uploading',
  UPLOADED: 'Queued',
  PROCESSING: 'Processing',
  READY: 'Ready',
  FAILED: 'Failed',
};

export function statusLabel(video: Pick<VideoDto, 'status' | 'progress'>): string {
  return video.status === 'PROCESSING' ? `Processing ${video.progress}%` : LABELS[video.status];
}
