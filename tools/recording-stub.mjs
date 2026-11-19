// airstring S5 local backend stub.
//
// One process for the whole S5 gate:
//   * static file server for web/ (the frontend), with the wasm
//     build products (/nethack.js, /nethack.wasm) mapped from the
//     build output directory -- in production (S6) the deploy step
//     copies out/* next to index.html instead;
//   * recording receiver: POST /upload {gameId, seq, final,
//     records:[...]} appends each record as one JSON line to
//     <dataDir>/<gameId>.jsonl (append-only, fsync per chunk);
//   * GET /recordings/<gameId>.jsonl returns the stored stream;
//     GET /recordings lists known game ids.
//
// Usage:
//   node tools/recording-stub.mjs [--port 8377] [--web web]
//        [--build out] [--data recordings]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const PORT = parseInt(arg('port', '8377'), 10);
const WEB = path.resolve(root, arg('web', 'web'));
const BUILD = path.resolve(root, arg('build', 'out'));
const DATA = path.resolve(root, arg('data', 'recordings'));
fs.mkdirSync(DATA, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
};
const GAME_ID_OK = /^[A-Za-z0-9._-]+$/;

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found: ' + file);
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'POST' && p === '/upload') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) {
        return send(res, 400, 'bad json');
      }
      const { gameId, records } = payload;
      if (!gameId || !GAME_ID_OK.test(gameId) || !Array.isArray(records))
        return send(res, 400, 'bad payload');
      const file = path.join(DATA, gameId + '.jsonl');
      const text = records.map((r) => JSON.stringify(r)).join('\n');
      const fd = fs.openSync(file, 'a');
      if (text) fs.writeSync(fd, text + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      send(res, 200, JSON.stringify({ ok: true, appended: records.length }),
        'application/json');
    });
    return;
  }
  if (req.method === 'GET' && p === '/recordings') {
    const ids = fs.readdirSync(DATA)
      .filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
    return send(res, 200, JSON.stringify(ids), 'application/json');
  }
  if (req.method === 'GET' && p.startsWith('/recordings/')) {
    const id = p.slice('/recordings/'.length).replace(/\.jsonl$/, '');
    if (!GAME_ID_OK.test(id)) return send(res, 400, 'bad id');
    return serveFile(res, path.join(DATA, id + '.jsonl'));
  }
  if (req.method === 'GET') {
    if (p === '/nethack.js') return serveFile(res, path.join(BUILD, 'nethack.js'));
    if (p === '/nethack.wasm') return serveFile(res, path.join(BUILD, 'nethack.wasm'));
    const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB)) return send(res, 403, 'forbidden');
    return serveFile(res, file);
  }
  send(res, 405, 'method not allowed');
});
server.listen(PORT, () => {
  console.log(`[stub] http://127.0.0.1:${PORT}/  web=${WEB} build=${BUILD} data=${DATA}`);
});
