import { useEffect, useState, type RefObject } from 'react';

export interface MediaState {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  /** NaN until the playlist is loaded. */
  duration: number;
  /** End of the buffered range around the playhead, in seconds. */
  bufferedEnd: number;
  volume: number;
  muted: boolean;
  /** Waiting for data: a stall, or a seek that hasn't landed yet. */
  buffering: boolean;
  /** Playback has really started at least once (not just a poster on screen). */
  started: boolean;
  /** Size of the frames playing right now, so it changes as the player switches renditions. */
  videoWidth: number;
  videoHeight: number;
}

const INITIAL: MediaState = {
  paused: true,
  ended: false,
  currentTime: 0,
  duration: NaN,
  bufferedEnd: 0,
  volume: 1,
  muted: false,
  buffering: false,
  started: false,
  videoWidth: 0,
  videoHeight: 0,
};

const EVENTS = [
  'play', 'pause', 'playing', 'waiting', 'seeking', 'seeked', 'ended', 'timeupdate', 'durationchange',
  'progress', 'volumechange', 'resize', 'loadedmetadata', 'canplay', 'emptied', 'error',
] as const;

function bufferedEndAt(video: HTMLVideoElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.5 && t <= video.buffered.end(i)) return video.buffered.end(i);
  }
  return t;
}

/** Mirrors the <video> element's state into React. The element stays the single source of truth. */
export function useMediaState(ref: RefObject<HTMLVideoElement | null>): MediaState {
  const [state, setState] = useState(INITIAL);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let stalled = false;
    let started = false;

    const update = (e?: Event) => {
      switch (e?.type) {
        case 'waiting':
          stalled = true;
          break;
        case 'playing':
          started = true;
          stalled = false;
          break;
        case 'canplay':
        case 'pause':
        case 'emptied':
        case 'error':
          stalled = false;
          break;
      }
      setState({
        paused: video.paused,
        ended: video.ended,
        currentTime: video.currentTime,
        duration: video.duration,
        bufferedEnd: bufferedEndAt(video),
        volume: video.volume,
        muted: video.muted,
        buffering: video.seeking || (stalled && !video.paused),
        started,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      });
    };

    for (const name of EVENTS) video.addEventListener(name, update);
    update();
    return () => {
      for (const name of EVENTS) video.removeEventListener(name, update);
    };
  }, [ref]);

  return state;
}
