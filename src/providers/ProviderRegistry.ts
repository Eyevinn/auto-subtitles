/**
 * Provider Registry — central hub for managing transcription providers.
 *
 * The registry handles:
 * - Registering provider factories (not instances, to allow lazy creation)
 * - Resolving which provider to use for a given model ID
 * - Creating and caching provider instances
 * - Listing available providers and their capabilities
 *
 * Usage:
 *   const registry = new ProviderRegistry();
 *   registry.register('openai', (config) => new OpenAIProvider(config));
 *   const provider = registry.getProviderForModel('whisper-1');
 */

import { TranscriptionProvider } from './TranscriptionProvider';
import {
  ProviderCapabilities,
  ProviderConfig,
  ProviderId,
  TranscriptionModelId
} from './types';

/** Factory function that creates a provider instance */
export type ProviderFactory = (config: ProviderConfig) => TranscriptionProvider;

/** Information about a registered provider */
export interface RegisteredProvider {
  providerId: ProviderId;
  factory: ProviderFactory;
  config: ProviderConfig;
  /** Cached instance (created on first use) */
  instance?: TranscriptionProvider;
}

export class ProviderRegistry {
  private providers: Map<ProviderId, RegisteredProvider> = new Map();
  /** Maps model IDs to the provider that supports them */
  private modelToProvider: Map<TranscriptionModelId, ProviderId> = new Map();

  /**
   * Register a provider with the registry.
   *
   * @param config - Provider configuration
   * @param factory - Factory function to create the provider
   */
  register(config: ProviderConfig, factory: ProviderFactory): void {
    const entry: RegisteredProvider = {
      providerId: config.providerId,
      factory,
      config
    };

    this.providers.set(config.providerId, entry);

    // Create a temporary instance to read capabilities and build the model map
    const tempInstance = factory(config);
    for (const model of tempInstance.capabilities.supportedModels) {
      // First-registered provider wins for a given model
      if (!this.modelToProvider.has(model)) {
        this.modelToProvider.set(model, config.providerId);
      }
    }

    // Cache the instance we just created
    entry.instance = tempInstance;
  }

  /**
   * Get a provider instance by its ID.
   *
   * @param providerId - The provider ID
   * @returns The provider instance
   * @throws Error if the provider is not registered
   */
  getProvider(providerId: ProviderId): TranscriptionProvider {
    const entry = this.providers.get(providerId);
    if (!entry) {
      throw new Error(
        `Provider "${providerId}" is not registered. ` +
          `Available providers: ${Array.from(this.providers.keys()).join(', ')}`
      );
    }
    if (!entry.instance) {
      entry.instance = entry.factory(entry.config);
    }
    return entry.instance;
  }

  /**
   * Get the provider that supports a specific model.
   *
   * @param model - The model ID
   * @returns The provider instance
   * @throws Error if no provider supports the model
   */
  getProviderForModel(model: TranscriptionModelId): TranscriptionProvider {
    const providerId = this.modelToProvider.get(model);
    if (!providerId) {
      throw new Error(
        `No provider registered for model "${model}". ` +
          `Available models: ${Array.from(this.modelToProvider.keys()).join(
            ', '
          )}`
      );
    }
    return this.getProvider(providerId);
  }

  /**
   * Resolve a model request to a specific provider and model.
   *
   * If model is specified, finds the provider that supports it.
   * If model is not specified, uses the default provider and its default model.
   *
   * @param model - Optional model ID
   * @param providerId - Optional explicit provider ID
   * @returns Tuple of [provider, resolvedModelId]
   */
  resolve(
    model?: TranscriptionModelId,
    providerId?: ProviderId
  ): [TranscriptionProvider, TranscriptionModelId] {
    if (providerId) {
      const provider = this.getProvider(providerId);
      const resolvedModel = provider.resolveModel(model);
      return [provider, resolvedModel];
    }

    if (model) {
      const provider = this.getProviderForModel(model);
      return [provider, model];
    }

    // No model or provider specified — use the first registered provider's default
    const firstEntry = this.providers.values().next().value;
    if (!firstEntry) {
      throw new Error('No providers registered');
    }
    const provider = this.getProvider(firstEntry.providerId);
    return [provider, provider.defaultModel];
  }

  /**
   * List all registered providers and their capabilities.
   */
  listProviders(): Array<{
    providerId: ProviderId;
    capabilities: ProviderCapabilities;
  }> {
    return Array.from(this.providers.keys()).map((id) => {
      const provider = this.getProvider(id);
      return {
        providerId: id,
        capabilities: provider.capabilities
      };
    });
  }

  /**
   * List all available model IDs across all providers.
   */
  listModels(): Array<{
    model: TranscriptionModelId;
    providerId: ProviderId;
  }> {
    return Array.from(this.modelToProvider.entries()).map(
      ([model, providerId]) => ({
        model,
        providerId
      })
    );
  }

  /**
   * Check if any provider is registered.
   */
  get hasProviders(): boolean {
    return this.providers.size > 0;
  }
}
