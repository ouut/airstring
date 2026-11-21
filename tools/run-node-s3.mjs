// airstring S3 headless harness: drive the WASM build in Node and
// collect everything the run produces, in three feed modes.
//
//   node tools/run-node-s3.mjs --keys <file>
//       [--mode replay|queue|async]
//       [--seed 42] [--date 1700000000]
//       [--options 'name:fleck,role:valkyrie,...']
//       [--out <prefix>] [--events <file>] [--quiet-keys]
//       [--chunk N] [--delay MS] [--initial-delay MS]
//       [--saves <dir>]
//
// Modes:
//   replay -- the key file is placed in MEMFS and FLECK_REPLAY does
//             the feeding inside the game (the native arrangement;
//             the S2 regression path).
//   queue  -- the whole stream is placed in the S3 key queue up
//             front and the input is closed immediately: the shim
//             never suspends, exhaustion is EOF (S2 queue semantics
//             through the S3 API).
//   async  -- the stream is pushed in chunks while the game runs;
//             whenever the queue drains before the next chunk the
//             game suspends inside nhgetch (ASYNCIFY) instead of
//             exiting, and resumes when the chunk lands.  The
//             harness reports how many times it suspended
//             (__airstring_key_waits).
//
// Outputs (with --out PREFIX): PREFIX.frames / PREFIX.rng read back
// from MEMFS (the canonical record), plus PREFIX.stream.frames /
// PREFIX.stream.rng assembled from the push-stream callbacks --
// the harness checks the two copies agree byte for byte.  The
// contract event stream goes to --events (JSONL).  With
// --saves DIR, any save files left in MEMFS /save are exported
// there as blobs.
//
// Completion semantics (S3 finding): with ASYNCIFY the module
// factory promise resolves at the first stack unwind -- long
// before main() is done -- and the game's exit() under the
// kept-alive runtime does not settle it either.  So in queue and
// async modes the harness waits for the shim's completion signal
// (__airstring_game_over, fired on both end paths) and ignores
// the factory promise except for real exceptions.  In replay
// mode no async import is ever called, so the factory promise
// keeps its S2 meaning and stays authoritative there.
import fs from 'node:fs';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);
function arg(name, dflt) {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : dflt;
}
const keysPath = arg('keys', null);
if (!keysPath) {
    console.error('usage: run-node-s3.mjs --keys <file> [--mode replay|queue|async] [--seed N] [--out PREFIX] [--events FILE] [--saves DIR]');
    process.exit(2);
}
const mode = arg('mode', 'async');
const seed = parseInt(arg('seed', '42'), 10);
const date = parseInt(arg('date', '1700000000'), 10);
const options = arg('options',
    'name:fleck,role:valkyrie,race:human,gender:female,align:neutral');
const outPrefix = arg('out', null);
const eventsPath = arg('events', null);
const eventsSummaryPath = arg('events-summary', null);
const savesDir = arg('saves', null);
const quietKeys = argv.includes('--quiet-keys');
const chunkSize = parseInt(arg('chunk', '8192'), 10);
const delayMs = parseInt(arg('delay', '2'), 10);
const initialDelayMs = parseInt(arg('initial-delay', '0'), 10);

