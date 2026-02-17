/**
 * Default provider registry setup.
 *
 * Creates a ProviderRegistry with the standard providers registered
 * based on environment configuration. This is the recommended way to
 * initialize the provider system.
 *
 * Environment variables:
 *   OPENAI_API_KEY       — Required for OpenAI provider
 *   OPENAI_BASE_URL      — Optional: override OpenAI API base URL
 *   DEFAULT_MODEL        — Optional: default model (default: 'whisper-1')
 *   DEFAULT_PROVIDER     — Optional: default provider (default: 'openai')
 *   LOCAL_WHISPER_BINARY — Optional: path to local whisper binary
 *   LOCAL_WHISPER_MODELS — Optional: path to local model directory
 *   LOCAL_WHISPER_THREADS — Optional: number of threads (default: 4)
 *   LOCAL_WHISPER_DEVICE  — Optional: device (cpu, cuda, auto)
 */

import { ProviderRegistry } from './ProviderRegistry';
import { OpenAIProvider, OpenAIProviderConfig } from './OpenAIProvider';
import {
  LocalWhisperProvider,
  LocalWhisperProviderConfig
} from './LocalWhisperProvider';
import logger from '../utils/logger';

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Register OpenAI provider if API key is available
  if (process.env.OPENAI_API_KEY) {
    const openaiConfig: OpenAIProviderConfig = {
      providerId: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      defaultModel:
        (process.env.DEFAULT_MODEL as OpenAIProviderConfig['defaultModel']) ??
        'whisper-1'
    };

    registry.register(
      openaiConfig,
      (config) => new OpenAIProvider(config as OpenAIProviderConfig)
    );
  }

  // Register local Whisper provider if binary path is configured
  if (process.env.LOCAL_WHISPER_BINARY) {
    const localConfig: LocalWhisperProviderConfig = {
      providerId: 'local-whisper',
      defaultModel: process.env.DEFAULT_MODEL ?? 'base',
      options: {
        binaryPath: process.env.LOCAL_WHISPER_BINARY,
        modelDir: process.env.LOCAL_WHISPER_MODELS,
        threads: process.env.LOCAL_WHISPER_THREADS
          ? parseInt(process.env.LOCAL_WHISPER_THREADS, 10)
          : 4,
        device: process.env.LOCAL_WHISPER_DEVICE ?? 'auto'
      }
    };

    registry.register(
      localConfig,
      (config) => new LocalWhisperProvider(config as LocalWhisperProviderConfig)
    );
  }

  if (!registry.hasProviders) {
    logger.warn(
      'No transcription providers registered. Set OPENAI_API_KEY or LOCAL_WHISPER_BINARY.'
    );
  }

  return registry;
}
