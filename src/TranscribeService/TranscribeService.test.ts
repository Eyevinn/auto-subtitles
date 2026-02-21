import {
  TranscribeService,
  TranscribeError,
  State,
  VALID_TRANSCRIBE_MODELS,
  DEFAULT_TRANSCRIBE_MODEL
} from './TranscribeService';

// Mock dependencies
const mockTranscriptionsCreate = jest.fn();
const mockChatCreate = jest.fn();

jest.mock('openai', () => {
  // Both named export OpenAI and default export Configuration must be constructors
  class MockOpenAI {
    audio = {
      transcriptions: {
        create: mockTranscriptionsCreate
      }
    };
    chat = {
      completions: {
        create: mockChatCreate
      }
    };
  }

  // The default export is used as `Configuration` in the source code
  class MockConfiguration {
    apiKey: string;
    constructor(opts: { apiKey?: string }) {
      this.apiKey = opts.apiKey || '';
    }
  }

  return {
    __esModule: true,
    OpenAI: MockOpenAI,
    default: MockConfiguration
  };
});

jest.mock('nanoid', () => ({
  nanoid: jest.fn().mockReturnValue('test-id-123')
}));

jest.mock('../aws/upload', () => ({
  signUrl: jest
    .fn()
    .mockResolvedValue(new URL('https://signed.example.com/file.mp3')),
  uploadToS3: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../audio/chunker', () => ({
  splitAudioOnSilence: jest.fn().mockResolvedValue(['/tmp/chunk_000.mp3']),
  getAudioDuration: jest.fn().mockResolvedValue(30.0)
}));

jest.mock('child_process', () => ({
  execFile: jest.fn(
    (_cmd: string, _args: string[], cb: (...args: unknown[]) => void) =>
      cb(null, { stdout: '', stderr: '' })
  )
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    statSync: jest.fn().mockReturnValue({ isFile: () => true }),
    unlinkSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(true),
    createReadStream: jest.fn().mockReturnValue('mock-read-stream')
  };
});

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis()
  }
}));

jest.mock('../utils/metrics', () => ({
  transcriptionTotal: { inc: jest.fn() },
  transcriptionErrors: { inc: jest.fn() },
  diarizationTotal: { inc: jest.fn() },
  transcriptionDuration: { observe: jest.fn() },
  activeWorkers: { inc: jest.fn(), dec: jest.fn() },
  totalWorkers: { inc: jest.fn(), set: jest.fn() },
  formatGenerationTotal: { inc: jest.fn() }
}));

