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
export const VERIFIER_ID = 'airstring-verifier/2 (Phase 2)';

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

/* ---------------- headless replay & summary extraction ---------------- */

function frameHashes(framesText) {
  const hashes = [];
  for (const block of String(framesText).split(/^frame \d+$/m).slice(1)) {
    const m = block.match(/^hash=([0-9a-f]{64})$/m);
    hashes.push(m ? m[1] : null);
  }
  return hashes;
}

function buildAsciiThumb(mapEv) {
  if (!mapEv || !Array.isArray(mapEv.rows) || !mapEv.rows.length) return null;
  const W = 35, H = 11;
  const rows = mapEv.rows;
  const colors = Array.isArray(mapEv.colors) ? mapEv.colors : [];
  let hx = 40, hy = 10;
  for (let y = 0; y < rows.length; y++) {
    const x = String(rows[y] || '').indexOf('@');
    if (x >= 0) { hx = x; hy = y; break; }
  }
  const mapH = Math.min(21, rows.length);
  const x0 = Math.max(0, Math.min(80 - W, hx - Math.floor(W / 2)));
  const y0 = Math.max(0, Math.min(Math.max(0, mapH - H), hy - Math.floor(H / 2)));
  const r = [];
  const c = [];
  for (let dy = 0; dy < H; dy++) {
    const my = y0 + dy;
    const line = String(rows[my] || '').padEnd(80, ' ');
    const cline = Array.isArray(colors[my]) ? colors[my] : [];
    r.push(line.slice(x0, x0 + W));
    let cs = '';
    for (let dx = 0; dx < W; dx++) {
      const col = cline[x0 + dx];
      cs += (typeof col === 'number' ? (col & 0xf) : 7).toString(16);
    }
    c.push(cs);
  }
  const json = JSON.stringify({ w: W, h: H, r, c });
  return Buffer.byteLength(json, 'utf8') <= 2048 ? json : null;
}

export function extractSummary(framesText, eventsText, header) {
  let maxDlvl = 1;
  for (const m of String(framesText || '').matchAll(/\bdlevel=(\d+)/g)) {
    const d = parseInt(m[1], 10);
    if (d > maxDlvl) maxDlvl = d;
  }

  let lastMapWithHero = null;
  let lastMapAny = null;
  let sawRip = false;
  let sawQuest = false;
  const recentMsgs = [];
  const lastTexts = [];

  for (const line of String(eventsText || '').split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (e) { continue; }
    if (ev.t === 'map' && Array.isArray(ev.rows)) {
      lastMapAny = ev;
      if (ev.rows.some((r) => String(r).includes('@'))) {
        lastMapWithHero = ev;
      }
    } else if (ev.t === 'rip') {
      sawRip = true;
    } else if ((ev.t === 'message' || ev.t === 'raw') && typeof ev.text === 'string') {
      const txt = ev.text.trim();
      if (txt) {
        recentMsgs.push(txt);
        if (recentMsgs.length > 20) recentMsgs.shift();
        if (/quest|nemesis|bell of opening|candelabrum/i.test(txt)) sawQuest = true;
      }
    } else if (ev.t === 'text' && Array.isArray(ev.lines)) {
      const lines = ev.lines
        .map((l) => (typeof l === 'string' ? l : (l && l.text) || '').trim())
        .filter(Boolean);
      if (lines.length) {
        lastTexts.push(lines);
        if (lastTexts.length > 4) lastTexts.shift();
      }
    }
  }

  const allTailLines = [...lastTexts.flat(), ...recentMsgs];
  const joined = allTailLines.join('\n');

  let outcome = 'quit';
  let deathReason = 'quit';

  if (/ascended|demigod|demigoddess/i.test(joined)) {
    outcome = 'ascended';
    deathReason = 'ascended';
  } else if (sawRip ||
      /killed by|you die|died of|choked on|petrified|drowned|poisoned|burned to a crisp|starved|slain by|fell into|disintegrated|crushed/i.test(joined)) {
    if (/\bquit\b/i.test(joined) && !sawRip && !/killed by|slain by/i.test(joined)) {
      outcome = 'quit';
      deathReason = 'quit';
    } else {
      outcome = 'died';
      const causeLine = allTailLines.find((l) =>
        /killed by|died of|choked on|petrified|drowned|poisoned|burned|starved|slain by|fell into|disintegrated|crushed/i.test(l));
      deathReason = (causeLine || 'died').slice(0, 120);
    }
  } else if (/escaped the dungeon/i.test(joined)) {
    outcome = 'quit';
    deathReason = 'escaped the dungeon';
  } else if (/really quit|you quit/i.test(joined)) {
    outcome = 'quit';
    deathReason = 'quit';
  }

  const roleMatch = /\brole:([a-z]+)/i.exec(String(header && header.options || ''));
  const role = roleMatch ? roleMatch[1].toLowerCase() : null;
  const tags = [];
  if (outcome === 'ascended') tags.push('stage20-ascension');
  if (sawQuest && role) tags.push('quest-' + role);
  if (maxDlvl >= 10) tags.push('deep-run');
  if (header && header.parentGameId) tags.push('fork');

  const thumb = buildAsciiThumb(lastMapWithHero || lastMapAny);
  return { thumb, maxDlvl, outcome, deathReason, tags };
}

export function replay(root, { seed, date, options, keys },
                       timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airstring-verify-'));
    const keysFile = path.join(tmp, 'keys.bin');
    const outPrefix = path.join(tmp, 'replay');
    const eventsFile = path.join(tmp, 'events.jsonl');
    fs.writeFileSync(keysFile, keys);
    const child = spawn('node', [
      path.join(root, 'tools', 'run-node-s3.mjs'),
      '--mode', 'replay',
      '--keys', keysFile,
      '--seed', String(seed),
      '--date', String(date),
      '--options', String(options),
      '--out', outPrefix,
      '--events', eventsFile,
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
        let eventsText = '';
        try { eventsText = fs.readFileSync(eventsFile, 'utf8'); } catch (_) { }
        resolve({
          hashes: frameHashes(frames),
          framesText: frames,
          eventsText,
          exitCode: code,
          log,
        });
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
  const summary = extractSummary(rep.framesText, rep.eventsText, header);
  return {
    ...base,
    ...summary,
    verdict: 'verified',
    reason: 'hash-chain: all ' + turns.length +
      ' frame hashes reproduced by headless replay',
  };
}
