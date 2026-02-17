/**
 * Core types for the transcription provider abstraction layer.
 *
 * These types define the contract that all transcription providers must follow,
 * enabling the service to work with OpenAI Whisper API, GPT-4o transcription
 * models, local Whisper backends, and future providers.
 *
 * IMPORTANT: gpt-4o-* models only support json and text output formats.
 * Only whisper-1 supports native srt/vtt output. Our service generates
 * SRT/VTT from the JSON segments returned by all providers.
 */

/** Supported transcription model identifiers */
export type TranscriptionModelId =
  | 'whisper-1'
  | 'gpt-4o-transcribe'
  | 'gpt-4o-mini-transcribe'
  | 'gpt-4o-mini-transcribe-2025-12-15'
  | 'gpt-4o-transcribe-diarize'
  | string; // Allow custom model IDs for local/future providers

/** Provider identifier */
export type ProviderId = 'openai' | 'local-whisper' | string;

/** A single transcribed segment with timing information */
export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

/** A single word with timing information (for word-level timestamps) */
export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
}

/** A speaker identified by the diarization model */
export interface Speaker {
  /** Speaker label (e.g., 'A', 'B', 'C' or a known speaker name) */
  id: string;
}

/** A diarized segment — a transcription segment attributed to a speaker */
export interface DiarizedSegment extends TranscriptionSegment {
  /** The speaker who said this segment */
  speaker: Speaker;
}

/** Streaming event emitted during real-time transcription */
export interface TranscriptionStreamEvent {
  /** Event type */
  type: 'transcript.text.delta' | 'transcript.text.done';
  /** The text delta or final text */
  text: string;
}

/** The result of a transcription request */
export interface TranscriptionResult {
  /** Transcribed segments with timing */
  segments: TranscriptionSegment[];
  /** Optional word-level timestamps (not all providers/models support this) */
  words?: TranscriptionWord[];
  /** Raw VTT text if available from the provider (whisper-1 only) */
  vttText?: string;
  /** The language detected or used */
  language?: string;
  /** Duration of the audio in seconds */
  duration?: number;
}

/** The result of a diarized transcription request */
export interface DiarizedTranscriptionResult extends TranscriptionResult {
  /** Segments attributed to speakers */
  diarizedSegments: DiarizedSegment[];
  /** All speakers identified in the audio */
  speakers: Speaker[];
}

/** Options passed to a transcription request */
export interface TranscriptionOptions {
  /** Path to the local audio file to transcribe */
  filePath: string;
  /** Language code in ISO 639-1 format (e.g., 'en', 'sv') */
  language?: string;
  /** Optional prompt to guide the transcription (context/vocabulary hints) */
  prompt?: string;
  /** Model to use for this specific transcription */
  model?: TranscriptionModelId;
  /** Temperature for randomness control (0-1, only gpt-4o models) */
  temperature?: number;
  /** Include log probabilities in response (only gpt-4o models, not diarize) */
  includeLogprobs?: boolean;
}

/** Options for diarized transcription */
export interface DiarizeOptions extends TranscriptionOptions {
  /** Known speaker names (up to 4) for labeling */
  knownSpeakerNames?: string[];
  /** Chunking strategy for audio > 30 seconds */
  chunkingStrategy?: 'auto' | Record<string, unknown>;
}

/** Configuration for a transcription provider */
export interface ProviderConfig {
  /** Unique provider identifier */
  providerId: ProviderId;
  /** API key (for cloud providers) */
  apiKey?: string;
  /** Base URL override (for local providers or proxies) */
  baseUrl?: string;
  /** Default model to use when none is specified */
  defaultModel?: TranscriptionModelId;
  /** Provider-specific extra configuration */
  options?: Record<string, unknown>;
}

/** Metadata about a provider's capabilities */
export interface ProviderCapabilities {
  /** Models supported by this provider */
  supportedModels: TranscriptionModelId[];
  /** Whether the provider supports word-level timestamps */
  supportsWordTimestamps: boolean;
  /** Whether the provider supports streaming responses */
  supportsStreaming: boolean;
  /** Whether the provider supports speaker diarization */
  supportsDiarization: boolean;
  /** Maximum file size in bytes (undefined = no limit) */
  maxFileSizeBytes?: number;
  /** Supported audio formats */
  supportedAudioFormats: string[];
  /**
   * Output formats natively supported by the provider.
   * IMPORTANT: gpt-4o-* models only support 'json' and 'text'.
   * Only whisper-1 supports 'srt', 'vtt', and 'verbose_json'.
   * Our service generates SRT/VTT from segments regardless.
   */
  nativeOutputFormats: string[];
}
