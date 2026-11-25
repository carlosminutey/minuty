// Serves docs/ locally so you can view the page on your PC: npm run view → http://localhost:5174
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../docs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const port = Number(process.env.PORT || 5174);
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(path.normalize(root))) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  })
  .listen(port, () => console.log(`Viewer: http://localhost:${port}`));
