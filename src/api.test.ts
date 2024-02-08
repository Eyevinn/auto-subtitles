import api from './api';

describe('api', () => {
  it('responds with hello, world!', async () => {
    const server = api({ title: '@eyevinn/auto-subtitles' });
    const response = await server.inject({
      method: 'GET',
      url: '/'
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('@eyevinn/auto-subtitles is healthy 💖');
  });
});
