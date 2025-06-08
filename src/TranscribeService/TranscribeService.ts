import { OpenAI } from 'openai';
import Configuration from 'openai';
import { execSync } from 'child_process';
import { nanoid } from 'nanoid';
import { signUrl, uploadToS3 } from '../aws/upload';
import fs, { statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getAudioDuration, splitAudioOnSilence } from '../audio/chunker';

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
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
};

export type TTranscribeRemoteFile = {
  source: string;
  language?: string; // language code in ISO 639-1 format
  format?: TTranscribeFormat;
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
};

export type TTranscribeParams = {
  jobId: string; // Unique job ID for tracking
  source: string;
  language?: string; // language code in ISO 639-1 format
  format?: TTranscribeFormat;
  model?: TTranscribeModel; // Model to use for transcription, default is 'whisper-1'
  callbackUrl?: URL; // Optional callback URL to send events to
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
    model
  }: TTranscribeLocalFile): Promise<TSegment[]> {
    try {
      const resp = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: model ?? 'whisper-1',
        response_format: 'vtt',
        language: language ?? 'en',
        prompt: prompt ?? undefined
      });
      console.log(`Transcription completed for chunk ${filePath}`);
      const segments = this.parseVTTToSegments(resp);
      return segments;
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  private parseVTTToSegments(vtt: string): TSegment[] {
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
        segments.push(currentSegment as TSegment);
        currentSegment = {};
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
    callbackUrl?: URL
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
          timestamp: new Date().toISOString()
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
    callbackUrl
  }: TTranscribeParams): Promise<string> {
    const stagingDir = process.env.STAGING_DIR || '/tmp/';
    const tempFile = join(stagingDir, `${jobId}.mp3`);
    const url = await this.createUrl(source);
    await this.postCallbackEvent('subtitling_started', jobId, callbackUrl);
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
    model,
    callbackUrl
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
      model,
      callbackUrl
    });
    await this.postCallbackEvent('subtitling_completed', jobId, callbackUrl);
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
    bucket,
    key,
    region,
    endpoint,
    callbackUrl
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
        model,
        callbackUrl
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
      await this.postCallbackEvent('subtitling_completed', jobId, callbackUrl);
      this.workerState = State.INACTIVE;
    } catch (err) {
      console.error(err);
      await this.postCallbackEvent('error', jobId, callbackUrl);
      this.workerState = State.INACTIVE;
    }
  }
}
