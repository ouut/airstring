// airstring S3: run-parameter injection + JS side of the window
// contract bridge + async key source + push-stream collectors +
// save export helpers.
//
// Superset of tools/pre-s2.js.  What S3 changes:
//   * The key source is async: the shim's nhgetch bridge
//     (EM_ASYNC_JS in oracle/win/stub/winstub.c, the single
//     ASYNCIFY import) awaits globalThis.__airstring_take_key_
//     async().  It suspends while the queue is empty and the input
//     is still open, and returns -1 only after the host closes the
//     input via __airstring_close_keys() -- so an interactive host
//     never has to fake EOF, while scripted runs keep the exact
//     S2 EOF semantics (clean exit, status 0).
//   * Frame export / RNG log are also pushed: the fleck
//     instrumentation calls globalThis.__airstring_frame(text) /
//     __airstring_rngline(line) as data is produced.  Default
//     collectors below accumulate the chunks in
//     globalThis.__airstring_frame_chunks / __airstring_rng_chunks;
//     a host may predefine its own callbacks instead.  The MEMFS
//     files are still written and remain the canonical record.
//   * Save export: __airstring_list_saves() /
//     __airstring_read_save(name) expose the MEMFS save directory
//     so the host can turn a save file into a Blob for download /
//     sync (S5) -- read_save returns a Uint8Array.
//
// Run parameters: as in S2, Emscripten 6.0 neither reads
// process.env nor honors an ENV object passed to the module
// factory; the working injection point is a preRun callback.
// The host sets globalThis.__airstring_config before
// instantiating the module:
//   {
//     seed: 42, date: 1700000000,
//     options: 'name:fleck,role:valkyrie,race:human,gender:female,align:neutral',
//     exportPath: '/fleck.frames', rngPath: '/fleck.rng',
//     mode: 'replay' | 'queue' | 'async',
//     keysBase64: '...'        // replay mode: the key stream file
//   }
// and globalThis.__airstring_event(json) to receive contract
// events.  In queue/async modes the host may preset
// globalThis.__airstring_key_queue =
//   { bytes: [...], pos: 0, closed: <bool> }
// or drive the default queue with __airstring_push_keys() /
// __airstring_close_keys().  A preset queue WITHOUT a `closed`
// field is treated as an S2-style fixed script: exhaustion is
// EOF and the game never suspends (S2 queue-mode compatibility).
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

/* ------------------------------------------------------------------ */
/* async key queue                                                     */

function airstring_key_queue() {
    var q = globalThis.__airstring_key_queue;
    if (!q) {
        q = { bytes: [], pos: 0, closed: false };
        globalThis.__airstring_key_queue = q;
    }
    return q;
}

var airstring_key_waiters = [];

function airstring_wake_key_waiters() {
    var waiters = airstring_key_waiters;
    airstring_key_waiters = [];
    for (var i = 0; i < waiters.length; i++)
        waiters[i]();
}

/* Host API: append key bytes (Uint8Array / array of byte values /
   string, taken as char codes) to the queue and wake the game if
   it is suspended waiting for a key. */
globalThis.__airstring_push_keys = function (data) {
    var q = airstring_key_queue();
    if (!Array.isArray(q.bytes))
        q.bytes = Array.from(q.bytes);
    if (typeof data === 'string') {
        for (var i = 0; i < data.length; i++)
            q.bytes.push(data.charCodeAt(i) & 0xff);
    } else {
        for (var j = 0; j < data.length; j++)
            q.bytes.push(data[j] & 0xff);
    }
    airstring_wake_key_waiters();
};

/* Host API: declare end-of-input.  A game suspended in nhgetch
   wakes up, sees -1, and exits cleanly (scripted-run EOF). */
globalThis.__airstring_close_keys = function () {
    var q = airstring_key_queue();
    q.closed = true;
    airstring_wake_key_waiters();
};

/* Number of times the game actually suspended waiting for a key
   (evidence counter for harnesses/tests). */
globalThis.__airstring_key_waits = 0;

/* The async key source awaited by the shim's ASYNCIFY bridge.
   Returns the next byte (0-255), or -1 at end-of-input. */
globalThis.__airstring_take_key_async = async function () {
    for (;;) {
        var q = airstring_key_queue();
        if (q.pos < q.bytes.length)
            return q.bytes[q.pos++] & 0xff;
        if (q.closed)
            return -1;
        if (!('closed' in q))
            return -1; /* S2-style fixed script, exhausted */
        globalThis.__airstring_key_waits++;
        await new Promise(function (resolve) {
            airstring_key_waiters.push(resolve);
        });
    }
};

/* S2-compatible synchronous key source.  The S3 funnel no longer
   calls it; it is kept so S2-era host code keeps working.  Returns
   the next byte or -1 when the queue is empty. */
globalThis.__airstring_next_key = function () {
    var q = globalThis.__airstring_key_queue;
    if (!q || q.pos >= q.bytes.length)
        return -1;
    return q.bytes[q.pos++];
};

/* ------------------------------------------------------------------ */
/* push-stream collectors (defaults; a host may predefine its own   */
/* __airstring_frame / __airstring_rngline before instantiation)    */

if (!globalThis.__airstring_frame) {
    globalThis.__airstring_frame_chunks = [];
    globalThis.__airstring_frame = function (text) {
        globalThis.__airstring_frame_chunks.push(text);
    };
}
if (!globalThis.__airstring_rngline) {
    globalThis.__airstring_rng_chunks = [];
    globalThis.__airstring_rngline = function (line) {
        globalThis.__airstring_rng_chunks.push(line);
    };
}

/* ------------------------------------------------------------------ */
/* save export                                                         */

/* List the files in the MEMFS save directory (HACKDIR is "/", so
   NetHack save files land in "/save"). */
globalThis.__airstring_list_saves = function () {
    try {
        return Module.FS.readdir('/save').filter(function (name) {
            return name !== '.' && name !== '..';
        });
    } catch (e) {
        return [];
    }
};

/* Read one save file as a Uint8Array; the host wraps it in a Blob
   for download or cross-device sync. */
globalThis.__airstring_read_save = function (name) {
    return Module.FS.readFile('/save/' + name);
};
