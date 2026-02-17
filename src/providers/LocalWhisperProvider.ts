/**
 * Local Whisper transcription provider.
 *
 * Runs Whisper locally via the whisper CLI (whisper.cpp or OpenAI whisper).
 * This enables fully offline transcription without API costs.
 *
 * Prerequisites:
 * - whisper CLI installed and available in PATH, OR
 * - whisper.cpp compiled and available in PATH
 * - Model files downloaded locally
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { dirname } from 'path';
import {
  ProviderCapabilities,
  ProviderConfig,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionSegment
} from './types';
import { TranscriptionProvider } from './TranscriptionProvider';
import logger from '../utils/logger';

/** Local Whisper-specific configuration */
export interface LocalWhisperProviderConfig extends ProviderConfig {
  providerId: 'local-whisper';
  options?: {
    /** Path to the whisper binary (default: 'whisper' in PATH) */
    binaryPath?: string;
    /** Path to the model directory */
    modelDir?: string;
    /** Number of threads to use */
    threads?: number;
    /** Device to use: 'cpu', 'cuda', 'auto' */
    device?: string;
  };
}

export class LocalWhisperProvider extends TranscriptionProvider {
  private binaryPath: string;
  private modelDir?: string;
  private threads: number;
  private device: string;

  constructor(config: LocalWhisperProviderConfig) {
    super({
      ...config,
      defaultModel: config.defaultModel ?? 'base'
    });
    this.binaryPath = config.options?.binaryPath ?? 'whisper';
    this.modelDir = config.options?.modelDir;
    this.threads = config.options?.threads ?? 4;
    this.device = config.options?.device ?? 'auto';
  }

  get capabilities(): ProviderCapabilities {
    return {
      supportedModels: [
        'tiny',
        'tiny.en',
        'base',
        'base.en',
        'small',
        'small.en',
        'medium',
        'medium.en',
        'large',
        'large-v2',
        'large-v3',
        'turbo'
      ],
      supportsWordTimestamps: true,
      supportsStreaming: false,
      supportsDiarization: false,
      // No enforced limit for local processing
      maxFileSizeBytes: undefined,
      supportedAudioFormats: [
        'flac',
        'mp3',
        'mp4',
        'mpeg',
        'mpga',
        'ogg',
        'wav',
        'webm',
        'm4a'
      ],
      nativeOutputFormats: ['json', 'text', 'srt', 'vtt', 'verbose_json']
    };
  }

  async transcribe(
    options: TranscriptionOptions
  ): Promise<TranscriptionResult> {
    const model = this.resolveModel(options.model);
    const language = options.language ?? 'en';
    const outputDir = dirname(options.filePath);

    try {
      const args = [
        `"${options.filePath}"`,
        `--model ${model}`,
        `--language ${language}`,
        `--output_format json`,
        `--output_dir "${outputDir}"`,
        `--word_timestamps True`,
        `--threads ${this.threads}`
      ];

      if (this.device !== 'auto') {
        args.push(`--device ${this.device}`);
      }

      if (this.modelDir) {
        args.push(`--model_dir "${this.modelDir}"`);
      }

      if (options.prompt) {
        args.push(`--initial_prompt "${options.prompt}"`);
      }

      const command = `${this.binaryPath} ${args.join(' ')}`;
      logger.info('Running local Whisper', { command });
      execSync(command, { timeout: 600000 }); // 10 minute timeout

      // Whisper outputs a JSON file alongside the input
      const jsonOutputPath = options.filePath.replace(/\.[^.]+$/, '.json');

      if (!fs.existsSync(jsonOutputPath)) {
        throw new Error(
          `Whisper did not produce expected output file: ${jsonOutputPath}`
        );
      }

      const rawOutput = JSON.parse(fs.readFileSync(jsonOutputPath, 'utf-8'));

      const segments: TranscriptionSegment[] = (rawOutput.segments ?? []).map(
        (s: { start: number; end: number; text: string }) => ({
          start: s.start,
          end: s.end,
          text: s.text.trim()
        })
      );

      const words = rawOutput.segments?.flatMap(
        (s: { words?: Array<{ word: string; start: number; end: number }> }) =>
          (s.words ?? []).map(
            (w: { word: string; start: number; end: number }) => ({
              word: w.word.trim(),
              start: w.start,
              end: w.end
            })
          )
      );

      // Clean up the output file
      try {
        fs.unlinkSync(jsonOutputPath);
      } catch {
        // Ignore cleanup errors
      }

      return {
        segments,
        words,
        language,
        duration: rawOutput.segments?.[rawOutput.segments.length - 1]?.end
      };
    } catch (err) {
      logger.error('Local Whisper transcription failed', {
        err: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }
}
