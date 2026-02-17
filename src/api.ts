import fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import {
  TranscribeService,
  TranscribeError,
  State,
  TTranscribeFormat,
  TTranscribeModel,
  VALID_TRANSCRIBE_MODELS,
  DEFAULT_TRANSCRIBE_MODEL
} from './TranscribeService/TranscribeService';
import logger from './utils/logger';
import { serializeMetrics, totalWorkers } from './utils/metrics';

const HelloWorld = Type.String({
  description: 'The magical words!'
});

export interface Options {
  title: string;
}

const transcribeWorkers: TranscribeService[] = [];
const transcribeWorker = (): TranscribeService => {
  const worker = transcribeWorkers.find(
    (client) => client.state === State.INACTIVE
  );
  if (worker) return worker;
  const newWorker = new TranscribeService();
  newWorker.state = State.IDLE;
  transcribeWorkers.push(newWorker);
  totalWorkers.set(transcribeWorkers.length);
  logger.info('New transcription worker created', {
    workerId: newWorker.id,
    totalWorkers: transcribeWorkers.length
  });
  return transcribeWorkers[transcribeWorkers.length - 1];
};
const healthcheck: FastifyPluginCallback<Options> = (fastify, opts, next) => {
  fastify.get<{ Reply: Static<typeof HelloWorld> }>(
    '/',
    {
      schema: {
        description: 'healthcheck',
        response: {
          200: HelloWorld
        }
      }
    },
    async (_, reply) => {
      reply.send(opts.title + ' is healthy \u{1F496}');
    }
  );
  fastify.get(
    '/health',
    {
      schema: {
        description: 'Detailed health check with worker status',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              title: { type: 'string' },
              workers: {
                type: 'object',
                properties: {
                  total: { type: 'number' },
                  active: { type: 'number' },
                  idle: { type: 'number' },
                  inactive: { type: 'number' }
                }
              }
            }
          }
        }
      }
    },
    async (_, reply) => {
      const active = transcribeWorkers.filter(
        (w) => w.state === State.ACTIVE
      ).length;
      const idle = transcribeWorkers.filter(
        (w) => w.state === State.IDLE
      ).length;
      const inactive = transcribeWorkers.filter(
        (w) => w.state === State.INACTIVE
      ).length;
      reply.send({
        status: 'healthy',
        title: opts.title,
        workers: {
          total: transcribeWorkers.length,
          active,
          idle,
          inactive
        }
      });
    }
  );
  next();
};
const transcribe: FastifyPluginCallback<Options> = (fastify, _opts, next) => {
  fastify.post<{
    Body: {
      url: string;
      language?: string;
      format?: TTranscribeFormat;
      model?: TTranscribeModel;
      callbackUrl?: string;
      externalId?: string;
      prompt?: string;
      speakerNames?: string[];
    };
  }>(
    '/transcribe',
    {
      schema: {
        description: 'Transcribe a remote file',
        body: {
          type: 'object',
          properties: {
            url: {
              type: 'string'
            },
            callbackUrl: {
              type: 'string',
              description: 'Optional callback URL to receive subtitling status'
            },
            externalId: {
              type: 'string',
              description:
                'Optional external ID for tracking the subtitling job'
            },
            language: {
              type: 'string' // language code in ISO 639-1 format (default: en)
            },
            prompt: {
              type: 'string',
              description:
                'Optional prompt to guide the transcription process. This can be used to provide context or specific instructions for the transcription.'
            },
            format: {
              type: 'string', // srt or vtt (default)
              enum: ['srt', 'vtt']
            },
            model: {
              type: 'string',
              enum: VALID_TRANSCRIBE_MODELS as unknown as string[],
              description: `Transcription model to use. Supported: ${VALID_TRANSCRIBE_MODELS.join(
                ', '
              )}. Default: ${DEFAULT_TRANSCRIBE_MODEL}`
            },
            speakerNames: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 4,
              description:
                'Known speaker names for diarization (max 4). Only used with gpt-4o-transcribe-diarize model.'
            }
          },
          required: ['url']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              workerId: {
                type: 'string'
              },
              result: {
                type: 'string'
              }
            }
          },
          400: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              },
              code: {
                type: 'string'
              }
            }
          },
          500: {
            type: 'object',
            properties: {
              workerId: {
                type: 'string'
              },
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const { model, speakerNames } = request.body;
      if (
        model &&
        !VALID_TRANSCRIBE_MODELS.includes(model as TTranscribeModel)
      ) {
        return reply
          .code(400)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({
            error: `Invalid model '${model}'. Supported models: ${VALID_TRANSCRIBE_MODELS.join(
              ', '
            )}`,
            code: 'INVALID_MODEL'
          });
      }
      if (
        speakerNames &&
        speakerNames.length > 0 &&
        model !== 'gpt-4o-transcribe-diarize'
      ) {
        return reply
          .code(400)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({
            error:
              'speakerNames is only supported with the gpt-4o-transcribe-diarize model',
            code: 'INVALID_PARAMETER'
          });
      }
      const worker = transcribeWorker();
      const effectiveModel = model ?? DEFAULT_TRANSCRIBE_MODEL;
      const effectiveFormat = request.body.format ?? 'vtt';
      const reqLog = logger.child({
        workerId: worker.id,
        model: effectiveModel,
        format: effectiveFormat,
        endpoint: 'transcribe'
      });
      reqLog.info('Transcription request received', {
        url: request.body.url
      });
      try {
        const result = await worker.transcribeRemoteFile({
          source: request.body.url,
          language: request.body.language,
          prompt: request.body.prompt,
          format: request.body.format,
          model: model as TTranscribeModel | undefined,
          callbackUrl: request.body.callbackUrl
            ? new URL(request.body.callbackUrl)
            : undefined,
          externalId: request.body.externalId,
          speakerNames
        });
        reqLog.info('Transcription completed');
        const resp = {
          workerId: worker.id,
          result
        };
        reply
          .code(200)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send(resp);
      } catch (err) {
        const statusCode =
          err instanceof TranscribeError ? err.statusCode : 500;
        reqLog.error('Transcription request failed', {
          statusCode,
          err: err instanceof Error ? err.message : 'Unknown error'
        });
        reply
          .code(statusCode)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({
            workerId: worker.id,
            error: err instanceof Error ? err.message : 'Unknown error occurred'
          });
      }
    }
  );
  next();
};
const transcribeS3: FastifyPluginCallback<Options> = (fastify, _opts, next) => {
  fastify.post<{
    Body: {
      url: string;
      callbackUrl?: string;
      externalId?: string;
      language?: string;
      bucket: string;
      key: string;
      region?: string;
      format?: TTranscribeFormat;
      model?: TTranscribeModel;
      prompt?: string;
      speakerNames?: string[];
    };
  }>(
    '/transcribe/s3',
    {
      schema: {
        description: 'Transcribe a remote file and upload to S3',
        body: {
          type: 'object',
          properties: {
            url: {
              type: 'string'
            },
            callbackUrl: {
              type: 'string'
            },
            externalId: {
              type: 'string',
              description:
                'Optional external ID for tracking the subtitling job'
            },
            language: {
              type: 'string' // language code in ISO 639-1 format (default: en)
            },
            prompt: {
              type: 'string',
              description:
                'Optional prompt to guide the transcription process. This can be used to provide context or specific instructions for the transcription.'
            },
            format: {
              type: 'string', // srt or vtt (default)
              enum: ['srt', 'vtt']
            },
            model: {
              type: 'string',
              enum: VALID_TRANSCRIBE_MODELS as unknown as string[],
              description: `Transcription model to use. Supported: ${VALID_TRANSCRIBE_MODELS.join(
                ', '
              )}. Default: ${DEFAULT_TRANSCRIBE_MODEL}`
            },
            speakerNames: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 4,
              description:
                'Known speaker names for diarization (max 4). Only used with gpt-4o-transcribe-diarize model.'
            },
            bucket: {
              type: 'string'
            },
            key: {
              type: 'string' // Name of uploaded file in S3
            },
            region: {
              type: 'string'
            },
            endpoint: {
              type: 'string'
            }
          },
          required: ['url', 'bucket', 'key']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              workerId: {
                type: 'string'
              }
            }
          },
          400: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              },
              code: {
                type: 'string'
              }
            }
          },
          500: {
            type: 'object',
            properties: {
              workerId: {
                type: 'string'
              },
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    async (request, reply) => {
      const { model, speakerNames } = request.body;
      if (
        model &&
        !VALID_TRANSCRIBE_MODELS.includes(model as TTranscribeModel)
      ) {
        return reply
          .code(400)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({
            error: `Invalid model '${model}'. Supported models: ${VALID_TRANSCRIBE_MODELS.join(
              ', '
            )}`,
            code: 'INVALID_MODEL'
          });
      }
      if (
        speakerNames &&
        speakerNames.length > 0 &&
        model !== 'gpt-4o-transcribe-diarize'
      ) {
        return reply
          .code(400)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({
            error:
              'speakerNames is only supported with the gpt-4o-transcribe-diarize model',
            code: 'INVALID_PARAMETER'
          });
      }
      const worker = transcribeWorker();
      const effectiveModel = model ?? DEFAULT_TRANSCRIBE_MODEL;
      const effectiveFormat = request.body.format ?? 'vtt';
      const reqLog = logger.child({
        workerId: worker.id,
        model: effectiveModel,
        format: effectiveFormat,
        endpoint: 'transcribe_s3'
      });
      reqLog.info('S3 transcription request received', {
        url: request.body.url,
        bucket: request.body.bucket,
        key: request.body.key
      });
      try {
        worker.TranscribeRemoteFileS3({
          source: request.body.url,
          callbackUrl: request.body.callbackUrl
            ? new URL(request.body.callbackUrl)
            : undefined,
          externalId: request.body.externalId,
          language: request.body.language,
          prompt: request.body.prompt,
          format: request.body.format,
          model: model as TTranscribeModel | undefined,
          bucket: request.body.bucket,
          key: request.body.key,
          region: request.body.region,
          speakerNames
        });
        reply
          .code(200)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({ workerId: worker.id });
      } catch (err) {
        const statusCode =
          err instanceof TranscribeError ? err.statusCode : 500;
        reqLog.error('S3 transcription request failed', {
          statusCode,
          err: err instanceof Error ? err.message : 'Unknown error'
        });
        reply
          .code(statusCode)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({
            workerId: worker.id,
            error: err instanceof Error ? err.message : 'Unknown error occurred'
          });
      }
    }
  );
  next();
};

const metrics: FastifyPluginCallback<Options> = (fastify, _opts, next) => {
  fastify.get(
    '/metrics',
    {
      schema: {
        description: 'Prometheus-compatible metrics endpoint',
        response: {
          200: {
            type: 'string'
          }
        }
      }
    },
    async (_, reply) => {
      reply
        .code(200)
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(serializeMetrics());
    }
  );
  next();
};

export interface ApiOptions {
  title: string;
}

export default (opts: ApiOptions) => {
  const api = fastify({
    ignoreTrailingSlash: true
  }).withTypeProvider<TypeBoxTypeProvider>();
  api.register(cors);
  api.register(swagger, {
    swagger: {
      info: {
        title: opts.title,
        description: 'Transcribe Service API',
        version: 'v1'
      }
    }
  });
  api.register(swaggerUI, {
    routePrefix: '/docs'
  });
  api.register(healthcheck, { title: opts.title });
  api.register(transcribe, { title: opts.title });
  api.register(transcribeS3, { title: opts.title });
  api.register(metrics, { title: opts.title });
  return api;
};
