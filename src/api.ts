import fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import {
  TranscribeService,
  State,
  TTranscribeFormat
} from './TranscribeService/TranscribeService';

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
      reply.send(opts.title + ' is healthy 💖');
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
      callbackUrl?: string;
      externalId?: string; // Optional external ID for tracking
      prompt?: string;
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
              type: 'string', // Optional external ID for tracking
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
      const worker = transcribeWorker();
      try {
        const result = await worker.transcribeRemoteFile({
          source: request.body.url,
          language: request.body.language,
          prompt: request.body.prompt,
          format: request.body.format,
          callbackUrl: request.body.callbackUrl
            ? new URL(request.body.callbackUrl)
            : undefined,
          externalId: request.body.externalId
        });
        const resp = {
          workerId: worker.id,
          result
        };
        reply
          .code(200)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send(resp);
      } catch (err) {
        reply
          .code(500)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({ workerId: worker.id, error: err });
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
      externalId?: string; // Optional external ID for tracking
      language?: string;
      bucket: string;
      key: string;
      region?: string;
      format?: TTranscribeFormat;
      prompt?: string;
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
              type: 'string', // Optional external ID for tracking
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
      const worker = transcribeWorker();
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
          bucket: request.body.bucket,
          key: request.body.key,
          region: request.body.region
        });
        reply
          .code(200)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({ workerId: worker.id });
      } catch (err) {
        reply
          .code(500)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({ workerId: worker.id, error: err });
      }
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
  return api;
};