describe('TranscribeService', () => {
  let service: TranscribeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TranscribeService('test-api-key');
  });

  describe('exports', () => {
    it('should export VALID_TRANSCRIBE_MODELS array', () => {
      expect(Array.isArray(VALID_TRANSCRIBE_MODELS)).toBe(true);
      expect(VALID_TRANSCRIBE_MODELS).toContain('whisper-1');
      expect(VALID_TRANSCRIBE_MODELS).toContain('gpt-4o-transcribe');
      expect(VALID_TRANSCRIBE_MODELS).toContain('gpt-4o-mini-transcribe');
      expect(VALID_TRANSCRIBE_MODELS).toContain(
        'gpt-4o-mini-transcribe-2025-12-15'
      );
      expect(VALID_TRANSCRIBE_MODELS).toContain('gpt-4o-transcribe-diarize');
    });

    it('should export DEFAULT_TRANSCRIBE_MODEL as whisper-1', () => {
      expect(DEFAULT_TRANSCRIBE_MODEL).toBe('whisper-1');
    });
  });

  describe('TranscribeError', () => {
    it('should create error with code and statusCode', () => {
      const err = new TranscribeError('test', 'TEST_CODE', 400);
      expect(err.message).toBe('test');
      expect(err.code).toBe('TEST_CODE');
      expect(err.statusCode).toBe(400);
      expect(err.retryable).toBe(false);
      expect(err.name).toBe('TranscribeError');
      expect(err instanceof Error).toBe(true);
    });

    it('should support retryable flag', () => {
      const err = new TranscribeError(
        'rate limited',
        'RATE_LIMITED',
        429,
        true
      );
      expect(err.retryable).toBe(true);
      expect(err.statusCode).toBe(429);
    });
  });

  describe('constructor and basic properties', () => {
    it('should create a service with an instance ID', () => {
      expect(service.id).toBe('test-id-123');
    });

    it('should initialize in INACTIVE state', () => {
      expect(service.state).toBe(State.INACTIVE);
    });

    it('should allow setting state', () => {
      service.state = State.ACTIVE;
      expect(service.state).toBe(State.ACTIVE);

      service.state = State.IDLE;
      expect(service.state).toBe(State.IDLE);
    });
  });

  describe('State enum', () => {
    it('should have correct enum values', () => {
      expect(State.IDLE).toBe('IDLE');
      expect(State.ACTIVE).toBe('ACTIVE');
      expect(State.INACTIVE).toBe('INACTIVE');
    });
  });

  describe('createUrl', () => {
    it('should return the same URL for http protocol', async () => {
      const url = await service.createUrl('https://example.com/audio.mp3');
      expect(url.toString()).toBe('https://example.com/audio.mp3');
    });

    it('should return the same URL for https protocol', async () => {
      const url = await service.createUrl('https://cdn.example.com/file.wav');
      expect(url.toString()).toBe('https://cdn.example.com/file.wav');
    });

    it('should sign S3 URLs', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { signUrl } = require('../aws/upload');
      const url = await service.createUrl('s3://my-bucket/path/to/file.mp3');
      expect(signUrl).toHaveBeenCalledWith({
        url: new URL('s3://my-bucket/path/to/file.mp3')
      });
      expect(url.toString()).toBe('https://signed.example.com/file.mp3');
    });

    it('should throw on invalid URL', async () => {
      await expect(service.createUrl('not-a-url')).rejects.toThrow();
    });
  });

  describe('formatSegmentsToVTT', () => {
    it('should format segments to VTT correctly', () => {
      const formatVTT = (service as any).formatSegmentsToVTT.bind(service);
      const segments = [
        { start: 0, end: 2.5, text: 'Hello world' },
        { start: 3.0, end: 5.5, text: 'This is a test' }
      ];
      const result = formatVTT(segments);
      expect(result).toContain('WEBVTT');
      expect(result).toContain('00:00:00.000 --> 00:00:02.500');
      expect(result).toContain('Hello world');
      expect(result).toContain('00:00:03.000 --> 00:00:05.500');
      expect(result).toContain('This is a test');
    });

    it('should format time with hours correctly', () => {
      const formatVTT = (service as any).formatSegmentsToVTT.bind(service);
      const segments = [
        { start: 3661.5, end: 3665.123, text: 'Over an hour in' }
      ];
      const result = formatVTT(segments);
      expect(result).toContain('01:01:01.500 --> 01:01:05.123');
    });

    it('should handle zero time', () => {
      const formatVTT = (service as any).formatSegmentsToVTT.bind(service);
      const segments = [{ start: 0, end: 1, text: 'First' }];
      const result = formatVTT(segments);
      expect(result).toContain('00:00:00.000 --> 00:00:01.000');
    });

    it('should handle empty segments array', () => {
      const formatVTT = (service as any).formatSegmentsToVTT.bind(service);
      const result = formatVTT([]);
      expect(result).toBe('WEBVTT\n\n');
    });
  });

  describe('formatSegmentsToSRT', () => {
    it('should format segments to SRT correctly', () => {
      const formatSRT = (service as any).formatSegmentsToSRT.bind(service);
      const segments = [
        { start: 0, end: 2.5, text: 'Hello world' },
        { start: 3.0, end: 5.5, text: 'This is a test' }
      ];
      const result = formatSRT(segments);
      expect(result).toContain('1\n00:00:00,000 --> 00:00:02,500\nHello world');
      expect(result).toContain(
        '2\n00:00:03,000 --> 00:00:05,500\nThis is a test'
      );
    });

    it('should use comma separator for milliseconds (SRT format)', () => {
      const formatSRT = (service as any).formatSegmentsToSRT.bind(service);
      const segments = [{ start: 1.25, end: 5.5, text: 'Test' }];
      const result = formatSRT(segments);
      expect(result).toContain(',250');
      expect(result).toContain(',500');
    });

    it('should number segments starting from 1', () => {
      const formatSRT = (service as any).formatSegmentsToSRT.bind(service);
      const segments = [
        { start: 0, end: 1, text: 'First' },
        { start: 1, end: 2, text: 'Second' },
        { start: 2, end: 3, text: 'Third' }
      ];
      const result = formatSRT(segments);
      expect(result).toContain('1\n');
      expect(result).toContain('2\n');
      expect(result).toContain('3\n');
    });

    it('should handle empty segments array', () => {
      const formatSRT = (service as any).formatSegmentsToSRT.bind(service);
      const result = formatSRT([]);
      expect(result).toBe('');
    });
  });

  describe('adjustSegmentTimecodes', () => {
    it('should offset all timecodes by the given amount', () => {
      const adjust = (service as any).adjustSegmentTimecodes.bind(service);
      const segments = [
        { start: 0, end: 2, text: 'Hello' },
        { start: 3, end: 5, text: 'World' }
      ];
      const result = adjust(segments, 10);
      expect(result[0].start).toBe(10);
      expect(result[0].end).toBe(12);
      expect(result[1].start).toBe(13);
      expect(result[1].end).toBe(15);
    });

    it('should handle zero offset', () => {
      const adjust = (service as any).adjustSegmentTimecodes.bind(service);
      const segments = [{ start: 5, end: 10, text: 'Test' }];
      const result = adjust(segments, 0);
      expect(result[0].start).toBe(5);
      expect(result[0].end).toBe(10);
    });

    it('should handle fractional offsets', () => {
      const adjust = (service as any).adjustSegmentTimecodes.bind(service);
      const segments = [{ start: 1.5, end: 3.7, text: 'Test' }];
      const result = adjust(segments, 0.3);
      expect(result[0].start).toBeCloseTo(1.8);
      expect(result[0].end).toBeCloseTo(4.0);
    });

    it('should not mutate original segments', () => {
      const adjust = (service as any).adjustSegmentTimecodes.bind(service);
      const segments = [{ start: 0, end: 2, text: 'Hello' }];
      adjust(segments, 10);
      expect(segments[0].start).toBe(0);
      expect(segments[0].end).toBe(2);
    });
  });

  describe('optimizeSegmentDurations', () => {
    it('should preserve original timing for segments within normal duration', () => {
      const optimize = (service as any).optimizeSegmentDurations.bind(service);
      const segments = [{ start: 0, end: 3, text: 'Short text' }];
      const result = optimize(segments);
      expect(result.length).toBe(1);
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(3);
    });

    it('should split long segments exceeding MAX_DURATION', () => {
      const optimize = (service as any).optimizeSegmentDurations.bind(service);
      const longText =
        'This is a very long subtitle text that definitely exceeds the maximum duration limit and should be split into multiple segments';
      const segments = [{ start: 0, end: 15, text: longText }];
      const result = optimize(segments);
      expect(result.length).toBeGreaterThan(1);
    });

    it('should distribute timing proportionally when splitting', () => {
      const optimize = (service as any).optimizeSegmentDurations.bind(service);
      const longText =
        'This is a very long subtitle text that definitely exceeds the maximum duration limit and should be split into multiple segments';
      const segments = [{ start: 0, end: 20, text: longText }];
      const result = optimize(segments);
      // Last segment should end at or before the original end time
      const lastSeg = result[result.length - 1];
      expect(lastSeg.end).toBeLessThanOrEqual(20);
      // First segment should start at original start time
      expect(result[0].start).toBe(0);
    });

    it('should enforce minimum duration of 1.5 seconds for short segments', () => {
      const optimize = (service as any).optimizeSegmentDurations.bind(service);
      const segments = [{ start: 0, end: 0.5, text: 'Hi' }];
      const result = optimize(segments);
      // Short segment gets extended to at least MIN_DURATION
      expect(result[0].end - result[0].start).toBeGreaterThanOrEqual(1.5);
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(1.5);
    });

    it('should handle empty segments array', () => {
      const optimize = (service as any).optimizeSegmentDurations.bind(service);
      const result = optimize([]);
      expect(result).toEqual([]);
    });

    it('should skip segments with invalid duration', () => {
      const optimize = (service as any).optimizeSegmentDurations.bind(service);
      const segments = [{ start: 5, end: 3, text: 'Bad segment' }];
      const result = optimize(segments);
      expect(result).toEqual([]);
    });
  });

  describe('mergeShortSegments', () => {
    it('should merge short segments with small gaps', () => {
      const merge = (service as any).mergeShortSegments.bind(service);
      const segments = [
        { start: 0, end: 0.5, text: 'Hi' },
        { start: 0.6, end: 2.0, text: 'there' }
      ];
      const result = merge(segments);
      expect(result.length).toBe(1);
      expect(result[0].text).toBe('Hi\nthere');
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(2.0);
    });

    it('should not merge segments with large gaps', () => {
      const merge = (service as any).mergeShortSegments.bind(service);
      const segments = [
        { start: 0, end: 0.5, text: 'Hi' },
        { start: 2.0, end: 3.0, text: 'there' }
      ];
      const result = merge(segments);
      expect(result.length).toBe(2);
    });

    it('should not merge segments with sufficient duration', () => {
      const merge = (service as any).mergeShortSegments.bind(service);
      const segments = [
        { start: 0, end: 2.0, text: 'Hello world' },
        { start: 2.1, end: 4.0, text: 'Goodbye' }
      ];
      const result = merge(segments);
      expect(result.length).toBe(2);
    });

    it('should handle single segment', () => {
      const merge = (service as any).mergeShortSegments.bind(service);
      const segments = [{ start: 0, end: 0.5, text: 'Hi' }];
      const result = merge(segments);
      expect(result.length).toBe(1);
    });

    it('should handle empty array', () => {
      const merge = (service as any).mergeShortSegments.bind(service);
      const result = merge([]);
      expect(result).toEqual([]);
    });

    it('should merge multiple consecutive short segments', () => {
      const merge = (service as any).mergeShortSegments.bind(service);
      const segments = [
        { start: 0, end: 0.3, text: 'A' },
        { start: 0.4, end: 0.7, text: 'B' },
        { start: 0.8, end: 1.1, text: 'C' }
      ];
      const result = merge(segments);
      expect(result.length).toBe(1);
      expect(result[0].text).toBe('A\nB\nC');
    });
  });

  describe('limitSegmentLines', () => {
    it('should not change short text', () => {
      const limit = (service as any).limitSegmentLines.bind(service);
      const segments = [{ start: 0, end: 2, text: 'Short text' }];
      const result = limit(segments);
      expect(result[0].text).toBe('Short text');
    });

    it('should split long text into multiple lines', () => {
      const limit = (service as any).limitSegmentLines.bind(service);
      const segments = [
        {
          start: 0,
          end: 5,
          text: 'This is a very long subtitle that should be split into two lines for readability'
        }
      ];
      const result = limit(segments);
      expect(result[0].text).toContain('\n');
    });

    it('should limit to 2 lines maximum', () => {
      const limit = (service as any).limitSegmentLines.bind(service);
      const segments = [
        {
          start: 0,
          end: 10,
          text: 'This is an extremely long subtitle text that would normally be split into three or even four lines because of the character limit per line but should be limited to only two lines maximum'
        }
      ];
      const result = limit(segments);
      const lineCount = result[0].text.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(2);
    });

    it('should handle empty segments', () => {
      const limit = (service as any).limitSegmentLines.bind(service);
      const result = limit([]);
      expect(result).toEqual([]);
    });

    it('should preserve start and end times', () => {
      const limit = (service as any).limitSegmentLines.bind(service);
      const segments = [
        {
          start: 1.5,
          end: 5.5,
          text: 'This is a long subtitle text that should be wrapped to multiple lines'
        }
      ];
      const result = limit(segments);
      expect(result[0].start).toBe(1.5);
      expect(result[0].end).toBe(5.5);
    });
  });

  describe('redistributeLines', () => {
    it('should redistribute words into lines up to 42 chars', () => {
      const redistribute = (service as any).redistributeLines.bind(service);
      const lines = [
        'This is a moderately long',
        'subtitle text that',
        'wraps to three lines'
      ];
      const result = redistribute(lines);
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it('should handle single line', () => {
      const redistribute = (service as any).redistributeLines.bind(service);
      const lines = ['Short'];
      const result = redistribute(lines);
      expect(result.length).toBe(1);
      expect(result[0]).toBe('Short');
    });
  });

  describe('parseVTTToSegments', () => {
    it('should parse basic VTT format with no word data', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt =
        'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nHello world\n\n00:00:03.000 --> 00:00:05.500\nThis is a test';

      const transcription = { words: undefined };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(2);
      expect(result[0].text).toBe('Hello world');
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(2.5);
      expect(result[1].text).toBe('This is a test');
      expect(result[1].start).toBe(3);
      expect(result[1].end).toBe(5.5);
    });

    it('should handle multi-line VTT cues', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt =
        'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nFirst line of text\nSecond line of text\n\n00:00:03.500 --> 00:00:06.000\nAnother cue';

      const transcription = { words: undefined };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(2);
      expect(result[0].text).toBe('First line of text Second line of text');
      expect(result[1].text).toBe('Another cue');
    });

    it('should handle VTT with hours', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt = 'WEBVTT\n\n01:30:00.000 --> 01:30:05.000\nLate in the show';

      const transcription = { words: undefined };
      const result = parse(vtt, transcription);
      expect(result[0].start).toBe(5400);
      expect(result[0].end).toBe(5405);
    });

    it('should handle empty VTT', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt = 'WEBVTT';
      const transcription = { words: undefined };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(0);
    });

    it('should parse overlapping VTT cues with both segments present', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt =
        'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nFirst segment\n\n00:00:03.000 --> 00:00:07.000\nOverlapping segment';

      const transcription = { words: undefined };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(2);
      result.forEach((seg: { start: number; end: number; text: string }) => {
        expect(seg.end).toBeGreaterThan(seg.start);
      });
    });

    it('should use word-level timing when available', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt =
        'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHello world test sentence';

      const transcription = {
        words: [
          { word: 'Hello', start: 0.5, end: 0.8 },
          { word: 'world', start: 0.9, end: 1.2 },
          { word: 'test', start: 1.3, end: 1.5 },
          { word: 'sentence', start: 1.6, end: 2.0 }
        ]
      };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(1);
      expect(result[0].start).toBe(0.5);
      expect(result[0].end).toBe(2.0);
    });

    it('should align multiple segments with global word index', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt =
        'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n\n00:00:02.000 --> 00:00:04.000\nGoodbye friend';

      const transcription = {
        words: [
          { word: 'Hello', start: 0.1, end: 0.5 },
          { word: 'world', start: 0.6, end: 1.0 },
          { word: 'Goodbye', start: 2.2, end: 2.6 },
          { word: 'friend', start: 2.7, end: 3.0 }
        ]
      };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(2);
      // First segment aligned to first two words
      expect(result[0].start).toBe(0.1);
      expect(result[0].end).toBe(1.0);
      // Second segment aligned to last two words
      expect(result[1].start).toBe(2.2);
      expect(result[1].end).toBe(3.0);
    });

    it('should never produce negative duration segments', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      // Simulate a case where word timing would cause negative duration
      const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:05.200\nQuick word';

      const transcription = {
        words: [{ word: 'Quick', start: 4.5, end: 4.8 }]
      };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(1);
      expect(result[0].end).toBeGreaterThan(result[0].start);
    });

    it('should handle punctuation in word matching', () => {
      const parse = (service as any).parseVTTToSegments.bind(service);
      const vtt =
        'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nHello, world! How are you?';

      const transcription = {
        words: [
          { word: 'Hello', start: 0.1, end: 0.3 },
          { word: 'world', start: 0.4, end: 0.6 },
          { word: 'How', start: 0.7, end: 0.8 },
          { word: 'are', start: 0.9, end: 1.0 },
          { word: 'you', start: 1.1, end: 1.3 }
        ]
      };
      const result = parse(vtt, transcription);
      expect(result.length).toBe(1);
      // Should match despite punctuation differences
      expect(result[0].start).toBe(0.1);
    });
  });

  describe('validateSegmentTiming', () => {
    it('should fix negative duration segments', () => {
      const validate = (service as any).validateSegmentTiming.bind(service);
      const segments = [
        { start: 5, end: 3, text: 'Bad duration' },
        { start: 6, end: 8, text: 'Good segment' }
      ];
      const result = validate(segments);
      expect(result[0].end).toBeGreaterThan(result[0].start);
      expect(result[0].end).toBeLessThanOrEqual(6); // Should not exceed next segment start
    });

    it('should fix overlapping segments', () => {
      const validate = (service as any).validateSegmentTiming.bind(service);
      const segments = [
        { start: 0, end: 5, text: 'First' },
        { start: 3, end: 7, text: 'Second' }
      ];
      const result = validate(segments);
      expect(result[0].end).toBeLessThanOrEqual(result[1].start);
    });

    it('should ensure minimum duration for all segments', () => {
      const validate = (service as any).validateSegmentTiming.bind(service);
      const segments = [{ start: 0, end: 0.01, text: 'Tiny' }];
      const result = validate(segments);
      expect(result[0].end - result[0].start).toBeGreaterThanOrEqual(0.1);
    });

    it('should handle empty array', () => {
      const validate = (service as any).validateSegmentTiming.bind(service);
      const result = validate([]);
      expect(result).toEqual([]);
    });

    it('should pass through valid segments unchanged', () => {
      const validate = (service as any).validateSegmentTiming.bind(service);
      const segments = [
        { start: 0, end: 3, text: 'First' },
        { start: 3.5, end: 6, text: 'Second' },
        { start: 6.5, end: 9, text: 'Third' }
      ];
      const result = validate(segments);
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(3);
      expect(result[1].start).toBe(3.5);
      expect(result[1].end).toBe(6);
      expect(result[2].start).toBe(6.5);
      expect(result[2].end).toBe(9);
    });
  });

  describe('optimizeSegments', () => {
    it('should apply all optimizations for whisper model (skip duration optimization)', () => {
      const optimize = (service as any).optimizeSegments.bind(service);
      const segments = [
        { start: 0, end: 3, text: 'Hello world' },
        { start: 3.5, end: 6, text: 'This is a subtitle' }
      ];
      const result = optimize(segments, 'whisper-1');
      expect(result.length).toBeGreaterThanOrEqual(1);
      result.forEach((seg: { text: string }) => {
        expect(seg.text).toBeTruthy();
      });
      // Whisper path preserves original timing
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(3);
    });

    it('should apply duration optimization for gpt-4o models', () => {
      const optimize = (service as any).optimizeSegments.bind(service);
      const longText =
        'This is a very long subtitle text that definitely exceeds the maximum duration limit and should be split into multiple segments for readability purposes';
      const segments = [{ start: 0, end: 20, text: longText }];
      const result = optimize(segments, 'gpt-4o-transcribe');
      expect(result.length).toBeGreaterThan(1);
    });

    it('should default to whisper-1 when no model specified', () => {
      const optimize = (service as any).optimizeSegments.bind(service);
      const segments = [
        { start: 0, end: 3, text: 'Hello world' },
        { start: 3.5, end: 6, text: 'This is a subtitle' }
      ];
      const result = optimize(segments);
      expect(result.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('transcribeLocalFile', () => {
    it('should call OpenAI API with correct parameters for whisper-1', async () => {
      const mockVerboseResponse = {
        text: 'Hello world',
        words: [
          { word: 'Hello', start: 0.0, end: 0.5 },
          { word: 'world', start: 0.6, end: 1.0 }
        ]
      };
      const mockVTTResponse =
        'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello world\n';

      mockTranscriptionsCreate
        .mockResolvedValueOnce(mockVerboseResponse)
        .mockResolvedValueOnce(mockVTTResponse);

      const result = await service.transcribeLocalFile({
        filePath: '/tmp/test.mp3',
        language: 'en'
      });

      expect(mockTranscriptionsCreate).toHaveBeenCalledTimes(2);
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should use default model whisper-1 when not specified', async () => {
      const mockVerboseResponse = {
        text: 'Test',
        words: [{ word: 'Test', start: 0.0, end: 1.0 }]
      };
      mockTranscriptionsCreate
        .mockResolvedValueOnce(mockVerboseResponse)
        .mockResolvedValueOnce(
          'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTest\n'
        );

      await service.transcribeLocalFile({
        filePath: '/tmp/test.mp3'
      });

      expect(mockTranscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'whisper-1'
        })
      );
    });

    it('should wrap API errors in TranscribeError', async () => {
      const apiError = new Error('API Error');
      (apiError as any).status = 400;
      mockTranscriptionsCreate.mockRejectedValueOnce(apiError);

      await expect(
        service.transcribeLocalFile({ filePath: '/tmp/test.mp3' })
      ).rejects.toThrow(TranscribeError);
    });

    it('should use json format for gpt-4o-transcribe model', async () => {
      mockTranscriptionsCreate.mockResolvedValueOnce({
        text: 'Hello from GPT'
      });

      const result = await service.transcribeLocalFile({
        filePath: '/tmp/test.mp3',
        model: 'gpt-4o-transcribe'
      });

      expect(mockTranscriptionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-transcribe',
          response_format: 'json'
        })
      );
      expect(result).toBeDefined();
    });

    it('should handle diarize model with speaker labels', async () => {
      mockTranscriptionsCreate.mockResolvedValueOnce({
        text: 'Speaker A says hello',
        speakers: [
          {
            id: 'A',
            name: 'Alice',
            segments: [{ text: 'Hello', start: 0, end: 1 }]
          },
          {
            id: 'B',
            name: 'Bob',
            segments: [{ text: 'Hi there', start: 1.5, end: 3 }]
          }
        ]
      });

      const result = await service.transcribeLocalFile({
        filePath: '/tmp/test.mp3',
        model: 'gpt-4o-transcribe-diarize',
        speakerNames: ['Alice', 'Bob']
      });

      expect(result).toBeDefined();
      expect(result.length).toBe(2);
      expect(result[0].text).toContain('[Alice]');
      expect(result[1].text).toContain('[Bob]');
    });
  });

  describe('transcribeRemoteFile', () => {
    it('should set state to INACTIVE after completion', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFile } = require('child_process');
      execFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (...args: unknown[]) => void) =>
          cb(null, { stdout: '', stderr: '' })
      );

      const mockVerboseResponse = {
        text: 'Hello',
        words: [{ word: 'Hello', start: 0.0, end: 1.0 }]
      };
      mockTranscriptionsCreate
        .mockResolvedValueOnce(mockVerboseResponse)
        .mockResolvedValueOnce(
          'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n'
        );

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({ ok: true });

      try {
        const result = await service.transcribeRemoteFile({
          source: 'https://example.com/video.mp4'
        });
        expect(service.state).toBe(State.INACTIVE);
        expect(result).toBeDefined();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('should default format to vtt', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFile } = require('child_process');
      execFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (...args: unknown[]) => void) =>
          cb(null, { stdout: '', stderr: '' })
      );

      const mockVerboseResponse = {
        text: 'Test',
        words: [{ word: 'Test', start: 0.0, end: 1.0 }]
      };
      mockTranscriptionsCreate
        .mockResolvedValueOnce(mockVerboseResponse)
        .mockResolvedValueOnce(
          'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTest\n'
        );

      const result = await service.transcribeRemoteFile({
        source: 'https://example.com/video.mp4'
      });
      expect(result).toContain('WEBVTT');
    });
  });

  describe('wrapTranscribeError', () => {
    it('should wrap 400 errors as INVALID_REQUEST', () => {
      const wrap = (service as any).wrapTranscribeError.bind(service);
      const err = new Error('bad request');
      (err as any).status = 400;

      try {
        wrap(err, 'whisper-1', '/tmp/test.mp3');
      } catch (e: any) {
        expect(e).toBeInstanceOf(TranscribeError);
        expect(e.code).toBe('INVALID_REQUEST');
        expect(e.statusCode).toBe(400);
      }
    });

    it('should wrap 401 errors as UNAUTHORIZED', () => {
      const wrap = (service as any).wrapTranscribeError.bind(service);
      const err = new Error('unauthorized');
      (err as any).status = 401;

      try {
        wrap(err, 'whisper-1', '/tmp/test.mp3');
      } catch (e: any) {
        expect(e.code).toBe('UNAUTHORIZED');
        expect(e.statusCode).toBe(401);
      }
    });

    it('should wrap 429 errors as RATE_LIMITED and retryable', () => {
      const wrap = (service as any).wrapTranscribeError.bind(service);
      const err = new Error('rate limited');
      (err as any).status = 429;

      try {
        wrap(err, 'whisper-1', '/tmp/test.mp3');
      } catch (e: any) {
        expect(e.code).toBe('RATE_LIMITED');
        expect(e.statusCode).toBe(429);
        expect(e.retryable).toBe(true);
      }
    });

    it('should wrap unknown errors as TRANSCRIPTION_FAILED', () => {
      const wrap = (service as any).wrapTranscribeError.bind(service);
      const err = new Error('something went wrong');

      try {
        wrap(err, 'gpt-4o-transcribe', '/tmp/test.mp3');
      } catch (e: any) {
        expect(e.code).toBe('TRANSCRIPTION_FAILED');
        expect(e.statusCode).toBe(500);
        expect(e.retryable).toBe(true);
      }
    });
  });
});
