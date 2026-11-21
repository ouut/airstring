/* airstring API-1: 10 HTTPS endpoints (Export, Import, Admin Query/Visibility)
 * Implemented on Firebase Cloud Functions v2 (us-central1), backed by Firestore + Cloud Storage.
 * Spec: ops/tasks/API-1-airstring-interfaces.md
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import * as tar from 'tar';

initializeApp();

const db = getFirestore();
const bucket = getStorage().bucket('airstring-nethack.firebasestorage.app');

const AIRSTRING_ADMIN_TOKENS = defineSecret('AIRSTRING_ADMIN_TOKENS');

const REGION = 'us-central1';
const FIXED_DATE = 1700000000;
const BOT_UID = 'ia3yu8PARXcT7d0WSfrpWE2WxxC2';
const BOT_DISPLAY_NAME = 'Beam Search';

const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;       /* 256 MiB compressed tar.gz */
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024; /* 1 GiB extracted safety cap */
const MAX_ENTRIES_COMPLETE = 200;
const MAX_ENTRIES_STUB = 500;
const EXPORT_URL_TTL_MS = 6 * 3600 * 1000;         /* 6 hours */
const RECORDING_URL_TTL_MS = 3600 * 1000;          /* 1 hour */

/* ---------------- error & response helpers ---------------- */
class ApiError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

function sendOk(res, data, status = 200) {
  res.status(status).json({ ok: true, data });
}

function sendErr(res, err) {
  if (err instanceof ApiError) {
    res.status(err.httpStatus).json({
      ok: false,
      error: { code: err.code, message: err.message },
    });
    return;
  }
  console.error('[api1] internal error:', err);
  res.status(500).json({
    ok: false,
    error: { code: 'INTERNAL', message: 'internal server error' },
  });
}

/* ---------------- auth (constant-time X-Admin-Token) ---------------- */
function parseConfiguredTokens(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        return arr.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch (_) { /* fall through */ }
  }
  return [s];
}

function safeEqualStr(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireAdminToken(req) {
  const provided = String(req.get('X-Admin-Token') || '').trim();
  if (!provided) {
    throw new ApiError(401, 'UNAUTHORIZED', 'missing X-Admin-Token header');
  }
  const tokens = parseConfiguredTokens(AIRSTRING_ADMIN_TOKENS.value());
  if (!tokens.length) {
    throw new ApiError(500, 'INTERNAL', 'admin token secret not configured');
  }
  for (const t of tokens) {
    if (safeEqualStr(provided, t)) return;
  }
  throw new ApiError(401, 'UNAUTHORIZED', 'invalid X-Admin-Token');
}

/* ---------------- date, field & watermark helpers ---------------- */
function toIso(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const ms = Date.parse(val);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof val.toDate === 'function') {
    return val.toDate().toISOString();
  }
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    return new Date(val).toISOString();
  }
  return null;
}

function parseRole(options, fallbackRole) {
  if (fallbackRole) return String(fallbackRole).toLowerCase();
  const m = /(?:^|,)role:([^,\s]+)/i.exec(String(options || ''));
  return m ? m[1].toLowerCase() : 'unknown';
}

function parseScore(doc) {
  if (doc.score != null && Number.isFinite(Number(doc.score))) {
    return Number(doc.score);
  }
  const m = /with\s+(\d+)\s+points/i.exec(String(doc.deathReason || ''));
  return m ? Number(m[1]) : null;
}

function normalizeGameDoc(id, d, isStub = false) {
  const gameId = d.gameId || id;
  const createdAt = toIso(d.createdAt) || toIso(d.importedAt) || toIso(d.verifiedAt) || '1970-01-01T00:00:00.000Z';
  const verifiedAt = toIso(d.verifiedAt);
  const importedAt = toIso(d.importedAt);
  /* Monotonic export timestamp: importedAt (for externally imported runs) > verifiedAt > createdAt */
  const exportTs = importedAt || verifiedAt || createdAt;
  const status = isStub ? 'incomplete-unverified' : (d.status || 'pending');
  const verdict = isStub
    ? null
    : (d.verdict || (status === 'verified' || status === 'rejected' ? status : null));
  const depth = Number(d.maxDlvl ?? d.depth ?? d.endLevel ?? 0);
  const frames = Number(d.framesMatched ?? d.frames ?? 0);
  const keysBytes = Number(d.keysTotal ?? d.keysBytes ?? 0);
  const visible = d.visible === false ? false : true;
  const hiddenByOwner = !!d.hiddenByOwner;

  return {
    gameId,
    uid: d.uid || null,
    player: d.displayName || d.player || d.uid || 'anonymous',
    seed: d.seed != null ? String(d.seed) : '',
    role: parseRole(d.options, d.role),
    options: d.options || '',
    depth: Number.isFinite(depth) ? depth : 0,
    turns: Number(d.turns ?? frames ?? 0),
    frames: Number.isFinite(frames) ? frames : 0,
    keysBytes: Number.isFinite(keysBytes) ? keysBytes : 0,
    outcome: d.outcome || null,
    deathReason: d.deathReason || null,
    score: parseScore(d),
    status,
    verdict,
    verdictBy: d.verdictBy || (verdict && !d.importedAt ? 'airstring-verifier' : null),
    verdictReason: d.verdictReason || null,
    verifiedAt,
    createdAt,
    importedAt,
    exportTs,
    visible,
    hiddenByOwner,
    kind: isStub ? 'stub' : (d.kind || 'complete'),
    keysComplete: isStub ? Boolean(d.keysComplete) : undefined,
    source: d.source || null,
    batch: d.batch || null,
    lineage: d.lineageId || d.lineage || null,
    recordingSha256: d.recordingSha256 || d.keysSha256 || null,
    publicRecordingPath: d.publicRecordingPath || null,
    storagePath: d.storagePath || null,
    parentGameId: d.parentGameId || null,
    forkTurn: d.forkTurn != null ? Number(d.forkTurn) : null,
  };
}

function toExportGameItem(g) {
  return {
    gameId: g.gameId,
    player: g.player,
    seed: g.seed,
    role: g.role,
    depth: g.depth,
    outcome: g.outcome,
    status: g.status,
    createdAt: g.createdAt,
  };
}

