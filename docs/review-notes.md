# Pre-Integration Review Notes

Holistic review of the codebase ahead of wiring `TranscribeService` to the provider abstraction. Covers type mismatches, naming inconsistencies, missing exports, and SDK upgrade risks.

---

## 1. Type Mismatches Between Providers and TranscribeService

### 1a. `TSegment` vs `TranscriptionSegment` -- compatible but not identical

- **TranscribeService** (`TSegment`): `{ start: number; end: number; text: string }` (line 79-83)
- **Providers** (`TranscriptionSegment`): `{ start: number; end: number; text: string }` (types.ts:26-30)

**Status: COMPATIBLE.** The shapes are identical. After migration, `TSegment` can be aliased to `TranscriptionSegment` or kept as-is.

### 1b. `TSegment` vs subtitle-quality `TSegment` -- different types with same name

- **TranscribeService** `TSegment`: `{ start, end, text }` -- no `speaker` field
- **subtitle-quality.ts** `TSegment`: `{ start, end, text, speaker? }` -- has optional `speaker` field (line 10-15)

**Issue: NAME COLLISION.** Both files define `TSegment` but with different shapes. The subtitle-quality version adds `speaker?: string`. This is not a problem today since they are in separate files, but it will cause confusion during integration. The quality module's `TSegment` is a superset of TranscribeService's `TSegment`, so passing TranscribeService segments to `evaluateSubtitles()` will work. However, for diarized segments, the Backend Dev maps speaker info into the `text` field as `[SpeakerA] Hello` rather than setting `segment.speaker = 'SpeakerA'`. This means the quality scorer's `speakerAttribution` analysis will never trigger for diarized output.

**Recommended fix:** When producing diarized output, also populate the `speaker` field so the quality scorer can detect speaker changes. Alternatively, the quality module could parse `[SpeakerX]` prefixes from the text.

### 1c. `TDiarizedSegment` vs `DiarizedSegment` -- different speaker types

- **TranscribeService** `TDiarizedSegment`: `{ speaker: string; text: string; start: number; end: number }` (lines 93-98) -- speaker is a plain string
- **Providers** `DiarizedSegment`: `{ speaker: Speaker; ... }` where `Speaker = { id: string }` (types.ts:46-49) -- speaker is an object

**Issue: STRUCTURAL MISMATCH.** When migrating, the diarization mapping changes from `seg.speaker` (string) to `seg.speaker.id` (string on an object). The integration guide covers this correctly (Step 2 uses `seg.speaker.id`), but the Backend Dev should be aware of this difference. After migration, `TDiarizedSegment` and `TDiarizedResponse` are deleted entirely.

### 1d. `TTranscribeModel` vs `TranscriptionModelId` -- compatible

- **TranscribeService** `TTranscribeModel`: union of 5 literal strings (lines 28-33)
- **Providers** `TranscriptionModelId`: same 5 literals plus `| string` for extensibility (types.ts:14-20)

**Status: COMPATIBLE.** `TTranscribeModel` is a subtype of `TranscriptionModelId`. After migration, `TTranscribeModel` can be aliased to `TranscriptionModelId`.

---

## 2. Model Naming and Capability Inconsistencies

### 2a. All 5 models consistent across files

Verified that the same 5 model IDs appear in:

- `TranscribeService.ts` `VALID_TRANSCRIBE_MODELS` (lines 35-41)
- `OpenAIProvider.ts` `capabilities.supportedModels` (lines 79-85)
- `types.ts` `TranscriptionModelId` union (lines 14-19)
- `api.test.ts` mock `VALID_TRANSCRIBE_MODELS` (lines 8-14)
- `metrics.ts` comments (line 129)
- `CLAUDE.md` model table

**Status: CONSISTENT.** No naming mismatches.

### 2b. Streaming capability on diarize model

- `CLAUDE.md` states: `gpt-4o-transcribe-diarize` supports streaming (Yes in table)
- `OpenAIProvider.ts` `STREAMING_MODELS` array (lines 37-42) includes `gpt-4o-transcribe-diarize`

**Status: CONSISTENT.**

### 2c. `whisper-1` streaming support

- `CLAUDE.md` states: `whisper-1` does NOT support streaming (No in table)
- `OpenAIProvider.transcribeStream()` correctly rejects non-streaming models (line 159)

**Status: CONSISTENT.**

---

## 3. Missing Exports or Imports That Would Block Integration

### 3a. `formatGenerationTotal` metric is exported but never used

