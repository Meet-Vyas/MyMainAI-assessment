import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoDto, VideoEvent } from '@ugn/contracts';
import { api, ApiError } from '../lib/api';
import { statusLabel } from './status';

export type LiveState = 'connecting' | 'live' | 'polling';
const POLL_MS = 10_000;

/**
 * Admin video list kept current by Server-Sent Events. On every (re)connect it refetches the
 * whole list, so events missed while disconnected don't matter. While SSE is down it polls.
 */
export function useAdminVideos() {
  const [videos, setVideos] = useState<VideoDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>('connecting');
  const [announcement, setAnnouncement] = useState('');
  const videosRef = useRef<VideoDto[] | null>(null);
  videosRef.current = videos;

  const refresh = useCallback(async () => {
    try {
      setVideos(await api.listVideos());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const upsert = useCallback((video: VideoDto) => {
    const previous = videosRef.current?.find((v) => v.id === video.id);
    if (previous && previous.status !== video.status) {
      setAnnouncement(`${video.title}: ${statusLabel(video)}`);
    }
    setVideos((prev) => {
      if (!prev) return [video];
      return prev.some((v) => v.id === video.id)
        ? prev.map((v) => (v.id === video.id ? video : v))
        : [video, ...prev];
    });
  }, []);

  const remove = useCallback((id: string) => setVideos((prev) => prev?.filter((v) => v.id !== id) ?? prev), []);

  const refreshOne = useCallback(
    async (id: string) => {
      try {
        upsert(await api.getVideo(id));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) remove(id);
      }
    },
    [upsert, remove],
  );

  useEffect(() => {
    const source = new EventSource('/api/admin/videos/events', { withCredentials: true });
    source.onopen = () => {
      setLive('live');
      void refresh();
    };
    // EventSource retries by itself after an error; until it reconnects we poll.
    source.onerror = () => setLive('polling');
    source.addEventListener('video', (e) => {
      const event = JSON.parse((e as MessageEvent<string>).data) as VideoEvent;
      if (event.kind === 'deleted') return remove(event.videoId);
      const current = videosRef.current?.find((v) => v.id === event.videoId);
      const onlyProgress = current && event.progress !== undefined && (!event.status || event.status === current.status);
      if (onlyProgress) {
        // Frequent progress ticks: patch in place instead of refetching.
        setVideos((prev) => prev?.map((v) => (v.id === event.videoId ? { ...v, progress: event.progress! } : v)) ?? prev);
      } else {
        void refreshOne(event.videoId);
      }
    });
    return () => source.close();
  }, [refresh, refreshOne, remove]);

  useEffect(() => {
    if (live === 'live') return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [live, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { videos, error, live, announcement, refresh, upsert, remove };
}
