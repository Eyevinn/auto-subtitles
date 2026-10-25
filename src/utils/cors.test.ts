import {
  CORS_ALLOWED_METHODS,
  corsOptionsFromEnv,
  parseAllowedOrigins
} from './cors';

describe('parseAllowedOrigins', () => {
  it('returns an empty list when the value is undefined', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('returns an empty list for an empty or whitespace-only value', () => {
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
    expect(parseAllowedOrigins(',,')).toEqual([]);
  });

  it('parses a single origin', () => {
    expect(parseAllowedOrigins('https://app.example.com')).toEqual([
      'https://app.example.com'
    ]);
  });

  it('trims entries and drops empty ones', () => {
    expect(
      parseAllowedOrigins(' https://a.example.com , ,https://b.example.com, ')
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});

describe('corsOptionsFromEnv', () => {
  it('denies all origins when the variable is unset', () => {
    const options = corsOptionsFromEnv({});
    expect(options.origin).toEqual([]);
  });

  it('denies all origins when the variable is empty', () => {
    const options = corsOptionsFromEnv({ CORS_ALLOWED_ORIGINS: '  ' });
    expect(options.origin).toEqual([]);
  });

  it('never defaults to a wildcard origin', () => {
    expect(corsOptionsFromEnv({}).origin).not.toBe('*');
  });

  it('uses the parsed allowlist when origins are configured', () => {
    const options = corsOptionsFromEnv({
      CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com'
    });
    expect(options.origin).toEqual([
      'https://a.example.com',
      'https://b.example.com'
    ]);
  });

  it('honours an explicit wildcard and warns about it', () => {
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const options = corsOptionsFromEnv({ CORS_ALLOWED_ORIGINS: '*' });
      expect(options.origin).toBe('*');
      const warned = stdout.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('"level":"warn"') &&
          call[0].includes('CORS_ALLOWED_ORIGINS')
      );
      expect(warned).toBe(true);
    } finally {
      stdout.mockRestore();
    }
  });

  it('restricts the advertised methods to those the API serves', () => {
    expect(corsOptionsFromEnv({}).methods).toEqual(CORS_ALLOWED_METHODS);
    expect(CORS_ALLOWED_METHODS).toEqual(['GET', 'POST', 'OPTIONS']);
  });
});
