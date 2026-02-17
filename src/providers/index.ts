/**
 * Providers module — public API for the transcription provider abstraction.
 *
 * Usage:
 *   import { createDefaultRegistry, TranscriptionProvider } from './providers';
 *   const registry = createDefaultRegistry();
 *   const [provider, model] = registry.resolve('gpt-4o-transcribe');
 *   const result = await provider.transcribe({ filePath, language: 'en', model });
 */

// Core types
export type {
  TranscriptionModelId,
  ProviderId,
  TranscriptionSegment,
  TranscriptionWord,
  Speaker,
  DiarizedSegment,
  DiarizedTranscriptionResult,
  DiarizeOptions,
  TranscriptionStreamEvent,
  TranscriptionResult,
  TranscriptionOptions,
  ProviderConfig,
  ProviderCapabilities
} from './types';

// Abstract base
export { TranscriptionProvider } from './TranscriptionProvider';

// Concrete providers
export { OpenAIProvider } from './OpenAIProvider';
export type { OpenAIProviderConfig } from './OpenAIProvider';
export { LocalWhisperProvider } from './LocalWhisperProvider';
export type { LocalWhisperProviderConfig } from './LocalWhisperProvider';

// Registry
export { ProviderRegistry } from './ProviderRegistry';
export type { ProviderFactory, RegisteredProvider } from './ProviderRegistry';

// Default setup
export { createDefaultRegistry } from './setup';
