import { getAudioDuration, splitAudioOnSilence } from './chunker';

jest.mock('child_process', () => ({
  execSync: jest.fn()
}));

jest.mock('fs', () => ({
  statSync: jest.fn()
}));

jest.mock('nanoid', () => ({
  nanoid: jest.fn().mockReturnValue('mock-nano-id')
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execSync } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { statSync } = require('fs');

describe('getAudioDuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return duration from ffprobe output', () => {
    execSync.mockReturnValue(Buffer.from('125.456\n'));
    const duration = getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(125.456);
    expect(execSync).toHaveBeenCalledWith(
      'ffprobe -i "/tmp/test.mp3" -show_entries format=duration -v quiet -of csv="p=0"'
    );
  });

  it('should handle integer duration', () => {
    execSync.mockReturnValue(Buffer.from('60\n'));
    const duration = getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(60);
  });

  it('should handle very short duration', () => {
    execSync.mockReturnValue(Buffer.from('0.5\n'));
    const duration = getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(0.5);
  });

  it('should handle very long duration', () => {
    execSync.mockReturnValue(Buffer.from('7200.123\n'));
    const duration = getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(7200.123);
  });

  it('should throw when ffprobe fails', () => {
    execSync.mockImplementation(() => {
      throw new Error('ffprobe: command not found');
    });
    expect(() => getAudioDuration('/tmp/nonexistent.mp3')).toThrow(
      'ffprobe: command not found'
    );
  });

  it('should handle whitespace in output', () => {
    execSync.mockReturnValue(Buffer.from('  42.0  \n'));
    const duration = getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(42.0);
  });

  it('should handle file paths with special characters', () => {
    execSync.mockReturnValue(Buffer.from('10.0\n'));
    getAudioDuration('/tmp/my file (1).mp3');
    expect(execSync).toHaveBeenCalledWith(
      'ffprobe -i "/tmp/my file (1).mp3" -show_entries format=duration -v quiet -of csv="p=0"'
    );
  });
});

