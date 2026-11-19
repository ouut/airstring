// Verdict stores: the persistence behind the verifier's
// idempotency guarantee. Interface:
//
//   get(gameId, recordingSha256) -> stored verdict record | null
//   put(verdictRecord)           -> persist (keyed by gameId)
//
// A stored record is returned only when the recording hash also
// matches, so re-verifying the same recording is a pure lookup
// (same verdict, same summary, no replay, no duplicate side
// effects), while a different recording under an already-used
// gameId is verified fresh and supersedes the old record.
import fs from 'node:fs';
import path from 'node:path';

export class MemoryVerdictStore {
  constructor() { this.map = new Map(); }
  async get(gameId, sha) {
    const rec = this.map.get(gameId);
    return rec && rec.recordingSha256 === sha ? rec : null;
  }
  async put(record) { this.map.set(record.gameId, record); }
}

export class FileVerdictStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
    } catch (e) { /* first run: no file yet */ }
  }
  async get(gameId, sha) {
    const rec = this.map.get(gameId);
    return rec && rec.recordingSha256 === sha ? rec : null;
  }
  async put(record) {
    this.map.set(record.gameId, record);
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp,
      JSON.stringify(Object.fromEntries(this.map), null, 1));
    fs.renameSync(tmp, this.file); // atomic replace
  }
}

export async function createStore() {
  const kind = process.env.VERIFIER_STORE || 'file';
  if (kind === 'memory') return new MemoryVerdictStore();
  if (kind === 'firestore') {
    const { FirestoreVerdictStore } = await import('./gcp.mjs');
    return new FirestoreVerdictStore();
  }
  const file = process.env.VERDICT_FILE ||
    path.join(process.cwd(), '.verdicts.json');
  return new FileVerdictStore(file);
}
