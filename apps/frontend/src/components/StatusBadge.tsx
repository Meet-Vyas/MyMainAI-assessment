import { AlertTriangle, CheckCircle2, Clock, Loader2, UploadCloud } from 'lucide-react';
import type { VideoDto, VideoStatus } from '@ugn/contracts';
import { statusLabel } from '../videos/status';

const STYLES: Record<VideoStatus, { cls: string; Icon: typeof Clock; spin?: boolean }> = {
  UPLOADING: { cls: 'bg-sky-500/10 text-sky-300 border-sky-500/30', Icon: UploadCloud },
  UPLOADED: { cls: 'bg-ink-800 text-ink-300 border-ink-700', Icon: Clock },
  PROCESSING: { cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30', Icon: Loader2, spin: true },
  READY: { cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  FAILED: { cls: 'bg-primary/10 text-red-300 border-primary/40', Icon: AlertTriangle },
};

export function StatusBadge({ video }: { video: Pick<VideoDto, 'status' | 'progress'> }) {
  const { cls, Icon, spin } = STYLES[video.status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      <Icon className={`size-3.5 ${spin ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
      {statusLabel(video)}
    </span>
  );
}
