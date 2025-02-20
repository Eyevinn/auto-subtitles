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
    Body: { url: string; language?: string; format?: TTranscribeFormat };
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
            language: {
              type: 'string' // language code in ISO 639-1 format (default: en)
            },
            format: {
              type: 'string' // json, text, srt, verbose_json, vtt (default)
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
          format: request.body.format
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
      language?: string;
      bucket: string;
      key: string;
      region?: string;
      format?: TTranscribeFormat;
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
            language: {
              type: 'string' // language code in ISO 639-1 format (default: en)
            },
            format: {
              type: 'string' // json, text, srt, verbose_json, vtt (default)
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
          language: request.body.language,
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
