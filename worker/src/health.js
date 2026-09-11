export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('RV Upload Service OK', {
        headers: {'content-type': 'text/plain; charset=utf-8'},
      });
    }
    return new Response('RV upload is not enabled yet.', {
      status: 503,
      headers: {'content-type': 'text/plain; charset=utf-8'},
    });
  },
};
