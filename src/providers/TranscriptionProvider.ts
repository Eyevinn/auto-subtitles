/**
 * Abstract base class for transcription providers.
 *
 * All transcription backends (OpenAI API, local Whisper, etc.) must extend
 * this class and implement the required methods. This enables the
 * TranscribeService to work with any backend without knowing the details
 * of the underlying API.
 */

import {
  DiarizedTranscriptionResult,
  DiarizeOptions,
  ProviderCapabilities,
  ProviderConfig,
  ProviderId,
  TranscriptionModelId,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionStreamEvent
} from './types';

export abstract class TranscriptionProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /** Unique identifier for this provider */
  get providerId(): ProviderId {
    return this.config.providerId;
  }

  /** The default model used when none is specified */
  get defaultModel(): TranscriptionModelId {
    return this.config.defaultModel ?? this.capabilities.supportedModels[0];
  }

  /**
   * Transcribe an audio file and return structured segments.
   *
   * This is the primary method that all providers must implement. It takes
   * a local file path and returns transcription results with timing data.
   *
   * @param options - Transcription options including file path, language, etc.
   * @returns Transcription result with segments and optional word timestamps
   */
  abstract transcribe(
    options: TranscriptionOptions
  ): Promise<TranscriptionResult>;

  /**
   * Return the capabilities of this provider.
   *
   * Used by the service layer to determine what features are available
   * (e.g., word timestamps, streaming, diarization) and to validate
   * requests before sending them to the provider.
   */
  abstract get capabilities(): ProviderCapabilities;

  /**
   * Stream transcription results in real-time.
   *
   * Only available on providers where capabilities.supportsStreaming is true.
   * Default implementation throws — providers that support streaming override this.
   *
   * @param options - Transcription options
   * @returns Async iterable of stream events
   */
  // eslint-disable-next-line require-yield
  async *transcribeStream(
    _options: TranscriptionOptions
  ): AsyncIterableIterator<TranscriptionStreamEvent> {
    throw new Error(
      `Streaming is not supported by provider "${this.providerId}". ` +
        `Check capabilities.supportsStreaming before calling this method.`
    );
  }

  /**
   * Transcribe with speaker diarization.
   *
   * Only available on providers where capabilities.supportsDiarization is true.
   * Default implementation throws — providers that support diarization override this.
   *
   * @param options - Diarization options (includes known speaker names, chunking)
   * @returns Diarized transcription result with speaker-attributed segments
   */
  async transcribeDiarize(
    _options: DiarizeOptions
  ): Promise<DiarizedTranscriptionResult> {
    throw new Error(
      `Diarization is not supported by provider "${this.providerId}". ` +
        `Check capabilities.supportsDiarization before calling this method.`
    );
  }

  /**
   * Validate that a model ID is supported by this provider.
   *
   * @param model - The model ID to validate
   * @returns true if the model is supported
   */
  supportsModel(model: TranscriptionModelId): boolean {
    return this.capabilities.supportedModels.includes(model);
  }

  /**
   * Resolve which model to use for a request.
   *
   * Uses the explicitly requested model if provided and supported,
   * otherwise falls back to the provider's default model.
   *
   * @param requestedModel - The model requested by the caller (may be undefined)
   * @returns The model ID to use
   * @throws Error if the requested model is not supported
   */
  resolveModel(requestedModel?: TranscriptionModelId): TranscriptionModelId {
    if (!requestedModel) {
      return this.defaultModel;
    }
    if (!this.supportsModel(requestedModel)) {
      throw new Error(
        `Model "${requestedModel}" is not supported by provider "${this.providerId}". ` +
          `Supported models: ${this.capabilities.supportedModels.join(', ')}`
      );
    }
    return requestedModel;
  }
}
