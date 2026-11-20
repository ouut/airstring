// Minimal Google Cloud access for the verifier, REST-only (no
// SDK dependency): an OAuth2 access token comes from the Cloud
// Run metadata server (or GOOGLE_ACCESS_TOKEN when provided, e.g.
// for local experiments with gcloud auth print-access-token).
//
// These paths are used only when VERIFIER_STORE=firestore or a
// /verify request names a storagePath. They cannot be exercised
// without real credentials, so the local S6 gates run against the
// file store instead; treat this file as code-reviewed, not
// gate-verified (see REPORT.md).
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/' +
  'service-accounts/default/token';

let cached = null; // {token, exp}
export async function accessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN)
    return process.env.GOOGLE_ACCESS_TOKEN;
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  const res = await fetch(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!res.ok)
    throw new Error('metadata-token: HTTP ' + res.status);
  const body = await res.json();
  cached = {
    token: body.access_token,
    exp: Date.now() + (body.expires_in || 3600) * 1000,
  };
  return cached.token;
}

export function projectId() {
  return process.env.FIREBASE_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT || 'airstring-nethack';
}

/* ---- Firestore REST value encoding (subset we write) ---- */
function fv(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((x) => fv(x)) } };
  }
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, x] of Object.entries(v)) fields[k] = fv(x);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fieldsOf(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = fv(v);
  return fields;
}

async function firestorePatch(collection, docId, obj) {
  const project = projectId();
  const base = 'https://firestore.googleapis.com/v1/projects/' +
    project + '/databases/(default)/documents/' + collection +
    '/' + encodeURIComponent(docId);
  const mask = Object.keys(obj)
    .map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k))
    .join('&');
  const res = await fetch(base + '?' + mask, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer ' + (await accessToken()),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ fields: fieldsOf(obj) }),
  });
  if (!res.ok)
    throw new Error('firestore-patch ' + collection + '/' + docId +
      ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

async function firestoreGet(collection, docId) {
  const project = projectId();
  const url = 'https://firestore.googleapis.com/v1/projects/' +
    project + '/databases/(default)/documents/' + collection +
    '/' + encodeURIComponent(docId);
  const res = await fetch(url, {
    headers: { authorization: 'Bearer ' + (await accessToken()) },
  });
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error('firestore-get: HTTP ' + res.status);
  const doc = await res.json();
  const out = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    out[k] = v.stringValue ?? v.integerValue ?? v.booleanValue ??
      v.timestampValue ?? null;
  }
  return out;
}

/* Verdict store backed by Firestore: verdicts/{gameId} holds the
 * full verdict; games/{gameId} gets the public summary + status
 * flip (this is the only writer of games.status after creation --
 * client rules forbid it, Admin/IAM access bypasses rules). */
export class FirestoreVerdictStore {
  async get(gameId, recordingSha256) {
    const doc = await firestoreGet('verdicts', gameId);
    if (!doc || doc.recordingSha256 !== recordingSha256) return null;
    return doc;
  }
  async put(record) {
    await firestorePatch('verdicts', record.gameId, {
      recordingSha256: record.recordingSha256,
      verdict: record.verdict,
      verdictReason: record.reason,
      seed: record.seed,
      seedSource: record.seedSource,
      framesCompared: record.framesCompared,
      framesMatched: record.framesMatched,
      firstMismatch: record.firstMismatch,
      endStatus: record.endStatus,
      verifiedAt: record.verifiedAt,
      verifier: record.verifier,
    });
    const gamePatch = {
      status: record.verdict,
      verdictReason: record.reason,
      verifiedAt: record.verifiedAt,
      framesCompared: record.framesCompared,
      framesMatched: record.framesMatched,
      recordingSha256: record.recordingSha256,
    };
    if (record.verdict === 'verified') {
      if (record.publicRecordingPath) {
        gamePatch.publicRecordingPath = record.publicRecordingPath;
      }
      if (record.thumb) gamePatch.thumb = record.thumb;
      if (typeof record.maxDlvl === 'number') gamePatch.maxDlvl = record.maxDlvl;
      if (record.outcome) gamePatch.outcome = record.outcome;
      if (record.deathReason) gamePatch.deathReason = record.deathReason;
      if (Array.isArray(record.tags)) gamePatch.tags = record.tags;
    }
    await firestorePatch('games', record.gameId, gamePatch);
  }
}

/* Download one object from Cloud Storage (JSON API, alt=media).
 * Bucket: STORAGE_BUCKET env, or the project's default bucket. */
export async function fetchStorageObject(objectPath, bucket) {
  const b = bucket || process.env.STORAGE_BUCKET ||
    projectId() + '.firebasestorage.app';
  const url = 'https://storage.googleapis.com/download/storage/' +
    'v1/b/' + encodeURIComponent(b) + '/o/' +
    encodeURIComponent(objectPath) + '?alt=media';
  const res = await fetch(url, {
    headers: { authorization: 'Bearer ' + (await accessToken()) },
  });
  if (!res.ok)
    throw new Error('storage-get ' + objectPath + ': HTTP ' +
      res.status);
  return await res.text();
}

/* Publish a verified recording to public-recordings/{gameId}.jsonl.
 * Uses ifGenerationMatch=0 so roles/storage.objectCreator (create-only,
 * no overwrite/delete) suffices; HTTP 412 means already published. */
export async function uploadPublicRecording(gameId, recordingText, bucket) {
  const b = bucket || process.env.STORAGE_BUCKET ||
    projectId() + '.firebasestorage.app';
  const objectPath = 'public-recordings/' + gameId + '.jsonl';
  const url = 'https://storage.googleapis.com/upload/storage/v1/b/' +
    encodeURIComponent(b) + '/o?uploadType=media&name=' +
    encodeURIComponent(objectPath) + '&ifGenerationMatch=0';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + (await accessToken()),
      'content-type': 'application/x-ndjson',
    },
    body: String(recordingText),
  });
  if (res.status === 412) {
    /* Already exists: idempotent skip under objectCreator */
    return objectPath;
  }
  if (!res.ok) {
    throw new Error('storage-put ' + objectPath + ': HTTP ' +
      res.status + ' ' + (await res.text()).slice(0, 200));
  }
  return objectPath;
}