function toAdminGameItem(g) {
  const item = {
    ...toExportGameItem(g),
    verdict: g.verdict,
    visible: g.visible,
  };
  if (g.source) item.source = g.source;
  if (g.batch) item.batch = g.batch;
  if (g.kind === 'stub') item.kind = 'stub';
  return item;
}

function encodeWatermark(tsIso, gameId) {
  return Buffer.from(JSON.stringify({ v: 1, ts: tsIso, id: gameId || '' }), 'utf8').toString('base64url');
}

function decodeWatermark(sinceStr) {
  if (!sinceStr) return null;
  const s = String(sinceStr).trim();
  if (!s) return null;
  /* Accept plain ISO 8601 timestamp as well as opaque base64url watermark */
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) {
      throw new ApiError(400, 'BAD_REQUEST', 'invalid since timestamp');
    }
    return { ts: new Date(ms).toISOString(), id: '' };
  }
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!obj || typeof obj.ts !== 'string' || !Number.isFinite(Date.parse(obj.ts))) {
      throw new Error('bad watermark');
    }
    return { ts: new Date(Date.parse(obj.ts)).toISOString(), id: String(obj.id || '') };
  } catch (_) {
    throw new ApiError(400, 'BAD_REQUEST', 'invalid since watermark');
  }
}

function isAfterWatermark(g, wm) {
  if (!wm) return true;
  if (g.exportTs > wm.ts) return true;
  if (g.exportTs < wm.ts) return false;
  return wm.id ? g.gameId > wm.id : false;
}

function compareByWatermark(a, b) {
  if (a.exportTs !== b.exportTs) return a.exportTs < b.exportTs ? -1 : 1;
  return a.gameId < b.gameId ? -1 : (a.gameId > b.gameId ? 1 : 0);
}

function parsePagination(query) {
  let page = 1;
  let pageSize = 50;
  if (query.page != null && String(query.page).trim() !== '') {
    page = Number(query.page);
    if (!Number.isInteger(page) || page < 1) {
      throw new ApiError(400, 'BAD_REQUEST', 'page must be an integer >= 1');
    }
  }
  if (query.pageSize != null && String(query.pageSize).trim() !== '') {
    pageSize = Number(query.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      throw new ApiError(400, 'BAD_REQUEST', 'pageSize must be an integer between 1 and 200');
    }
  }
  return { page, pageSize };
}

function paginate(items, page, pageSize) {
  const total = items.length;
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page,
    pageSize,
    total,
    hasMore: start + slice.length < total,
  };
}

async function fetchAllGames({ includeStubs = false, onlyStubs = false } = {}) {
  const out = [];
  if (!onlyStubs) {
    const snap = await db.collection('games').get();
    snap.forEach((doc) => {
      out.push(normalizeGameDoc(doc.id, doc.data() || {}, false));
    });
  }
  if (includeStubs || onlyStubs) {
    const snap = await db.collection('incomplete_saves').get();
    snap.forEach((doc) => {
      out.push(normalizeGameDoc(doc.id, doc.data() || {}, true));
    });
  }
  return out;
}

async function resolveRecordingFile(g) {
  const candidates = [];
  if (g.kind === 'stub') {
    if (g.storagePath) candidates.push(g.storagePath);
  } else {
    if (g.publicRecordingPath) candidates.push(g.publicRecordingPath);
    if (g.uid) candidates.push(`recordings/${g.uid}/${g.gameId}.jsonl`);
    candidates.push(`public-recordings/${g.gameId}.jsonl`);
    candidates.push(`recordings/${BOT_UID}/${g.gameId}.jsonl`);
  }
  for (const p of candidates) {
    const f = bucket.file(p);
    const [exists] = await f.exists();
    if (exists) return { file: f, path: p };
  }
  return null;
}

/* ---------------- SSRF-safe HTTPS package downloader ---------------- */
function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true;
    if (low.startsWith('::ffff:')) {
      return isPrivateIp(low.slice(7));
    }
    return false;
  }
  return true;
}

async function assertSafeHttpsUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    throw new ApiError(400, 'BAD_REQUEST', 'packageUrl must be a valid URL');
  }
  if (u.protocol !== 'https:') {
    throw new ApiError(400, 'BAD_REQUEST', 'packageUrl must use https');
  }
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new ApiError(400, 'BAD_REQUEST', 'packageUrl host is not allowed');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new ApiError(400, 'BAD_REQUEST', 'packageUrl IP is not allowed');
    return u.toString();
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (_) {
    throw new ApiError(400, 'BAD_REQUEST', 'packageUrl hostname could not be resolved');
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new ApiError(400, 'BAD_REQUEST', 'packageUrl resolved to a restricted IP');
  }
  return u.toString();
}

async function downloadPackageChecked(rawUrl, destPath, maxBytes) {
  let curUrl = await assertSafeHttpsUrl(rawUrl);
  let resp = null;
  for (let hop = 0; hop < 5; hop++) {
    resp = await fetch(curUrl, { redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      const next = new URL(resp.headers.get('location'), curUrl).toString();
      curUrl = await assertSafeHttpsUrl(next);
      continue;
    }
    break;
  }
  if (!resp || !resp.ok || !resp.body) {
    throw new ApiError(400, 'BAD_REQUEST', `failed to fetch packageUrl (HTTP ${resp ? resp.status : 'err'})`);
  }
  const cl = Number(resp.headers.get('content-length') || 0);
  if (Number.isFinite(cl) && cl > maxBytes) {
    throw new ApiError(413, 'TOO_LARGE', `package exceeds limit of ${maxBytes} bytes`);
  }
  const hash = crypto.createHash('sha256');
  let total = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(new ApiError(413, 'TOO_LARGE', `package exceeds limit of ${maxBytes} bytes`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(resp.body), counter, fs.createWriteStream(destPath));
  return { bytes: total, sha256: hash.digest('hex') };
}

/* ---------------- safe tar.gz extraction ---------------- */
async function safeExtractTarGz(archivePath, extractDir) {
  await fsp.mkdir(extractDir, { recursive: true });
  let totalUncompressed = 0;
  await tar.extract({
    file: archivePath,
    cwd: extractDir,
    strict: true,
    filter: (entryPath, entry) => {
      const norm = path.posix.normalize(String(entryPath || '').replace(/\\/g, '/'));
      if (norm.startsWith('/') || norm.startsWith('..') || norm.includes('/../')) {
        throw new ApiError(400, 'BAD_REQUEST', `unsafe path in archive: ${entryPath}`);
      }
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        throw new ApiError(400, 'BAD_REQUEST', `symlinks not allowed in archive: ${entryPath}`);
      }
      totalUncompressed += Number(entry.size || 0);
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new ApiError(413, 'TOO_LARGE', `uncompressed archive exceeds limit of ${MAX_UNCOMPRESSED_BYTES} bytes`);
      }
      return true;
    },
  });
  return totalUncompressed;
}

