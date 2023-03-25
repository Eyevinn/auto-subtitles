import api from './api';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env' });

const server = api({ title: '@eyevinn/subtitle-generator' });

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

server.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    throw err;
  }
  console.log(`Server listening on ${address}`);
});

export default server;
