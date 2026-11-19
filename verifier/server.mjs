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
//   GET /healthz -> {"ok": true}
//
// Environment:
//   PORT             listen port (Cloud Run injects it; def. 8080)
//   AIRSTRING_ROOT   repo tree holding tools/ + out/ (default:
//                    the parent directory of verifier/)
//   VERIFIER_STORE   file | memory | firestore   (default file)
//   VERDICT_FILE     file store path (default ./.verdicts.json)
//   FIREBASE_PROJECT Firestore/Storage project (firestore store)
//   STORAGE_BUCKET   default bucket for storagePath requests
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

async function recordingFromRequest(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body-too-large');
    chunks.push(c);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  // Envelope detection: a JSON envelope is a SINGLE JSON value
  // carrying recording/storagePath. A JSONL recording also starts
  // with '{' (every line does), so only a successful whole-body
  // parse with one of those keys counts as an envelope; anything
  // else is treated as recording text and judged by the parser.
  try {
    const payload = JSON.parse(body);
    if (payload && typeof payload === 'object' &&
        typeof payload.recording === 'string')
      return payload.recording;
    if (payload && typeof payload === 'object' &&
        typeof payload.storagePath === 'string') {
      const { fetchStorageObject } = await import('./gcp.mjs');
      return await fetchStorageObject(payload.storagePath,
        payload.bucket);
    }
  } catch (e) { /* not a single JSON value: it is JSONL text */ }
  return body;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz')
    return send(res, 200, { ok: true });
  if (req.method !== 'POST' || url.pathname !== '/verify')
    return send(res, 404, { error: 'not-found' });
  let text;
  try {
    text = await recordingFromRequest(req);
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
