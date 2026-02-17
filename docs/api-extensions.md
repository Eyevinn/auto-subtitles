# API Contract Extensions

This document describes the new and modified API endpoints to support multi-model transcription, streaming, and speaker diarization.

## Available Models (February 2026)

| Model                               | Streaming | Diarization | Native Output Formats              | Notes                                          |
| ----------------------------------- | --------- | ----------- | ---------------------------------- | ---------------------------------------------- |
| `whisper-1`                         | No        | No          | json, text, srt, vtt, verbose_json | Legacy, word-level timestamps via verbose_json |
| `gpt-4o-transcribe`                 | Yes       | No          | json, text                         | Higher accuracy, context-aware                 |
| `gpt-4o-mini-transcribe`            | Yes       | No          | json, text                         | Lightweight, faster                            |
| `gpt-4o-mini-transcribe-2025-12-15` | Yes       | No          | json, text                         | 89% fewer hallucinations vs whisper-1          |
| `gpt-4o-transcribe-diarize`         | Yes       | Yes         | json, text, diarized_json          | Speaker identification                         |

**CRITICAL**: gpt-4o-\* models do NOT support srt/vtt output from the API. Our service always generates SRT/VTT from the JSON segments returned by the provider, regardless of model.

## Changes to Existing Endpoints

### POST /transcribe

**New request body parameters:**

| Parameter     | Type   | Required | Default       | Description                            |
| ------------- | ------ | -------- | ------------- | -------------------------------------- |
| `model`       | string | No       | `whisper-1`   | Transcription model to use             |
| `provider`    | string | No       | auto          | Explicit provider selection            |
| `temperature` | number | No       | (API default) | Randomness control 0-1 (gpt-4o models) |

The `model` field accepts any model supported by a registered provider:

- `whisper-1` (OpenAI)
- `gpt-4o-transcribe` (OpenAI)
- `gpt-4o-mini-transcribe` (OpenAI)
- `gpt-4o-mini-transcribe-2025-12-15` (OpenAI)
- `gpt-4o-transcribe-diarize` (OpenAI)
- `base`, `small`, `medium`, `large`, `large-v2`, `large-v3`, `turbo` (local Whisper)

When `model` is specified without `provider`, the registry automatically routes to the correct provider. When `provider` is also specified, the request is sent only to that provider.

**Updated schema:**

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string" },
    "model": {
      "type": "string",
      "description": "Transcription model (default: whisper-1)"
    },
    "provider": {
      "type": "string",
      "description": "Explicit provider ID (openai, local-whisper)"
    },
    "language": { "type": "string" },
    "format": { "type": "string", "enum": ["srt", "vtt"] },
    "prompt": { "type": "string" },
    "temperature": {
      "type": "number",
      "description": "Randomness control 0-1 (gpt-4o models only)"
    },
    "callbackUrl": { "type": "string" },
    "externalId": { "type": "string" }
  },
  "required": ["url"]
}
```

### POST /transcribe/s3

Same new `model`, `provider`, and `temperature` parameters as `/transcribe`.

## New Endpoints

### GET /providers

Lists all registered providers and their capabilities.

**Response:**

```json
{
  "providers": [
    {
      "providerId": "openai",
      "capabilities": {
        "supportedModels": [
          "whisper-1",
          "gpt-4o-transcribe",
          "gpt-4o-mini-transcribe",
          "gpt-4o-mini-transcribe-2025-12-15",
          "gpt-4o-transcribe-diarize"
        ],
        "supportsWordTimestamps": true,
        "supportsStreaming": true,
        "supportsDiarization": true,
        "maxFileSizeBytes": 26214400,
        "supportedAudioFormats": [
          "mp3",
          "mp4",
          "mpeg",
          "mpga",
          "m4a",
          "ogg",
          "wav",
          "webm"
        ],
        "nativeOutputFormats": ["json", "text", "srt", "vtt", "verbose_json"]
      }
    }
  ]
}
```

### GET /models

Lists all available models across all providers.

**Response:**

```json
{
  "models": [
    { "model": "whisper-1", "providerId": "openai" },
    { "model": "gpt-4o-transcribe", "providerId": "openai" },
    { "model": "gpt-4o-mini-transcribe", "providerId": "openai" },
    { "model": "gpt-4o-mini-transcribe-2025-12-15", "providerId": "openai" },
    { "model": "gpt-4o-transcribe-diarize", "providerId": "openai" },
    { "model": "base", "providerId": "local-whisper" }
  ]
}
```

### POST /transcribe/diarize

Transcribe with speaker identification. Uses `gpt-4o-transcribe-diarize` model.

**Request body:**

```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string" },
    "language": { "type": "string" },
    "format": { "type": "string", "enum": ["srt", "vtt"] },
    "prompt": { "type": "string" },
    "temperature": { "type": "number" },
    "knownSpeakerNames": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 4,
      "description": "Known speaker names for labeling (up to 4)"
    },
    "callbackUrl": { "type": "string" },
    "externalId": { "type": "string" }
  },
  "required": ["url"]
}
```

**Response:**

```json
{
  "workerId": "abc123",
  "result": "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\n[Speaker A] Hello, how are you?\n...",
  "speakers": [{ "id": "A" }, { "id": "B" }]
}
```

The SRT/VTT output prefixes each segment with the speaker label in brackets. The `speakers` array lists all identified speakers.

### POST /transcribe/stream (future)

Server-Sent Events endpoint for real-time transcription. Requires gpt-4o-\* models.

**Request:** Same as `/transcribe` with `model` set to a streaming-capable model.

**SSE Response:**

```
event: transcript.text.delta
data: {"text": "Hello"}

event: transcript.text.delta
data: {"text": ", how are you"}

event: transcript.text.done
data: {"text": "Hello, how are you doing today?"}
```

## Backward Compatibility

All changes are backward-compatible:

- Existing requests without `model` or `provider` work exactly as before (defaults to `whisper-1` on OpenAI)
- The `TTranscribeModel` type is widened from the literal `'whisper-1'` to `string` to support new models
- No existing response formats change
- SRT/VTT output is always generated by our service from segments, regardless of whether the API supports native SRT/VTT (whisper-1) or only JSON (gpt-4o-\* models)
