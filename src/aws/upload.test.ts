import { uploadToS3, signUrl } from './upload';

// Use factory functions inside jest.mock to avoid hoisting issues
jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: mockSend
    })),
    GetObjectCommand: jest.fn().mockImplementation((params) => params)
  };
});

jest.mock('@aws-sdk/lib-storage', () => {
  const mockDone = jest.fn().mockResolvedValue(undefined);
  const mockOn = jest.fn();
  return {
    Upload: jest.fn().mockImplementation(() => ({
      done: mockDone,
      on: mockOn
    }))
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest
    .fn()
    .mockResolvedValue('https://bucket.s3.amazonaws.com/key?signed=true')
}));

// Get references to mocked constructors after mocking
/* eslint-disable @typescript-eslint/no-var-requires */
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
/* eslint-enable @typescript-eslint/no-var-requires */

describe('uploadToS3', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AWS_REGION;
    delete process.env.AWS_S3_ENDPOINT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should upload content to S3 with vtt format', async () => {
    await uploadToS3({
      content: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTest',
      bucket: 'my-bucket',
      key: 'subtitles/output',
      format: 'vtt'
    });

    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Bucket: 'my-bucket',
          Key: 'subtitles/output.vtt',
          Body: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nTest'
        })
      })
    );
  });

  it('should upload with srt extension for srt format', async () => {
    await uploadToS3({
      content: '1\n00:00:00,000 --> 00:00:01,000\nTest',
      bucket: 'my-bucket',
      key: 'subtitles/output',
      format: 'srt'
    });

    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Key: 'subtitles/output.srt'
        })
      })
    );
  });

  it('should upload with json extension for json format', async () => {
    await uploadToS3({
      content: '[]',
      bucket: 'my-bucket',
      key: 'subtitles/output',
      format: 'json'
    });

    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Key: 'subtitles/output.json'
        })
      })
    );
  });

  it('should upload with json extension for verbose_json format', async () => {
    await uploadToS3({
      content: '{}',
      bucket: 'my-bucket',
      key: 'subtitles/output',
      format: 'verbose_json'
    });

    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Key: 'subtitles/output.json'
        })
      })
    );
  });

  it('should upload with txt extension for text format', async () => {
    await uploadToS3({
      content: 'Plain text',
      bucket: 'my-bucket',
      key: 'subtitles/output',
      format: 'text'
    });

    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Key: 'subtitles/output.txt'
        })
      })
    );
  });

  it('should use provided region', async () => {
    await uploadToS3({
      content: 'test',
      bucket: 'my-bucket',
      key: 'output',
      format: 'vtt',
      region: 'eu-west-1'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'eu-west-1'
      })
    );
  });

  it('should use AWS_REGION from environment when no region provided', async () => {
    process.env.AWS_REGION = 'us-west-2';

    await uploadToS3({
      content: 'test',
      bucket: 'my-bucket',
      key: 'output',
      format: 'vtt'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2'
      })
    );
  });

  it('should use custom endpoint when provided', async () => {
    await uploadToS3({
      content: 'test',
      bucket: 'my-bucket',
      key: 'output',
      format: 'vtt',
      endpoint: 'https://minio.example.com'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://minio.example.com',
        forcePathStyle: true,
        region: 'custom'
      })
    );
  });

  it('should use AWS_S3_ENDPOINT from environment when no endpoint provided', async () => {
    process.env.AWS_S3_ENDPOINT = 'https://env-endpoint.example.com';

    await uploadToS3({
      content: 'test',
      bucket: 'my-bucket',
      key: 'output',
      format: 'vtt'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://env-endpoint.example.com',
        forcePathStyle: true
      })
    );
  });

  it('should register httpUploadProgress event handler', async () => {
    await uploadToS3({
      content: 'test',
      bucket: 'my-bucket',
      key: 'output',
      format: 'vtt'
    });

    const uploadInstance = Upload.mock.results[0].value;
    expect(uploadInstance.on).toHaveBeenCalledWith(
      'httpUploadProgress',
      expect.any(Function)
    );
  });

  it('should not use forcePathStyle when no custom endpoint', async () => {
    await uploadToS3({
      content: 'test',
      bucket: 'my-bucket',
      key: 'output',
      format: 'vtt'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        forcePathStyle: false
      })
    );
  });
});

describe('signUrl', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.AWS_REGION;
    delete process.env.AWS_S3_ENDPOINT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should sign an S3 URL and return a URL object', async () => {
    const result = await signUrl({
      url: new URL('s3://my-bucket/path/to/file.mp3')
    });

    expect(result).toBeInstanceOf(URL);
    expect(result.toString()).toBe(
      'https://bucket.s3.amazonaws.com/key?signed=true'
    );
  });

  it('should extract bucket from URL hostname and key from pathname', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { GetObjectCommand } = require('@aws-sdk/client-s3');

    await signUrl({
      url: new URL('s3://test-bucket/some/path/file.mp3')
    });

    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'some/path/file.mp3'
    });
  });

  it('should use provided region', async () => {
    await signUrl({
      url: new URL('s3://bucket/key'),
      region: 'ap-southeast-1'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'ap-southeast-1'
      })
    );
  });

  it('should use custom endpoint when provided', async () => {
    await signUrl({
      url: new URL('s3://bucket/key'),
      endpoint: 'https://custom-s3.example.com'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://custom-s3.example.com',
        forcePathStyle: true,
        region: 'custom'
      })
    );
  });

  it('should use AWS_S3_ENDPOINT from environment', async () => {
    process.env.AWS_S3_ENDPOINT = 'https://env-s3.example.com';

    await signUrl({
      url: new URL('s3://bucket/key')
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://env-s3.example.com',
        forcePathStyle: true
      })
    );
  });

  it('should call getSignedUrl with 1 hour expiry', async () => {
    await signUrl({
      url: new URL('s3://bucket/key')
    });

    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { expiresIn: 3600 }
    );
  });

  it('should use AWS_REGION from environment when no region or endpoint provided', async () => {
    process.env.AWS_REGION = 'eu-central-1';

    await signUrl({
      url: new URL('s3://bucket/key')
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'eu-central-1'
      })
    );
  });

  it('should set region to custom when endpoint is provided but no region', async () => {
    await signUrl({
      url: new URL('s3://bucket/key'),
      endpoint: 'https://minio.local:9000'
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'custom'
      })
    );
  });
});
