import { OpenAI } from 'openai';
import Configuration from 'openai';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import { uploadToS3 } from '../aws/upload';
import fs from 'fs';

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
};

export type TTranscribeRemoteFile = {
  url: string;
  language?: string; // language code in ISO 639-1 format
  format?: TTranscribeFormat;
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

  private convertToMP3(videoUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const path = `./${nanoid()}.mp3`;
      const ffmpeg = spawn('ffmpeg', ['-i', videoUrl, '-f', 'mp3', '-']);
      const mp3Stream = fs.createWriteStream(path);
      ffmpeg.stdout.pipe(mp3Stream);
      ffmpeg.on('close', () => {
        resolve(path);
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

  async transcribeLocalFile({
    filePath,
    language,
    format
  }: TTranscribeLocalFile): Promise<string> {
    try {
      const resp = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1',
        response_format: format ?? 'vtt',
        language: language ?? 'en'
      });
      return resp.text;
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  async transcribeRemoteFile({
    url,
    language,
    format
  }: TTranscribeRemoteFile): Promise<string> {
    this.workerState = State.ACTIVE;
    const filePath = await this.convertToMP3(url);
    const resp = await this.transcribeLocalFile({ filePath, language, format });
    // TODO: Find a way to not be dependent on the need to download the file locally
    // delete local file when done transcribing path is path
    fs.unlinkSync(filePath);
    console.log(`Deleted ${filePath}`);
    this.workerState = State.INACTIVE;
    if (format && ['json', 'verbose_json'].includes(format)) {
      return JSON.stringify(resp);
    }
    return resp;
  }

  async TranscribeRemoteFileS3({
    url,
    language,
    format,
    bucket,
    key,
    region
  }: TTranscribeRemoteFile & {
    bucket: string;
    key: string;
    region?: string;
  }): Promise<void> {
    try {
      this.workerState = State.ACTIVE;
      const filePath = await this.convertToMP3(url);
      let resp = await this.transcribeLocalFile({ filePath, language, format });
      if (format && ['json', 'verbose_json'].includes(format)) {
        resp = JSON.stringify(resp);
      }
      if (!format) {
        format = 'vtt';
      }
      uploadToS3({
        bucket,
        key,
        format,
        region,
        content: JSON.stringify(resp)
      });
      // TODO: Find a way to not be dependent on the need to download the file locally
      // delete local file when done transcribing path is path
      fs.unlinkSync(filePath);
      console.log(`Deleted ${filePath}`);
      this.workerState = State.INACTIVE;
    } catch (err) {
      console.error(err);
      this.workerState = State.INACTIVE;
    }
  }
}