`metrics.ts` exports `formatGenerationTotal` (line 161) for tracking server-side SRT/VTT generation from JSON (needed for gpt-4o models). However, `TranscribeService.ts` does not import or use it. When gpt-4o models are used, `formatSegmentsToVTT()` / `formatSegmentsToSRT()` are called but the metric is never incremented.

**Recommended fix:** The Backend Dev should increment `formatGenerationTotal` in `formatSegmentsToVTT()` and `formatSegmentsToSRT()` when the model is a gpt-4o variant (since whisper-1 returns native VTT, those calls are just re-formatting).

### 3b. `subtitle-quality.ts` is never imported anywhere

The `evaluateSubtitles()` and `formatQualityReport()` functions are exported but never called from `TranscribeService`, `api.ts`, or any route. There is no `/quality` endpoint.

**Not a blocker** -- the quality module is likely intended for a future endpoint or post-processing step. No action needed now, but worth noting for the Test Engineer.

### 3c. `logger` not used in providers

`OpenAIProvider.ts` and `LocalWhisperProvider.ts` use `console.log` / `console.error` instead of the structured `logger` from `utils/logger.ts`. This means provider-level logs will not be JSON-formatted or respect the `LOG_LEVEL` env var.

**Recommended fix:** Import and use `logger` in both provider files. Minor but improves observability.

### 3d. `TranscriptionResult.vttText` requires careful handling

`OpenAIProvider.transcribeWithWhisper()` sets `vttText: vttResponse as unknown as string` (line 302). The `as unknown as string` cast works at runtime because whisper-1 with `response_format: 'vtt'` returns a string, but the TypeScript SDK types it as `Transcription`. This cast is safe for v4.x but may need adjustment for v6.x (see section 4).

### 3e. Barrel export coverage

Verified `src/providers/index.ts` exports all types, classes, and `createDefaultRegistry`. All imports referenced in the integration guide resolve correctly.

**Status: NO MISSING EXPORTS.**

---

## 4. SDK Upgrade Risks (v4.85.3 to v6.22.0)

### 4a. `import Configuration from 'openai'` removed in v5+

`TranscribeService.ts` line 2: `import Configuration from 'openai'` -- this named export was removed in OpenAI SDK v5. After migration this import is deleted, so **no issue** for the provider code. However, if anyone tries to upgrade the SDK before the provider migration, this import will fail.

**Recommended fix:** Upgrade SDK after provider migration, not before.

### 4b. `openai.audio.transcriptions.create()` return type changes

In v4.x, `response_format: 'vtt'` returns `Transcription` (an object with `.text`). In v6.x, the SDK may return a string directly for text-based formats. The `as unknown as string` cast in `OpenAIProvider.ts:302` handles this but is fragile.

**Risk: LOW.** The cast works in both v4 and v6. After upgrading, test the whisper VTT path.

### 4c. `stream: true` parameter typing

`OpenAIProvider.transcribeStream()` uses `as any` for the create params (line 173) because `stream` is not in v4.x types. In v6.x, `stream: true` is properly typed and returns a typed stream object.

**After SDK upgrade:** Remove the `as any` cast and use the proper v6 stream types. The `for await (const event of stream)` pattern should work unchanged.

### 4d. Diarization parameters not in v4.x types

`OpenAIProvider.transcribeDiarize()` uses `as any` cast (line 214) for `response_format: 'diarized_json'`, `chunking_strategy`, `known_speaker_names`. These are v6.x parameters.

**After SDK upgrade:** Remove the `as any` cast. The v6 SDK should have proper types for these parameters.

### 4e. `TranscriptionVerbose` import

`TranscribeService.ts` line 9: `import { TranscriptionVerbose } from 'openai/resources/audio/transcriptions'`. This deep import path may change in v6. After migration this import is deleted from TranscribeService, but the `OpenAIProvider.transcribeWithWhisper()` method uses the verbose response shape without importing the type.

**Risk: NONE** for provider code (it accesses `.words` and `.language` from the response, which are standard properties). The deep import only exists in `TranscribeService.ts` which removes it during migration.

---

## 5. Test Compatibility Issues

### 5a. Tests mock `TranscribeService` constructor with no args

`api.test.ts` line 37: `TranscribeService: jest.fn().mockImplementation(() => ({...}))` -- the mock takes no constructor arguments. After migration, `TranscribeService` takes a `ProviderRegistry` argument. The test mock needs to be updated to match the new constructor signature.

