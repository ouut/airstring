// airstring S2 headless harness: drive the WASM build in Node with
// a scripted key stream and collect everything the run produces.
//
//   node tools/run-node-s2.mjs --keys <file> [--mode replay|queue]
//       [--seed 42] [--date 1700000000]
//       [--options 'name:fleck,role:valkyrie,...']
//       [--out <prefix>] [--events <file>] [--quiet-keys]
//
// Modes:
//   replay -- the key file is placed in MEMFS and FLECK_REPLAY does
//             the feeding inside the game (the native arrangement).
//   queue  -- the same bytes are fed through the JS key queue and
//             the shim's funnel (the product path).  Both modes must
//             produce byte-identical exports for the same stream.
//
// Outputs (with --out PREFIX): PREFIX.frames / PREFIX.rng read back
// from MEMFS; the contract event stream goes to --events (JSONL).
import fs from 'node:fs';

const argv = process.argv.slice(2);
function arg(name, dflt) {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : dflt;
}
const keysPath = arg('keys', null);
if (!keysPath) {
    console.error('usage: run-node-s2.mjs --keys <file> [--mode replay|queue] [--seed N] [--out PREFIX] [--events FILE]');
    process.exit(2);
}
const mode = arg('mode', 'replay');
const seed = parseInt(arg('seed', '42'), 10);
const date = parseInt(arg('date', '1700000000'), 10);
const options = arg('options',
    'name:fleck,role:valkyrie,race:human,gender:female,align:neutral');
const outPrefix = arg('out', null);
const eventsPath = arg('events', null);
const quietKeys = argv.includes('--quiet-keys');

const keysBytes = fs.readFileSync(keysPath);

const events = [];
globalThis.__airstring_event = (json) => {
    if (quietKeys && json.startsWith('{"t":"key"'))
        return;
    events.push(json);
};
globalThis.__airstring_key_queue = { bytes: keysBytes, pos: 0 };
globalThis.__airstring_config = {
    seed, date, options, mode,
    exportPath: '/fleck.frames',
    rngPath: '/fleck.rng',
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
try {
    await createModule(M);
    status = 'main-returned';
} catch (e) {
    if (e && e.name === 'ExitStatus')
        status = 'exit-status-' + e.status;
    else
        status = 'exception: ' + (e && e.name ? e.name : typeof e)
            + ' status=' + (e && 'status' in e ? e.status : '(none)')
            + ' message=' + (e && e.message ? e.message : String(e));
}
console.log('[harness] run ended:', status);
console.log('[harness] keys in stream:', keysBytes.length,
            ' queue pos:', globalThis.__airstring_key_queue.pos);

if (eventsPath)
    fs.writeFileSync(eventsPath, events.join('\n') + '\n');
console.log('[harness] events:', events.length,
            eventsPath ? '-> ' + eventsPath : '');

for (const [memPath, suffix] of [['/fleck.frames', '.frames'],
                                 ['/fleck.rng', '.rng']]) {
    try {
        const data = M.FS.readFile(memPath, { encoding: 'utf8' });
        const lines = data.length ? data.split('\n').length - 1 : 0;
        console.log(`[harness] ${memPath}: ${data.length} bytes, ${lines} lines`);
        if (outPrefix)
            fs.writeFileSync(outPrefix + suffix, data);
    } catch (e) {
        console.log(`[harness] ${memPath}: not readable (${e.message})`);
    }
}
