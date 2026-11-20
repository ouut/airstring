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
// The token's RS256 signature is verified against Google's
// securetoken JWKS (aud + iss pinned to FIREBASE_PROJECT); for
// storagePath requests the token's uid must own the recording
// path. This keeps strangers from spending replay compute; the
// verdict itself never trusts the caller either way.
//
// CORS: browsers call /verify cross-origin from the site, so
// OPTIONS preflights are answered and allowlisted origins get
// Access-Control-Allow-Origin on every response (see
// ALLOWED_ORIGINS below).
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

function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json',
    ...(extraHeaders || {}) });
  res.end(body);
}

const REQUIRE_AUTH = process.env.VERIFIER_REQUIRE_AUTH === '1';
const PROJECT = process.env.FIREBASE_PROJECT || '';

/* Firebase ID-token verification against Google's securetoken
 * JWKS (self-contained RS256 check; no reliance on the tokeninfo
 * endpoint's acceptance of securetoken-issued tokens). */
let jwksCache = { keys: null, until: 0 };
async function getJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.until)
    return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/service_accounts' +
    '/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!r.ok) return null;
  const body = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  jwksCache = { keys: body.keys,
    until: Date.now() + (m ? parseInt(m[1], 10) * 1000 : 3600000) };
  return jwksCache.keys;
}

async function checkIdToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !PROJECT) return null;
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString());
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString());
    if (payload.aud !== PROJECT) return null;
    if (payload.iss !== 'https://securetoken.google.com/' + PROJECT)
      return null;
    if (!payload.sub) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now || payload.iat > now + 300) return null;
    const keys = await getJwks();
    if (!keys) return null;
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify('RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]), key,
      Buffer.from(parts[2], 'base64url'));
    return ok ? payload : null; /* payload.sub is the caller's uid */
  } catch (e) { return null; }
}

/* CORS: the site calls /verify cross-origin with an Authorization
 * header, so browsers preflight. Only the project's own origins
 * are allowed; other origins get no CORS headers (browser blocks
 * them; non-browser callers are unaffected either way). */
const ALLOWED_ORIGINS = new Set([
  'https://airstring-nethack.web.app',
  'https://airstring-nethack.firebaseapp.com',
  'https://airstring.org',
  'https://www.airstring.org',
]);
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
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
  const CORS = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  // /health is the production health path: Cloud Run's front end
  // reserves *z paths (/healthz never reaches the container there).
  // /healthz is kept for local use.
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz'))
    return send(res, 200, { ok: true }, CORS);
  if (req.method !== 'POST' || url.pathname !== '/verify')
    return send(res, 404, { error: 'not-found' }, CORS);
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) }, CORS);
  }
  if (REQUIRE_AUTH) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const info = m && await checkIdToken(m[1]);
    if (!info) return send(res, 401, { error: 'unauthorized' }, CORS);
    const payload = parseEnvelope(body);
    if (payload && typeof payload.storagePath === 'string') {
      // Bind caller to their own recordings: recordings/<uid>/...
      const seg = payload.storagePath.split('/');
      if (seg[0] !== 'recordings' || seg[1] !== info.sub)
        return send(res, 403, { error: 'forbidden' }, CORS);
    }
  }
  const payload = parseEnvelope(body);
  let text;
  try {
    text = await recordingFromBody(body);
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) }, CORS);
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
    if (hit) return send(res, 200, { ...hit, idempotent: true }, CORS);
  }
  const verdict = await verifyRecording(text, { root: ROOT });
  if (verdict.verdict === 'verified' && verdict.gameId &&
      process.env.VERIFIER_STORE === 'firestore') {
    try {
      const { uploadPublicRecording } = await import('./gcp.mjs');
      verdict.publicRecordingPath = await uploadPublicRecording(
        verdict.gameId, text, payload && payload.bucket);
    } catch (e) {
      console.error('[verifier] public-recording upload failed:',
        e && e.message || e);
    }
  }
  if (verdict.gameId) await store.put(verdict);
  return send(res, 200, { ...verdict, idempotent: false }, CORS);
});
server.listen(PORT, () => {
  console.log('[verifier] listening on ' + PORT +
    ' root=' + ROOT +
    ' store=' + (process.env.VERIFIER_STORE || 'file'));
});
