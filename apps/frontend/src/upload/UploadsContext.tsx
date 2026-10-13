import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import type { ThumbnailUploadRequest, ThumbnailUploadResponse, VideoDto } from '@ugn/contracts';
import { api, ApiError } from '../lib/api';
import { matchesUpload, resumeStore, sampleHash } from './resumeStore';
import { UploadEngine, type UploadApi, type UploadSnapshot } from './UploadEngine';
import { xhrPutPart } from './xhrPutPart';

export interface ActiveUpload {
  videoId: string;
  title: string;
  fileName: string;
  engine: UploadEngine;
  snapshot: UploadSnapshot;
}

export interface NewUpload {
  file: File;
  title: string;
  description: string;
  thumbnail?: File;
}

interface UploadsContextValue {
  uploads: ActiveUpload[];
  isUploadingInThisTab(videoId: string): boolean;
  startNew(input: NewUpload): Promise<void>;
  /** Re-attach a file to an unfinished upload (after a refresh, or from another tab/session). */
  resume(video: VideoDto, file: File): Promise<void>;
  cancel(videoId: string): Promise<void>;
}

const engineApi: UploadApi = {
  status: api.uploadStatus,
  signParts: api.signParts,
  complete: api.completeUpload,
};

const UploadsContext = createContext<UploadsContextValue | null>(null);

async function uploadThumbnail(presigned: ThumbnailUploadResponse, file: File) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presigned.fields)) form.append(k, v);
  form.append('file', file); // must come after the policy fields
  const res = await fetch(presigned.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Storage rejected the thumbnail (${res.status})`);
}

/**
 * Owns the upload engines, above the routes, so an upload keeps going while the admin navigates
 * within the app. Leaving the page (refresh/close) stops it; the resume flow picks it back up.
 */
export function UploadsProvider({ children }: { children: ReactNode }) {
  const [uploads, setUploads] = useState<Record<string, ActiveUpload>>({});
  const engines = useRef(new Map<string, UploadEngine>());

  const attach = useCallback((videoId: string, title: string, file: File) => {
    if (engines.current.has(videoId)) return;
    const engine = new UploadEngine(videoId, file, engineApi, xhrPutPart);
    engines.current.set(videoId, engine);
    engine.subscribe((snapshot) => {
      setUploads((prev) => ({ ...prev, [videoId]: { videoId, title, fileName: file.name, engine, snapshot } }));
      if (snapshot.phase === 'done') {
        resumeStore.remove(videoId);
        toast.success(`"${title}" uploaded. Processing will start shortly.`);
        // Leave the 100% bar up briefly, then let the video list take over.
        setTimeout(() => {
          engines.current.delete(videoId);
          setUploads(({ [videoId]: _, ...rest }) => rest);
        }, 2500);
      }
    });
    void engine.start();
  }, []);

  const startNew = useCallback(
    async ({ file, title, description, thumbnail }: NewUpload) => {
      const { video } = await api.initUpload({
        title,
        description,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
      });
      resumeStore.save({
        videoId: video.id,
        title,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        sampleHash: await sampleHash(file),
        startedAt: new Date().toISOString(),
      });
      if (thumbnail) {
        // Sent first and it's small; if it fails, the video still gets an auto-generated poster.
        try {
          const presigned = await api.thumbnailUpload(video.id, { contentType: thumbnail.type as ThumbnailUploadRequest['contentType'], size: thumbnail.size });
          await uploadThumbnail(presigned, thumbnail);
        } catch (err) {
          toast.error(`Thumbnail not saved: ${(err as Error).message}. A frame from the video will be used.`);
        }
      }
      attach(video.id, title, file);
    },
    [attach],
  );

  const resume = useCallback(
    async (video: VideoDto, file: File) => {
      const match = await matchesUpload(file, video, resumeStore.get(video.id));
      if (!match.ok) throw new Error(match.reason);
      attach(video.id, video.title, file);
    },
    [attach],
  );

  const cancel = useCallback(async (videoId: string) => {
    engines.current.get(videoId)?.cancel();
    try {
      await api.deleteVideo(videoId); // aborts the multipart upload and frees its parts
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    } finally {
      engines.current.delete(videoId);
      resumeStore.remove(videoId);
      setUploads(({ [videoId]: _, ...rest }) => rest);
    }
  }, []);

  // Warn before closing the tab mid-upload. Nothing is lost (it resumes), but it does stop.
  const anyActive = Object.values(uploads).some((u) => u.engine.isActive);
  useEffect(() => {
    if (!anyActive) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyActive]);

  const value = useMemo<UploadsContextValue>(
    () => ({
      uploads: Object.values(uploads),
      isUploadingInThisTab: (id) => engines.current.has(id),
      startNew,
      resume,
      cancel,
    }),
    [uploads, startNew, resume, cancel],
  );
  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}

export function useUploads(): UploadsContextValue {
  const ctx = useContext(UploadsContext);
  if (!ctx) throw new Error('useUploads must be used inside UploadsProvider');
  return ctx;
}
