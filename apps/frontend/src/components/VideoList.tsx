import { useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { Film, FolderOpen, Play, RotateCcw } from 'lucide-react';
import type { VideoDto } from '@ugn/contracts';
import { api } from '../lib/api';
import { formatBytes, formatDuration } from '../lib/format';
import { useUploads } from '../upload/UploadsContext';
import { ConfirmButton } from './ConfirmButton';
import { ProgressBar } from './ProgressBar';
import { StatusBadge } from './StatusBadge';
import { ui } from './ui';

interface Props {
  videos: VideoDto[];
  onChanged: (video: VideoDto) => void;
  onDeleted: (id: string) => void;
}

export function VideoList({ videos, onChanged, onDeleted }: Props) {
  if (videos.length === 0) {
    return (
      <div className={`${ui.card} flex flex-col items-center gap-2 py-12 text-center`}>
        <Film className="size-8 text-ink-500" aria-hidden />
        <p className="text-white">No videos yet</p>
        <p className="text-sm text-ink-500">Uploads you start will appear here with their processing status.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      <AnimatePresence initial={false}>
        {videos.map((v) => (
          <VideoRow key={v.id} video={v} onChanged={onChanged} onDeleted={onDeleted} />
        ))}
      </AnimatePresence>
    </ul>
  );
}

function VideoRow({ video, onChanged, onDeleted }: { video: VideoDto } & Omit<Props, 'videos'>) {
  const { isUploadingInThisTab, resume, cancel } = useUploads();
  const fileInput = useRef<HTMLInputElement>(null);
  const activeHere = isUploadingInThisTab(video.id);

  const onDelete = async () => {
    try {
      if (video.status === 'UPLOADING') await cancel(video.id);
      else await api.deleteVideo(video.id);
      onDeleted(video.id);
      toast(`Deleted “${video.title}”`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onRetry = async () => {
    try {
      onChanged(await api.retryVideo(video.id));
      toast.success('Queued for processing again');
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const onResumeFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await resume(video, file);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      className={`${ui.card} flex flex-col gap-4 sm:flex-row sm:items-center`}
    >
      <div className="aspect-video w-full shrink-0 overflow-hidden rounded-lg bg-ink-800 sm:w-40">
        {video.posterUrl ? (
          <img src={video.posterUrl} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Film className="size-6 text-ink-500" aria-hidden />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate font-sans text-base font-semibold tracking-normal text-white">{video.title}</h3>
          <StatusBadge video={video} />
        </div>
        <p className="truncate text-sm text-ink-500">
          {video.fileName} · {formatBytes(video.fileSize)}
          {video.durationSec !== null && ` · ${formatDuration(video.durationSec)}`}
        </p>
        {video.status === 'PROCESSING' && (
          <ProgressBar value={video.progress} label={`Processing progress for ${video.title}`} />
        )}
        {video.status === 'FAILED' && video.failureReason && (
          <p className="text-sm text-red-400">{video.failureReason}</p>
        )}
        {video.status === 'UPLOADING' && !activeHere && (
          <p className="text-sm text-sky-300">Upload interrupted. Choose the same file to continue where it stopped.</p>
        )}
      </div>

      <div className="flex flex-wrap gap-2 sm:justify-end">
        {video.status === 'UPLOADING' && !activeHere && (
          <>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => onResumeFile(e.target.files?.[0])}
            />
            <button type="button" className={ui.btnSecondary} onClick={() => fileInput.current?.click()}>
              <FolderOpen className="size-4" aria-hidden /> Resume
            </button>
          </>
        )}
        {video.status === 'READY' && (
          <Link to={`/videos/${video.id}`} className={ui.btnSecondary} aria-label={`Watch ${video.title}`}>
            <Play className="size-4" aria-hidden /> Watch
          </Link>
        )}
        {video.status === 'FAILED' && (
          <button type="button" className={ui.btnSecondary} onClick={onRetry}>
            <RotateCcw className="size-4" aria-hidden /> Retry
          </button>
        )}
        {!(video.status === 'UPLOADING' && activeHere) && (
          <ConfirmButton
            onConfirm={onDelete}
            confirmLabel={video.status === 'UPLOADING' ? 'Cancel upload?' : 'Delete for good?'}
          >
            {video.status === 'UPLOADING' ? 'Cancel' : 'Delete'}
          </ConfirmButton>
        )}
      </div>
    </motion.li>
  );
}
