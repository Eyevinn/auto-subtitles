/**
 * OpenAI transcription provider.
 *
 * Supports all 5 OpenAI transcription models:
 *   - whisper-1 (legacy, supports srt/vtt/verbose_json natively)
 *   - gpt-4o-transcribe (higher accuracy, json/text only)
 *   - gpt-4o-mini-transcribe (lightweight, json/text only)
 *   - gpt-4o-mini-transcribe-2025-12-15 (89% fewer hallucinations, json/text only)
 *   - gpt-4o-transcribe-diarize (speaker identification, json/text/diarized_json)
 *
 * CRITICAL: gpt-4o-* models do NOT support srt/vtt output formats.
 * Only json and text are available. Our service generates SRT/VTT from
 * the JSON segments returned by the provider.
 *
 * Streaming is supported on all gpt-4o-* models via stream: true.
 * Diarization is supported via gpt-4o-transcribe-diarize model.
 */

import { OpenAI } from 'openai';
import fs from 'fs';
import {
  DiarizedTranscriptionResult,
  DiarizedSegment,
  DiarizeOptions,
  ProviderCapabilities,
  ProviderConfig,
  Speaker,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionStreamEvent,
  TranscriptionWord
} from './types';
import { TranscriptionProvider } from './TranscriptionProvider';

/** Models that support streaming */
const STREAMING_MODELS = [
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-transcribe-diarize'
];

/** Models that only support json/text output (NOT srt/vtt) */
const JSON_ONLY_MODELS = [
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-transcribe-diarize'
];

/** The diarization model */
const DIARIZE_MODEL = 'gpt-4o-transcribe-diarize';

/** OpenAI-specific configuration */
export interface OpenAIProviderConfig extends ProviderConfig {
  providerId: 'openai';
  apiKey?: string;
  /** Override the OpenAI API base URL (for proxies or compatible APIs) */
  baseUrl?: string;
}

export class OpenAIProvider extends TranscriptionProvider {
  private client: OpenAI;