describe('splitAudioOnSilence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return original file if no silences found and file is small', () => {
    // Flow: no silence_end in output => silences=[], silences.length>0 is false,
    // silences.length===0 is true => statSync => size <= MAX => return [inputFile]
    // execSync calls: 1 (ffmpeg silencedetect)
    execSync.mockReturnValueOnce(
      Buffer.from('some ffmpeg output without silence markers\n')
    );
    statSync.mockReturnValue({ size: 5 * 1024 * 1024 }); // 5MB < 25MB

    const result = splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual(['/tmp/input.mp3']);
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('should split into equal chunks when no silences and file is too big', () => {
    // Flow: no silence_end => silences=[], silences.length>0 is false,
    // silences.length===0 => statSync => size > MAX => getAudioDuration => ffmpeg segment => ls
    // execSync calls: 1 (silencedetect), 2 (ffprobe for duration), 3 (ffmpeg segment), 4 (ls)
    execSync
      .mockReturnValueOnce(Buffer.from('no silence\n')) // 1: silencedetect
      .mockReturnValueOnce(Buffer.from('120.0\n')) // 2: ffprobe (getAudioDuration)
      .mockReturnValueOnce(Buffer.from('')) // 3: ffmpeg segment
      .mockReturnValueOnce(
        // 4: ls
        Buffer.from(
          '/tmp/mock-nano-id_chunk_000.mp3\n/tmp/mock-nano-id_chunk_001.mp3\n'
        )
      );

    statSync.mockReturnValue({ size: 60 * 1024 * 1024 }); // 60MB > 25MB

    const result = splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual([
      '/tmp/mock-nano-id_chunk_000.mp3',
      '/tmp/mock-nano-id_chunk_001.mp3'
    ]);
    expect(execSync).toHaveBeenCalledTimes(4);
  });

  it('should split on silence points when detected', () => {
    // Flow: silence_end found => silences=[30.5, 60.2], check if last > duration-2,
    // getAudioDuration(120) => 60.2 < 118, so no pop, silences.length > 0 => ffmpeg segment => ls
    // execSync calls: 1 (silencedetect), 2 (ffprobe for end-check), 3 (ffmpeg segment), 4 (ls)
    execSync
      .mockReturnValueOnce(
        Buffer.from(
          '[silencedetect @ 0x] silence_end: 30.5 | silence_duration: 2.1\n' +
            '[silencedetect @ 0x] silence_end: 60.2 | silence_duration: 2.3\n'
        )
      )
      .mockReturnValueOnce(Buffer.from('120.0\n')) // ffprobe
      .mockReturnValueOnce(Buffer.from('')) // ffmpeg segment
      .mockReturnValueOnce(
        Buffer.from(
          '/tmp/mock-nano-id_chunk_000.mp3\n/tmp/mock-nano-id_chunk_001.mp3\n/tmp/mock-nano-id_chunk_002.mp3\n'
        )
      );

    const result = splitAudioOnSilence('/tmp/input.mp3');
    expect(result.length).toBe(3);
  });

  it('should ignore silence at the end of the audio file', () => {
    // Flow: silences=[30.5, 59.0], getAudioDuration=60 => 59.0 > 58 => pop => silences=[30.5]
    // silences.length > 0 => ffmpeg segment => ls
    // execSync calls: 1 (silencedetect), 2 (ffprobe), 3 (ffmpeg segment), 4 (ls)
    execSync
      .mockReturnValueOnce(
        Buffer.from(
          '[silencedetect @ 0x] silence_end: 30.5 | silence_duration: 2.1\n' +
            '[silencedetect @ 0x] silence_end: 59.0 | silence_duration: 2.0\n'
        )
      )
      .mockReturnValueOnce(Buffer.from('60.0\n'))
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(
        Buffer.from(
          '/tmp/mock-nano-id_chunk_000.mp3\n/tmp/mock-nano-id_chunk_001.mp3\n'
        )
      );

    splitAudioOnSilence('/tmp/input.mp3');
    // Verify ffmpeg was called with only one split point (30.5, not 59.0)
    const segmentCall = execSync.mock.calls[2][0];
    expect(segmentCall).toContain('-segment_times 30.5');
    expect(segmentCall).not.toContain('59.0');
  });

  it('should throw error when ffmpeg fails', () => {
    execSync.mockImplementation(() => {
      throw new Error('ffmpeg error');
    });

    expect(() => splitAudioOnSilence('/tmp/input.mp3')).toThrow();
  });

  it('should use STAGING_DIR from environment if set', () => {
    const originalEnv = process.env.STAGING_DIR;
    process.env.STAGING_DIR = '/custom/staging/';

    // No silences, small file
    execSync.mockReturnValueOnce(Buffer.from('no silence\n'));
    statSync.mockReturnValue({ size: 1024 });

    const result = splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual(['/tmp/input.mp3']);

    process.env.STAGING_DIR = originalEnv;
  });

  it('should handle single silence point', () => {
    // silences=[45.0], getAudioDuration=120 => 45 < 118 => no pop
    // silences.length > 0 => ffmpeg segment => ls
    execSync
      .mockReturnValueOnce(
        Buffer.from(
          '[silencedetect @ 0x] silence_end: 45.0 | silence_duration: 2.5\n'
        )
      )
      .mockReturnValueOnce(Buffer.from('120.0\n'))
      .mockReturnValueOnce(Buffer.from(''))
      .mockReturnValueOnce(
        Buffer.from(
          '/tmp/mock-nano-id_chunk_000.mp3\n/tmp/mock-nano-id_chunk_001.mp3\n'
        )
      );

    const result = splitAudioOnSilence('/tmp/input.mp3');
    expect(result.length).toBe(2);
  });

  it('should return original file when all silences are at the end', () => {
    // silences=[29.5], getAudioDuration=30 => 29.5 > 28 => pop => silences=[]
    // silences.length === 0 => statSync => small => return [inputFile]
    execSync
      .mockReturnValueOnce(
        Buffer.from(
          '[silencedetect @ 0x] silence_end: 29.5 | silence_duration: 2.0\n'
        )
      )
      .mockReturnValueOnce(Buffer.from('30.0\n'));
    statSync.mockReturnValue({ size: 5 * 1024 * 1024 });

    const result = splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual(['/tmp/input.mp3']);
  });
});
