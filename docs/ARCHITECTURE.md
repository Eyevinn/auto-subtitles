# Architecture: Multi-Model Transcription Abstraction

## Problem

The auto-subtitles service is tightly coupled to the OpenAI `whisper-1` model. The `TranscribeService` class directly instantiates the OpenAI SDK client and calls `openai.audio.transcriptions.create()`. This makes it impossible to:

1. Use newer OpenAI models (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, dated variants, diarize model)
2. Run Whisper locally for cost savings or offline use
3. Add future transcription backends without modifying core logic
4. Support streaming or speaker diarization

## Critical API Constraint

**gpt-4o-\* models do NOT support srt/vtt output formats from the API.** Only `json` and `text` are available. Only the legacy `whisper-1` model returns native SRT/VTT.

Our service must always generate SRT/VTT from the JSON segments returned by the provider, regardless of model. This is why the provider interface returns `TranscriptionResult` with segments, and SRT/VTT formatting remains in the service layer.

## Solution: Provider Abstraction Layer

We introduce a **provider pattern** that decouples the transcription backend from the service logic.

```
                         +------------------+
                         | TranscribeService|
                         |  (orchestrator)  |
                         +--------+---------+
                                  |
                                  | uses
                                  v
                         +------------------+
                         | ProviderRegistry |
                         |  resolve(model)  |
                         +--------+---------+
                                  |
                    +-------------+-------------+
                    |                           |
             +------v------+            +------v--------+
             | OpenAI      |            | LocalWhisper  |
             | Provider    |            | Provider      |
             +------+------+            +------+--------+
                    |                           |
                    v                           v
             OpenAI API                  whisper CLI
             - whisper-1                 - tiny..turbo
             - gpt-4o-transcribe
             - gpt-4o-mini-transcribe
             - gpt-4o-mini-transcribe-2025-12-15
             - gpt-4o-transcribe-diarize
```

## Available Models (February 2026)

| Model                               | Provider      | Streaming | Diarization | Native Formats                     | Notes                                    |
| ----------------------------------- | ------------- | --------- | ----------- | ---------------------------------- | ---------------------------------------- |
| `whisper-1`                         | openai        | No        | No          | json, text, srt, vtt, verbose_json | Legacy, word timestamps via verbose_json |
| `gpt-4o-transcribe`                 | openai        | Yes       | No          | json, text                         | Higher accuracy                          |
| `gpt-4o-mini-transcribe`            | openai        | Yes       | No          | json, text                         | Lightweight, faster                      |
| `gpt-4o-mini-transcribe-2025-12-15` | openai        | Yes       | No          | json, text                         | 89% fewer hallucinations                 |
| `gpt-4o-transcribe-diarize`         | openai        | Yes       | Yes         | json, text, diarized_json          | Speaker identification                   |
| `tiny`..`turbo`                     | local-whisper | No        | No          | json, text, srt, vtt               | Offline, no API costs                    |

## Key Components

### 1. `TranscriptionProvider` (abstract base class)

Location: `src/providers/TranscriptionProvider.ts`

The contract that all providers must implement:

```typescript
abstract class TranscriptionProvider {
  abstract transcribe(
    options: TranscriptionOptions
  ): Promise<TranscriptionResult>;
  abstract get capabilities(): ProviderCapabilities;

  // Optional: override for streaming support
  async *transcribeStream(
    options
  ): AsyncIterableIterator<TranscriptionStreamEvent>;

  // Optional: override for diarization support
  async transcribeDiarize(
    options: DiarizeOptions
  ): Promise<DiarizedTranscriptionResult>;

  // Shared logic
  resolveModel(requestedModel?: string): string;
  supportsModel(model: string): boolean;
}
```

**Design decisions:**

