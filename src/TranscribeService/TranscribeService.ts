import { OpenAIApi, Configuration, CreateTranscriptionResponse } from 'openai';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
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
  private jobState: State;
  private openai: OpenAIApi;

  constructor(openApiKey?: string) {
    this.instanceId = nanoid();
    this.jobState = State.INACTIVE;
    const config = new Configuration({
      apiKey: openApiKey ? openApiKey : process.env.OPENAI_API_KEY
    });
    this.openai = new OpenAIApi(config);
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
    return this.jobState;
  }

  set state(status: State) {
    this.jobState = status;
  }

  async transcribeLocalFile({
    filePath,
    language,
    format
  }: TTranscribeLocalFile): Promise<CreateTranscriptionResponse> {
    try {
      const resp = await this.openai.createTranscription(
        fs.createReadStream(filePath) as unknown,
        'whisper-1',
        undefined,
        format ?? 'vtt',
        1,
        language ?? 'en'
      );
      return resp.data;
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  async transcribeRemoteFile({
    url,
    language,
    format
  }: TTranscribeRemoteFile): Promise<CreateTranscriptionResponse> {
    this.jobState = State.ACTIVE;
    const filePath = await this.convertToMP3(url);
    const resp = await this.transcribeLocalFile({ filePath, language, format });
    // TODO: Find a way to not be dependent on the need to download the file locally
    // delete local file when done transcribing path is path
    fs.unlinkSync(filePath);
    console.log(`Deleted ${filePath}`);
    this.jobState = State.INACTIVE;
    if (format && ['json', 'verbose_json'].includes(format)) {
      return JSON.stringify(resp) as unknown as CreateTranscriptionResponse;
    }
    return resp;
  }
}
