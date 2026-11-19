// airstring S6 verification core.
//
// Given one recording (JSONL, docs/recording-format.md), decide
// whether the recorded key stream really reproduces the recorded
// game on the pinned wasm build:
//
//   parse -> structural checks -> rebuild the full key stream ->
//   headless replay via tools/run-node-s3.mjs (replay mode, the
//   S3/S4 passport path) -> compare the replayed per-frame [hero]
//   hash= sequence against the recorded turn.hash sequence.
//
// Verdicts are binary per the M0 spec: 'verified' | 'rejected',
// always with a human-readable reason and a per-frame summary.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PINNED_DATE = 1700000000; // spec SS2.2, passport value
export const VERIFIER_ID = 'airstring-verifier/1 (S6)';

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function fail(reason, extra) {
  return { ok: false, reason, ...(extra || {}) };
}

/* ---------------- parsing & structural checks ---------------- */

export function parseRecording(text) {
  const lines = String(text).split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return fail('empty-recording');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    try { records.push(JSON.parse(lines[i])); }
    catch (e) { return fail('malformed-jsonl: line ' + (i + 1)); }
  }
  const header = records[0];
  if (!header || header.k !== 'header')
    return fail('missing-header: first record is not a header');
  if (records.filter((r) => r.k === 'header').length !== 1)
    return fail('multiple-headers');
  const end = records[records.length - 1];
  if (!end || end.k !== 'end')
    return fail('missing-end: last record is not an end record');
  if (records.filter((r) => r.k === 'end').length !== 1)
    return fail('multiple-ends');
  const turns = records.filter((r) => r.k === 'turn');
  const tails = records.filter((r) => r.k === 'tail');
  if (tails.length > 1) return fail('multiple-tails');
  if (tails.length === 1 &&
      records.indexOf(tails[0]) !== records.length - 2)
    return fail('tail-not-before-end');
  for (const r of records) {
    if (!['header', 'turn', 'tail', 'end'].includes(r.k))
      return fail('unknown-record-kind: ' + r.k);
  }
  // turn sequence: turn = 1..N, frame = turn-1 (0-based frame index)
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].turn !== i + 1 || turns[i].frame !== i)
      return fail('turn-sequence: record ' + (i + 1) +
        ' has turn=' + turns[i].turn + ' frame=' + turns[i].frame);
    if (!/^[0-9a-f]{64}$/.test(turns[i].hash || ''))
      return fail('bad-turn-hash: turn ' + turns[i].turn);
  }
  // key material: strict base64, and the totals must agree with
  // the end record (all counts are claimed by the recording itself)
  const keyParts = [];
  let keysTotal = 0;
  for (const r of [...turns, ...tails]) {
    if (typeof r.keys !== 'string' || !B64.test(r.keys) ||
        r.keys.length % 4 !== 0)
      return fail('bad-keys-encoding');
    const buf = Buffer.from(r.keys, 'base64');
    keyParts.push(buf);
    keysTotal += buf.length;
  }
  if (end.keysTotal !== keysTotal)
    return fail('keysTotal-mismatch: end claims ' + end.keysTotal +
      ', records carry ' + keysTotal);
  if (end.turns !== turns.length)
    return fail('turn-count-mismatch: end claims ' + end.turns +
      ', recording carries ' + turns.length);
  if (end.frames !== turns.length)
    return fail('frame-count-mismatch: end claims ' + end.frames +
      ' frames for ' + turns.length + ' turns');
  // controlled conditions (spec SS2.5): pinned date, 64-bit seed,
  // an options string the replay can be fed with
  if (header.date !== PINNED_DATE)
    return fail('date-not-pinned: header.date=' + header.date);
  if (!/^\d+$/.test(String(header.seed)) ||
      BigInt(header.seed) >= (1n << 64n))
    return fail('bad-seed: ' + header.seed);
  if (typeof header.options !== 'string' || !header.options)
    return fail('bad-options');
  if (typeof header.gameId !== 'string' || !header.gameId)
    return fail('bad-gameId');
  return {
    ok: true, records, header, turns,
    tail: tails[0] || null, end,
    keys: Buffer.concat(keyParts),
  };
}

