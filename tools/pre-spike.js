// airstring S1 spike: inject the pinned run parameters into the
// wasm program's environment.  Emscripten 6.0 neither reads
// process.env nor honors an ENV object passed to the module factory
// (the runtime overwrites Module.ENV with its own object during
// init); the working injection point is a preRun callback, which
// runs after the runtime ENV object exists but before main().
// In the product (S3/S5) the page will fill these from a config
// object instead of literals.
Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
    Module.ENV.FLECK_SEED = '42';
    Module.ENV.FLECK_DATE = '1700000000';
    Module.ENV.FLECK_EXPORT = '/fleck.frames';
    Module.ENV.FLECK_RNGLOG = '/fleck.rng';
    Module.ENV.NETHACKOPTIONS =
        'name:s1spike,role:valkyrie,race:human,gender:female,align:neutral';
    // mail.c getmailstatus() dereferences getpwuid()->pw_name without
    // a NULL check when MAIL is unset; Emscripten's getpwuid() returns
    // NULL (no /etc/passwd), so give it a dummy spool path instead.
    Module.ENV.MAIL = '/no-mail-spool';
});
