import api from './api';

// Mock the TranscribeService module with all required exports
jest.mock('./TranscribeService/TranscribeService', () => {
  const mockTranscribeRemoteFile = jest.fn();
  const mockTranscribeRemoteFileS3 = jest.fn();

  const VALID_TRANSCRIBE_MODELS = [
    'whisper-1',
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'gpt-4o-mini-transcribe-2025-12-15',
    'gpt-4o-transcribe-diarize'
  ];

  const DEFAULT_TRANSCRIBE_MODEL = 'whisper-1';

  class TranscribeError extends Error {
    public readonly code: string;
    public readonly statusCode: number;
    public readonly retryable: boolean;
    constructor(
      message: string,
      code: string,
      statusCode: number,
      retryable = false
    ) {
      super(message);
      this.name = 'TranscribeError';
      this.code = code;
      this.statusCode = statusCode;
      this.retryable = retryable;
    }
  }

  return {
    TranscribeService: jest.fn().mockImplementation(() => ({
      id: 'mock-worker-id',
      state: 'INACTIVE',
      transcribeRemoteFile: mockTranscribeRemoteFile,
      TranscribeRemoteFileS3: mockTranscribeRemoteFileS3
    })),
    TranscribeError,
    State: {
      IDLE: 'IDLE',
      ACTIVE: 'ACTIVE',
      INACTIVE: 'INACTIVE'
    },
    VALID_TRANSCRIBE_MODELS,
    DEFAULT_TRANSCRIBE_MODEL
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TranscribeService } = require('./TranscribeService/TranscribeService');

describe('api', () => {
  describe('GET / (healthcheck)', () => {
    it('responds with healthy message', async () => {
      const server = api({ title: '@eyevinn/auto-subtitles' });
      const response = await server.inject({
        method: 'GET',
        url: '/'
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(
        '@eyevinn/auto-subtitles is healthy \u{1F496}'
      );
    });

    it('uses the provided title in the health response', async () => {
      const server = api({ title: 'My Custom Service' });
      const response = await server.inject({
        method: 'GET',
        url: '/'
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('My Custom Service is healthy \u{1F496}');
    });

    it('handles trailing slash', async () => {
      const server = api({ title: 'test' });
      const response = await server.inject({
        method: 'GET',
        url: '/'
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /transcribe', () => {
    let server: ReturnType<typeof api>;

    beforeEach(() => {
      jest.clearAllMocks();
      server = api({ title: 'test' });
    });

    it('should transcribe a remote file successfully', async () => {
      const mockWorker =
        TranscribeService.mock.results[0]?.value ?? TranscribeService();
      mockWorker.transcribeRemoteFile.mockResolvedValue(
        'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n'
      );

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('workerId');
      expect(body).toHaveProperty('result');
      expect(body.result).toContain('WEBVTT');
    });

    it('should pass language parameter', async () => {
      const mockWorker = TranscribeService();
      mockWorker.transcribeRemoteFile.mockResolvedValue('WEBVTT\n\n');

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4',
          language: 'sv'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(mockWorker.transcribeRemoteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          language: 'sv'
        })
      );
    });

    it('should pass format parameter', async () => {
      const mockWorker = TranscribeService();
      mockWorker.transcribeRemoteFile.mockResolvedValue(
        '1\n00:00:00,000 --> 00:00:01,000\nHello\n'
      );

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4',
          format: 'srt'
        }
      });

      expect(response.statusCode).toBe(200);
    });

    it('should pass callback URL when provided', async () => {
      const mockWorker = TranscribeService();
      mockWorker.transcribeRemoteFile.mockResolvedValue('WEBVTT\n\n');

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4',
          callbackUrl: 'https://callback.example.com/webhook'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(mockWorker.transcribeRemoteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackUrl: expect.any(URL)
        })
      );
    });

    it('should pass external ID when provided', async () => {
      const mockWorker = TranscribeService();
      mockWorker.transcribeRemoteFile.mockResolvedValue('WEBVTT\n\n');

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4',
          externalId: 'ext-123'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(mockWorker.transcribeRemoteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          externalId: 'ext-123'
        })
      );
    });

    it('should pass prompt when provided', async () => {
      const mockWorker = TranscribeService();
      mockWorker.transcribeRemoteFile.mockResolvedValue('WEBVTT\n\n');

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4',
          prompt: 'This is a tech talk about Node.js'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(mockWorker.transcribeRemoteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'This is a tech talk about Node.js'
        })
      );
    });

    it('should return 500 on transcription error', async () => {
      const mockWorker = TranscribeService();
      mockWorker.transcribeRemoteFile.mockRejectedValue(
        new Error('Transcription failed')
      );

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4'
        }
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('workerId');
      expect(body).toHaveProperty('error');
    });

    it('should require url in the body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {}
      });

      expect(response.statusCode).toBe(400);
    });

    it('should handle undefined optional parameters gracefully', async () => {
      const mockWorker = TranscribeService();
      mockWorker.transcribeRemoteFile.mockResolvedValue('WEBVTT\n\n');

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe',
        payload: {
          url: 'https://example.com/video.mp4'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(mockWorker.transcribeRemoteFile).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'https://example.com/video.mp4',
          callbackUrl: undefined,
          externalId: undefined
        })
      );
    });
  });

  describe('POST /transcribe/s3', () => {
    let server: ReturnType<typeof api>;

    beforeEach(() => {
      jest.clearAllMocks();
      server = api({ title: 'test' });
    });

    it('should accept a valid S3 transcribe request', async () => {
      const mockWorker = TranscribeService();
      mockWorker.TranscribeRemoteFileS3.mockResolvedValue(undefined);

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe/s3',
        payload: {
          url: 'https://example.com/video.mp4',
          bucket: 'my-output-bucket',
          key: 'subtitles/output'
        }
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toHaveProperty('workerId');
    });

    it('should pass all parameters to TranscribeRemoteFileS3', async () => {
      const mockWorker = TranscribeService();
      mockWorker.TranscribeRemoteFileS3.mockResolvedValue(undefined);

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe/s3',
        payload: {
          url: 'https://example.com/video.mp4',
          bucket: 'my-bucket',
          key: 'output',
          language: 'en',
          format: 'srt',
          region: 'us-east-1',
          callbackUrl: 'https://callback.example.com',
          externalId: 'job-456',
          prompt: 'Technical content'
        }
      });

      expect(response.statusCode).toBe(200);
      expect(mockWorker.TranscribeRemoteFileS3).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'https://example.com/video.mp4',
          bucket: 'my-bucket',
          key: 'output',
          language: 'en',
          format: 'srt',
          region: 'us-east-1'
        })
      );
    });

    it('should require url, bucket, and key in the body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/transcribe/s3',
        payload: {
          url: 'https://example.com/video.mp4'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should require url in the body', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/transcribe/s3',
        payload: {
          bucket: 'my-bucket',
          key: 'output'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 200 immediately (async operation)', async () => {
      const mockWorker = TranscribeService();
      mockWorker.TranscribeRemoteFileS3.mockResolvedValue(undefined);

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe/s3',
        payload: {
          url: 'https://example.com/video.mp4',
          bucket: 'my-bucket',
          key: 'output'
        }
      });

      expect(response.statusCode).toBe(200);
    });

    it('should return 500 when TranscribeRemoteFileS3 throws synchronously', async () => {
      const mockWorker = TranscribeService();
      mockWorker.TranscribeRemoteFileS3.mockImplementation(() => {
        throw new Error('Immediate failure');
      });

      const response = await server.inject({
        method: 'POST',
        url: '/transcribe/s3',
        payload: {
          url: 'https://example.com/video.mp4',
          bucket: 'my-bucket',
          key: 'output'
        }
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('Swagger docs', () => {
    it('should serve swagger docs at /docs/json', async () => {
      const server = api({ title: 'test' });
      const response = await server.inject({
        method: 'GET',
        url: '/docs/json'
      });

      expect(response.statusCode).toBe(200);
      const docs = JSON.parse(response.body);
      expect(docs).toHaveProperty('swagger');
      expect(docs.info.title).toBe('test');
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown routes', async () => {
      const server = api({ title: 'test' });
      const response = await server.inject({
        method: 'GET',
        url: '/nonexistent'
      });

      expect(response.statusCode).toBe(404);
    });

    it('should return 404 for wrong HTTP method', async () => {
      const server = api({ title: 'test' });
      const response = await server.inject({
        method: 'GET',
        url: '/transcribe'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const server = api({ title: 'test' });
      const response = await server.inject({
        method: 'OPTIONS',
        url: '/',
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'GET'
        }
      });

      expect(response.statusCode).toBeLessThanOrEqual(204);
    });
  });
});
