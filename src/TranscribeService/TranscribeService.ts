import { OpenAIApi, Configuration, CreateTranscriptionResponse } from 'openai';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import fs from 'fs';

export enum State {
  IDLE = 'IDLE',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE'
}

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

  async transcribeLocalFile(
    filePath: string
  ): Promise<CreateTranscriptionResponse> {
    try {
      const resp = await this.openai.createTranscription(
        fs.createReadStream(filePath) as unknown,
        'whisper-1',
        undefined,
        'vtt',
        1,
        'en'
      );
      return resp.data;
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  async transcribeRemoteFile(
    url: string
  ): Promise<CreateTranscriptionResponse> {
    this.jobState = State.ACTIVE;
    const path = await this.convertToMP3(url);
    const resp = await this.transcribeLocalFile(path);
    // delete local file when done transcribing path is path
    fs.unlinkSync(path);
    console.log(`Deleted ${path}`);
    this.jobState = State.INACTIVE;
    return resp;
  }
}
