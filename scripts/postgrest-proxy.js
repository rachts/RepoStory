const http = require('http');
const server = http.createServer((req, res) => {
  const targetPath = req.url.replace(/^\/rest\/v1/, '') || '/';
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: 3001,
    path: targetPath,
    method: req.method,
    headers: req.headers
  }, (pRes) => {
    res.writeHead(pRes.statusCode, pRes.headers);
    pRes.pipe(res);
  });
  proxy.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(String(err));
  });
  req.pipe(proxy);
});
server.listen(3002, '127.0.0.1', () => {
  console.log('PostgREST /rest/v1 proxy listening on port 3002');
});
