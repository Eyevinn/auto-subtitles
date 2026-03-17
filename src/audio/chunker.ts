import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { statSync } from 'fs';
import { nanoid } from 'nanoid';
import { join } from 'path';
import logger from '../utils/logger';

const execFileAsync = promisify(execFile);
const MAX_CHUNK_SIZE = 25 * 1024 * 1024; // 25MB

export async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-i',
    filePath,
    '-show_entries',
    'format=duration',
    '-v',
    'quiet',
    '-of',
    'csv=p=0'
  ]);
  return parseFloat(stdout.trim());
}

export async function splitAudioOnSilence(
  inputFile: string
): Promise<string[]> {
  const stagingDir = process.env.STAGING_DIR || '/tmp/';
  const chunkId = nanoid();
  const baseOutputFile = join(stagingDir, `${chunkId}_chunk_%03d.mp3`);

  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-i',
      inputFile,
      '-af',
      'silencedetect=noise=-30dB:d=2',
      '-f',
      'null',
      '-'
    ]);

    const silences = stderr
      .split('\n')
      .filter((line) => line.includes('silence_end'))
      .map((line) => {
        const match = line.match(/silence_end: ([\d.]+)/);
        return match ? parseFloat(match[1]) : null;
      })
      .filter((time): time is number => time !== null);

    const duration = await getAudioDuration(inputFile);
    if (silences.length > 0 && silences[silences.length - 1] > duration - 2) {
      logger.info('Ignoring silence at the end of the audio file');
      silences.pop();
    }

    if (silences.length === 0) {
      const stats = statSync(inputFile);
      if (stats.size <= MAX_CHUNK_SIZE) {
        return [inputFile];
      }
      const chunks = Math.ceil(stats.size / MAX_CHUNK_SIZE);
      const chunkDuration = duration / chunks;

      await execFileAsync('ffmpeg', [
        '-i',
        inputFile,
        '-f',
        'segment',
        '-segment_time',
        String(chunkDuration),
        '-c',
        'copy',
        baseOutputFile
      ]);
    } else {
      const segmentTimes = silences.join(',');

      await execFileAsync('ffmpeg', [
        '-i',
        inputFile,
        '-f',
        'segment',
        '-segment_times',
        segmentTimes,
        '-c',
        'copy',
        baseOutputFile
      ]);
    }

    const chunkPrefix = `${chunkId}_chunk_`;
    const files = await fs.promises.readdir(stagingDir);
    const chunkFiles = files
      .filter((f) => f.startsWith(chunkPrefix) && f.endsWith('.mp3'))
      .sort()
      .map((f) => join(stagingDir, f));

    return chunkFiles;
  } catch (error) {
    logger.error('Error splitting audio', {
      err: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
