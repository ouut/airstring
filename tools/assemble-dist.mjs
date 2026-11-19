// airstring S6: assemble the Firebase Hosting public dir (dist/).
//
// firebase.json sets hosting.public = "dist" and runs this script
// as a predeploy hook. Layout mirrors tools/recording-stub.mjs:
// index.html and the frontend files at /, the wasm build products
// at /nethack.js and /nethack.wasm (the stub maps them from out/;
// here they are copied next to index.html, as the stub's header
// comment anticipated).
//
// Usage: node tools/assemble-dist.mjs [--web web] [--build out]
//        [--dist dist]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const WEB = path.resolve(root, arg('web', 'web'));
const BUILD = path.resolve(root, arg('build', 'out'));
const DIST = path.resolve(root, arg('dist', 'dist'));

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const name of fs.readdirSync(WEB)) {
  fs.copyFileSync(path.join(WEB, name), path.join(DIST, name));
}
for (const name of ['nethack.js', 'nethack.wasm']) {
  const src = path.join(BUILD, name);
  if (!fs.existsSync(src)) {
    console.error('[assemble-dist] missing build product: ' + src +
      ' (run ./build-wasm.sh first)');
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DIST, name));
}
console.log('[assemble-dist] dist/ ready: ' +
  fs.readdirSync(DIST).join(', '));
