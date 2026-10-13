import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { CheckCircle2, Pause, Play, RotateCcw, WifiOff } from 'lucide-react';
import { formatBytes, formatEta, formatSpeed } from '../lib/format';
import { useUploads, type ActiveUpload } from '../upload/UploadsContext';
import type { UploadPhase } from '../upload/UploadEngine';
import { ConfirmButton } from './ConfirmButton';
import { ProgressBar } from './ProgressBar';
import { ui } from './ui';

const PHASE_TEXT: Record<UploadPhase, string> = {
  preparing: 'Checking what’s already uploaded…',
  uploading: 'Uploading',
  reconnecting: 'Connection lost. Retrying automatically…',
  paused: 'Paused',
  completing: 'Finishing up…',
  done: 'Uploaded',
  error: 'Stopped',
  cancelled: 'Cancelled',
};

export function ActiveUploadCard({ upload }: { upload: ActiveUpload }) {
  const { cancel } = useUploads();
  const { snapshot: s, engine } = upload;
  const pct = s.totalBytes ? (s.uploadedBytes / s.totalBytes) * 100 : 0;
  const canPause = s.phase === 'uploading' || s.phase === 'reconnecting' || s.phase === 'preparing';
  const canResume = s.phase === 'paused' || s.phase === 'error';

  const onCancel = async () => {
    try {
      await cancel(upload.videoId);
      toast(`Cancelled “${upload.title}”`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className={ui.card}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-white">{upload.title}</p>
          <p className="truncate text-sm text-ink-500">{upload.fileName}</p>
        </div>
        <div className="flex items-center gap-1">
          {canPause && (
            <button type="button" className={ui.iconBtn} onClick={() => engine.pause()} aria-label={`Pause ${upload.title}`}>
              <Pause className="size-4" aria-hidden />
            </button>
          )}
          {canResume && (
            <button type="button" className={ui.iconBtn} onClick={() => void engine.start()} aria-label={`Resume ${upload.title}`}>
              {s.phase === 'error' ? <RotateCcw className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            </button>
          )}
          {s.phase !== 'done' && s.phase !== 'completing' && (
            <ConfirmButton onConfirm={onCancel} confirmLabel="Cancel upload?">
              Cancel
            </ConfirmButton>
          )}
        </div>
      </div>

      <div className="mt-3">
        <ProgressBar value={pct} label={`Upload progress for ${upload.title}`} tone={s.phase === 'paused' ? 'muted' : 'primary'} />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm" aria-live="polite">
        <span className="flex items-center gap-1.5 text-white">
          {s.phase === 'reconnecting' && <WifiOff className="size-4 text-amber-300" aria-hidden />}
          {s.phase === 'done' && <CheckCircle2 className="size-4 text-emerald-300" aria-hidden />}
          {PHASE_TEXT[s.phase]} · {pct.toFixed(1)}%
        </span>
        <span className="tabular-nums text-ink-500">
          {formatBytes(s.uploadedBytes)} of {formatBytes(s.totalBytes)}
          {s.phase === 'uploading' && ` · ${formatSpeed(s.speedBps)} · ${formatEta(s.etaSec)} left`}
        </span>
      </div>
      {s.error && (
        <p className="mt-2 text-sm text-red-400" role="alert">
          {s.error}
        </p>
      )}
    </motion.li>
  );
}
