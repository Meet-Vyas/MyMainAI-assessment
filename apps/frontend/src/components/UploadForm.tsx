import { useState, type DragEvent } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import toast from 'react-hot-toast';
import { FileVideo, ImageIcon, Loader2, RotateCcw, UploadCloud, X } from 'lucide-react';
import {
  GiB,
  isAcceptableVideoFile,
  MAX_UPLOAD_BYTES,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_TYPES,
  VIDEO_DESCRIPTION_MAX,
  VIDEO_EXTENSIONS,
  VIDEO_TITLE_MAX,
  type VideoDto,
} from '@ugn/contracts';
import { formatBytes } from '../lib/format';
import { findRecordForFile } from '../upload/resumeStore';
import { useUploads } from '../upload/UploadsContext';
import { ui } from './ui';

const ACCEPT_VIDEO = Object.keys(VIDEO_EXTENSIONS).map((e) => `.${e}`).join(',');

/** Same rules the server applies (shared from @ugn/contracts), checked before anything is sent. */
const schema = z.object({
  title: z.string().trim().min(1, 'Give the video a title').max(VIDEO_TITLE_MAX),
  description: z.string().trim().max(VIDEO_DESCRIPTION_MAX),
  file: z
    .instanceof(File, { message: 'Choose a video file' })
    .refine((f) => isAcceptableVideoFile(f.name, f.type), `Unsupported type. Use ${Object.keys(VIDEO_EXTENSIONS).join(', ')}`)
    .refine((f) => f.size > 0, 'That file is empty')
    .refine((f) => f.size <= MAX_UPLOAD_BYTES, `Maximum size is ${MAX_UPLOAD_BYTES / GiB} GiB`),
  thumbnail: z
    .instanceof(File)
    .refine((f) => (THUMBNAIL_TYPES as readonly string[]).includes(f.type), 'Thumbnail must be JPEG, PNG or WebP')
    .refine((f) => f.size <= THUMBNAIL_MAX_BYTES, 'Thumbnail must be 5 MiB or smaller')
    .optional(),
});
type FormValues = z.infer<typeof schema>;

interface Props {
  /** Unfinished uploads from the server, so picking the same file again offers to resume. */
  unfinished: VideoDto[];
}

export function UploadForm({ unfinished }: Props) {
  const { startNew, resume } = useUploads();
  const [dragging, setDragging] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    setValue,
    getValues,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: '', description: '' } });

  const file = watch('file');
  const thumbnail = watch('thumbnail');
  const record = file ? findRecordForFile(file) : undefined;
  const resumable = record ? unfinished.find((v) => v.id === record.videoId) : undefined;

  const chooseFile = (f: File | undefined) => {
    if (!f) return;
    setValue('file', f, { shouldValidate: true });
    // Suggest a title from the file name if the admin hasn't typed one.
    if (!getValues('title')) setValue('title', f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, VIDEO_TITLE_MAX));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    chooseFile(e.dataTransfer.files[0]);
  };

  const onSubmit = async (values: FormValues) => {
    try {
      await startNew(values);
      reset({ title: '', description: '', file: undefined, thumbnail: undefined });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const resumeInstead = async () => {
    if (!resumable || !file) return;
    try {
      await resume(resumable, file);
      reset({ title: '', description: '', file: undefined, thumbnail: undefined });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={`${ui.card} space-y-4`} noValidate>
      <h2 className="text-3xl">Upload a set</h2>

      <Controller
        control={control}
        name="file"
        render={() => (
          <div>
            <label
              onDragOver={(e) => (e.preventDefault(), setDragging(true))}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors focus-within:ring-2 focus-within:ring-primary ${
                dragging ? 'border-primary bg-primary/5' : 'border-ink-700 hover:border-ink-500'
              }`}
            >
              <input
                type="file"
                accept={`video/*,${ACCEPT_VIDEO}`}
                className="sr-only"
                onChange={(e) => chooseFile(e.target.files?.[0])}
                aria-invalid={!!errors.file}
                aria-describedby={errors.file ? 'file-error' : undefined}
              />
              {file ? (
                <>
                  <FileVideo className="size-8 text-primary" aria-hidden />
                  <span className="break-all font-medium text-white">{file.name}</span>
                  <span className="text-sm text-ink-500">{formatBytes(file.size)} · click to change</span>
                </>
              ) : (
                <>
                  <UploadCloud className="size-8 text-ink-500" aria-hidden />
                  <span className="font-medium text-white">Drop a video here or click to choose</span>
                  <span className="text-sm text-ink-500">
                    MP4, MOV, MKV, WebM, AVI · up to {MAX_UPLOAD_BYTES / GiB} GiB
                  </span>
                </>
              )}
            </label>
            {errors.file && (
              <p id="file-error" className={ui.error} role="alert">
                {errors.file.message}
              </p>
            )}
          </div>
        )}
      />

      {resumable && (
        <div className="flex flex-col gap-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-sm sm:flex-row sm:items-center">
          <p className="flex-1">
            You started uploading this file as <strong className="text-white">“{resumable.title}”</strong>. Resume it
            instead of starting over?
          </p>
          <button type="button" className={ui.btnSecondary} onClick={resumeInstead}>
            <RotateCcw className="size-4" aria-hidden /> Resume
          </button>
        </div>
      )}

      <div>
        <label htmlFor="title" className={ui.label}>
          Title
        </label>
        <input id="title" className={ui.input} {...register('title')} aria-invalid={!!errors.title} />
        {errors.title && <p className={ui.error}>{errors.title.message}</p>}
      </div>

      <div>
        <label htmlFor="description" className={ui.label}>
          Description <span className="font-normal text-ink-500">(optional)</span>
        </label>
        <textarea id="description" rows={3} className={ui.input} {...register('description')} />
        {errors.description && <p className={ui.error}>{errors.description.message}</p>}
      </div>

      <div>
        <span className={ui.label}>
          Custom thumbnail <span className="font-normal text-ink-500">(optional; otherwise a frame is used)</span>
        </span>
        {thumbnail ? (
          <div className="flex items-center gap-3 rounded-lg border border-ink-700 px-3 py-2 text-sm">
            <ImageIcon className="size-4 shrink-0 text-ink-500" aria-hidden />
            <span className="flex-1 truncate">{thumbnail.name}</span>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label="Remove thumbnail"
              onClick={() => setValue('thumbnail', undefined, { shouldValidate: true })}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ) : (
          <label className={`${ui.btnSecondary} cursor-pointer focus-within:ring-2 focus-within:ring-primary`}>
            <ImageIcon className="size-4" aria-hidden /> Choose image
            <input
              type="file"
              accept={THUMBNAIL_TYPES.join(',')}
              className="sr-only"
              onChange={(e) => e.target.files?.[0] && setValue('thumbnail', e.target.files[0], { shouldValidate: true })}
            />
          </label>
        )}
        {errors.thumbnail && <p className={ui.error}>{errors.thumbnail.message}</p>}
      </div>

      <button type="submit" className={`${ui.btnPrimary} w-full`} disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UploadCloud className="size-4" aria-hidden />}
        {isSubmitting ? 'Starting…' : 'Start upload'}
      </button>
    </form>
  );
}
