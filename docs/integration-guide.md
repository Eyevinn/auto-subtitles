# Integration Guide: Wiring TranscribeService to the Provider Abstraction

This guide walks through refactoring `TranscribeService` to use the `ProviderRegistry` and `TranscriptionProvider` abstraction instead of calling the OpenAI SDK directly. All code snippets are copy-paste ready and match the existing code style (2-space indent, single quotes, no trailing commas, `logger` usage).

## Current State

The Backend Dev has implemented multi-model support directly in `TranscribeService.ts` with three separate methods:

- `transcribeLocalFileWhisper()` -- calls `this.openai.audio.transcriptions.create()` with whisper-1
- `transcribeLocalFileGpt()` -- calls `this.openai.audio.transcriptions.create()` with gpt-4o-\* models
- `transcribeLocalFileDiarize()` -- calls `this.openai.audio.transcriptions.create()` with diarize model

This works but has issues:

1. All OpenAI-specific logic lives in `TranscribeService` instead of the provider
2. Adding a local Whisper backend requires modifying `TranscribeService` again
3. Model-specific API details (format restrictions, diarization params) are scattered
4. The `retryWithBackoff()` and `wrapTranscribeError()` utilities duplicate what a provider could handle

The provider abstraction in `src/providers/` encapsulates all of this behind a single `provider.transcribe()` call.

## What Stays, What Moves

### Stays in TranscribeService (orchestration)

- Worker pool management (`workerState`, `instanceId`)
- Audio conversion (`convertToMP3`)
- Chunk iteration loop
- Segment timecode adjustment (`adjustSegmentTimecodes`)
- Segment optimization (`optimizeSegments`, `mergeShortSegments`, `limitSegmentLines`, etc.)
- VTT/SRT formatting (`formatSegmentsToVTT`, `formatSegmentsToSRT`)
- Callback events (`postCallbackEvent`)
- Post-processing prompts (chat completions for text refinement)
- `retryWithBackoff()` -- keep as a wrapper around provider calls
- `wrapTranscribeError()` -- keep as catch handler
- `TranscribeError` class -- keep for error modeling
- Metrics tracking (`transcriptionTotal`, `transcriptionErrors`, etc.)

### Moves to Provider (transcription backend)

- OpenAI SDK instantiation and API calls
- Model-specific logic (whisper dual-call vs gpt-4o json-only vs diarize)
- Format restriction knowledge (which models support which formats)
- VTT parsing for whisper-1 (`parseVTTToSegments` in provider handles the whisper VTT)
- Diarization API parameters (chunking_strategy, known_speaker_names)

### Already duplicated (delete from TranscribeService)

- `isWhisperModel()` / `isDiarizeModel()` -- provider handles routing internally
- `TDiarizedSegment` / `TDiarizedResponse` local types -- use `DiarizedSegment` / `DiarizedTranscriptionResult` from provider types
- `VALID_TRANSCRIBE_MODELS` / `DEFAULT_TRANSCRIBE_MODEL` -- use `registry.listModels()` and provider defaults
- `import { OpenAI } from 'openai'` -- no longer needed in TranscribeService
- `import Configuration from 'openai'` -- no longer needed
- `import { TranscriptionVerbose } from 'openai/resources/audio/transcriptions'` -- no longer needed
- `parseVTTToSegments()` in TranscribeService -- the provider handles VTT parsing internally now

---

## Step-by-Step Refactoring

### Step 1: Replace constructor — swap OpenAI SDK for ProviderRegistry

**Replace the imports at the top of TranscribeService.ts:**

```typescript
// REMOVE these imports:
// import { OpenAI } from 'openai';
// import Configuration from 'openai';
// import { TranscriptionVerbose } from 'openai/resources/audio/transcriptions';

// ADD these imports:
import {
  ProviderRegistry,
  OpenAIProvider,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionModelId
} from '../providers';
```

**Replace the class property and constructor:**

```typescript
export class TranscribeService {
  private instanceId: string;
  private workerState: State;
  private registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.instanceId = nanoid();
    this.workerState = State.INACTIVE;
    this.registry = registry;
  }
```