**Recommended fix for Test Engineer:** Update the mock to accept a registry argument, or mock the registry module separately.

### 5b. Tests import `VALID_TRANSCRIBE_MODELS` and `DEFAULT_TRANSCRIBE_MODEL`

The mock re-exports `VALID_TRANSCRIBE_MODELS` and `DEFAULT_TRANSCRIBE_MODEL` (lines 8-16). After migration, these are removed from `TranscribeService.ts` and replaced by `registry.listModels()`. The test mock must be updated.

**Recommended fix for Test Engineer:** Mock the providers module's `createDefaultRegistry()` and return a registry with known models, OR mock the registry at the `api.ts` module level.

### 5c. Healthcheck test expects string body, handler sends string

`api.test.ts` line 67: `expect(response.body).toBe('@eyevinn/auto-subtitles is healthy \u{1F496}')`. The actual handler at `api.ts:56` sends `opts.title + ' is healthy \u{1F496}'`. The `/health` endpoint (line 59-93) sends an object with worker status. The GET `/` endpoint sends the string.

**Status: TEST IS CORRECT.** The `GET /` endpoint sends a plain string. The `GET /health` endpoint sends the object. These are two different routes.

---

## 6. Other Observations

### 6a. `retryWithBackoff` should wrap provider calls

The integration guide instructs wrapping provider calls with `retryWithBackoff()`. This is correct. The provider itself does not retry -- it makes a single API call and returns or throws. The retry logic stays in `TranscribeService`.

### 6b. `wrapTranscribeError` model parameter type

After migration, `wrapTranscribeError(err, model, filePath)` receives `model` as `TranscriptionModelId` (which includes `| string`). The current signature uses `TTranscribeModel`. This is fine as long as `TTranscribeModel` is aliased to `TranscriptionModelId`.

### 6c. OpenAI chat completions for post-processing

Post-processing uses `gpt-4.1` via `openai.chat.completions.create()`. This is a chat API call, not a transcription call, so it is independent of the provider abstraction. The integration guide correctly shows accessing the OpenAI client via `OpenAIProvider.openaiClient`. One edge case: if only the local-whisper provider is registered (no OpenAI API key), `registry.getProvider('openai')` will throw. Post-processing would need to be skipped or a separate OpenAI client configured.

**Recommended fix:** Add a guard in `applyPostProcessing()`:

```typescript
try {
  const openaiProvider = this.registry.getProvider('openai') as OpenAIProvider;
  // ... proceed with post-processing
} catch {
  logger.warn('OpenAI provider not available, skipping post-processing');
  return segments;
}
```

### 6d. `LocalWhisperProvider` uses `console.log` instead of `logger`

Line 125: `console.log(...)` and line 174: `console.error(...)`. Should use the structured logger.

---

## Summary: Action Items

| #   | Issue                                                     | Severity | Owner                 | Action                                                                 |
| --- | --------------------------------------------------------- | -------- | --------------------- | ---------------------------------------------------------------------- |
| 1   | Speaker field not set on diarized `TSegment` output       | Medium   | Backend Dev           | Populate `speaker` field alongside `[Speaker] text` format             |
| 2   | `DiarizedSegment.speaker` is `Speaker` object, not string | Low      | Backend Dev           | Use `seg.speaker.id` during migration (covered in guide)               |
| 3   | `formatGenerationTotal` metric never incremented          | Low      | Backend Dev           | Increment when generating SRT/VTT for gpt-4o models                    |
| 4   | Providers use `console.log` instead of `logger`           | Low      | Architect             | Switch to structured logger in OpenAIProvider and LocalWhisperProvider |
| 5   | Post-processing crashes if OpenAI provider not registered | Medium   | Backend Dev           | Add try/catch guard in `applyPostProcessing()`                         |
| 6   | Tests mock `TranscribeService()` with no args             | Medium   | Test Engineer         | Update mock for new `TranscribeService(registry)` constructor          |
| 7   | Tests re-export `VALID_TRANSCRIBE_MODELS`                 | Medium   | Test Engineer         | Update mock to use registry-based model list                           |
| 8   | SDK upgrade must happen AFTER provider migration          | High     | All                   | Do not upgrade `openai` npm package until migration is complete        |
| 9   | `as any` casts in OpenAIProvider                          | Low      | Architect             | Remove after SDK upgrade to v6                                         |
| 10  | subtitle-quality `TSegment` name collision                | Low      | Linguistic Researcher | Consider renaming to `QualitySegment` or importing from providers      |
