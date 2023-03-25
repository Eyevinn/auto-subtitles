import fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Static, Type } from '@sinclair/typebox';
import { FastifyPluginCallback } from 'fastify';
import {
  TranscribeService,
  State
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
  fastify.post<{ Body: { url: string } }>(
    '/transcribe',
    {
      schema: {
        description: 'Transcribe a remote file',
        body: {
          type: 'object',
          properties: {
            url: {
              type: 'string'
            }
          }
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
        const resp = {
          workerId: worker.id,
          result: await worker.transcribeRemoteFile(request.body.url)
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
        description: 'hello',
        version: 'v1'
      }
    }
  });
  api.register(swaggerUI, {
    routePrefix: '/docs'
  });
  api.register(healthcheck, { title: opts.title });
  api.register(transcribe, { title: opts.title });
  return api;
};
