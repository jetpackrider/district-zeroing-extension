#!/usr/bin/env node
/**
 * Static server for development and tests. Binds 127.0.0.1 only; picks a free port unless --port.
 *
 *   /            fixture/www (the fake DRA page)
 *   /vendor/     maplibre-gl dist files
 *   /data/       bundle directory (default fixture/data; --data ../../data serves the real pipeline output)
 *
 * Bundle files are served as raw bytes (no Content-Encoding) with CORS, like R2.
 * Prints one JSON line {"url": "..."} on stdout once listening.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const port = Number(opt('port', '0'));
const dataDir = resolve(root, opt('data', 'fixture/data'));
const mounts = [
  ['/vendor/', join(root, 'node_modules/maplibre-gl/dist')],
  ['/data/', dataDir],
  ['/', join(root, 'fixture/www')],
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.gz': 'application/octet-stream', '.map': 'application/json' };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const [prefix, dir] = mounts.find(([p]) => url.pathname.startsWith(p));
  let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
  const file = normalize(join(dir, rel));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': prefix === '/data/' && !file.endsWith('manifest.json') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => {
  const { port: p } = server.address();
  process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${p}`, data: `http://127.0.0.1:${p}/data/` }) + '\n');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
