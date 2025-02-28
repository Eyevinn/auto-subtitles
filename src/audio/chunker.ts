import { execSync } from 'child_process';
import { statSync } from 'fs';
import { nanoid } from 'nanoid';
import { join } from 'path';

const MAX_CHUNK_SIZE = 25 * 1024 * 1024; // 25MB

export function getAudioDuration(filePath: string) {
  const output = execSync(
    `ffprobe -i "${filePath}" -show_entries format=duration -v quiet -of csv="p=0"`
  );
  return parseFloat(output.toString().trim());
}

export function splitAudioOnSilence(inputFile: string) {
  const stagingDir = process.env.STAGING_DIR || '/tmp/';
  const baseOutputFile = join(stagingDir, `${nanoid()}_chunk_%03d.mp3`);

  try {
    // First, detect silence periods
    const output = execSync(
      `ffmpeg -i "${inputFile}" -af silencedetect=noise=-30dB:d=2 -f null - 2>&1`
    );

    // Parse silence periods
    const silences = output
      .toString()
      .split('\n')
      .filter((line) => line.includes('silence_end'))
      .map((line) => {
        const match = line.match(/silence_end: ([\d.]+)/);
        return match ? parseFloat(match[1]) : null;
      })
      .filter((time): time is number => time !== null);

    // If no silences found or file is small enough, return original file
    if (silences.length === 0) {
      const stats = statSync(inputFile);
      if (stats.size <= MAX_CHUNK_SIZE) {
        return [inputFile];
      }
      // If no silences found but file is too big, split in equal chunks
      const duration = getAudioDuration(inputFile);
      const chunks = Math.ceil(stats.size / MAX_CHUNK_SIZE);
      const chunkDuration = duration / chunks;

      execSync(
        `ffmpeg -i "${inputFile}" -f segment -segment_time ${chunkDuration} -c copy "${baseOutputFile}"`
      );
    } else {
      // Split on silence points
      let segments = '';
      silences.forEach((time, index) => {
        segments += `${time},`;
      });

      execSync(
        `ffmpeg -i "${inputFile}" -f segment -segment_times ${segments.slice(
          0,
          -1
        )} -c copy "${baseOutputFile}"`
      );
    }

    // Get list of created chunks
    const chunksPattern = baseOutputFile.replace('%03d', '*');
    const lsOutput = execSync(`ls ${chunksPattern}`);
    return lsOutput.toString().trim().split('\n');
  } catch (error) {
    console.error('Error splitting audio:', error);
    throw error;
  }
}
