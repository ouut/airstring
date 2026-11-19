// airstring S6 verification worker (Cloud Run).
//
//   POST /verify
//     body (any of):
//       * a recording as JSONL text
//         (content-type text/plain or application/x-ndjson, or a
//         JSON body {"recording": "<jsonl>"})
//       * {"storagePath": "recordings/<uid>/<gameId>.jsonl",
//          "bucket": "<optional>"}
//         fetched from Cloud Storage with the worker's service
//         account (see gcp.mjs; needs STORAGE_BUCKET or the
//         project default bucket)
//     response: the verdict object (see verify.mjs), plus
//       "idempotent": true when the verdict came from the store
//       instead of a fresh replay.
//   GET /health -> {"ok": true}   (/healthz kept for local use;
//     Cloud Run's front end reserves *z paths in production)
//
// Auth (optional): with VERIFIER_REQUIRE_AUTH=1, POST /verify
// requires an `Authorization: Bearer <Firebase ID token>` header.
// The token is validated against Google's tokeninfo endpoint
// (aud + iss pinned to FIREBASE_PROJECT); for storagePath
// requests the token's uid must own the recording path. This
// keeps strangers from spending replay compute; the verdict
// itself never trusts the caller either way.
//
// Environment:
//   PORT             listen port (Cloud Run injects it; def. 8080)
//   AIRSTRING_ROOT   repo tree holding tools/ + out/ (default:
//                    the parent directory of verifier/)
//   VERIFIER_STORE   file | memory | firestore   (default file)
//   VERDICT_FILE     file store path (default ./.verdicts.json)
//   FIREBASE_PROJECT Firestore/Storage project (firestore store)
//   STORAGE_BUCKET   default bucket for storagePath requests
//   VERIFIER_REQUIRE_AUTH  '1' to require a Firebase ID token
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { verifyRecording } from './verify.mjs';
import { createStore } from './store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.AIRSTRING_ROOT || path.resolve(here, '..');
const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_BODY = 16 * 1024 * 1024;

const store = await createStore();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

const REQUIRE_AUTH = process.env.VERIFIER_REQUIRE_AUTH === '1';
const PROJECT = process.env.FIREBASE_PROJECT || '';

async function checkIdToken(token) {
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo' +
      '?id_token=' + encodeURIComponent(token));
    if (!r.ok) return null;
    const info = await r.json();
    if (!PROJECT || info.aud !== PROJECT) return null;
    if (info.iss !== 'https://securetoken.google.com/' + PROJECT)
      return null;
    return info; /* info.sub is the caller's uid */
  } catch (e) { return null; }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body-too-large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseEnvelope(body) {
  // Envelope detection: a JSON envelope is a SINGLE JSON value
  // carrying recording/storagePath. A JSONL recording also starts
  // with '{' (every line does), so only a successful whole-body
  // parse with one of those keys counts as an envelope; anything
  // else is treated as recording text and judged by the parser.
  try {
    const payload = JSON.parse(body);
    if (payload && typeof payload === 'object' &&
        (typeof payload.recording === 'string' ||
         typeof payload.storagePath === 'string'))
      return payload;
  } catch (e) { /* not a single JSON value: it is JSONL text */ }
  return null;
}

async function recordingFromBody(body) {
  const payload = parseEnvelope(body);
  if (payload) {
    if (typeof payload.recording === 'string')
      return payload.recording;
    if (typeof payload.storagePath === 'string') {
      const { fetchStorageObject } = await import('./gcp.mjs');
      return await fetchStorageObject(payload.storagePath,
        payload.bucket);
    }
  }
  return body;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // /health is the production health path: Cloud Run's front end
  // reserves *z paths (/healthz never reaches the container there).
  // /healthz is kept for local use.
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz'))
    return send(res, 200, { ok: true });
  if (req.method !== 'POST' || url.pathname !== '/verify')
    return send(res, 404, { error: 'not-found' });
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
  if (REQUIRE_AUTH) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const info = m && await checkIdToken(m[1]);
    if (!info) return send(res, 401, { error: 'unauthorized' });
    const payload = parseEnvelope(body);
    if (payload && typeof payload.storagePath === 'string') {
      // Bind caller to their own recordings: recordings/<uid>/...
      const seg = payload.storagePath.split('/');
      if (seg[0] !== 'recordings' || seg[1] !== info.sub)
        return send(res, 403, { error: 'forbidden' });
    }
  }
  let text;
  try {
    text = await recordingFromBody(body);
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  // Idempotency: the gameId is only known after parsing, so the
  // cheap pre-check uses the header line alone.
  let gameId = null;
  try {
    const first = JSON.parse(text.split('\n').find((l) => l.trim()));
    if (first && first.k === 'header') gameId = first.gameId;
  } catch (e) { /* fall through: full verify reports the problem */ }
  if (gameId) {
    const hit = await store.get(gameId, sha);
    if (hit) return send(res, 200, { ...hit, idempotent: true });
  }
  const verdict = await verifyRecording(text, { root: ROOT });
  if (verdict.gameId) await store.put(verdict);
  return send(res, 200, { ...verdict, idempotent: false });
});
server.listen(PORT, () => {
  console.log('[verifier] listening on ' + PORT +
    ' root=' + ROOT +
    ' store=' + (process.env.VERIFIER_STORE || 'file'));
});
