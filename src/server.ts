import api from './api';
import * as dotenv from 'dotenv';
import logger from './utils/logger';

dotenv.config({ path: '.env' });

const server = api({ title: '@eyevinn/auto-subtitles' });

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

server.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    logger.error('Server failed to start', {
      err: err.message
    });
    throw err;
  }
  logger.info('Server listening', { address, port: PORT });
});

export default server;
