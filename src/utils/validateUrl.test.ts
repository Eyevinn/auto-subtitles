import { validateSourceUrl, validateCallbackUrl } from './validateUrl';

describe('validateSourceUrl', () => {
  it('should accept http URLs', () => {
    const result = validateSourceUrl('http://example.com/video.mp4');
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe('http:');
  });

  it('should accept https URLs', () => {
    const result = validateSourceUrl('https://example.com/video.mp4');
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe('https:');
  });

  it('should accept s3 URLs', () => {
    const result = validateSourceUrl('s3://my-bucket/path/to/file.mp4');
    expect(result).toBeInstanceOf(URL);
  });

  it('should reject file:// URLs', () => {
    expect(() => validateSourceUrl('file:///etc/passwd')).toThrow(
      'Unsupported URL protocol'
    );
  });

  it('should reject ftp:// URLs', () => {
    expect(() => validateSourceUrl('ftp://evil.com/file.mp4')).toThrow(
      'Unsupported URL protocol'
    );
  });

  it('should reject data: URLs', () => {
    expect(() => validateSourceUrl('data:text/plain;base64,aGVsbG8=')).toThrow(
      'Unsupported URL protocol'
    );
  });

  it('should throw on malformed input', () => {
    expect(() => validateSourceUrl('not-a-url')).toThrow();
  });
});

describe('validateCallbackUrl', () => {
  it('should accept http URLs', () => {
    const result = validateCallbackUrl('http://callback.example.com/hook');
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe('http:');
  });

  it('should accept https URLs', () => {
    const result = validateCallbackUrl('https://callback.example.com/hook');
    expect(result).toBeInstanceOf(URL);
    expect(result.protocol).toBe('https:');
  });

  it('should reject s3 URLs', () => {
    expect(() => validateCallbackUrl('s3://my-bucket/callback')).toThrow(
      'Unsupported callback URL protocol'
    );
  });

  it('should reject ftp:// URLs', () => {
    expect(() => validateCallbackUrl('ftp://evil.com/hook')).toThrow(
      'Unsupported callback URL protocol'
    );
  });

  it('should reject file:// URLs', () => {
    expect(() => validateCallbackUrl('file:///etc/passwd')).toThrow(
      'Unsupported callback URL protocol'
    );
  });

  it('should throw on malformed input', () => {
    expect(() => validateCallbackUrl('not-a-url')).toThrow();
  });
});