The `ProviderRegistry` is created once at startup in `api.ts` (see Step 5) and shared across all workers. The registry handles OpenAI client creation internally.

### Step 2: Replace `transcribeLocalFile()` — use `provider.transcribe()` instead of model-specific methods

Replace the entire `transcribeLocalFile()` method with this version that delegates to the provider:

```typescript
async transcribeLocalFile({
  filePath,
  language,
  prompt,
  postProcessingPrompt,
  model,
  speakerNames
}: TTranscribeLocalFile): Promise<TSegment[]> {
  const [provider, resolvedModel] = this.registry.resolve(model);

  try {
    // Diarization request: use provider.transcribeDiarize()
    if (resolvedModel === 'gpt-4o-transcribe-diarize') {
      const diarizeResult = await this.retryWithBackoff(() =>
        provider.transcribeDiarize({
          filePath,
          language: language ?? 'en',
          prompt,
          model: resolvedModel,
          knownSpeakerNames: speakerNames
        })
      );
      return diarizeResult.diarizedSegments.map((seg) => ({
        start: seg.start,
        end: seg.end,
        text: `[${seg.speaker.id}] ${seg.text}`
      }));
    }

    // Standard transcription (whisper-1, gpt-4o-*, or local whisper)
    const result = await this.retryWithBackoff(() =>
      provider.transcribe({
        filePath,
        language: language ?? 'en',
        prompt,
        model: resolvedModel
      })
    );

    let segments: TSegment[] = result.segments;

    // Post-processing prompt (uses OpenAI chat completions for text refinement)
    if (postProcessingPrompt && segments.length > 0) {
      segments = await this.applyPostProcessing(
        segments,
        result,
        postProcessingPrompt,
        filePath
      );
    }

    return segments;
  } catch (err) {
    if (err instanceof TranscribeError) throw err;
    this.wrapTranscribeError(
      err,
      (resolvedModel ?? 'whisper-1') as TTranscribeModel,
      filePath
    );
  }
}
```

Key differences from the old code:

- No `if (isWhisperModel(...))` / `if (isDiarizeModel(...))` branching -- the provider routes internally
- `retryWithBackoff()` wraps the provider call (same retry logic you already have)
- `wrapTranscribeError()` still catches and re-throws as `TranscribeError`
- The `result.segments` already contain properly timed segments regardless of the model

### Step 3: Extract post-processing into a dedicated method — accessing `OpenAIProvider.openaiClient`

Post-processing uses GPT-4.1 chat completions and is independent of the transcription provider. It should always use the OpenAI client, even when the transcription came from a local Whisper backend.

**How to get the OpenAI client from the registry:**

```typescript
const openaiProvider = this.registry.getProvider('openai') as OpenAIProvider;
const openai = openaiProvider.openaiClient;
```

This returns the same `OpenAI` instance the provider uses internally. The `openaiClient` getter is defined in `src/providers/OpenAIProvider.ts:417`.

**Add this method to the TranscribeService class:**

