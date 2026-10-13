import { planLadder } from './ladder';
import { hlsArgs, outTimeSeconds, posterTime } from './ffmpeg';

const argValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('hlsArgs', () => {
  const ladder = planLadder(1920, 1080);
  const args = hlsArgs({ input: '/w/source', outDir: '/w/out', ladder, hasAudio: true, preset: 'veryfast', threads: 4 });

  it('decodes once and scales into one output per variant', () => {
    expect(argValue(args, '-filter_complex')).toBe(
      '[0:v]split=3[s0][s1][s2];' +
        '[s0]scale=1920:1080,setsar=1[v0];[s1]scale=1280:720,setsar=1[v1];[s2]scale=854:480,setsar=1[v2]',
    );
    expect(argValue(args, '-var_stream_map')).toBe('v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p');
  });

  it('produces widely playable H.264/AAC with aligned keyframes', () => {
    expect(argValue(args, '-c:v')).toBe('libx264');
    expect(argValue(args, '-pix_fmt')).toBe('yuv420p');
    expect(argValue(args, '-profile:v')).toBe('high');
    expect(argValue(args, '-sc_threshold')).toBe('0');
    expect(argValue(args, '-force_key_frames')).toBe('expr:gte(t,n_forced*2)');
    expect(argValue(args, '-c:a')).toBe('aac');
    expect(argValue(args, '-maxrate:v:0')).toBe('5000k');
    expect(argValue(args, '-bufsize:v:2')).toBe('3000k');
  });

  it('writes 6 s MPEG-TS VOD segments and a master playlist', () => {
    expect(argValue(args, '-hls_time')).toBe('6');
    expect(argValue(args, '-hls_playlist_type')).toBe('vod');
    expect(argValue(args, '-hls_segment_type')).toBe('mpegts');
    expect(argValue(args, '-master_pl_name')).toBe('master.m3u8');
    expect(args[args.length - 1]).toBe('/w/out/%v/index.m3u8');
  });

  it('maps no audio for a silent source', () => {
    const silent = hlsArgs({ input: 'i', outDir: 'o', ladder, hasAudio: false, preset: 'veryfast', threads: 1 });
    expect(silent).not.toContain('0:a:0');
    expect(silent).not.toContain('-c:a');
    expect(argValue(silent, '-var_stream_map')).toBe('v:0,name:1080p v:1,name:720p v:2,name:480p');
  });
});

describe('outTimeSeconds', () => {
  it('parses out_time_us and ignores everything else', () => {
    expect(outTimeSeconds('out_time_us=27730000000')).toBe(27730);
    expect(outTimeSeconds('out_time_us=N/A')).toBeNull();
    expect(outTimeSeconds('frame=600')).toBeNull();
  });
});

describe('posterTime', () => {
  it('is 10% in, capped at 30 s', () => {
    expect(posterTime(60)).toBe(6);
    expect(posterTime(36000)).toBe(30);
  });
});
