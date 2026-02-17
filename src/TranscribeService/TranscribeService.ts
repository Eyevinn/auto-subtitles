import { OpenAI } from 'openai';
import Configuration from 'openai';
import { execSync } from 'child_process';
import { nanoid } from 'nanoid';
import { signUrl, uploadToS3 } from '../aws/upload';
import fs, { statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getAudioDuration, splitAudioOnSilence } from '../audio/chunker';
import { TranscriptionVerbose } from 'openai/resources/audio/transcriptions';
import logger from '../utils/logger';
import {
  transcriptionTotal,
  transcriptionErrors,
  diarizationTotal,
  formatGenerationTotal,
  transcriptionDuration,
  activeWorkers
} from '../utils/metrics';

export type TEvent = 'subtitling_started' | 'subtitling_completed' | 'error';
export enum State {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE'
}
export type TTranscribeFormat = 'srt' | 'vtt';

export type TTranscribeModel =
  | 'whisper-1'
  | 'gpt-4o-transcribe'
  | 'gpt-4o-mini-transcribe'
  | 'gpt-4o-mini-transcribe-2025-12-15'
  | 'gpt-4o-transcribe-diarize';

export const VALID_TRANSCRIBE_MODELS: TTranscribeModel[] = [
  'whisper-1',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-transcribe-diarize'
];

export const DEFAULT_TRANSCRIBE_MODEL: TTranscribeModel = 'whisper-1';

export type TTranscribeLocalFile = {
  filePath: string;
  language?: string; // language code in ISO 639-1 format
  prompt?: string;
  postProcessingPrompt?: string; // Optional prompt to guide transcription
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
  externalId?: string; // Optional external ID for tracking
  speakerNames?: string[]; // Optional known speaker names for diarization (max 4)
};

export type TTranscribeRemoteFile = {
  source: string;
  language?: string; // language code in ISO 639-1 format
  format?: TTranscribeFormat;
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
  externalId?: string; // Optional external ID for tracking
  prompt?: string; // Optional prompt to guide transcription
  speakerNames?: string[]; // Optional known speaker names for diarization (max 4)
};

export type TTranscribeParams = {
  jobId: string; // Unique job ID for tracking
  source: string;
  language?: string; // language code in ISO 639-1 format
  postProcessingPrompt?: string; // Optional prompt to guide transcription
  format?: TTranscribeFormat;
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
  externalId?: string; // Optional external ID for tracking
  speakerNames?: string[]; // Optional known speaker names for diarization (max 4)
};

type TSegment = {
  start: number;
  end: number;
  text: string;
};

function isWhisperModel(model: TTranscribeModel): boolean {
  return model === 'whisper-1';
}

function isDiarizeModel(model: TTranscribeModel): boolean {
  return model === 'gpt-4o-transcribe-diarize';
}

type TDiarizedSegment = {
  speaker: string;
  text: string;
  start: number;
  end: number;
};

type TDiarizedResponse = {
  text: string;
  speakers: Array<{
    id: string;
    name?: string;
    segments: Array<{
      text: string;
      start: number;
      end: number;
    }>;
  }>;
};