const keysBytes = fs.readFileSync(keysPath);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const summaryOnly = !!(eventsSummaryPath && !eventsPath);
const events = [];
const evSummary = {
    lastMapWithHero: null,
    lastMapAny: null,
    sawRip: false,
    sawQuest: false,
    recentMsgs: [],
    lastTexts: [],
    eventCount: 0,
};
globalThis.__airstring_event = (json) => {
    if (quietKeys && json.startsWith('{"t":"key"'))
        return;
    if (summaryOnly) {
        evSummary.eventCount++;
        if (json.startsWith('{"t":"map"')) {
            try {
                const ev = JSON.parse(json);
                if (Array.isArray(ev.rows)) {
                    evSummary.lastMapAny = ev;
                    if (ev.rows.some((r) => String(r).includes('@'))) {
                        evSummary.lastMapWithHero = ev;
                    }
                }
            } catch (_) { }
        } else if (json.startsWith('{"t":"rip"')) {
            evSummary.sawRip = true;
        } else if (json.startsWith('{"t":"message"') || json.startsWith('{"t":"raw"')) {
            try {
                const ev = JSON.parse(json);
                if (typeof ev.text === 'string') {
                    const txt = ev.text.trim();
                    if (txt) {
                        evSummary.recentMsgs.push(txt);
                        if (evSummary.recentMsgs.length > 20) evSummary.recentMsgs.shift();
                        if (/quest|nemesis|bell of opening|candelabrum/i.test(txt)) {
                            evSummary.sawQuest = true;
                        }
                    }
                }
            } catch (_) { }
        } else if (json.startsWith('{"t":"text"')) {
            try {
                const ev = JSON.parse(json);
                if (Array.isArray(ev.lines)) {
                    const lines = ev.lines
                        .map((l) => (typeof l === 'string' ? l : (l && l.text) || '').trim())
                        .filter(Boolean);
                    if (lines.length) {
                        evSummary.lastTexts.push(lines);
                        if (evSummary.lastTexts.length > 4) evSummary.lastTexts.shift();
                    }
                }
            } catch (_) { }
        }
        return;
    }
    events.push(json);
};

/* shim completion signal (see header note) */
let gameOverResolve;
const gameOverPromise = new Promise((r) => { gameOverResolve = r; });
globalThis.__airstring_game_over = (code) => gameOverResolve(code);

/* push-stream collectors (pre-s3.js keeps these if predefined) */
const frameChunks = [];
const rngChunks = [];
globalThis.__airstring_frame = (text) => { if (!summaryOnly) frameChunks.push(text); };
globalThis.__airstring_rngline = (line) => { if (!summaryOnly) rngChunks.push(line); };

if (mode === 'queue') {
    globalThis.__airstring_key_queue =
        { bytes: Array.from(keysBytes), pos: 0, closed: true };
} else if (mode === 'async') {
    globalThis.__airstring_key_queue =
        { bytes: [], pos: 0, closed: false };
}
globalThis.__airstring_config = {
    seed, date, options, mode,
    exportPath: '/fleck.frames',
    rngPath: summaryOnly ? undefined : '/fleck.rng',
    keysBase64: mode === 'replay'
        ? Buffer.from(keysBytes).toString('base64') : undefined,
};

const { default: createModule } =
    await import(new URL('../out/nethack.js', import.meta.url));

const M = {
    print: (s) => console.log('[stdout]', s),
    printErr: (s) => console.log('[stderr]', s),
};

let status = 'no-exit';
const runPromise = (async () => {
    try {
        await createModule(M);
        return 'main-returned';
    } catch (e) {
        if (e && e.name === 'ExitStatus')
            return 'exit-status-' + e.status;
        return 'exception: ' + (e && e.name ? e.name : typeof e)
            + ' status=' + (e && 'status' in e ? e.status : '(none)')
            + ' message=' + (e && e.message ? e.message : String(e));
    }
})();

