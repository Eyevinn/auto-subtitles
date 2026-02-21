const ALLOWED_SOURCE_PROTOCOLS = ['http:', 'https:', 's3:'];
const ALLOWED_CALLBACK_PROTOCOLS = ['http:', 'https:'];

export function validateSourceUrl(urlString: string): URL {
  const url = new URL(urlString);
  if (!ALLOWED_SOURCE_PROTOCOLS.includes(url.protocol)) {
    throw new Error(
      `Unsupported URL protocol: ${url.protocol}. Only http, https, and s3 are allowed.`
    );
  }
  return url;
}

export function validateCallbackUrl(urlString: string): URL {
  const url = new URL(urlString);
  if (!ALLOWED_CALLBACK_PROTOCOLS.includes(url.protocol)) {
    throw new Error(
      `Unsupported callback URL protocol: ${url.protocol}. Only http and https are allowed.`
    );
  }
  return url;
}