- Abstract class (not interface) to share common logic like `resolveModel()`
- `capabilities` is a getter, not a constructor param, so providers compute it dynamically
- `TranscriptionResult` is provider-agnostic: segments + optional words + optional VTT
- `transcribeStream()` and `transcribeDiarize()` have default implementations that throw, allowing providers to opt in
- `ProviderCapabilities` includes `nativeOutputFormats` to document the format restriction

### 2. `ProviderRegistry`

Location: `src/providers/ProviderRegistry.ts`

Central hub that maps model IDs to providers:

```typescript
class ProviderRegistry {
  register(config: ProviderConfig, factory: ProviderFactory): void;
  resolve(model?, providerId?): [TranscriptionProvider, string];
  getProviderForModel(model: string): TranscriptionProvider;
  listProviders(): ProviderInfo[];
  listModels(): ModelInfo[];
}
```

**Design decisions:**

- Uses factory functions (not direct instantiation) for lazy creation
- First-registered provider wins for a given model ID (deterministic ordering)
- `resolve()` handles both explicit model selection and automatic routing
- Registry is created once at startup and shared across workers

### 3. `OpenAIProvider`

Location: `src/providers/OpenAIProvider.ts`

Wraps the OpenAI SDK. Has model-specific logic:

- **whisper-1**: Two API calls (verbose_json for words + vtt for segments) — preserves existing behavior
- **gpt-4o-transcribe / gpt-4o-mini-transcribe / dated variant**: Single json call. **No srt/vtt support from API.** Our service generates SRT/VTT from the returned segments.
- **gpt-4o-transcribe-diarize**: Uses `diarized_json` format with `chunking_strategy: "auto"`. Supports `known_speaker_names` (up to 4).
- **Streaming**: All gpt-4o-\* models support `stream: true` via `transcribeStream()`

Also exposes the `openaiClient` for post-processing (chat completions).

Helper methods:

- `isStreamingModel(model)` — check if a model supports streaming
- `isJsonOnlyModel(model)` — check if a model only supports json/text (no srt/vtt)

### 4. `LocalWhisperProvider`

Location: `src/providers/LocalWhisperProvider.ts`

Runs the `whisper` CLI via `execSync`. Supports all standard Whisper model sizes (tiny through turbo). Parses JSON output for segments and word timestamps.

### 5. `createDefaultRegistry()`

Location: `src/providers/setup.ts`

Factory function that reads environment variables and registers available providers. Called once at startup.

## Types

Location: `src/providers/types.ts`

Key types:

- `TranscriptionResult` — segments + optional words + optional vttText
- `DiarizedTranscriptionResult` — extends result with `diarizedSegments` and `speakers`
- `TranscriptionStreamEvent` — `{ type: 'transcript.text.delta' | 'transcript.text.done', text: string }`
- `DiarizeOptions` — extends options with `knownSpeakerNames` and `chunkingStrategy`
- `ProviderCapabilities` — includes `nativeOutputFormats` array

## Data Flow

### Before (current)

```
API request -> TranscribeService -> OpenAI SDK -> whisper-1 (vtt/verbose_json)
                    ^
                    | owns OpenAI client
```

### After (new)

```
API request (with model/provider params)
    |
    v
TranscribeService (orchestrator)
    |
    | registry.resolve(model, provider)
    v
ProviderRegistry -> TranscriptionProvider.transcribe()
    |                   returns TranscriptionResult { segments, words }
    |
    v
TranscribeService formats segments -> SRT / VTT / JSON output
    |
    +-> OpenAIProvider
    |     whisper-1: verbose_json + vtt (2 calls)
    |     gpt-4o-*: json only (1 call) -- no native srt/vtt!
    |     gpt-4o-transcribe-diarize: diarized_json
    |
    +-> LocalWhisperProvider
          whisper CLI -> JSON output
```

## Integration with TranscribeService

The `TranscribeService` needs the following changes (to be done by the Backend Developer):