  constructor(config: OpenAIProviderConfig) {
    super({
      ...config,
      defaultModel: config.defaultModel ?? 'whisper-1'
    });
    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {})
    });
  }

  get capabilities(): ProviderCapabilities {
    return {
      supportedModels: [
        'whisper-1',
        'gpt-4o-transcribe',
        'gpt-4o-mini-transcribe',
        'gpt-4o-mini-transcribe-2025-12-15',
        'gpt-4o-transcribe-diarize'
      ],
      supportsWordTimestamps: true,
      supportsStreaming: true,
      supportsDiarization: true,
      maxFileSizeBytes: 25 * 1024 * 1024, // 25MB OpenAI limit
      supportedAudioFormats: [
        'mp3',
        'mp4',
        'mpeg',
        'mpga',
        'm4a',
        'ogg',
        'wav',
        'webm'
      ],
      nativeOutputFormats: ['json', 'text', 'srt', 'vtt', 'verbose_json']
    };
  }

  /**
   * Transcribe using the OpenAI transcription API.
   *
   * Routes to the correct internal method based on the model:
   * - whisper-1: dual-call (verbose_json + vtt) for backward compat
   * - gpt-4o-*: single json call (no srt/vtt support from API)
   * - gpt-4o-transcribe-diarize: delegates to transcribeDiarize()
   */
  async transcribe(
    options: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const model = this.resolveModel(options.model);
    const language = options.language ?? 'en';

    if (model === 'whisper-1') {
      return this.transcribeWithWhisper(
        options.filePath,
        language,
        options.prompt
      );
    }

    if (model === DIARIZE_MODEL) {
      // For plain transcribe() calls with the diarize model,
      // return a standard result (without speaker info).
      // Use transcribeDiarize() to get speaker attribution.
      return this.transcribeWithGpt4o(
        options.filePath,
        language,
        options.prompt,
        model,
        options.temperature
      );
    }

    return this.transcribeWithGpt4o(
      options.filePath,
      language,
      options.prompt,
      model,
      options.temperature
    );
  }

  /**
   * Stream transcription results in real-time.
   *
   * Supported on all gpt-4o-* models. Uses `stream: true` parameter.
   * Yields TranscriptionStreamEvent objects with delta/done types.
   *
   * @param options - Transcription options (model must be a gpt-4o-* model)
   */
  async *transcribeStream(
    options: TranscriptionOptions
  ): AsyncIterableIterator<TranscriptionStreamEvent> {
    const model = this.resolveModel(options.model);

    if (!STREAMING_MODELS.includes(model)) {
      throw new Error(
        `Streaming is not supported for model "${model}". ` +
          `Supported models: ${STREAMING_MODELS.join(', ')}`
      );
    }

    const stream = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(options.filePath),
      model,
      stream: true,
      response_format: 'text',
      language: options.language ?? 'en',
      prompt: options.prompt ?? undefined
    } as any); // stream param not yet in SDK types at v4.x

    for await (const event of stream as any) {
      yield {
        type: event.type ?? 'transcript.text.delta',
        text: event.text ?? event.delta ?? ''
      };
    }
  }

  /**
   * Transcribe with speaker diarization.
   *
   * Uses the gpt-4o-transcribe-diarize model with diarized_json format.
   * For audio > 30 seconds, chunking_strategy must be set (defaults to 'auto').
   *
   * @param options - Diarization options including optional knownSpeakerNames
   */
  async transcribeDiarize(
    options: DiarizeOptions
  ): Promise<DiarizedTranscriptionResult> {
    const createParams: Record<string, unknown> = {
      file: fs.createReadStream(options.filePath),
      model: DIARIZE_MODEL,
      response_format: 'diarized_json',
      language: options.language ?? 'en',
      chunking_strategy: options.chunkingStrategy ?? 'auto'
    };

    if (options.prompt) {
      createParams.prompt = options.prompt;
    }

    if (options.temperature !== undefined) {
      createParams.temperature = options.temperature;
    }

    if (options.knownSpeakerNames && options.knownSpeakerNames.length > 0) {
      createParams.known_speaker_names = options.knownSpeakerNames.slice(0, 4);
    }

    const response = await (this.client.audio.transcriptions.create as any)(
      createParams
    );

    // Parse the diarized response
    const speakers: Speaker[] = [];
    const speakerSet = new Set<string>();
    const diarizedSegments: DiarizedSegment[] = [];
    const segments: TranscriptionSegment[] = [];

    // The diarized_json response contains segments with speaker labels
    const rawSegments = response.segments ?? response.utterances ?? [];
    for (const seg of rawSegments) {
      const speakerId = seg.speaker ?? seg.speaker_id ?? 'unknown';

      if (!speakerSet.has(speakerId)) {
        speakerSet.add(speakerId);
        speakers.push({ id: speakerId });
      }

      const segment: TranscriptionSegment = {
        start: seg.start,
        end: seg.end,
        text: (seg.text ?? '').trim()
      };

      segments.push(segment);
      diarizedSegments.push({
        ...segment,
        speaker: { id: speakerId }
      });
    }

    return {
      segments,
      diarizedSegments,
      speakers,
      language: response.language,
      duration: response.duration
    };
  }

  /**
   * Transcribe using the whisper-1 model.
   *
   * Makes two API calls:
   * 1. verbose_json with word-level timestamps
   * 2. vtt format for segment-level timing
   *
   * This matches the existing behavior in TranscribeService.
   */
  private async transcribeWithWhisper(
    filePath: string,
    language: string,
    prompt?: string
  ): Promise<TranscriptionResult> {
    // First call: get word-level timestamps
    const verboseResponse = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      language,
      prompt: prompt ?? undefined,
      timestamp_granularities: ['word']
    });

    // Second call: get VTT formatted output
    const vttResponse = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'whisper-1',
      response_format: 'vtt',
      language,
      prompt: prompt ?? undefined
    });

    const words: TranscriptionWord[] = (verboseResponse.words ?? []).map(
      (w) => ({
        word: w.word,
        start: w.start,
        end: w.end
      })
    );

    const segments = this.parseVTTToSegments(vttResponse as unknown as string);

    return {
      segments,
      words,
      vttText: vttResponse as unknown as string,
      language: verboseResponse.language,
      duration: verboseResponse.duration
    };
  }

  /**
   * Transcribe using gpt-4o-* models (non-whisper).
   *
   * CRITICAL: These models only support json and text output formats.
   * We request json and parse the response into our standard segments.
   * SRT/VTT generation is handled by the service layer from these segments.
   */
  private async transcribeWithGpt4o(
    filePath: string,
    language: string,
    prompt: string | undefined,
    model: string,
    temperature?: number
  ): Promise<TranscriptionResult> {
    const createParams: Record<string, unknown> = {
      file: fs.createReadStream(filePath),
      model,
      response_format: 'json',
      language
    };

    if (prompt) {
      createParams.prompt = prompt;
    }

    if (temperature !== undefined) {
      createParams.temperature = temperature;
    }

    const response = await (this.client.audio.transcriptions.create as any)(
      createParams
    );

    // gpt-4o models return json with text and optional logprobs
    // Segment/word data may come from verbose_json-like structure or
    // may need to be inferred from the text response
    const words: TranscriptionWord[] = (response.words ?? []).map(
      (w: { word: string; start: number; end: number }) => ({
        word: w.word,
        start: w.start,
        end: w.end
      })
    );

    const segments: TranscriptionSegment[] = (response.segments ?? []).map(
      (s: { start: number; end: number; text: string }) => ({
        start: s.start,
        end: s.end,
        text: (s.text ?? '').trim()
      })
    );

    // If no segments but we have text, create a single segment
    if (segments.length === 0 && response.text) {
      segments.push({
        start: 0,
        end: response.duration ?? 0,
        text: response.text.trim()
      });
    }

    return {
      segments,
      words: words.length > 0 ? words : undefined,
      language: response.language,
      duration: response.duration
    };
  }

  /** Parse VTT text into segments (for whisper-1 backward compatibility) */
  private parseVTTToSegments(vtt: string): TranscriptionSegment[] {
    const lines = vtt.split('\n');
    const segments: TranscriptionSegment[] = [];
    let currentSegment: Partial<TranscriptionSegment> = {};

    for (const line of lines) {
      if (line.includes('-->')) {
        const [start, end] = line.split('-->').map((timeStr) => {
          const [h, m, s] = timeStr.trim().split(':').map(Number);
          return h * 3600 + m * 60 + s;
        });
        currentSegment.start = start;
        currentSegment.end = end;
      } else if (line.trim() && currentSegment.start !== undefined) {
        currentSegment.text = line.trim();
        if (!isNaN(currentSegment.start)) {
          segments.push(currentSegment as TranscriptionSegment);
          currentSegment = {};
        }
      }
    }
    return segments;
  }

  /**
   * Check if a model supports streaming.
   */
  isStreamingModel(model: string): boolean {
    return STREAMING_MODELS.includes(model);
  }

  /**
   * Check if a model only supports json/text output (no srt/vtt).
   */
  isJsonOnlyModel(model: string): boolean {
    return JSON_ONLY_MODELS.includes(model);
  }

  /** Expose the underlying OpenAI client for post-processing (chat completions) */
  get openaiClient(): OpenAI {
    return this.client;
  }
}