export class TranscribeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    retryable = false
  ) {
    super(message);
    this.name = 'TranscribeError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class TranscribeService {
  private instanceId: string;
  private workerState: State;
  private openai: OpenAI;

  constructor(openApiKey?: string) {
    this.instanceId = nanoid();
    this.workerState = State.INACTIVE;
    const config = new Configuration({
      apiKey: openApiKey ? openApiKey : process.env.OPENAI_API_KEY
    });
    this.openai = new OpenAI({ ...config });
  }

  private async convertToMP3(
    videoUrl: string,
    tempFile: string
  ): Promise<string[]> {
    try {
      logger.info('Converting video to MP3', { videoUrl, tempFile });
      execSync(`ffmpeg -i "${videoUrl}" -f mp3 "${tempFile}"`);
      logger.info('Conversion completed, splitting into chunks');
      if (!statSync(tempFile).isFile()) {
        throw new Error('Error converting video, temp file not found');
      }
      const chunks = splitAudioOnSilence(tempFile);
      logger.info('Audio split into chunks', { chunkCount: chunks.length });
      return chunks;
    } catch (error) {
      logger.error('Error converting video', {
        err: error instanceof Error ? error.message : String(error)
      });
      throw new Error('Error converting video');
    }
  }

  get id(): string {
    return this.instanceId;
  }

  get state(): State {
    return this.workerState;
  }

  set state(status: State) {
    this.workerState = status;
  }

  async createUrl(source: string): Promise<URL> {
    const url = new URL(source);
    if (url.protocol === 's3:') {
      // We need to sign the URL for ffmpeg to be able to access it
      return await signUrl({ url });
    }
    return url;
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;
        const isRetryable =
          err instanceof Error &&
          ('status' in err
            ? [429, 500, 502, 503, 504].includes(
                (err as Error & { status: number }).status
              )
            : err.message.includes('ECONNRESET') ||
              err.message.includes('ETIMEDOUT'));
        if (!isRetryable || attempt === maxRetries) {
          throw err;
        }
        const delay = baseDelay * Math.pow(2, attempt);
        logger.warn('Retryable error, backing off', {
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          err: lastError.message
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  private wrapTranscribeError(
    err: unknown,
    model: TTranscribeModel,
    filePath: string
  ): never {
    const error = err as Error & { status?: number; code?: string };
    logger.error('Transcription failed', {
      filePath,
      model,
      err: error.message,
      status: error.status
    });
    if (error.status === 400) {
      throw new TranscribeError(
        `Invalid request for model ${model}: ${error.message}`,
        'INVALID_REQUEST',
        400
      );
    } else if (error.status === 401) {
      throw new TranscribeError('Invalid OpenAI API key', 'UNAUTHORIZED', 401);
    } else if (error.status === 429) {
      throw new TranscribeError(
        'OpenAI rate limit exceeded',
        'RATE_LIMITED',
        429,
        true
      );
    }
    throw new TranscribeError(
      `Transcription failed: ${error.message}`,
      'TRANSCRIPTION_FAILED',
      500,
      true
    );
  }

  async transcribeLocalFile({
    filePath,
    language,
    prompt,
    postProcessingPrompt,
    model,
    speakerNames
  }: TTranscribeLocalFile): Promise<TSegment[]> {
    const effectiveModel = model ?? DEFAULT_TRANSCRIBE_MODEL;
    try {
      if (isWhisperModel(effectiveModel)) {
        return await this.transcribeLocalFileWhisper({
          filePath,
          language,
          prompt,
          postProcessingPrompt,
          model: effectiveModel
        });
      } else if (isDiarizeModel(effectiveModel)) {
        const diarized = await this.transcribeLocalFileDiarize({
          filePath,
          language,
          speakerNames
        });
        return diarized.map((seg) => ({
          start: seg.start,
          end: seg.end,
          text: `[${seg.speaker}] ${seg.text}`
        }));
      } else {
        return await this.transcribeLocalFileGpt({
          filePath,
          language,
          prompt,
          postProcessingPrompt,
          model: effectiveModel
        });
      }
    } catch (err) {
      if (err instanceof TranscribeError) throw err;
      this.wrapTranscribeError(err, effectiveModel, filePath);
    }
  }

  private async transcribeLocalFileWhisper({
    filePath,
    language,
    prompt,
    postProcessingPrompt,
    model
  }: TTranscribeLocalFile & { model: TTranscribeModel }): Promise<TSegment[]> {
    const transcription = await this.retryWithBackoff(() =>
      this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: model,
        response_format: 'verbose_json',
        language: language ?? 'en',
        prompt: prompt ?? undefined,
        timestamp_granularities: ['word']
      })
    );

    const resp = await this.retryWithBackoff(() =>
      this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: model,
        response_format: 'vtt',
        language: language ?? 'en',
        prompt: prompt ?? undefined
      })
    );
    logger.info('Transcription completed for chunk', { filePath });
    let processedText = resp;
    if (postProcessingPrompt) {
      logger.info('Applying post-processing prompt', { filePath });
      const postProcessingResponse = await this.openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Your task is to process the VTT formatted text and make adjustment based on the context provided. Expected output is a VTT formatted text with proper timecodes and text segments.'
          },
          {
            role: 'user',
            content: postProcessingPrompt + '\n\n' + resp
          }
        ]
      });
      if (postProcessingResponse.choices[0].message.content) {
        logger.debug('Updating VTT text in transcription');
        processedText = postProcessingResponse.choices[0].message.content;
      }
      if (transcription.words) {
        const postProcessingTranscription =
          await this.openai.chat.completions.create({
            model: 'gpt-4.1',
            messages: [
              {
                role: 'system',
                content:
                  'You are a helpful assistant. Your task is to process the JSON and make adjustment based on the context provided. Do not make any adjustments to timing. Expected output is only a JSON with the same structure. Do not give any additional information or explanations.'
              },
              {
                role: 'user',
                content:
                  postProcessingPrompt +
                  '\n\n' +
                  JSON.stringify(transcription.words)
              }
            ]
          });
        if (postProcessingTranscription.choices[0].message.content) {
          logger.debug('Updating words in transcription');
          try {
            const cleanedContent =
              postProcessingTranscription.choices[0].message.content
                .replace(/```json\s*|\s*```/g, '')
                .trim();
            postProcessingTranscription.choices[0].message.content =
              cleanedContent;
            transcription.words = JSON.parse(
              postProcessingTranscription.choices[0].message.content
            );
          } catch (e) {
            logger.warn(
              'Error parsing post-processed transcription words JSON',
              {
                err: e instanceof Error ? e.message : String(e)
              }
            );
          }
        }
      }
    }
    const segments = this.parseVTTToSegments(processedText, transcription);
    return segments;
  }

  private async transcribeLocalFileGpt({
    filePath,
    language,
    prompt,
    postProcessingPrompt,
    model
  }: TTranscribeLocalFile & { model: TTranscribeModel }): Promise<TSegment[]> {
    // gpt-4o models only support json and text response formats
    const transcription = await this.retryWithBackoff(() =>
      this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: model,
        response_format: 'json',
        language: language ?? 'en',
        prompt: prompt ?? undefined
      })
    );
    logger.info('Transcription completed for chunk', { filePath, model });

    // json format returns { text: string } - create a single segment
    // We estimate timing from the audio duration since json format has no timestamps
    const duration = getAudioDuration(filePath);
    let segments: TSegment[] = [
      {
        start: 0,
        end: duration,
        text: transcription.text.trim()
      }
    ];

    if (postProcessingPrompt && segments.length > 0) {
      logger.info('Applying post-processing prompt', { filePath });
      const segmentsJson = JSON.stringify(segments);
      const postProcessingResponse = await this.openai.chat.completions.create({
        model: 'gpt-4.1',
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Your task is to process the JSON subtitle segments and make adjustments based on the context provided. Do not make any adjustments to timing. Expected output is only a JSON array with objects containing start, end, and text fields. Do not give any additional information or explanations.'
          },
          {
            role: 'user',
            content: postProcessingPrompt + '\n\n' + segmentsJson
          }
        ]
      });
      if (postProcessingResponse.choices[0].message.content) {
        try {
          const cleanedContent =
            postProcessingResponse.choices[0].message.content
              .replace(/```json\s*|\s*```/g, '')
              .trim();
          segments = JSON.parse(cleanedContent);
          logger.debug('Updated segments with post-processing');
        } catch (e) {
          logger.warn('Error parsing post-processed segments JSON', {
            err: e instanceof Error ? e.message : String(e)
          });
        }
      }
    }

    return segments;
  }

  private async transcribeLocalFileDiarize({
    filePath,
    language,
    speakerNames
  }: {
    filePath: string;
    language?: string;
    speakerNames?: string[];
  }): Promise<TDiarizedSegment[]> {
    // gpt-4o-transcribe-diarize requires diarized_json format and chunking_strategy
    const params: Record<string, unknown> = {
      file: fs.createReadStream(filePath),
      model: 'gpt-4o-transcribe-diarize',
      response_format: 'diarized_json',
      language: language ?? 'en',
      chunking_strategy: 'auto'
    };
    if (speakerNames && speakerNames.length > 0) {
      params.known_speaker_names = speakerNames.slice(0, 4);
    }

    const transcription = await this.retryWithBackoff(() =>
      this.openai.audio.transcriptions.create(params as never)
    );
    logger.info('Diarization completed for chunk', { filePath });

    // Parse the diarized response into segments with speaker labels
    const response = transcription as unknown as TDiarizedResponse;
    const diarizedSegments: TDiarizedSegment[] = [];

    if (response.speakers) {
      for (const speaker of response.speakers) {
        const speakerLabel = speaker.name ?? speaker.id;
        for (const seg of speaker.segments) {
          diarizedSegments.push({
            speaker: speakerLabel,
            start: seg.start,
            end: seg.end,
            text: seg.text.trim()
          });
        }
      }
      // Sort by start time
      diarizedSegments.sort((a, b) => a.start - b.start);
    } else {
      // Fallback: treat as single speaker
      const duration = getAudioDuration(filePath);
      diarizedSegments.push({
        speaker: 'A',
        start: 0,
        end: duration,
        text: response.text?.trim() ?? ''
      });
    }

    return diarizedSegments;
  }

  private static normalizeWord(word: string): string {
    return word.replace(/[,!?.;:'"()-]/g, '').toLowerCase();
  }

  private parseVTTToSegments(
    vtt: string,
    transcription: TranscriptionVerbose
  ): TSegment[] {
    const lines = vtt.split('\n');
    const segments: TSegment[] = [];
    let currentStart: number | undefined;
    let currentEnd: number | undefined;
    let currentTextLines: string[] = [];

    // Step 1: Parse VTT cues, handling multi-line text
    for (const line of lines) {
      if (line.includes('-->')) {
        // If we have a pending segment, push it first
        if (
          currentStart !== undefined &&
          currentEnd !== undefined &&
          currentTextLines.length > 0
        ) {
          segments.push({
            start: currentStart,
            end: currentEnd,
            text: currentTextLines.join(' ')
          });
        }
        const [start, end] = line.split('-->').map((timeStr) => {
          const [h, m, s] = timeStr.trim().split(':').map(Number);
          return h * 3600 + m * 60 + s;
        });
        if (!isNaN(start) && !isNaN(end)) {
          currentStart = start;
          currentEnd = end;
          currentTextLines = [];
        } else {
          logger.warn('Invalid timecode in VTT, skipping cue', {
            line
          });
          currentStart = undefined;
          currentEnd = undefined;
          currentTextLines = [];
        }
      } else if (line.trim() && currentStart !== undefined) {
        // Accumulate multi-line text for this cue
        currentTextLines.push(line.trim());
      } else if (!line.trim() && currentTextLines.length > 0) {
        // Empty line signals end of cue text
        if (currentStart !== undefined && currentEnd !== undefined) {
          segments.push({
            start: currentStart,
            end: currentEnd,
            text: currentTextLines.join(' ')
          });
        }
        currentStart = undefined;
        currentEnd = undefined;
        currentTextLines = [];
      }
    }
    // Push final segment if exists
    if (
      currentStart !== undefined &&
      currentEnd !== undefined &&
      currentTextLines.length > 0
    ) {
      segments.push({
        start: currentStart,
        end: currentEnd,
        text: currentTextLines.join(' ')
      });
    }

    // Step 2: Align segments with word-level timestamps using global word index
    const allWords = transcription.words ?? [];
    if (allWords.length === 0) {
      return segments;
    }

    let globalWordIdx = 0;
    for (const segment of segments) {
      const segmentWords = segment.text
        .split(' ')
        .filter((w) => w.trim().length > 0);
      if (segmentWords.length === 0) continue;

      // Search for the first segment word in the word list, starting from
      // our current position but allowing a wider search window
      const firstNorm = TranscribeService.normalizeWord(segmentWords[0]);
      let bestMatchIdx = -1;
      const searchLimit = Math.min(globalWordIdx + 50, allWords.length);

      // Search forward from current position (prefer nearest match)
      for (let i = globalWordIdx; i < searchLimit; i++) {
        if (TranscribeService.normalizeWord(allWords[i].word) === firstNorm) {
          bestMatchIdx = i;
          break;
        }
      }

      if (bestMatchIdx === -1) {
        // Fallback: search backwards a small window (handles slight reordering)
        const backLimit = Math.max(0, globalWordIdx - 10);
        for (let i = globalWordIdx - 1; i >= backLimit; i--) {
          if (TranscribeService.normalizeWord(allWords[i].word) === firstNorm) {
            bestMatchIdx = i;
            break;
          }
        }
      }

      if (bestMatchIdx !== -1) {
        // Count consecutive word matches
        let matchCount = 1;
        for (let s = 1; s < segmentWords.length; s++) {
          const wordIdx = bestMatchIdx + s;
          if (wordIdx >= allWords.length) break;
          if (
            TranscribeService.normalizeWord(segmentWords[s]) ===
            TranscribeService.normalizeWord(allWords[wordIdx].word)
          ) {
            matchCount++;
          } else {
            break;
          }
        }

        if (matchCount >= 2) {
          const lastMatchIdx = bestMatchIdx + matchCount - 1;
          const newStart = allWords[bestMatchIdx].start;
          const newEnd = allWords[lastMatchIdx].end;

          // Only adjust if word timestamps are reasonable
          if (newStart >= 0 && newEnd > newStart) {
            segment.start = newStart;
            segment.end = newEnd;
            logger.debug('Aligned segment to word timestamps', {
              matchedWords: matchCount,
              start: segment.start,
              end: segment.end
            });
          }
          // Advance global index past matched words
          globalWordIdx = lastMatchIdx + 1;
        } else {
          logger.debug('Insufficient word matches, keeping VTT timing', {
            matchedWords: matchCount,
            text: segment.text.slice(0, 40)
          });
          // Still advance past approximate position
          globalWordIdx = bestMatchIdx + 1;
        }
      } else {
        logger.debug('No word match found, keeping VTT timing', {
          text: segment.text.slice(0, 40)
        });
      }

      // Safety: ensure end > start with minimum duration
      if (segment.end <= segment.start) {
        segment.end = segment.start + 0.5;
        logger.warn('Fixed negative/zero duration segment', {
          text: segment.text.slice(0, 40),
          start: segment.start,
          end: segment.end
        });
      }
    }
    return segments;
  }

  private adjustSegmentTimecodes(
    segments: TSegment[],
    offset: number
  ): TSegment[] {
    return segments.map((segment) => ({
      ...segment,
      start: segment.start + offset,
      end: segment.end + offset
    }));
  }

  private formatSegmentsToVTT(segments: TSegment[]): string {
    return `WEBVTT\n\n${segments
      .map((segment) => {
        const formatTime = (seconds: number) => {
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = Math.floor(seconds % 60);
          const ms = Math.floor((seconds % 1) * 1000);
          return `${String(h).padStart(2, '0')}:${String(m).padStart(
            2,
            '0'
          )}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
        };
        return `${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${
          segment.text
        }\n`;
      })
      .join('\n')}`;
  }

  private formatSegmentsToSRT(segments: TSegment[]): string {
    return segments
      .map((segment, index) => {
        const formatTime = (seconds: number) => {
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = Math.floor(seconds % 60);
          const ms = Math.floor((seconds % 1) * 1000);
          return `${String(h).padStart(2, '0')}:${String(m).padStart(
            2,
            '0'
          )}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
        };
        return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(
          segment.end
        )}\n${segment.text}\n`;
      })
      .join('\n');
  }

  private optimizeSegmentDurations(segments: TSegment[]): TSegment[] {
    const optimized: TSegment[] = [];
    const MIN_DURATION = 1.5; // 1.5 seconds
    const MAX_DURATION = 7.0; // 7 seconds
    const CHARS_PER_SECOND = 15; // Average speech rate

    for (const segment of segments) {
      const text = segment.text;
      const totalDuration = segment.end - segment.start;

      if (totalDuration <= 0) {
        logger.warn('Skipping segment with invalid duration', {
          text: text.slice(0, 40)
        });
        continue;
      }

      if (totalDuration > MAX_DURATION) {
        // Split long segments proportionally based on word count
        // so timing is distributed evenly rather than based on char count
        const words = text.split(' ').filter((w) => w.trim().length > 0);
        const totalWords = words.length;
        if (totalWords === 0) continue;

        const split: TSegment[] = [];
        let currentWords: string[] = [];
        let wordsUsed = 0;

        for (const word of words) {
          currentWords.push(word);
          const currentText = currentWords.join(' ');
          const estimatedDuration = currentText.length / CHARS_PER_SECOND;

          if (estimatedDuration >= MAX_DURATION && currentWords.length > 1) {
            // Remove last word that pushed over limit
            currentWords.pop();
            const segText = currentWords.join(' ');

            // Proportional timing: distribute total duration by word count
            const segStart =
              segment.start + (wordsUsed / totalWords) * totalDuration;
            const segEnd =
              segment.start +
              ((wordsUsed + currentWords.length) / totalWords) * totalDuration;
            split.push({
              start: segStart,
              end: segEnd,
              text: segText
            });

            wordsUsed += currentWords.length;
            currentWords = [word];
          }
        }

        // Final remaining segment
        if (currentWords.length > 0) {
          const segText = currentWords.join(' ');
          const segStart =
            segment.start + (wordsUsed / totalWords) * totalDuration;
          split.push({
            start: segStart,
            end: segment.end,
            text: segText
          });
        }

        logger.debug('Split long segment proportionally', {
          newSegmentCount: split.length,
          originalDuration: totalDuration
        });
        optimized.push(...split);
      } else if (totalDuration < MIN_DURATION) {
        // Try to extend into available gap before this segment
        if (optimized.length > 0) {
          const prev = optimized[optimized.length - 1];
          const gap = segment.start - prev.end;
          if (gap < 0.5 && gap >= 0) {
            prev.end = segment.start;
          }
        }
        // Keep the segment with minimum duration
        optimized.push({
          start: segment.start,
          end: Math.max(segment.end, segment.start + MIN_DURATION),
          text
        });
      } else {
        // Segment duration is within acceptable range, keep original timing
        optimized.push({
          start: segment.start,
          end: segment.end,
          text
        });
      }
    }
    return optimized;
  }

  private limitSegmentLines(segments: TSegment[]): TSegment[] {
    const optimized: TSegment[] = [];
    const MAX_CHARS_PER_LINE = 42;

    for (const segment of segments) {
      const words = segment.text.split(' ');
      let currentLine = '';
      let lines: string[] = [];

      // Split into lines based on character count
      for (const word of words) {
        if ((currentLine + word).length > MAX_CHARS_PER_LINE) {
          if (currentLine) lines.push(currentLine.trim());
          currentLine = word + ' ';
        } else {
          currentLine += word + ' ';
        }
      }
      if (currentLine) lines.push(currentLine.trim());

      // Limit to 2 lines maximum
      if (lines.length > 2) {
        const newLines = this.redistributeLines(lines);
        lines = newLines.slice(0, 2);
      }
      optimized.push({
        start: segment.start,
        end: segment.end,
        text: lines.join('\n')
      });
    }
    return optimized;
  }

  private optimizeSegments(
    segments: TSegment[],
    model?: TTranscribeModel
  ): TSegment[] {
    const validated = this.validateSegmentTiming(segments);
    const effectiveModel = model ?? DEFAULT_TRANSCRIBE_MODEL;

    // For Whisper models, segments already have accurate word-level timestamps
    // from parseVTTToSegments. Only apply line limiting and short-segment merging.
    // For GPT-4o models (no timestamps), apply full duration optimization.
    if (isWhisperModel(effectiveModel)) {
      const mergedShortSegments = this.mergeShortSegments(validated);
      return this.limitSegmentLines(mergedShortSegments);
    }

    const optimizedDurations = this.optimizeSegmentDurations(validated);
    const mergedShortSegments = this.mergeShortSegments(optimizedDurations);
    return this.limitSegmentLines(mergedShortSegments);
  }

  private validateSegmentTiming(segments: TSegment[]): TSegment[] {
    const validated: TSegment[] = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = { ...segments[i] };

      // Fix negative or zero duration
      if (segment.end <= segment.start) {
        const nextStart =
          i + 1 < segments.length ? segments[i + 1].start : segment.start + 2;
        segment.end = Math.min(segment.start + 2, nextStart);
        logger.warn('Fixed invalid segment duration', {
          text: segment.text.slice(0, 40),
          originalEnd: segments[i].end,
          fixedEnd: segment.end
        });
      }

      // Fix overlapping with previous segment
      if (validated.length > 0) {
        const prev = validated[validated.length - 1];
        if (segment.start < prev.end) {
          // Adjust: split the overlap by moving previous end to this start
          const overlap = prev.end - segment.start;
          if (overlap < 0.5) {
            prev.end = segment.start;
          } else {
            // Larger overlap: place gap at midpoint
            const mid = (prev.end + segment.start) / 2;
            prev.end = mid;
            segment.start = mid;
          }
          logger.debug('Fixed overlapping segments', {
            prevEnd: prev.end,
            currentStart: segment.start
          });
        }
      }

      // Ensure minimum duration after all adjustments
      if (segment.end - segment.start < 0.1) {
        segment.end = segment.start + 0.5;
      }

      validated.push(segment);
    }
    return validated;
  }

  private redistributeLines(lines: string[]): string[] {
    const words = lines.join(' ').split(' ');
    const MAX_CHARS_PER_LINE = 42;
    const newLines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + word).length > MAX_CHARS_PER_LINE) {
        if (currentLine) newLines.push(currentLine.trim());
        currentLine = word + ' ';
      } else {
        currentLine += word + ' ';
      }
    }
    if (currentLine) newLines.push(currentLine.trim());
    if (newLines.length > 2) {
      // If we still have more than 2 lines, we need to join the last lines to the second last line
      newLines[newLines.length - 2] += ' ' + newLines.pop();
    }
    return newLines;
  }

  private mergeShortSegments(segments: TSegment[]): TSegment[] {
    const MIN_DURATION = 1.0;
    const result: TSegment[] = [];
    let current: TSegment | null = null;

    for (const segment of segments) {
      if (!current) {
        current = { ...segment };
        continue;
      }

      const currentDuration = current.end - current.start;
      const gap = segment.start - current.end;

      if (currentDuration < MIN_DURATION && gap < 0.3) {
        // Merge with next segment
        current.end = segment.end;
        current.text += '\n' + segment.text;
      } else {
        result.push(current);
        current = { ...segment };
      }
    }

    if (current) result.push(current);
    return result;
  }

  private async postCallbackEvent(
    eventType: TEvent,
    jobId: string,
    callbackUrl?: URL,
    externalId?: string
  ) {
    if (!callbackUrl) {
      return;
    }
    try {
      const response = await fetch(callbackUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: eventType,
          jobId,
          workerId: this.id,
          timestamp: new Date().toISOString(),
          externalId
        })
      });
      if (!response.ok) {
        logger.warn('Callback failed', {
          callbackUrl: callbackUrl.toString(),
          status: response.status
        });
      } else {
        logger.info('Callback event sent', {
          event: eventType,
          callbackUrl: callbackUrl.toString()
        });
      }
    } catch (err) {
      logger.warn('Failed to send callback event', {
        err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private async transcribe({
    jobId,
    source,
    language,
    format,
    model,
    postProcessingPrompt,
    callbackUrl,
    externalId,
    speakerNames
  }: TTranscribeParams): Promise<string> {
    const stagingDir = process.env.STAGING_DIR || '/tmp/';
    const tempFile = join(stagingDir, `${jobId}.mp3`);
    const url = await this.createUrl(source);
    await this.postCallbackEvent(
      'subtitling_started',
      jobId,
      callbackUrl,
      externalId
    );
    const filePaths = await this.convertToMP3(url.toString(), tempFile);
    const allSegments: TSegment[] = [];

    let currentTime = 0;
    for await (const filePath of filePaths) {
      logger.info('Processing chunk', { filePath });
      const actualDuration = getAudioDuration(filePath);
      const segments = await this.transcribeLocalFile({
        filePath,
        language,
        prompt: allSegments[allSegments.length - 1]?.text,
        postProcessingPrompt,
        model,
        speakerNames
      });
      logger.debug('Adjusting timecodes for chunk', { filePath });
      const adjustedSegments = this.adjustSegmentTimecodes(
        segments,
        currentTime
      );
      allSegments.push(...adjustedSegments);

      logger.debug('Deleting chunk', { filePath });
      unlinkSync(filePath);
      currentTime += actualDuration;
    }
    if (fs.existsSync(tempFile)) {
      unlinkSync(tempFile);
      logger.debug('Deleted temp file', { tempFile });
    }
    const effectiveModel = model ?? DEFAULT_TRANSCRIBE_MODEL;
    logger.info('Optimizing segments', {
      model: effectiveModel,
      segmentCount: allSegments.length
    });
    const optimizedSegments = this.optimizeSegments(
      allSegments,
      effectiveModel
    );
    if (format === 'vtt') {
      if (!isWhisperModel(effectiveModel)) {
        formatGenerationTotal.inc({ format: 'vtt', model: effectiveModel });
      }
      return this.formatSegmentsToVTT(optimizedSegments);
    } else if (format === 'srt') {
      if (!isWhisperModel(effectiveModel)) {
        formatGenerationTotal.inc({ format: 'srt', model: effectiveModel });
      }
      return this.formatSegmentsToSRT(optimizedSegments);
    } else if (format === 'json') {
      return JSON.stringify(optimizedSegments);
    } else {
      return allSegments.map((segment) => segment.text).join('\n');
    }
  }

  async transcribeRemoteFile({
    source,
    language,
    format,
    prompt,
    model,
    callbackUrl,
    externalId,
    speakerNames
  }: TTranscribeRemoteFile): Promise<string> {
    this.workerState = State.ACTIVE;
    activeWorkers.inc();
    const jobId = nanoid();
    const effectiveModel = model ?? DEFAULT_TRANSCRIBE_MODEL;
    const effectiveFormat = format ?? 'vtt';
    const startTime = Date.now();
    const jobLog = logger.child({
      jobId,
      workerId: this.instanceId,
      model: effectiveModel,
      format: effectiveFormat
    });

    transcriptionTotal.inc({
      model: effectiveModel,
      format: effectiveFormat,
      endpoint: 'transcribe'
    });
    if (isDiarizeModel(effectiveModel)) {
      diarizationTotal.inc({
        has_known_speakers:
          speakerNames && speakerNames.length > 0 ? 'true' : 'false'
      });
    }

    jobLog.info('Starting transcription job', { source });
    try {
      const fullTranscription = await this.transcribe({
        jobId,
        source,
        language,
        format: effectiveFormat,
        postProcessingPrompt: prompt,
        model,
        callbackUrl,
        externalId,
        speakerNames
      });
      await this.postCallbackEvent(
        'subtitling_completed',
        jobId,
        callbackUrl,
        externalId
      );

      const durationSec = (Date.now() - startTime) / 1000;
      transcriptionDuration.observe(durationSec);
      jobLog.info('Transcription job completed', { durationSec });

      this.workerState = State.INACTIVE;
      activeWorkers.dec();

      if (
        effectiveFormat &&
        ['json', 'verbose_json'].includes(effectiveFormat)
      ) {
        return JSON.stringify(fullTranscription);
      }
      return fullTranscription;
    } catch (err) {
      transcriptionErrors.inc({
        model: effectiveModel,
        error_type: err instanceof TranscribeError ? err.code : 'UNKNOWN'
      });
      jobLog.error('Transcription job failed', {
        err: err instanceof Error ? err.message : 'Unknown error'
      });
      activeWorkers.dec();
      this.workerState = State.INACTIVE;
      throw err;
    }
  }

  async TranscribeRemoteFileS3({
    source,
    language,
    format,
    model,
    prompt,
    bucket,
    key,
    region,
    endpoint,
    callbackUrl,
    externalId,
    speakerNames
  }: TTranscribeRemoteFile & {
    bucket: string;
    key: string;
    region?: string;
    endpoint?: string;
  }): Promise<void> {
    const jobId = nanoid();
    const effectiveModel = model ?? DEFAULT_TRANSCRIBE_MODEL;
    const effectiveFormat = format ?? 'vtt';
    const startTime = Date.now();
    const jobLog = logger.child({
      jobId,
      workerId: this.instanceId,
      model: effectiveModel,
      format: effectiveFormat,
      bucket,
      key
    });

    transcriptionTotal.inc({
      model: effectiveModel,
      format: effectiveFormat,
      endpoint: 'transcribe_s3'
    });
    if (isDiarizeModel(effectiveModel)) {
      diarizationTotal.inc({
        has_known_speakers:
          speakerNames && speakerNames.length > 0 ? 'true' : 'false'
      });
    }

    jobLog.info('Starting S3 transcription job', { source });
    try {
      this.workerState = State.ACTIVE;
      activeWorkers.inc();
      const fullTranscription = await this.transcribe({
        jobId,
        source,
        language,
        format: effectiveFormat,
        postProcessingPrompt: prompt,
        model,
        callbackUrl,
        externalId,
        speakerNames
      });

      let resp = fullTranscription;
      if (['json', 'verbose_json'].includes(effectiveFormat)) {
        resp = JSON.stringify(fullTranscription);
      }
      uploadToS3({
        bucket,
        key,
        format: effectiveFormat,
        region,
        endpoint,
        content: resp
      });
      await this.postCallbackEvent(
        'subtitling_completed',
        jobId,
        callbackUrl,
        externalId
      );

      const durationSec = (Date.now() - startTime) / 1000;
      transcriptionDuration.observe(durationSec);
      jobLog.info('S3 transcription job completed', { durationSec });

      this.workerState = State.INACTIVE;
      activeWorkers.dec();
    } catch (err) {
      jobLog.error('S3 transcription job failed', {
        err: err instanceof Error ? err.message : String(err)
      });
      transcriptionErrors.inc({
        model: effectiveModel,
        error_type:
          err instanceof TranscribeError
            ? (err as TranscribeError).code
            : 'UNKNOWN'
      });
      await this.postCallbackEvent('error', jobId, callbackUrl, externalId);
      this.workerState = State.INACTIVE;
      activeWorkers.dec();
    }
  }
}
