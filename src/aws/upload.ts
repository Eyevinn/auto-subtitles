import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';

export type TContent =
  | string
  | Readable
  | ReadableStream
  | Blob
  | Uint8Array
  | Buffer
  | undefined;

export type TTranscribeFormat =
  | 'json'
  | 'text'
  | 'srt'
  | 'verbose_json'
  | 'vtt';

export type TUploadToS3 = {
  content: TContent;
  bucket: string;
  key: string;
  format: TTranscribeFormat;
  region?: string;
};

export async function uploadToS3({
  content,
  bucket,
  key,
  format,
  region
}: TUploadToS3): Promise<void> {
  let fileFormat = 'txt';
  if (['json', 'verbose_json'].includes(format)) {
    fileFormat = 'json';
  } else if (format === 'srt') {
    fileFormat = 'srt';
  } else if (format === 'vtt') {
    fileFormat = 'vtt';
  }
  const client = new S3Client({ region: region ?? process.env.AWS_REGION });
  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: `${key}.${fileFormat}`, Body: content }
  });
  const round = (percent: number) => Math.round(percent * 100) / 100;
  upload.on('httpUploadProgress', (progress) => {
    const percent =
      progress.loaded && progress.total
        ? round((progress.loaded / progress.total) * 100)
        : 0;
    console.log(`Uploading: ${percent}%`);
  });
  await upload.done();
}