function resolveFileInExtract(extractDir, relCandidates) {
  const rootResolved = path.resolve(extractDir);
  for (const rel of relCandidates) {
    if (!rel) continue;
    const cleaned = String(rel).replace(/^\.\/+/, '');
    const full = path.resolve(rootResolved, cleaned);
    if (!full.startsWith(rootResolved + path.sep)) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return full;
    }
  }
  return null;
}

async function findManifestPath(extractDir) {
  const direct = resolveFileInExtract(extractDir, ['MANIFEST.json']);
  if (direct) return { manifestPath: direct, baseDir: extractDir };
  /* Also support packages wrapped in a single top-level folder */
  const entries = await fsp.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    const sub = path.join(extractDir, dirs[0].name);
    const nested = resolveFileInExtract(sub, ['MANIFEST.json']);
    if (nested) return { manifestPath: nested, baseDir: sub };
  }
  return null;
}

function validateManifestTop(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new ApiError(400, 'BAD_REQUEST', 'MANIFEST.json must be a JSON object');
  }
  if (!manifest.batch || typeof manifest.batch !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'MANIFEST.json missing required string field: batch');
  }
  if (!manifest.source || typeof manifest.source !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'MANIFEST.json missing required string field: source');
  }
  const createdAt = manifest.createdAt || manifest.generatedAt;
  if (!createdAt || typeof createdAt !== 'string') {
    throw new ApiError(400, 'BAD_REQUEST', 'MANIFEST.json missing required field: createdAt');
  }
  if (!Array.isArray(manifest.entries)) {
    throw new ApiError(400, 'BAD_REQUEST', 'MANIFEST.json missing required array field: entries');
  }
  if (manifest.count != null && Number(manifest.count) !== manifest.entries.length) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `MANIFEST.json count (${manifest.count}) does not match entries.length (${manifest.entries.length})`,
    );
  }
  const isStubBatch = manifest.kind === 'stub' || manifest.status === 'incomplete-unverified';
  const maxEntries = isStubBatch ? MAX_ENTRIES_STUB : MAX_ENTRIES_COMPLETE;
  if (manifest.entries.length > maxEntries) {
    throw new ApiError(
      413,
      'TOO_LARGE',
      `package entry count (${manifest.entries.length}) exceeds limit (${maxEntries})`,
    );
  }
  return { createdAt, isStubBatch };
}

function buildManifestMarkdown(manifest) {
  const lines = [
    `# airstring Export Package: ${manifest.batch}`,
    '',
    `- **Source**: \`${manifest.source}\``,
    `- **Kind**: \`${manifest.kind}\``,
    `- **Created At**: \`${manifest.createdAt}\``,
    `- **Count**: ${manifest.count}`,
    '',
    '| gameId | seed | role | depth | outcome | frames | keysBytes | verdict | recording |',
    '|---|---|---|---|---|---:|---:|---|---|',
  ];
  for (const e of manifest.entries) {
    lines.push(
      `| \`${e.gameId}\` | \`${e.seed}\` | ${e.role} | ${e.depth} | ${e.outcome || '-'} | ${e.frames} | ${e.keysBytes} | ${e.verdict || e.status || '-'} | \`${e.recording}\` |`,
    );
  }
  return lines.join('\n') + '\n';
}

