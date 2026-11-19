// airstring S2: run-parameter injection + JS side of the window
// contract bridge.
//
// Emscripten 6.0 neither reads process.env nor honors an ENV object
// passed to the module factory (the runtime overwrites Module.ENV
// with its own object during init); the working injection point is
// a preRun callback, which runs after the runtime ENV object exists
// but before main() (proven in S1).
//
// The harness (tools/run-node-s2.mjs) or the product page sets
// globalThis.__airstring_config before instantiating the module:
//   {
//     seed: 42, date: 1700000000,
//     options: 'name:fleck,role:valkyrie,race:human,gender:female,align:neutral',
//     exportPath: '/fleck.frames', rngPath: '/fleck.rng',
//     mode: 'replay' | 'queue',
//     keysBase64: '...'        // replay mode: the key stream file
//   }
// and globalThis.__airstring_event(json) to receive contract events.
// In queue mode the harness also sets
// globalThis.__airstring_key_queue = { bytes: Uint8Array, pos: 0 }.
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
    var cfg = globalThis.__airstring_config || {};
    var ENV = Module.ENV;

    ENV.FLECK_SEED = String(cfg.seed != null ? cfg.seed : 42);
    ENV.FLECK_DATE = String(cfg.date != null ? cfg.date : 1700000000);
    ENV.FLECK_EXPORT = cfg.exportPath || '/fleck.frames';
    ENV.FLECK_RNGLOG = cfg.rngPath || '/fleck.rng';
    ENV.NETHACKOPTIONS = cfg.options
        || 'name:fleck,role:valkyrie,race:human,gender:female,align:neutral';
    // mail.c getmailstatus() dereferences getpwuid()->pw_name without
    // a NULL check when MAIL is unset; Emscripten's getpwuid() returns
    // NULL (no /etc/passwd), so give it a dummy spool path instead.
    // (Full getpwuid audit: see S2 report.)
    ENV.MAIL = '/no-mail-spool';

    if (cfg.mode === 'replay' && cfg.keysBase64) {
        var bin = atob(cfg.keysBase64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++)
            bytes[i] = bin.charCodeAt(i) & 0xff;
        Module.FS.writeFile('/replay.keys', bytes);
        ENV.FLECK_REPLAY = '/replay.keys';
    }
});

// Queue-mode key source for the shim's input funnel.  Returns the
// next byte (0-255) or -1 when the queue is empty; the shim treats
// -1 in scripted runs as end-of-input (clean exit), mirroring the
// FLECK_REPLAY EOF semantics.  Interactive hosts (S3+) replace this
// with an async source that never returns -1.
globalThis.__airstring_next_key = function () {
    var q = globalThis.__airstring_key_queue;
    if (!q || q.pos >= q.bytes.length)
        return -1;
    return q.bytes[q.pos++];
};
