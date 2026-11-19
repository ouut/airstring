// airstring S1 spike harness: load the WASM build in Node and let
// the stub window port feed its scripted keys.  Run parameters
// (seed/date/role, export paths) are injected by the build-time
// --pre-js file (pre-spike.js) via a preRun callback -- Emscripten
// 6.0 neither reads process.env nor honors a factory-passed ENV.
// After the run, read back whatever the fleck instrumentation
// exported into MEMFS.
const { default: createModule } = await import('./out/nethack.js');

const M = {
    print: (s) => console.log('[stdout]', s),
    printErr: (s) => console.log('[stderr]', s),
};

let status = 'no-exit';
try {
    await createModule(M);
    status = 'main-returned';
} catch (e) {
    status = 'exception: ' + (e && e.name ? e.name : typeof e)
        + ' status=' + (e && 'status' in e ? e.status : '(none)')
        + ' message=' + (e && e.message ? e.message : String(e));
}
console.log('[harness] run ended:', status);

for (const p of ['/fleck.frames', '/fleck.rng']) {
    try {
        const data = M.FS.readFile(p, { encoding: 'utf8' });
        const lines = data.split('\n').length - 1;
        console.log(`[harness] ${p}: ${data.length} bytes, ${lines} lines`);
        M.FS.writeFile('/tmp-unused', ''); // keep FS alive check trivial
        // persist a copy next to the harness for the report
        const fs = await import('node:fs');
        fs.writeFileSync(new URL('./wasm-' + p.slice(1), import.meta.url), data);
    } catch (e) {
        console.log(`[harness] ${p}: not readable (${e.message})`);
    }
}
