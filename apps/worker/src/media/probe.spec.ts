import { InvalidMediaError, parseProbe } from './probe';

const h264 = { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 };
const aac = { codec_type: 'audio', codec_name: 'aac' };
const format = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '36000.040000' };

describe('parseProbe', () => {
  it('reads duration, size and audio presence', () => {
    expect(parseProbe({ streams: [h264, aac], format })).toEqual({
      durationSec: 36000.04,
      width: 1920,
      height: 1080,
      hasAudio: true,
      videoCodec: 'h264',
      formatName: format.format_name,
    });
  });

  it('accepts a video with no audio track', () => {
    expect(parseProbe({ streams: [h264], format }).hasAudio).toBe(false);
  });

  it('swaps width and height for rotated phone video (side data or legacy tag)', () => {
    const rotated = { ...h264, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] };
    expect(parseProbe({ streams: [rotated], format })).toMatchObject({ width: 1080, height: 1920 });
    const legacy = { ...h264, tags: { rotate: '270' } };
    expect(parseProbe({ streams: [legacy], format })).toMatchObject({ width: 1080, height: 1920 });
  });

  it('applies non-square pixels to the display width', () => {
    const anamorphic = { ...h264, width: 1440, height: 1080, sample_aspect_ratio: '4:3' };
    expect(parseProbe({ streams: [anamorphic], format })).toMatchObject({ width: 1920, height: 1080 });
  });

  it.each([
    ['an audio file', { streams: [aac], format: { format_name: 'mp3', duration: '200' } }, /No video stream/],
    [
      'an audio file with cover art',
      { streams: [aac, { ...h264, codec_name: 'mjpeg', disposition: { attached_pic: 1 } }], format },
      /No video stream/,
    ],
    ['an image', { streams: [{ ...h264, codec_name: 'png' }], format: { format_name: 'png_pipe' } }, /image/],
    ['a stream with no duration', { streams: [h264], format: { format_name: 'mpegts' } }, /duration/],
    ['a stream with no frame size', { streams: [{ ...h264, width: 0 }], format }, /frame size/],
  ])('rejects %s', (_label, data, message) => {
    expect(() => parseProbe(data)).toThrow(InvalidMediaError);
    expect(() => parseProbe(data)).toThrow(message);
  });
});