/* ---------------- headless replay ---------------- */

function frameHashes(framesText) {
  const hashes = [];
  for (const block of String(framesText).split(/^frame \d+$/m).slice(1)) {
    const m = block.match(/^hash=([0-9a-f]{64})$/m);
    hashes.push(m ? m[1] : null);
  }
  return hashes;
}

export function replay(root, { seed, date, options, keys },
                       timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airstring-verify-'));
    const keysFile = path.join(tmp, 'keys.bin');
    const outPrefix = path.join(tmp, 'replay');
    fs.writeFileSync(keysFile, keys);
    const child = spawn('node', [
      path.join(root, 'tools', 'run-node-s3.mjs'),
      '--mode', 'replay',
      '--keys', keysFile,
      '--seed', String(seed),
      '--date', String(date),
      '--options', String(options),
      '--out', outPrefix,
      '--quiet-keys',
    ], { cwd: root });
    let log = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('replay-timeout'), { code: 'replay-timeout' }));
    }, timeoutMs);
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const frames = fs.readFileSync(outPrefix + '.frames', 'utf8');
        resolve({ hashes: frameHashes(frames), exitCode: code, log });
      } catch (e) {
        reject(Object.assign(
          new Error('replay-produced-no-frames: exit=' + code),
          { code: 'replay-failed', log }));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
}

/* ---------------- top level ---------------- */

export async function verifyRecording(text, { root }) {
  const recordingSha256 = crypto.createHash('sha256')
    .update(String(text)).digest('hex');
  const base = {
    gameId: null, recordingSha256, seed: null, seedSource: null,
    restored: null, framesCompared: 0, framesMatched: 0,
    firstMismatch: null, endStatus: null,
    verifiedAt: new Date().toISOString(), verifier: VERIFIER_ID,
  };
  const parsed = parseRecording(text);
  if (!parsed.ok)
    return { ...base, verdict: 'rejected', reason: parsed.reason };
  const { header, turns, end } = parsed;
  Object.assign(base, {
    gameId: header.gameId, seed: String(header.seed),
    seedSource: header.seedSource ?? null,
    restored: header.restored ?? null, endStatus: end.status,
  });

  // A restored game's key stream is not self-contained (the
  // recording starts at the restore point; replay would need the
  // parent save). Per docs/recording-format.md and s5-report SS8
  // such recordings must be linked to their parent before they can
  // be verified; standalone they are rejected for that stated
  // reason -- this is a self-containment limit, NOT a hash
  // mismatch and NOT evidence of tampering.
  if (header.restored)
    return {
      ...base, verdict: 'rejected',
      reason: 'restored-not-self-contained: header.restored=' +
        JSON.stringify(header.restored) +
        '; key stream starts at the restore point, verification' +
        ' requires the parent save/recording (parent linkage)',
    };

  let rep;
  try {
    rep = await replay(root, {
      seed: header.seed, date: header.date,
      options: header.options, keys: parsed.keys,
    });
  } catch (e) {
    return {
      ...base, verdict: 'rejected',
      reason: 'replay-failed: ' + (e.code || e.message),
    };
  }
  base.framesCompared = Math.min(rep.hashes.length, turns.length);
  for (let i = 0; i < base.framesCompared; i++) {
    if (rep.hashes[i] === turns[i].hash) base.framesMatched++;
    else if (!base.firstMismatch) {
      base.firstMismatch = {
        frame: turns[i].frame, turn: turns[i].turn,
        expected: turns[i].hash, actual: rep.hashes[i],
      };
    }
  }
  if (rep.hashes.length !== turns.length)
    return {
      ...base, verdict: 'rejected',
      reason: 'frame-count-mismatch: replay produced ' +
        rep.hashes.length + ' frames, recording claims ' +
        turns.length,
    };
  if (base.firstMismatch)
    return {
      ...base, verdict: 'rejected',
      reason: 'hash-mismatch at frame ' + base.firstMismatch.frame +
        ' (turn ' + base.firstMismatch.turn + ')',
    };
  return {
    ...base, verdict: 'verified',
    reason: 'hash-chain: all ' + turns.length +
      ' frame hashes reproduced by headless replay',
  };
}