````typescript
private async applyPostProcessing(
  segments: TSegment[],
  result: TranscriptionResult,
  postProcessingPrompt: string,
  filePath: string
): Promise<TSegment[]> {
  // Get the OpenAI client for chat completions.
  // Post-processing always uses OpenAI regardless of transcription provider.
  const openaiProvider = this.registry.getProvider('openai') as OpenAIProvider;
  const openai = openaiProvider.openaiClient;

  // If we have VTT text (whisper-1 provider returns this), post-process the VTT
  if (result.vttText) {
    logger.info('Applying VTT post-processing prompt', { filePath });
    const vttResponse = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant. Your task is to process the VTT formatted text and make adjustment based on the context provided. Expected output is a VTT formatted text with proper timecodes and text segments.'
        },
        {
          role: 'user',
          content: postProcessingPrompt + '\n\n' + result.vttText
        }
      ]
    });
    if (vttResponse.choices[0].message.content) {
      logger.debug('VTT post-processing complete', { filePath });
      // The provider already parsed VTT into segments, and we got the
      // word-level timestamps in result.words. Re-process with the
      // post-processed VTT text to get updated segments.
      // For now, continue to the JSON-based post-processing below
      // which works for all providers.
    }

    // Also post-process the word-level data if available
    if (result.words && result.words.length > 0) {
      logger.info('Applying word-level post-processing', { filePath });
      const wordResponse = await openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Your task is to process the JSON and make adjustment based on the context provided. Do not make any adjustments to timing. Expected output is only a JSON with the same structure. Do not give any additional information or explanations.'
          },
          {
            role: 'user',
            content:
              postProcessingPrompt + '\n\n' + JSON.stringify(result.words)
          }
        ]
      });
      if (wordResponse.choices[0].message.content) {
        try {
          const cleanedContent = wordResponse.choices[0].message.content
            .replace(/```json\s*|\s*```/g, '')
            .trim();
          // Updated words are available but we use segments as the primary output
          logger.debug('Word-level post-processing complete');
        } catch (e) {
          logger.warn('Error parsing post-processed words JSON', {
            err: e instanceof Error ? e.message : String(e)
          });
        }
      }
    }
  }

  // Post-process segments as JSON (works for all providers: whisper, gpt-4o, local)
  logger.info('Applying segments post-processing prompt', { filePath });
  const segmentsJson = JSON.stringify(segments);
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content:
          'You are a helpful assistant. Your task is to process the JSON subtitle segments and make adjustments based on the context provided. Do not make any adjustments to timing. Expected output is only a JSON array with objects containing start, end, and text fields. Do not give any additional information or explanations.'
      },
      {
        role: 'user',
        content: postProcessingPrompt + '\n\n' + segmentsJson
      }
    ]
  });
  if (response.choices[0].message.content) {
    try {
      const cleaned = response.choices[0].message.content
        .replace(/```json\s*|\s*```/g, '')
        .trim();
      return JSON.parse(cleaned);
    } catch (e) {
      logger.warn('Error parsing post-processed segments JSON', {
        err: e instanceof Error ? e.message : String(e)
      });
    }
  }
  return segments;
}
````

### Step 4: Delete model-specific methods and types

Remove the following from `TranscribeService.ts`:

| What to delete                        | Current lines | Reason                                     |
| ------------------------------------- | ------------- | ------------------------------------------ |
| `isWhisperModel()` function           | ~85-87        | Provider routes internally                 |
| `isDiarizeModel()` function           | ~89-91        | Provider routes internally                 |
| `TDiarizedSegment` type               | ~93-98        | Use `DiarizedSegment` from providers       |
| `TDiarizedResponse` type              | ~100-111      | Handled inside `OpenAIProvider`            |
| `transcribeLocalFileWhisper()` method | ~308-399      | Replaced by `provider.transcribe()`        |
| `transcribeLocalFileGpt()` method     | ~401-466      | Replaced by `provider.transcribe()`        |
| `transcribeLocalFileDiarize()` method | ~468-524      | Replaced by `provider.transcribeDiarize()` |
| `parseVTTToSegments()` method         | ~526-641      | Provider parses VTT internally             |
| `import { OpenAI } from 'openai'`     | line 1        | No longer needed                           |
| `import Configuration from 'openai'`  | line 2        | No longer needed                           |
| `import { TranscriptionVerbose } ...` | line 9        | No longer needed                           |

**Keep these** (they are still used):

- `TranscribeError` class
- `retryWithBackoff()` method -- wraps provider calls
- `wrapTranscribeError()` method -- catch handler
- All segment optimization methods
- All formatting methods
- Worker management
- Metrics imports and tracking
- Logger imports

**Update type exports** -- replace the hardcoded model list with registry-based types:

```typescript
// REMOVE these:
// export const VALID_TRANSCRIBE_MODELS: TTranscribeModel[] = [...]
// export const DEFAULT_TRANSCRIBE_MODEL: TTranscribeModel = 'whisper-1';

// KEEP TTranscribeModel as an alias for backward compatibility:
import { TranscriptionModelId } from '../providers';
export type TTranscribeModel = TranscriptionModelId;
```