1. **Constructor**: Accept a `ProviderRegistry` instead of an `openApiKey`
2. **`transcribeLocalFile()`**: Call `provider.transcribe()` instead of `openai.audio.transcriptions.create()`
3. **Post-processing**: Access the OpenAI client via `OpenAIProvider.openaiClient` for chat completions (post-processing prompt)
4. **Type changes**: `TTranscribeModel` widened from `'whisper-1'` to `string`
5. **SRT/VTT generation**: For gpt-4o-\* models, the provider returns JSON segments only. The `formatSegmentsToVTT()` / `formatSegmentsToSRT()` methods in TranscribeService handle output formatting for ALL models, not just non-whisper ones. This simplifies the flow.
6. **Diarization endpoint**: Add new `/transcribe/diarize` route that calls `provider.transcribeDiarize()` and formats speaker-attributed subtitles

The `parseVTTToSegments()` logic from `TranscribeService` has been extracted into the `OpenAIProvider` for whisper-1 compatibility, while the main segment alignment logic (matching words to VTT segments) stays in `TranscribeService` since it operates on the provider-agnostic `TranscriptionResult`.

## API Changes

New request parameters on `/transcribe` and `/transcribe/s3`:

- `model`: string — model to use (optional, default: `whisper-1`)
- `provider`: string — explicit provider (optional, auto-resolved from model)
- `temperature`: number — randomness control 0-1 (gpt-4o models only)

New endpoints:

- `GET /providers` — list registered providers and capabilities
- `GET /models` — list available models
- `POST /transcribe/diarize` — transcribe with speaker identification
- `POST /transcribe/stream` (future) — SSE endpoint for real-time transcription

See `docs/api-extensions.md` for full details.

## Environment Variables

| Variable                | Description                 | Required                |
| ----------------------- | --------------------------- | ----------------------- |
| `OPENAI_API_KEY`        | OpenAI API key              | For OpenAI provider     |
| `OPENAI_BASE_URL`       | Override OpenAI base URL    | No                      |
| `DEFAULT_MODEL`         | Default transcription model | No (default: whisper-1) |
| `LOCAL_WHISPER_BINARY`  | Path to whisper CLI         | For local provider      |
| `LOCAL_WHISPER_MODELS`  | Path to model directory     | No                      |
| `LOCAL_WHISPER_THREADS` | Number of threads           | No (default: 4)         |
| `LOCAL_WHISPER_DEVICE`  | Device: cpu, cuda, auto     | No (default: auto)      |

## Adding a New Provider

1. Create a class extending `TranscriptionProvider`
2. Implement `transcribe()` and `capabilities` (including `nativeOutputFormats`)
3. Optionally override `transcribeStream()` and/or `transcribeDiarize()`
4. Register it in `setup.ts` or at runtime via `registry.register()`

Example:

```typescript
import { TranscriptionProvider } from './TranscriptionProvider';

export class MyProvider extends TranscriptionProvider {
  get capabilities() {
    return {
      supportedModels: ['my-model-v1'],
      supportsWordTimestamps: true,
      supportsStreaming: false,
      supportsDiarization: false,
      supportedAudioFormats: ['mp3', 'wav'],
      nativeOutputFormats: ['json', 'text']
    };
  }

  async transcribe(options) {
    // Your implementation here
    return { segments: [...], words: [...] };
  }
}
```

## SDK Version Note

The OpenAI npm package is at v6.22.0 (February 2026). The project currently uses v4.85.3. Some newer API parameters (`stream`, `chunking_strategy`, `known_speaker_names`, `diarized_json` format) may not have TypeScript types in v4.x. The provider uses `as any` casts for these parameters. Upgrading to v6.x is recommended but is a separate task to avoid breaking changes.

## Future Considerations

- **SDK upgrade**: Upgrade openai package from v4.85.3 to v6.22.0 for full type support
- **Cost tracking**: The registry can track usage per provider/model for billing
- **Fallback chains**: The registry could support fallback (try provider A, fall back to B on failure)
- **Rate limiting**: Per-provider rate limiting based on API quotas