if (mode === 'async') {
    /* the push/close API is installed by pre-s3.js during module
     * instantiation (preRun); wait until it exists */
    for (let i = 0;
         typeof globalThis.__airstring_push_keys !== 'function'; i++) {
        if (i > 2000)
            throw new Error('key-queue API never appeared');
        await sleep(5);
    }
    if (initialDelayMs > 0)
        await sleep(initialDelayMs);
    for (let off = 0; off < keysBytes.length; off += chunkSize) {
        globalThis.__airstring_push_keys(
            keysBytes.subarray(off, off + chunkSize));
        if (delayMs > 0)
            await sleep(delayMs);
    }
    globalThis.__airstring_close_keys();
}
if (mode === 'replay') {
    status = await runPromise;
} else {
    /* queue/async: the factory promise resolves at the first
       ASYNCIFY unwind, so only its real exceptions are meaningful;
       completion is the shim's game_over signal. */
    const timeoutMs = parseInt(arg('timeout', '600000'), 10);
    status = await Promise.race([
        gameOverPromise.then((code) => 'game-over-' + code),
        runPromise.then((s) => s.startsWith('exception')
            ? s : new Promise(() => {})),
        sleep(timeoutMs).then(() => 'timeout'),
    ]);
}
console.log('[harness] run ended:', status);
console.log('[harness] mode:', mode,
            ' keys in stream:', keysBytes.length,
            ' queue pos:', globalThis.__airstring_key_queue
                ? globalThis.__airstring_key_queue.pos : '(replay)',
            ' key waits (suspensions):', globalThis.__airstring_key_waits);

if (eventsSummaryPath) {
    fs.writeFileSync(eventsSummaryPath, JSON.stringify(evSummary));
    console.log('[harness] events-summary:', evSummary.eventCount, '->', eventsSummaryPath);
}
if (eventsPath) {
    fs.writeFileSync(eventsPath, events.join('\n') + '\n');
    console.log('[harness] events:', events.length, '->', eventsPath);
} else if (!eventsSummaryPath) {
    console.log('[harness] events:', events.length);
}

/* canonical MEMFS record vs push-streamed copy */
if (summaryOnly) {
    const data = M.FS.readFile('/fleck.frames');
    console.log(`[harness] /fleck.frames: ${data.length} bytes, sha256 ${sha256(data)}`);
    if (outPrefix) fs.writeFileSync(outPrefix + '.frames', data);
} else {
    const streamed = {
        '.frames': Buffer.from(frameChunks.join(''), 'utf8'),
        '.rng': Buffer.from(rngChunks.join(''), 'utf8'),
    };
    for (const [memPath, suffix] of [['/fleck.frames', '.frames'],
                                     ['/fleck.rng', '.rng']]) {
        try {
            const data = M.FS.readFile(memPath);
            const lines = data.length
                ? Buffer.from(data).toString('utf8').split('\n').length - 1 : 0;
            console.log(`[harness] ${memPath}: ${data.length} bytes, ${lines} lines, sha256 ${sha256(data)}`);
            console.log(`[harness] streamed${suffix}: ${streamed[suffix].length} bytes, sha256 ${sha256(streamed[suffix])}, identical-to-memfs: ${Buffer.from(data).equals(streamed[suffix])}`);
            if (outPrefix) {
                fs.writeFileSync(outPrefix + suffix, data);
                fs.writeFileSync(outPrefix + '.stream' + suffix, streamed[suffix]);
            }
        } catch (e) {
            console.log(`[harness] ${memPath}: not readable (${e.message}); streamed${suffix}: ${streamed[suffix].length} bytes`);
            if (outPrefix)
                fs.writeFileSync(outPrefix + '.stream' + suffix, streamed[suffix]);
        }
    }
}

/* save export */
if (savesDir) {
    fs.mkdirSync(savesDir, { recursive: true });
    const saves = globalThis.__airstring_list_saves();
    console.log('[harness] saves in MEMFS /save:', saves.length
        ? saves.join(', ') : '(none)');
    for (const name of saves) {
        const blob = globalThis.__airstring_read_save(name);
        fs.writeFileSync(savesDir + '/' + name, blob);
        console.log(`[harness] save exported: ${name} ${blob.length} bytes, sha256 ${sha256(blob)}`);
    }
}

/* The runtime is kept alive by design (EXIT_RUNTIME=0 + ASYNCIFY);
   the harness is done, so leave explicitly. */
process.exit(
    (status === 'game-over-0' || status === 'main-returned'
     || status === 'exit-status-0') ? 0 : 1);