### Step 5: Update `api.ts` — create registry at startup and pass to workers

**Replace the import block at the top of `api.ts`:**

```typescript
import {
  TranscribeService,
  TranscribeError,
  State,
  TTranscribeFormat,
  TTranscribeModel
} from './TranscribeService/TranscribeService';
import { createDefaultRegistry } from './providers';
import logger from './utils/logger';
import { serializeMetrics, totalWorkers } from './utils/metrics';
```

Note: `VALID_TRANSCRIBE_MODELS` and `DEFAULT_TRANSCRIBE_MODEL` are no longer imported from TranscribeService. They come from the registry.

**Create the registry once at module level and update the worker factory:**

```typescript
// Create registry once at startup
const registry = createDefaultRegistry();

const transcribeWorkers: TranscribeService[] = [];
const transcribeWorker = (): TranscribeService => {
  const worker = transcribeWorkers.find(
    (client) => client.state === State.INACTIVE
  );
  if (worker) return worker;
  const newWorker = new TranscribeService(registry);
  newWorker.state = State.IDLE;
  transcribeWorkers.push(newWorker);
  totalWorkers.set(transcribeWorkers.length);
  logger.info('New transcription worker created', {
    workerId: newWorker.id,
    totalWorkers: transcribeWorkers.length
  });
  return transcribeWorkers[transcribeWorkers.length - 1];
};
```

### Step 6: Replace model validation in `api.ts`

In both the `/transcribe` and `/transcribe/s3` route handlers, replace the static model validation with registry-based validation.

**Replace the model validation block in both routes:**

```typescript
// OLD:
// if (model && !VALID_TRANSCRIBE_MODELS.includes(model as TTranscribeModel)) { ... }

// NEW:
const availableModels = registry.listModels().map((m) => m.model);
if (model && !availableModels.includes(model)) {
  return reply
    .code(400)
    .header('Content-Type', 'application/json; charset=utf-8')
    .send({
      error: `Invalid model '${model}'. Supported models: ${availableModels.join(
        ', '
      )}`,
      code: 'INVALID_MODEL'
    });
}
```

**Update the schema `enum` for the `model` field in both routes:**

```typescript
model: {
  type: 'string',
  // Remove the static enum -- validation is now dynamic via the registry.
  // The enum in the schema is for OpenAPI documentation only.
  description: 'Transcription model to use. Call GET /models for available models.'
}
```

### Step 7: Add new API routes — `/providers`, `/models`, `/transcribe/diarize`, `/transcribe/stream`

Add these route plugins in `api.ts`. Each is a complete, copy-paste ready Fastify plugin.

#### GET /providers and GET /models

```typescript
const providerRoutes: FastifyPluginCallback<Options> = (
  fastify,
  _opts,
  next
) => {
  fastify.get(
    '/providers',
    {
      schema: {
        description: 'List registered transcription providers and capabilities',
        response: {
          200: {
            type: 'object',
            properties: {
              providers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    providerId: { type: 'string' },
                    capabilities: {
                      type: 'object',
                      properties: {
                        supportedModels: {
                          type: 'array',
                          items: { type: 'string' }
                        },
                        supportsStreaming: { type: 'boolean' },
                        supportsDiarization: { type: 'boolean' },
                        supportsWordTimestamps: { type: 'boolean' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    async (_request, reply) => {
      reply.send({ providers: registry.listProviders() });
    }
  );

  fastify.get(
    '/models',
    {
      schema: {
        description: 'List available transcription models',
        response: {
          200: {
            type: 'object',
            properties: {
              models: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    model: { type: 'string' },
                    providerId: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      }
    },
    async (_request, reply) => {
      reply.send({ models: registry.listModels() });
    }
  );

  next();
};
```

#### POST /transcribe/diarize

This endpoint is dedicated to speaker diarization. It uses the `gpt-4o-transcribe-diarize` model and returns segments with speaker labels.

