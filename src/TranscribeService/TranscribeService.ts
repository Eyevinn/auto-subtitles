import { OpenAI } from 'openai';
import Configuration from 'openai';
import { execSync } from 'child_process';
import { nanoid } from 'nanoid';
import { signUrl, uploadToS3 } from '../aws/upload';
import fs, { statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getAudioDuration, splitAudioOnSilence } from '../audio/chunker';
import { TranscriptionVerbose } from 'openai/resources/audio/transcriptions';

export type TEvent = 'subtitling_started' | 'subtitling_completed' | 'error';
export enum State {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE'
}
export type TTranscribeFormat = 'srt' | 'vtt';

export type TTranscribeModel = 'whisper-1';

export type TTranscribeLocalFile = {
  filePath: string;
  language?: string; // language code in ISO 639-1 format
  prompt?: string;
  postProcessingPrompt?: string; // Optional prompt to guide transcription
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
  externalId?: string; // Optional external ID for tracking
};

export type TTranscribeRemoteFile = {
  source: string;
  language?: string; // language code in ISO 639-1 format
  format?: TTranscribeFormat;
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
  externalId?: string; // Optional external ID for tracking
  prompt?: string; // Optional prompt to guide transcription
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
};

type TSegment = {
  start: number;
  end: number;
  text: string;
};

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
      console.log(`Converting ${videoUrl} to ${tempFile}`);
      execSync(`ffmpeg -i "${videoUrl}" -f mp3 "${tempFile}"`);
      console.log(`Conversion completed. Now splitting into chunks...`);
      if (!statSync(tempFile).isFile()) {
        throw new Error('Error converting video, temp file not found');
      }
      const chunks = splitAudioOnSilence(tempFile);
      console.log(`Splitted into ${chunks.length} chunks`);
      return chunks;
    } catch (error) {
      console.error(error);
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

  async transcribeLocalFile({
    filePath,
    language,
    prompt,
    postProcessingPrompt,
    model
  }: TTranscribeLocalFile): Promise<TSegment[]> {
    try {
      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: model ?? 'whisper-1',
        response_format: 'verbose_json',
        language: language ?? 'en',
        prompt: prompt ?? undefined,
        timestamp_granularities: ['word']
      });

      const resp = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: model ?? 'whisper-1',
        response_format: 'vtt',
        language: language ?? 'en',
        prompt: prompt ?? undefined
      });
      console.log(`Transcription completed for chunk ${filePath}`);
      let processedText = resp;
      if (postProcessingPrompt) {
        console.log(
          `Applying post-processing prompt to transcription for chunk ${filePath}`
        );
        const postProcessingResponse =
          await this.openai.chat.completions.create({
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
          console.log('Updating VTT text in transcription');
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
            console.log('Updating words in transcription');
            // Remove any ```json``` code block formatting and unexpected non-whitespace characters
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
              console.log(
                'Error parsing post-processed transcription words JSON:',
                e
              );
              console.log(
                postProcessingTranscription.choices[0].message.content
              );
            }
          }
        }
      }
      const segments = this.parseVTTToSegments(processedText, transcription);
      return segments;
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  private parseVTTToSegments(
    vtt: string,
    transcription: TranscriptionVerbose
  ): TSegment[] {
    const lines = vtt.split('\n');
    const segments: TSegment[] = [];
    let currentSegment: Partial<TSegment> = {};

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
          segments.push(currentSegment as TSegment);
          currentSegment = {};
        } else {
          console.warn(
            `Segment start time is NaN for line: "${line.trim()}", skipping segment.`
          );
        }
      }
    }
    let intervalStart = segments[0]?.start ?? 0;
    for (const segment of segments) {
      if (segment.start < intervalStart) {
        const diff = intervalStart - segment.start;
        segment.start = intervalStart;
        segment.end += diff;
      }
      // Find words within the segment
      const words = transcription.words?.filter((word) => {
        return word.start >= intervalStart && word.end <= intervalStart + 15;
      });
      if (words && words.length > 0) {
        // Update segment start time to the first word's start time
        const segmentWords = segment.text.split(' ');
        const wordIndex = words.findIndex(
          (word) => word.word === segmentWords[0].replace(/[,!?]/g, '')
        );
        if (wordIndex !== -1) {
          let j = 0;
          let numMatchedWords = 1;
          for (let i = wordIndex; i < words.length - 1; i++) {
            if (segmentWords[j + 1] === words[i + 1].word) {
              numMatchedWords++;
            } else {
              break;
            }
            j++;
          }
          if (numMatchedWords > 2) {
            const diff = words[wordIndex].start - segment.start;
            segment.start = words[wordIndex].start;
            segment.end += diff;
            console.log(
              `Adjusted segment start time to ${segment.start} and end time to ${segment.end} for text: "${segment.text}"`
            );
          } else {
            console.log(
              `Only ${numMatchedWords} words matched, not adjusting start time. Keep original start time ${segment.start} and end time ${segment.end} for "${segment.text}".`
            );
          }
        } else {
          console.warn(
            `First word of "${segment.text}" not found in words, keep original start time ${segment.start} and end time ${segment.end}.`
          );
        }
      } else {
        console.warn(
          `No words found for segment with text: "${segment.text}" between ${segment.start} and ${segment.end}. Using first word start time.`
        );
        const diff = transcription.words?.[0]?.start ?? 0 - segment.start;
        segment.start = transcription.words?.[0]?.start ?? segment.start;
        segment.end += diff;
        console.log(
          `Adjusted segment start time to ${segment.start} and end time to ${segment.end} for text: "${segment.text}"`
        );
      }
      intervalStart = segment.end;
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

  private optimizeSegments(segments: TSegment[]): TSegment[] {
    const optimized: TSegment[] = [];
    const MIN_DURATION = 1.5; // 1.5 second
    const MAX_DURATION = 7.0; // 7 seconds
    const MAX_CHARS_PER_LINE = 42;
    const CHARS_PER_SECOND = 12;

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

      const text = lines.join('\n');
      const duration = segment.end - segment.start;

      // Adjust timing based on text length and reading speed
      const requiredDuration = text.length / CHARS_PER_SECOND;
      const newDuration = Math.min(
        MAX_DURATION,
        Math.max(MIN_DURATION, requiredDuration)
      );

      if (duration < newDuration && optimized.length > 0) {
        // Try to extend previous segment's duration
        const prev = optimized[optimized.length - 1];
        const gap = segment.start - prev.end;
        if (gap < 0.5) {
          // If segments are close enough
          prev.end = Math.min(segment.start, prev.start + MAX_DURATION);
        }
      }

      optimized.push({
        start: segment.start,
        end: Math.min(segment.start + newDuration, segment.end),
        text
      });
    }

    return this.mergeShortSegments(optimized);
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
      const nextDuration = segment.end - segment.start;
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
        console.warn(
          `Callback to ${callbackUrl} failed with status ${response.status}`
        );
      } else {
        console.log(`Event ${eventType} sent to ${callbackUrl}`);
      }
    } catch (err) {
      console.warn('Failed to send event', err);
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
    externalId
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
      console.log(`Processing chunk ${filePath}`);
      const actualDuration = getAudioDuration(filePath);
      const segments = await this.transcribeLocalFile({
        filePath,
        language,
        prompt: allSegments[allSegments.length - 1]?.text,
        postProcessingPrompt,
        model
      });
      console.log(`Adjusting timecodes for chunk ${filePath}`);
      const adjustedSegments = this.adjustSegmentTimecodes(
        segments,
        currentTime
      );
      allSegments.push(...adjustedSegments);

      console.log(`Deleting chunk ${filePath}`);
      unlinkSync(filePath);
      console.log(`Deleted chunk ${filePath}`);
      currentTime += actualDuration;
    }
    if (fs.existsSync(tempFile)) {
      unlinkSync(tempFile);
      console.log(`Deleted temp file ${tempFile}`);
    }
    console.log(`Optimizing segments...`);
    const optimizedSegments = this.optimizeSegments(allSegments);
    if (format === 'vtt') {
      return this.formatSegmentsToVTT(optimizedSegments);
    } else if (format === 'srt') {
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
    externalId
  }: TTranscribeRemoteFile): Promise<string> {
    this.workerState = State.ACTIVE;
    const jobId = nanoid();

    if (!format) {
      format = 'vtt';
    }

    const fullTranscription = await this.transcribe({
      jobId,
      source,
      language,
      format,
      postProcessingPrompt: prompt,
      model,
      callbackUrl,
      externalId
    });
    await this.postCallbackEvent(
      'subtitling_completed',
      jobId,
      callbackUrl,
      externalId
    );
    this.workerState = State.INACTIVE;

    if (format && ['json', 'verbose_json'].includes(format)) {
      return JSON.stringify(fullTranscription);
    }
    return fullTranscription;
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
    externalId
  }: TTranscribeRemoteFile & {
    bucket: string;
    key: string;
    region?: string;
    endpoint?: string;
  }): Promise<void> {
    const jobId = nanoid();
    try {
      this.workerState = State.ACTIVE;
      if (!format) {
        format = 'vtt';
      }
      const fullTranscription = await this.transcribe({
        jobId,
        source,
        language,
        format,
        postProcessingPrompt: prompt,
        model,
        callbackUrl,
        externalId
      });

      let resp = fullTranscription;
      if (format && ['json', 'verbose_json'].includes(format)) {
        resp = JSON.stringify(fullTranscription);
      }
      uploadToS3({
        bucket,
        key,
        format,
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
      this.workerState = State.INACTIVE;
    } catch (err) {
      console.error(err);
      await this.postCallbackEvent('error', jobId, callbackUrl, externalId);
      this.workerState = State.INACTIVE;
    }
  }
}
