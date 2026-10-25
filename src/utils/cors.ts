/**
 * CORS configuration for the auto-subtitles API.
 *
 * The browser-facing origin allowlist is configured with the
 * `CORS_ALLOWED_ORIGINS` environment variable: a comma-separated list of exact
 * origins (for example `https://app.example.com,https://admin.example.com`).
 *
 * Deny by default: when the variable is unset or empty, no origin is allowed
 * and no `Access-Control-Allow-Origin` header is ever sent, so a browser on a
 * third-party page cannot read responses or drive jobs cross-site. Same-origin
 * requests and non-browser clients (curl, SDKs, server-to-server) are not
 * affected by CORS at all and keep working.
 *
 * Contract: the `origin` option is typed as
 * `ValueOrArray<string | boolean | RegExp> | OriginFunction` on
 * `FastifyCorsOptions` — see
 * node_modules/@fastify/cors/types/index.d.ts (`fastifyCors.FastifyCorsOptions`).
 */

import type { FastifyCorsOptions } from '@fastify/cors';
import logger from './logger';

/** The `origin` option shape accepted by @fastify/cors. */
export type CorsOriginOption = FastifyCorsOptions['origin'];

/**
 * Deny-all value for the `origin` option.
 *
 * An empty allowlist matches no request origin, so @fastify/cors writes no
 * `Access-Control-Allow-Origin` header. It is used in preference to
 * `origin: false` because `false` also disables the plugin's preflight route,
 * which turns every `OPTIONS` request into a 404 even for callers that are not
 * subject to CORS. Both values are equally closed; this one only withholds the
 * CORS grant.
 */
const DENY_ALL_ORIGINS: CorsOriginOption = [];

/** HTTP methods the API actually serves (plus the preflight method). */
export const CORS_ALLOWED_METHODS = ['GET', 'POST', 'OPTIONS'];

/**
 * Parse a comma-separated origin list: trim each entry and drop empty ones.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Build the @fastify/cors options from the environment.
 *
 * - unset/empty `CORS_ALLOWED_ORIGINS` -> deny every cross-origin request
 * - an explicit `*` entry -> allow any origin, with a startup warning
 * - otherwise -> allow exactly the listed origins
 */
export function corsOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): FastifyCorsOptions {
  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

  let origin: CorsOriginOption;
  if (allowedOrigins.length === 0) {
    origin = DENY_ALL_ORIGINS;
    logger.info(
      'CORS_ALLOWED_ORIGINS is not set, denying all cross-origin browser requests'
    );
  } else if (allowedOrigins.includes('*')) {
    origin = '*';
    logger.warn(
      'CORS_ALLOWED_ORIGINS contains "*", so any website may call this API from a browser. Set an explicit list of origins instead.'
    );
  } else {
    origin = allowedOrigins;
    logger.info('CORS origin allowlist configured', { allowedOrigins });
  }

  return {
    origin,
    methods: CORS_ALLOWED_METHODS
  };
}