```typescript
const transcribeDiarize: FastifyPluginCallback<Options> = (
  fastify,
  _opts,
  next
) => {
  fastify.post<{
    Body: {
      url: string;
      language?: string;
      format?: TTranscribeFormat;
      callbackUrl?: string;
      externalId?: string;
      prompt?: string;
      speakerNames?: string[];
    };
  }>(
    '/transcribe/diarize',
    {
      schema: {
        description:
          'Transcribe a remote file with speaker diarization using gpt-4o-transcribe-diarize',
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
              type: 'string',
              description: 'Language code in ISO 639-1 format (default: en)'
            },
            prompt: {
              type: 'string',
              description: 'Optional prompt to guide the transcription process'
            },
            format: {
              type: 'string',
              enum: ['srt', 'vtt'],
              description: 'Output format (default: vtt)'
            },
            speakerNames: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 4,
              description:
                'Known speaker names for labeling (max 4). Speakers are labeled A, B, C... if not provided.'
            }
          },
          required: ['url']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              workerId: { type: 'string' },
              result: { type: 'string' }
            }
          },
          500: {
            type: 'object',
            properties: {
              workerId: { type: 'string' },
              error: { type: 'string' }
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
          model: 'gpt-4o-transcribe-diarize',
          callbackUrl: request.body.callbackUrl
            ? new URL(request.body.callbackUrl)
            : undefined,
          externalId: request.body.externalId,
          speakerNames: request.body.speakerNames
        });
        reply
          .code(200)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({ workerId: worker.id, result });
      } catch (err) {
        const statusCode =
          err instanceof TranscribeError ? err.statusCode : 500;
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
```

#### POST /transcribe/stream (future)

Streaming transcription returns real-time events via Server-Sent Events (SSE). This requires a gpt-4o-\* model.

