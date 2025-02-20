import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';

export type TContent =
  | string
  | Readable
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
  endpoint?: string;
};

export type TSignS3Url = {
  url: URL;
  region?: string;
  endpoint?: string;
};

export async function uploadToS3({
  content,
  bucket,
  key,
  format,
  region,
  endpoint
}: TUploadToS3): Promise<void> {
  let fileFormat = 'txt';
  if (['json', 'verbose_json'].includes(format)) {
    fileFormat = 'json';
  } else if (format === 'srt') {
    fileFormat = 'srt';
  } else if (format === 'vtt') {
    fileFormat = 'vtt';
  }
  const customEndpoint = endpoint ?? process.env.AWS_S3_ENDPOINT;
  const client = new S3Client({
    region: region ?? process.env.AWS_REGION,
    forcePathStyle: customEndpoint ? true : false,
    endpoint: customEndpoint
  });
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

export async function signUrl({
  url,
  region,
  endpoint
}: TSignS3Url): Promise<URL> {
  const customEndpoint = endpoint ?? process.env.AWS_S3_ENDPOINT;
  const client = new S3Client({
    region: region ?? process.env.AWS_REGION,
    forcePathStyle: customEndpoint ? true : false,
    endpoint: customEndpoint
  });
  const command = new GetObjectCommand({
    Bucket: url.hostname,
    Key: url.pathname.slice(1)
  });
  const signedUrl = await getSignedUrl(client, command, { expiresIn: 3600 });
  return new URL(signedUrl);
}