function inspectJsonlRecording(buf) {
  const text = buf.toString('utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    return { error: 'empty recording file' };
  }
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (_) {
    return { error: 'invalid JSON in recording header (line 1)' };
  }
  if (!header || header.k !== 'header') {
    return { error: 'line 1 is not a recording header (k !== "header")' };
  }
  if (Number(header.date) !== FIXED_DATE) {
    return { error: `controlled condition mismatch: header.date=${header.date} (expected ${FIXED_DATE})` };
  }
  if (header.seed == null || String(header.seed).trim() === '') {
    return { error: 'controlled condition mismatch: missing header.seed' };
  }
  const opts = String(header.options || '');
  if (!opts) {
    return { error: 'controlled condition mismatch: missing header.options' };
  }
  if (/(^|[,:\s])(wizard|explore)\b/i.test(opts) || /(^|[,\s])bones\b/i.test(opts)) {
    return { error: `controlled condition mismatch: forbidden option in header.options (${opts})` };
  }

  let frames = 0;
  let lastTurn = 0;
  let keysBytes = 0;
  let endStatus = null;
  for (let i = 1; i < lines.length; i++) {
    let rec;
    try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
    if (rec && rec.k === 'turn') {
      frames++;
      if (rec.turn != null) lastTurn = Number(rec.turn) || lastTurn;
      if (typeof rec.keys === 'string' && rec.keys) {
        keysBytes += Buffer.from(rec.keys, 'base64').length;
      } else if (typeof rec.in === 'string' && rec.in) {
        keysBytes += Buffer.from(rec.in, 'base64').length;
      }
    } else if (rec && rec.k === 'end') {
      if (rec.turns != null) lastTurn = Number(rec.turns) || lastTurn;
      if (rec.frames != null) frames = Number(rec.frames) || frames;
      if (rec.keysTotal != null) keysBytes = Number(rec.keysTotal) || keysBytes;
      if (rec.end != null) endStatus = rec.end;
    } else if (rec && rec.k === 'tail' && typeof rec.keys === 'string' && rec.keys) {
      keysBytes += Buffer.from(rec.keys, 'base64').length;
    }
  }
  return {
    header,
    frames,
    turns: lastTurn || frames,
    keysBytes,
    endStatus,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/* ---------------- 10 API-1 Endpoint Handlers ---------------- */

/* ① GET /api/export/package */
async function handleExportPackage(req, res) {
  const statusFilter = req.query.status ? String(req.query.status).trim() : null;
  const wm = decodeWatermark(req.query.since);
  const onlyStubs = statusFilter === 'incomplete-unverified';

  let games = await fetchAllGames({ onlyStubs, includeStubs: false });
  if (statusFilter && !onlyStubs) {
    games = games.filter((g) => g.status === statusFilter);
  }
  games.sort(compareByWatermark);
  const matched = games.filter((g) => isAfterWatermark(g, wm));

  const maxCount = onlyStubs ? MAX_ENTRIES_STUB : MAX_ENTRIES_COMPLETE;
  if (matched.length > maxCount) {
    throw new ApiError(
      413,
      'TOO_LARGE',
      `matched ${matched.length} games exceeds single-package limit of ${maxCount}; paginate with since watermark`,
    );
  }

  const nowIso = new Date().toISOString();
  const exportId = `export-${nowIso.replace(/[-:T.Z]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'as-exp-'));
  const tarPath = path.join(os.tmpdir(), `${exportId}.tar.gz`);

  try {
    const recDir = path.join(tmpDir, 'recordings');
    await fsp.mkdir(recDir, { recursive: true });

    const manifestEntries = [];
    let totalBytes = 0;

    for (const g of matched) {
      const resolved = await resolveRecordingFile(g);
      if (!resolved) continue;
      const [buf] = await resolved.file.download();
      totalBytes += buf.length;
      if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new ApiError(413, 'TOO_LARGE', `export uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`);
      }
      const ext = g.kind === 'stub' ? '.keys' : '.jsonl';
      const relPath = `recordings/${g.gameId}${ext}`;
      await fsp.writeFile(path.join(tmpDir, relPath), buf);

      const entry = {
        gameId: g.gameId,
        seed: g.seed,
        role: g.role,
        depth: g.depth,
        outcome: g.outcome,
        frames: g.frames,
        keysBytes: g.keysBytes,
        recording: relPath,
        kind: g.kind,
      };
      if (g.lineage) entry.lineage = g.lineage;
      if (g.kind === 'stub') {
        entry.status = 'incomplete-unverified';
        entry.keysComplete = Boolean(g.keysComplete);
      } else if (g.verdict) {
        entry.verdict = g.verdict;
        if (g.verdictBy) entry.verdictBy = g.verdictBy;
        if (g.verifiedAt) entry.verifiedAt = g.verifiedAt;
      }
      manifestEntries.push(entry);
    }

    const manifest = {
      batch: exportId,
      source: 'airstring',
      createdAt: nowIso,
      count: manifestEntries.length,
      kind: onlyStubs ? 'stub' : 'complete',
      ...(onlyStubs ? { status: 'incomplete-unverified' } : {}),
      entries: manifestEntries,
    };

    await fsp.writeFile(path.join(tmpDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await fsp.writeFile(path.join(tmpDir, 'MANIFEST.md'), buildManifestMarkdown(manifest), 'utf8');

    await tar.create(
      { gzip: true, file: tarPath, cwd: tmpDir, portable: true },
      ['MANIFEST.json', 'MANIFEST.md', 'recordings'],
    );

    const tarBuf = await fsp.readFile(tarPath);
    if (tarBuf.length > MAX_PACKAGE_BYTES) {
      throw new ApiError(413, 'TOO_LARGE', `compressed export (${tarBuf.length} bytes) exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
    const sha256 = crypto.createHash('sha256').update(tarBuf).digest('hex');
    const storagePath = `exports/${exportId}.tar.gz`;
    const file = bucket.file(storagePath);
    await file.save(tarBuf, {
      contentType: 'application/gzip',
      resumable: false,
    });

    const expiresMs = Date.now() + EXPORT_URL_TTL_MS;
    const expiresAt = new Date(expiresMs).toISOString();
    const [downloadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresMs,
    });

    let newWatermark;
    if (matched.length > 0) {
      const last = matched[matched.length - 1];
      newWatermark = encodeWatermark(last.exportTs, last.gameId);
    } else if (wm) {
      newWatermark = encodeWatermark(wm.ts, wm.id);
    } else {
      newWatermark = encodeWatermark(nowIso, '');
    }

    sendOk(res, {
      downloadUrl,
      sha256,
      count: manifestEntries.length,
      newWatermark,
      expiresAt,
    });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    await fsp.rm(tarPath, { force: true }).catch(() => { });
  }
}

/* ② GET /api/export/games */
async function handleExportGames(req, res) {
  const { page, pageSize } = parsePagination(req.query);
  const statusFilter = req.query.status ? String(req.query.status).trim() : null;
  const wm = decodeWatermark(req.query.since);
  const onlyStubs = statusFilter === 'incomplete-unverified';

  let games = await fetchAllGames({ onlyStubs, includeStubs: false });
  if (statusFilter && !onlyStubs) {
    games = games.filter((g) => g.status === statusFilter);
  }
  games.sort(compareByWatermark);
  const matched = games.filter((g) => isAfterWatermark(g, wm));

  const pg = paginate(matched.map(toExportGameItem), page, pageSize);
  const newWatermark = matched.length > 0
    ? encodeWatermark(matched[matched.length - 1].exportTs, matched[matched.length - 1].gameId)
    : (wm ? encodeWatermark(wm.ts, wm.id) : encodeWatermark(new Date().toISOString(), ''));

  sendOk(res, { ...pg, newWatermark });
}