```typescript
const transcribeStream: FastifyPluginCallback<Options> = (
  fastify,
  _opts,
  next
) => {
  fastify.post<{
    Body: {
      url: string;
      language?: string;
      model?: string;
      prompt?: string;
    };
  }>(
    '/transcribe/stream',
    {
      schema: {
        description:
          'Stream transcription of a remote file in real-time (SSE). Requires gpt-4o-* model.',
        body: {
          type: 'object',
          properties: {
            url: {
              type: 'string'
            },
            language: {
              type: 'string',
              description: 'Language code in ISO 639-1 format (default: en)'
            },
            model: {
              type: 'string',
              description:
                'gpt-4o-* model to use. Default: gpt-4o-mini-transcribe'
            },
            prompt: {
              type: 'string',
              description: 'Optional prompt to guide the transcription'
            }
          },
          required: ['url']
        }
      }
    },
    async (request, reply) => {
      const model = request.body.model ?? 'gpt-4o-mini-transcribe';

      // Validate model supports streaming
      const availableModels = registry.listModels().map((m) => m.model);
      if (!availableModels.includes(model)) {
        return reply
          .code(400)
          .header('Content-Type', 'application/json; charset=utf-8')
          .send({
            error: `Invalid model '${model}'. Supported models: ${availableModels.join(
              ', '
            )}`,
            code: 'INVALID_MODEL'
          });
      }

      const [provider] = registry.resolve(model);

      // Set up SSE response
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      try {
        // NOTE: Streaming currently works with a single audio file.
        // For chunked audio (long files), you would stream each chunk.
        // This is a starting point for the Backend Dev to expand.
        const stream = provider.transcribeStream({
          filePath: request.body.url, // Backend Dev: replace with download + convert logic
          language: request.body.language ?? 'en',
          prompt: request.body.prompt,
          model
        });

        for await (const event of stream) {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } catch (err) {
        logger.error('Streaming transcription failed', {
          err: err instanceof Error ? err.message : String(err)
        });
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'error',
            text: err instanceof Error ? err.message : 'Unknown error'
          })}\n\n`
        );
        reply.raw.end();
      }
    }
  );
  next();
};
```

**Note for Backend Dev:** The streaming endpoint above is a starting point. The main challenge is that the current `transcribeRemoteFile()` flow downloads the file, converts to MP3, and splits into chunks before transcribing. Streaming works on individual chunks, so you would need to either:

1. Stream each chunk as it is transcribed (hybrid approach)
2. Require the client to provide a pre-processed audio file URL

#### Register all new routes in the api factory

At the bottom of `api.ts`, register the new plugins:

```typescript
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
  api.register(transcribeDiarize, { title: opts.title }); // NEW
  api.register(transcribeStream, { title: opts.title }); // NEW
  api.register(providerRoutes, { title: opts.title }); // NEW
  api.register(metrics, { title: opts.title });
  return api;
};
```

---

## What the Backend Dev Can Keep

These parts of the Backend Dev's work are valuable and should be preserved:

1. **`TranscribeError` class** (lines 113-130) -- Good error modeling, keep it. The provider can throw these too.
2. **`retryWithBackoff()`** (lines 189-222) -- Keep in TranscribeService as a wrapper around provider calls.
3. **`wrapTranscribeError()`** (lines 224-262) -- Keep in TranscribeService as a catch handler.
4. **Model validation pattern in api.ts** -- Keep the pattern, just switch from `VALID_TRANSCRIBE_MODELS` to `registry.listModels()`.
5. **`speakerNames` parameter threading** -- Keep the parameter, it flows through to `provider.transcribeDiarize()`.
6. **400 response schema** -- Good addition, keep it.
7. **All metrics tracking** -- Keep `transcriptionTotal`, `transcriptionErrors`, `diarizationTotal`, `transcriptionDuration`, `activeWorkers`, `totalWorkers`. These work the same way with the provider abstraction.
8. **All logger usage** -- Keep all `logger.info/warn/error/debug` calls.

## Type Compatibility

The Backend Dev's `TSegment` type (`{ start, end, text }`) is identical to the provider's `TranscriptionSegment`. Add a type alias:

```typescript
import { TranscriptionSegment } from '../providers';
type TSegment = TranscriptionSegment;
```

Similarly, `TTranscribeModel` can be replaced with `TranscriptionModelId`:

```typescript
import { TranscriptionModelId } from '../providers';
export type TTranscribeModel = TranscriptionModelId;
```

## Migration Checklist

- [ ] Replace constructor: swap `OpenAI` for `ProviderRegistry` (Step 1)
- [ ] Replace `transcribeLocalFile()` with provider-based dispatch (Step 2)
- [ ] Extract post-processing into `applyPostProcessing()` method (Step 3)
- [ ] Delete `transcribeLocalFileWhisper()`, `transcribeLocalFileGpt()`, `transcribeLocalFileDiarize()` (Step 4)
- [ ] Delete `isWhisperModel()`, `isDiarizeModel()`, `TDiarizedSegment`, `TDiarizedResponse` (Step 4)
- [ ] Delete `parseVTTToSegments()` from TranscribeService (Step 4)
- [ ] Remove `import { OpenAI } from 'openai'` and related imports (Step 4)
- [ ] Replace `VALID_TRANSCRIBE_MODELS` / `DEFAULT_TRANSCRIBE_MODEL` with registry (Step 4)
- [ ] Update `api.ts` imports and create registry at startup (Step 5)
- [ ] Update worker factory to pass registry to `TranscribeService` (Step 5)
- [ ] Replace model validation with `registry.listModels()` (Step 6)
- [ ] Add `GET /providers`, `GET /models`, `POST /transcribe/diarize`, `POST /transcribe/stream` routes (Step 7)
- [ ] Register new route plugins in the api factory (Step 7)
- [ ] Verify all tests pass
- [ ] Verify TypeScript compilation with `npx tsc --noEmit`

## Benefits After Migration

1. **Adding local Whisper**: Just set `LOCAL_WHISPER_BINARY` env var. No code changes in TranscribeService or api.ts.
2. **Adding new models**: Provider handles them. Registry auto-discovers capabilities.
3. **Testing**: Can mock `TranscriptionProvider` for unit tests instead of mocking OpenAI SDK.
4. **Separation of concerns**: TranscribeService focuses on orchestration (chunking, optimization, formatting). Providers focus on API communication.
5. **Dynamic model discovery**: `GET /models` returns all available models across all providers. No hardcoded lists to maintain.
