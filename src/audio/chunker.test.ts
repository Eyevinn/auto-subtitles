import { getAudioDuration, splitAudioOnSilence } from './chunker';

jest.mock('child_process', () => ({
  execFile: jest.fn()
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    statSync: jest.fn(),
    promises: {
      readdir: jest.fn()
    }
  };
});

jest.mock('nanoid', () => ({
  nanoid: jest.fn().mockReturnValue('mock-nano-id')
}));

jest.mock('../utils/logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { __esModule: true, default: mock };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { execFile } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');

function mockExecFile(stdout: string, stderr = '') {
  execFile.mockImplementationOnce(
    (_cmd: string, _args: string[], cb: (...args: unknown[]) => void) =>
      cb(null, { stdout, stderr })
  );
}

function mockExecFileError(error: Error) {
  execFile.mockImplementationOnce(
    (_cmd: string, _args: string[], cb: (...args: unknown[]) => void) =>
      cb(error)
  );
}

describe('getAudioDuration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return duration from ffprobe output', async () => {
    mockExecFile('125.456\n');
    const duration = await getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(125.456);
    expect(execFile).toHaveBeenCalledWith(
      'ffprobe',
      [
        '-i',
        '/tmp/test.mp3',
        '-show_entries',
        'format=duration',
        '-v',
        'quiet',
        '-of',
        'csv=p=0'
      ],
      expect.any(Function)
    );
  });

  it('should handle integer duration', async () => {
    mockExecFile('60\n');
    const duration = await getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(60);
  });

  it('should handle very short duration', async () => {
    mockExecFile('0.5\n');
    const duration = await getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(0.5);
  });

  it('should handle very long duration', async () => {
    mockExecFile('7200.123\n');
    const duration = await getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(7200.123);
  });

  it('should throw when ffprobe fails', async () => {
    mockExecFileError(new Error('ffprobe: command not found'));
    await expect(getAudioDuration('/tmp/nonexistent.mp3')).rejects.toThrow(
      'ffprobe: command not found'
    );
  });

  it('should handle whitespace in output', async () => {
    mockExecFile('  42.0  \n');
    const duration = await getAudioDuration('/tmp/test.mp3');
    expect(duration).toBe(42.0);
  });
});

describe('splitAudioOnSilence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return original file if no silences found and file is small', async () => {
    mockExecFile('', 'some ffmpeg output without silence markers\n');
    mockExecFile('120.0\n');
    fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 });

    const result = await splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual(['/tmp/input.mp3']);
  });

  it('should split into equal chunks when no silences and file is too big', async () => {
    mockExecFile('', 'no silence\n');
    mockExecFile('120.0\n');
    mockExecFile('');

    fs.statSync.mockReturnValue({ size: 60 * 1024 * 1024 });
    fs.promises.readdir.mockResolvedValue([
      'mock-nano-id_chunk_000.mp3',
      'mock-nano-id_chunk_001.mp3'
    ]);

    const result = await splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual([
      '/tmp/mock-nano-id_chunk_000.mp3',
      '/tmp/mock-nano-id_chunk_001.mp3'
    ]);
  });

  it('should split on silence points when detected', async () => {
    mockExecFile(
      '',
      '[silencedetect @ 0x] silence_end: 30.5 | silence_duration: 2.1\n' +
        '[silencedetect @ 0x] silence_end: 60.2 | silence_duration: 2.3\n'
    );
    mockExecFile('120.0\n');
    mockExecFile('');

    fs.promises.readdir.mockResolvedValue([
      'mock-nano-id_chunk_000.mp3',
      'mock-nano-id_chunk_001.mp3',
      'mock-nano-id_chunk_002.mp3'
    ]);

    const result = await splitAudioOnSilence('/tmp/input.mp3');
    expect(result.length).toBe(3);
  });

  it('should ignore silence at the end of the audio file', async () => {
    mockExecFile(
      '',
      '[silencedetect @ 0x] silence_end: 30.5 | silence_duration: 2.1\n' +
        '[silencedetect @ 0x] silence_end: 59.0 | silence_duration: 2.0\n'
    );
    mockExecFile('60.0\n');
    mockExecFile('');

    fs.promises.readdir.mockResolvedValue([
      'mock-nano-id_chunk_000.mp3',
      'mock-nano-id_chunk_001.mp3'
    ]);

    await splitAudioOnSilence('/tmp/input.mp3');
    const segmentCall = execFile.mock.calls[2];
    expect(segmentCall[1]).toContain('-segment_times');
    const timesIdx = segmentCall[1].indexOf('-segment_times');
    expect(segmentCall[1][timesIdx + 1]).toBe('30.5');
  });

  it('should throw error when ffmpeg fails', async () => {
    mockExecFileError(new Error('ffmpeg error'));
    await expect(splitAudioOnSilence('/tmp/input.mp3')).rejects.toThrow();
  });

  it('should use STAGING_DIR from environment if set', async () => {
    const originalEnv = process.env.STAGING_DIR;
    process.env.STAGING_DIR = '/custom/staging/';

    mockExecFile('', 'no silence\n');
    mockExecFile('120.0\n');
    fs.statSync.mockReturnValue({ size: 1024 });

    const result = await splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual(['/tmp/input.mp3']);

    process.env.STAGING_DIR = originalEnv;
  });

  it('should handle single silence point', async () => {
    mockExecFile(
      '',
      '[silencedetect @ 0x] silence_end: 45.0 | silence_duration: 2.5\n'
    );
    mockExecFile('120.0\n');
    mockExecFile('');

    fs.promises.readdir.mockResolvedValue([
      'mock-nano-id_chunk_000.mp3',
      'mock-nano-id_chunk_001.mp3'
    ]);

    const result = await splitAudioOnSilence('/tmp/input.mp3');
    expect(result.length).toBe(2);
  });

  it('should return original file when all silences are at the end', async () => {
    mockExecFile(
      '',
      '[silencedetect @ 0x] silence_end: 29.5 | silence_duration: 2.0\n'
    );
    mockExecFile('30.0\n');
    mockExecFile('30.0\n');
    fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 });

    const result = await splitAudioOnSilence('/tmp/input.mp3');
    expect(result).toEqual(['/tmp/input.mp3']);
  });
});