/* ③ POST /api/import/package */
async function handleImportPackage(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const packageUrl = typeof body.packageUrl === 'string' ? body.packageUrl.trim() : '';
  const declaredSha = typeof body.sha256 === 'string' ? body.sha256.trim().toLowerCase() : '';

  if (!packageUrl) {
    throw new ApiError(400, 'BAD_REQUEST', 'missing required field: packageUrl');
  }
  if (!/^[0-9a-f]{64}$/.test(declaredSha)) {
    throw new ApiError(400, 'BAD_REQUEST', 'sha256 must be a 64-character lowercase hex string');
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'as-imp-'));
  const tarPath = path.join(tmpDir, 'package.tar.gz');
  const extractDir = path.join(tmpDir, 'extracted');

  try {
    const dl = await downloadPackageChecked(packageUrl, tarPath, MAX_PACKAGE_BYTES);
    if (dl.sha256 !== declaredSha) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        `sha256 mismatch: declared=${declaredSha}, actual=${dl.sha256}`,
      );
    }

    try {
      await safeExtractTarGz(tarPath, extractDir);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(400, 'BAD_REQUEST', `invalid tar.gz archive: ${e.message}`);
    }

    const found = await findManifestPath(extractDir);
    if (!found) {
      throw new ApiError(400, 'BAD_REQUEST', 'archive missing MANIFEST.json');
    }

    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(found.manifestPath, 'utf8'));
    } catch (e) {
      throw new ApiError(400, 'BAD_REQUEST', `MANIFEST.json is not valid JSON: ${e.message}`);
    }
    validateManifestTop(manifest);

    /* Reject concurrent re-submission of the exact same batch name while still processing */
    const activeSnap = await db.collection('import_batches')
      .where('manifestBatch', '==', manifest.batch)
      .where('status', '==', 'processing')
      .limit(1)
      .get();
    if (!activeSnap.empty) {
      throw new ApiError(409, 'CONFLICT', `batch "${manifest.batch}" is already processing`);
    }

    const nowIso = new Date().toISOString();
    const safeBatchPrefix = manifest.batch.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
    const batchId = `${safeBatchPrefix}-${nowIso.replace(/[-:T.Z]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
    const inboxPath = `import-inbox/${batchId}.tar.gz`;

    await bucket.upload(tarPath, {
      destination: inboxPath,
      metadata: { contentType: 'application/gzip' },
    });

    await db.collection('import_batches').doc(batchId).set({
      batchId,
      manifestBatch: manifest.batch,
      source: manifest.source,
      packageSha256: declaredSha,
      packageBytes: dl.bytes,
      inboxPath,
      status: 'processing',
      total: manifest.entries.length,
      received: manifest.entries.length,
      createdAt: nowIso,
      completedAt: null,
      results: [],
    });

    sendOk(res, { batchId, received: manifest.entries.length });
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
  }
}

/* ④ GET /api/import/batches/{batchId} */
async function handleGetImportBatch(req, res, batchId) {
  const snap = await db.collection('import_batches').doc(batchId).get();
  if (!snap.exists) {
    throw new ApiError(404, 'NOT_FOUND', `batch not found: ${batchId}`);
  }
  const d = snap.data() || {};
  sendOk(res, {
    batchId: d.batchId || batchId,
    status: d.status || 'processing',
    total: Number(d.total ?? 0),
    results: Array.isArray(d.results) ? d.results : [],
    batch: d.manifestBatch || null,
    source: d.source || null,
    createdAt: d.createdAt || null,
    completedAt: d.completedAt || null,
    ...(d.error ? { error: d.error } : {}),
  });
}

/* ⑤ GET /api/admin/games */
async function handleAdminGames(req, res) {
  const { page, pageSize } = parsePagination(req.query);
  const statusFilter = req.query.status ? String(req.query.status).trim() : null;
  const playerFilter = req.query.player ? String(req.query.player).trim().toLowerCase() : null;
  const seedFilter = req.query.seed != null && String(req.query.seed).trim() !== ''
    ? String(req.query.seed).trim()
    : null;
  const fromIso = req.query.from ? toIso(String(req.query.from).trim()) : null;
  const toIsoVal = req.query.to ? toIso(String(req.query.to).trim()) : null;
  if (req.query.from && !fromIso) throw new ApiError(400, 'BAD_REQUEST', 'invalid from timestamp');
  if (req.query.to && !toIsoVal) throw new ApiError(400, 'BAD_REQUEST', 'invalid to timestamp');

  let games = await fetchAllGames({
    includeStubs: true,
    onlyStubs: statusFilter === 'incomplete-unverified',
  });

  if (statusFilter) {
    games = games.filter((g) => g.status === statusFilter);
  }
  if (playerFilter) {
    games = games.filter((g) =>
      String(g.uid || '').toLowerCase() === playerFilter ||
      String(g.player || '').toLowerCase() === playerFilter,
    );
  }
  if (seedFilter) {
    games = games.filter((g) => g.seed === seedFilter);
  }
  if (fromIso) {
    games = games.filter((g) => g.createdAt >= fromIso);
  }
  if (toIsoVal) {
    games = games.filter((g) => g.createdAt <= toIsoVal);
  }

  games.sort((a, b) => (a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0)));
  const pg = paginate(games.map(toAdminGameItem), page, pageSize);
  sendOk(res, pg);
}

/* ⑥ GET /api/admin/games/{gameId} */
async function handleAdminGameDetail(req, res, gameId) {
  let doc = await db.collection('games').doc(gameId).get();
  let isStub = false;
  if (!doc.exists) {
    doc = await db.collection('incomplete_saves').doc(gameId).get();
    isStub = true;
  }
  if (!doc.exists) {
    throw new ApiError(404, 'NOT_FOUND', `game not found: ${gameId}`);
  }
  const g = normalizeGameDoc(doc.id, doc.data() || {}, isStub);

  let recordingUrl = null;
  let recordingExpiresAt = null;
  const resolved = await resolveRecordingFile(g);
  if (resolved) {
    const expMs = Date.now() + RECORDING_URL_TTL_MS;
    const [url] = await resolved.file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expMs,
    });
    recordingUrl = url;
    recordingExpiresAt = new Date(expMs).toISOString();
  }

  sendOk(res, {
    ...toAdminGameItem(g),
    uid: g.uid,
    options: g.options,
    turns: g.turns,
    frames: g.frames,
    keysBytes: g.keysBytes,
    recordingSha256: g.recordingSha256,
    lineage: g.lineage,
    deathReason: g.deathReason,
    score: g.score,
    verdictBy: g.verdictBy,
    verdictReason: g.verdictReason,
    verifiedAt: g.verifiedAt,
    hiddenByOwner: g.hiddenByOwner,
    parentGameId: g.parentGameId,
    forkTurn: g.forkTurn,
    ...(isStub ? { keysComplete: g.keysComplete } : {}),
    recordingUrl,
    recordingExpiresAt,
  });
}

/* ⑦ GET /api/admin/stats */
async function handleAdminStats(req, res) {
  const games = await fetchAllGames({ includeStubs: true });
  const nowMs = Date.now();
  const d7 = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString();
  const d30 = new Date(nowMs - 30 * 24 * 3600 * 1000).toISOString();

  const byStatus = {};
  const byDepth = {};
  const byRole = {};
  let addedLast7d = 0;
  let addedLast30d = 0;

  for (const g of games) {
    byStatus[g.status] = (byStatus[g.status] || 0) + 1;
    const dk = String(g.depth);
    byDepth[dk] = (byDepth[dk] || 0) + 1;
    byRole[g.role] = (byRole[g.role] || 0) + 1;
    const ts = g.importedAt || g.createdAt;
    if (ts >= d7) addedLast7d++;
    if (ts >= d30) addedLast30d++;
  }

  sendOk(res, {
    total: games.length,
    byStatus,
    byDepth,
    byRole,
    addedLast7d,
    addedLast30d,
  });
}

/* ⑧ GET /api/admin/leaderboard */
async function handleAdminLeaderboard(req, res) {
  let limit = 100;
  if (req.query.limit != null && String(req.query.limit).trim() !== '') {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError(400, 'BAD_REQUEST', 'limit must be an integer between 1 and 200');
    }
  }
  const games = await fetchAllGames({ includeStubs: false });
  const eligible = games.filter((g) => g.status === 'verified' && g.visible !== false && !g.hiddenByOwner);
  eligible.sort((a, b) =>
    (b.depth - a.depth) ||
    (b.turns - a.turns) ||
    (b.createdAt.localeCompare(a.createdAt)),
  );
  const entries = eligible.slice(0, limit).map((g, i) => ({
    rank: i + 1,
    gameId: g.gameId,
    player: g.player,
    seed: g.seed,
    role: g.role,
    depth: g.depth,
    outcome: g.outcome,
    ...(g.score != null ? { score: g.score } : {}),
  }));
  sendOk(res, {
    generatedAt: new Date().toISOString(),
    entries,
  });
}

/* ⑨ GET /api/admin/players/{player} */
async function handleAdminPlayer(req, res, playerParam) {
  const { page, pageSize } = parsePagination(req.query);
  const target = String(playerParam || '').trim();
  if (!target) throw new ApiError(400, 'BAD_REQUEST', 'missing player identifier');
  const targetLow = target.toLowerCase();

  const all = await fetchAllGames({ includeStubs: false });
  const matched = all.filter((g) =>
    String(g.uid || '').toLowerCase() === targetLow ||
    String(g.player || '').toLowerCase() === targetLow,
  );
  matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0)));

  const verifiedOnly = matched.filter((g) => g.status === 'verified');
  const bestPool = verifiedOnly.length ? verifiedOnly : matched;
  let best = null;
  if (bestPool.length) {
    const top = bestPool.slice().sort((a, b) => (b.depth - a.depth) || (b.turns - a.turns))[0];
    best = { gameId: top.gameId, depth: top.depth, outcome: top.outcome };
  }

  const pg = paginate(matched.map(toAdminGameItem), page, pageSize);
  sendOk(res, {
    player: matched.length ? matched[0].player : target,
    gameCount: matched.length,
    best,
    games: pg.items,
    page: pg.page,
    pageSize: pg.pageSize,
    total: pg.total,
    hasMore: pg.hasMore,
  });
}

/* ⑩ POST /api/admin/games/{gameId}/visibility */
async function handleAdminVisibility(req, res, gameId) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.visible !== 'boolean') {
    throw new ApiError(400, 'BAD_REQUEST', 'visible must be a boolean');
  }
  const ref = db.collection('games').doc(gameId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new ApiError(404, 'NOT_FOUND', `game not found: ${gameId}`);
  }
  await ref.update({
    visible: body.visible,
    visibilityUpdatedAt: new Date().toISOString(),
  });
  sendOk(res, { gameId, visible: body.visible });
}

/* ---------------- HTTP router (Cloud Function v2 `api`) ---------------- */
export const api = onRequest(
  {
    region: REGION,
    memory: '1GiB',
    timeoutSeconds: 300,
    maxInstances: 10,
    secrets: [AIRSTRING_ADMIN_TOKENS],
  },
  async (req, res) => {
    try {
      requireAdminToken(req);

      const rawPath = (req.path || '/').replace(/\/+$/, '') || '/';
      const routePath = rawPath.startsWith('/api/') ? rawPath : ('/api' + rawPath);
      const method = String(req.method || 'GET').toUpperCase();

      if (method === 'GET' && routePath === '/api/export/package') {
        await handleExportPackage(req, res);
        return;
      }
      if (method === 'GET' && routePath === '/api/export/games') {
        await handleExportGames(req, res);
        return;
      }
      if (method === 'POST' && routePath === '/api/import/package') {
        await handleImportPackage(req, res);
        return;
      }
      let m = /^\/api\/import\/batches\/([^/]+)$/.exec(routePath);
      if (method === 'GET' && m) {
        await handleGetImportBatch(req, res, decodeURIComponent(m[1]));
        return;
      }
      if (method === 'GET' && routePath === '/api/admin/games') {
        await handleAdminGames(req, res);
        return;
      }
      m = /^\/api\/admin\/games\/([^/]+)\/visibility$/.exec(routePath);
      if (method === 'POST' && m) {
        await handleAdminVisibility(req, res, decodeURIComponent(m[1]));
        return;
      }
      m = /^\/api\/admin\/games\/([^/]+)$/.exec(routePath);
      if (method === 'GET' && m) {
        await handleAdminGameDetail(req, res, decodeURIComponent(m[1]));
        return;
      }
      if (method === 'GET' && routePath === '/api/admin/stats') {
        await handleAdminStats(req, res);
        return;
      }
      if (method === 'GET' && routePath === '/api/admin/leaderboard') {
        await handleAdminLeaderboard(req, res);
        return;
      }
      m = /^\/api\/admin\/players\/([^/]+)$/.exec(routePath);
      if (method === 'GET' && m) {
        await handleAdminPlayer(req, res, decodeURIComponent(m[1]));
        return;
      }

      throw new ApiError(404, 'NOT_FOUND', `unknown endpoint: ${method} ${routePath}`);
    } catch (err) {
      sendErr(res, err);
    }
  },
);

/* ---------------- Background async import processor (Firestore trigger) ---------------- */
export const processImportBatch = onDocumentCreated(
  {
    document: 'import_batches/{batchId}',
    region: 'northamerica-northeast2',
    memory: '1GiB',
    timeoutSeconds: 540,
    maxInstances: 4,
  },
  async (event) => {
    let batchId = (event && event.params && event.params.batchId) || null;
    if (!batchId && event && typeof event.subject === 'string') {
      const m = /documents\/import_batches\/([^/]+)$/.exec(event.subject);
      if (m) batchId = m[1];
    }
    if (!batchId && event && typeof event.document === 'string') {
      const m = /import_batches\/([^/]+)$/.exec(event.document);
      if (m) batchId = m[1];
    }
    if (!batchId) {
      const pending = await db.collection('import_batches')
        .where('status', '==', 'processing')
        .limit(1)
        .get();
      if (!pending.empty) batchId = pending.docs[0].id;
    }
    if (!batchId) {
      console.log('[api1] processImportBatch: no batchId found in event');
      return;
    }

    const batchRef = db.collection('import_batches').doc(batchId);
    const batchDoc = await db.runTransaction(async (tx) => {
      const docSnap = await tx.get(batchRef);
      if (!docSnap.exists) return null;
      const d = docSnap.data() || {};
      if (d.status !== 'processing' || !d.inboxPath || d.claimedAt) return null;
      tx.update(batchRef, { claimedAt: new Date().toISOString() });
      return d;
    });
    if (!batchDoc) {
      console.log('[api1] processImportBatch: batch already claimed or not processing:', batchId);
      return;
    }
    console.log('[api1] processImportBatch start:', batchId, 'inbox=', batchDoc.inboxPath);

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'as-proc-'));
    const tarPath = path.join(tmpDir, 'package.tar.gz');
    const extractDir = path.join(tmpDir, 'extracted');

    try {
      await bucket.file(batchDoc.inboxPath).download({ destination: tarPath });
      await safeExtractTarGz(tarPath, extractDir);
      const found = await findManifestPath(extractDir);
      if (!found) throw new Error('MANIFEST.json missing in inbox archive');
      const manifest = JSON.parse(await fsp.readFile(found.manifestPath, 'utf8'));
      const baseDir = found.baseDir;

      const results = [];
      for (const entry of manifest.entries) {
        const entryKind = entry.kind || manifest.kind ||
          (manifest.status === 'incomplete-unverified' ? 'stub' : 'complete');
        const nowIso = new Date().toISOString();

        if (entryKind === 'stub') {
          const recPath = resolveFileInExtract(baseDir, [
            entry.recording,
            entry.keysFile,
            entry.keys_file,
            entry.keys_file ? `keys/${entry.keys_file}` : null,
            entry.keys_file ? `recordings/${entry.keys_file}` : null,
            entry.gameId ? `recordings/${entry.gameId}.keys` : null,
            entry.gameId ? `keys/${entry.gameId}.keys` : null,
          ]);
          const fallbackId = entry.gameId || entry.lineage || 'unknown';
          if (!recPath) {
            results.push({ gameId: fallbackId, result: 'rejected', reason: 'keys file missing in package' });
            continue;
          }
          if (typeof entry.keysComplete !== 'boolean') {
            results.push({ gameId: fallbackId, result: 'rejected', reason: 'stub entry missing boolean keysComplete' });
            continue;
          }
          const buf = await fsp.readFile(recPath);
          const keysSha256 = crypto.createHash('sha256').update(buf).digest('hex');
          const lineage = entry.lineage || entry.lineageId || null;
          const docId = entry.gameId ||
            `stub-${crypto.createHash('sha256').update(`${lineage || ''}:${keysSha256}`).digest('hex').slice(0, 20)}`;

          if (!/^[A-Za-z0-9._-]{1,128}$/.test(docId)) {
            results.push({ gameId: String(docId), result: 'rejected', reason: 'invalid stub gameId characters' });
            continue;
          }
          const stubRef = db.collection('incomplete_saves').doc(docId);
          const existing = await stubRef.get();
          if (existing.exists) {
            results.push({ gameId: docId, result: 'duplicate' });
            continue;
          }
          const safeBatchDir = String(manifest.batch).replace(/[^A-Za-z0-9._-]/g, '_');
          const storagePath = `incomplete-keys/${safeBatchDir}/${docId}.keys`;
          try {
            await bucket.file(storagePath).save(buf, {
              contentType: 'application/octet-stream',
              resumable: false,
              preconditionOpts: { ifGenerationMatch: 0 },
            });
          } catch (e) {
            if (e && (e.code === 412 || String(e.message || '').includes('Precondition'))) {
              results.push({ gameId: docId, result: 'duplicate' });
              continue;
            }
            throw e;
          }
          try {
            await stubRef.create({
              gameId: docId,
              uid: BOT_UID,
              displayName: entry.player || BOT_DISPLAY_NAME,
              kind: 'stub',
              status: 'incomplete-unverified',
              keysComplete: entry.keysComplete,
              seed: entry.seed != null ? String(entry.seed) : '',
              role: entry.role ? String(entry.role).toLowerCase() : 'unknown',
              depth: Number(entry.depth ?? entry.endLevel ?? entry.dlvl ?? 0),
              maxDlvl: Number(entry.depth ?? entry.endLevel ?? entry.dlvl ?? 0),
              frames: Number(entry.frames ?? 0),
              keysBytes: Number(entry.keysBytes ?? entry.keys_bytes ?? buf.length),
              keysSha256,
              storagePath,
              source: manifest.source,
              batch: manifest.batch,
              lineageId: lineage,
              outcome: entry.outcome || null,
              visible: false,
              importedAt: nowIso,
              createdAt: toIso(entry.createdAt) || nowIso,
            });
            results.push({ gameId: docId, result: 'imported' });
          } catch (e) {
            if (e && (e.code === 6 || String(e.message || '').includes('ALREADY_EXISTS'))) {
              results.push({ gameId: docId, result: 'duplicate' });
            } else {
              throw e;
            }
          }
          continue;
        }

        /* A-class complete recording */
        const gameId = entry.gameId ? String(entry.gameId).trim() : '';
        if (!gameId || !/^[A-Za-z0-9._-]{1,128}$/.test(gameId)) {
          results.push({ gameId: gameId || 'unknown', result: 'rejected', reason: 'missing or invalid gameId' });
          continue;
        }
        const recPath = resolveFileInExtract(baseDir, [
          entry.recording,
          entry.path,
          entry.file,
          `recordings/${gameId}.jsonl`,
        ]);
        if (!recPath) {
          results.push({ gameId, result: 'rejected', reason: 'recording file missing in package' });
          continue;
        }
        const buf = await fsp.readFile(recPath);
        const parsed = inspectJsonlRecording(buf);
        if (parsed.error) {
          results.push({ gameId, result: 'rejected', reason: parsed.error });
          continue;
        }

        const gameRef = db.collection('games').doc(gameId);
        const existing = await gameRef.get();
        if (existing.exists) {
          results.push({ gameId, result: 'duplicate' });
          continue;
        }

        const privPath = `recordings/${BOT_UID}/${gameId}.jsonl`;
        try {
          await bucket.file(privPath).save(buf, {
            contentType: 'application/x-ndjson',
            resumable: false,
            preconditionOpts: { ifGenerationMatch: 0 },
          });
        } catch (e) {
          if (e && (e.code === 412 || String(e.message || '').includes('Precondition'))) {
            results.push({ gameId, result: 'duplicate' });
            continue;
          }
          throw e;
        }

        const extVerdict = entry.verdict === 'verified' || entry.verdict === 'rejected'
          ? entry.verdict
          : null;
        let publicRecordingPath = null;
        if (extVerdict === 'verified') {
          publicRecordingPath = `public-recordings/${gameId}.jsonl`;
          try {
            await bucket.file(publicRecordingPath).save(buf, {
              contentType: 'application/x-ndjson',
              resumable: false,
              preconditionOpts: { ifGenerationMatch: 0 },
            });
          } catch (e) {
            if (!(e && (e.code === 412 || String(e.message || '').includes('Precondition')))) {
              throw e;
            }
          }
        }

        const docStatus = extVerdict || 'unverified';
        const verifiedAtIso = extVerdict ? (toIso(entry.verifiedAt) || nowIso) : null;
        const verdictBy = extVerdict ? (entry.verdictBy || manifest.source) : null;
        const hdr = parsed.header;
        const depth = Number(entry.depth ?? entry.endLevel ?? entry.maxDlvl ?? 1);
        const frames = Number(entry.frames ?? parsed.frames ?? 0);
        const keysTotal = Number(entry.keysBytes ?? entry.keysTotal ?? parsed.keysBytes ?? 0);
        const turns = Number(entry.turns ?? parsed.turns ?? frames);

        const gameDoc = {
          gameId,
          uid: BOT_UID,
          displayName: entry.player || BOT_DISPLAY_NAME,
          seed: String(hdr.seed),
          seedSource: hdr.seedSource || 'given',
          date: FIXED_DATE,
          options: hdr.options,
          role: parseRole(hdr.options, entry.role),
          restored: null,
          end: parsed.endStatus != null ? parsed.endStatus : 0,
          turns,
          frames,
          framesCompared: frames,
          framesMatched: extVerdict === 'verified' ? frames : 0,
          keysTotal,
          maxDlvl: Number.isFinite(depth) ? depth : 1,
          outcome: entry.outcome || null,
          deathReason: entry.deathCause || entry.deathReason || null,
          recordingSha256: parsed.sha256,
          status: docStatus,
          verdict: extVerdict,
          verdictBy,
          verifiedAt: verifiedAtIso,
          publicRecordingPath,
          thumb: entry.thumb || null,
          tags: Array.isArray(entry.tags) ? entry.tags : [],
          kind: 'complete',
          visible: true,
          source: manifest.source,
          batch: manifest.batch,
          lineageId: entry.lineage || entry.lineageId || null,
          importedAt: nowIso,
          createdAt: toIso(entry.createdAt) || toIso(hdr.startedAt) || nowIso,
        };
        if (hdr.parentGameId) {
          gameDoc.parentGameId = hdr.parentGameId;
          gameDoc.forkTurn = hdr.forkTurn != null ? Number(hdr.forkTurn) : 0;
        }

        try {
          await gameRef.create(gameDoc);
        } catch (e) {
          if (e && (e.code === 6 || String(e.message || '').includes('ALREADY_EXISTS'))) {
            results.push({ gameId, result: 'duplicate' });
            continue;
          }
          throw e;
        }

        if (extVerdict) {
          await db.collection('verdicts').doc(gameId).set({
            gameId,
            verdict: extVerdict,
            verdictBy,
            verifiedAt: verifiedAtIso,
            recordingSha256: parsed.sha256,
            frames,
            external: true,
            source: manifest.source,
            batch: manifest.batch,
          });
        }

        results.push({ gameId, result: 'imported' });
      }

      await batchRef.update({
        status: 'done',
        completedAt: new Date().toISOString(),
        results,
      });
    } catch (err) {
      console.error('[api1] processImportBatch failed:', batchId, err);
      await batchRef.update({
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: String(err && err.message ? err.message : err),
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    }
  },
);
