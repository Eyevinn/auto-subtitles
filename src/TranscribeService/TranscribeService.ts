import { OpenAI } from 'openai';
import Configuration from 'openai';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import { signUrl, uploadToS3 } from '../aws/upload';
import fs, { unlinkSync } from 'fs';
import { join } from 'path';
import { getAudioDuration, splitAudioOnSilence } from '../audio/chunker';

export enum State {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE'
}
export type TTranscribeFormat =
  | 'json'
  | 'text'
  | 'srt'
  | 'verbose_json'
  | 'vtt';

export type TTranscribeLocalFile = {
  filePath: string;
  language?: string; // language code in ISO 639-1 format
  format?: TTranscribeFormat;
  prompt?: string;
};

export type TTranscribeRemoteFile = {
  source: string;
  language?: string; // language code in ISO 639-1 format
  format?: TTranscribeFormat;
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

  private convertToMP3(videoUrl: string): Promise<string[]> {
    const stagingDir = process.env.STAGING_DIR || '/tmp/';
    const tempFile = join(stagingDir, `${nanoid()}.mp3`);

    return new Promise((resolve, reject) => {
      console.log(`Converting ${videoUrl} to ${tempFile}`);
      const ffmpeg = spawn('ffmpeg', ['-i', videoUrl, '-f', 'mp3', tempFile]);
      ffmpeg.on('close', async () => {
        try {
          console.log(`Conversion compleded. Now splitting into chunks...`);
          const chunks = await splitAudioOnSilence(tempFile);
          unlinkSync(tempFile);
          resolve(chunks);
        } catch (error) {
          reject(error);
        }
      });
      ffmpeg.on('error', (err) => {
        console.error('Error:', err);
        reject(err);
      });
    });
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
    format,
    prompt
  }: TTranscribeLocalFile): Promise<string> {
    try {
      const response_format = format ?? 'vtt';
      const resp = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1',
        response_format,
        language: language ?? 'en',
        prompt: prompt ?? undefined
      });
      if (!resp.text) {
        return resp as unknown as string;
      }
      return resp.text;
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

  private async transcribe({
    source,
    language,
    format
  }: TTranscribeRemoteFile): Promise<string> {
    const url = await this.createUrl(source);
    const filePaths = await this.convertToMP3(url.toString());
    const allSegments: TSegment[] = [];

    let currentTime = 0;
    for (const filePath of filePaths) {
      const actualDuration = await getAudioDuration(filePath);
      const chunkTranscription = await this.transcribeLocalFile({
        filePath,
        language,
        format: 'vtt',
        prompt: allSegments[allSegments.length - 1]?.text
      });
      const segments = this.parseVTTToSegments(chunkTranscription);
      const adjustedSegments = this.adjustSegmentTimecodes(
        segments,
        currentTime
      );
      allSegments.push(...adjustedSegments);

      unlinkSync(filePath);
      console.log(`Deleted chunk ${filePath}`);
      currentTime += actualDuration;
    }
    if (format === 'vtt') {
      return this.formatSegmentsToVTT(allSegments);
    } else if (format === 'srt') {
      return this.formatSegmentsToSRT(allSegments);
    } else if (format === 'json') {
      return JSON.stringify(allSegments);
    } else {
      return allSegments.map((segment) => segment.text).join('\n');
    }
  }

  async transcribeRemoteFile({
    source,
    language,
    format
  }: TTranscribeRemoteFile): Promise<string> {
    this.workerState = State.ACTIVE;
    const fullTranscription = await this.transcribe({
      source,
      language,
      format
    });
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
    bucket,
    key,
    region,
    endpoint
  }: TTranscribeRemoteFile & {
    bucket: string;
    key: string;
    region?: string;
    endpoint?: string;
  }): Promise<void> {
    try {
      this.workerState = State.ACTIVE;
      const fullTranscription = await this.transcribe({
        source,
        language,
        format
      });

      let resp = fullTranscription;
      if (format && ['json', 'verbose_json'].includes(format)) {
        resp = JSON.stringify(fullTranscription);
      }
      if (!format) {
        format = 'vtt';
      }
      uploadToS3({
        bucket,
        key,
        format,
        region,
        endpoint,
        content: resp
      });
      this.workerState = State.INACTIVE;
    } catch (err) {
      console.error(err);
      this.workerState = State.INACTIVE;
    }
  }
}
