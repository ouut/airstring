// airstring S5 gate driver: plays full scripted games through the
// real page in headless Chromium, once in a desktop viewport
// (physical-keyboard path) and once in a mobile viewport (touch /
// action-bar path), then verifies the uploaded recording of the
// main game by replaying its key stream headlessly and comparing
// the full frame-hash chain.
//
//   node tools/drive-s5.mjs [--base http://127.0.0.1:8377]
//                           [--only desktop|mobile]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const BASE = (process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]
  : 'http://127.0.0.1:8377');
const ONLY = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1] : null;
const EVID = path.join(root, 'evidence');
fs.mkdirSync(EVID, { recursive: true });

const OPTIONS = 'name:fleck,role:valkyrie,race:human,gender:female,align:neutral';
const summary = { base: BASE, profiles: {}, failures: [] };
function check(name, cond, detail) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
  if (!cond) summary.failures.push(name + (detail ? ' -- ' + detail : ''));
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function state(page) {
  return page.evaluate(() => window.__airstring_debug.state());
}
async function waitFor(page, fn, timeout = 25000) {
  await page.waitForFunction(fn, null, { timeout });
}
async function waitMode(page, mode, timeout = 25000) {
  await page.waitForFunction(
    (m) => window.__airstring_debug.state().mode === m, mode, { timeout });
}

/* dismiss text/more/getret layers until the main command state */
async function dismissToMain(page, prof, maxTries = 14) {
  for (let i = 0; i < maxTries; i++) {
    const s = await state(page);
    if (s.mode === 'main') return true;
    if (s.mode === 'text' || s.mode === 'more' || s.mode === 'getret') {
      if (prof.mobile) {
        const btn = page.locator(
          '#overlay:not([hidden]) #overlay-actions button, #actionbar button.primary').first();
        if (await btn.count()) await btn.tap();
        else await page.keyboard.press('Space');
      } else {
        await page.keyboard.press('Space');
      }
      await sleep(220);
      continue;
    }
    if (s.mode === 'menu') { /* inventory-style menu: Esc closes */
      await page.keyboard.press('Escape');
      await sleep(220);
      continue;
    }
    await sleep(220);
  }
  const s = await state(page);
  return s.mode === 'main';
}

/* after the first "Really ...?" answer, a game can ask follow-up
   yn questions (e.g. possessions identified?) and show end text;
   answer 'n' / dismiss until the game_over signal lands */
async function settleToGameOver(page, prof, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await state(page);
    if (s.over) return true;
    if (s.mode === 'yn' || s.mode === 'objprompt') {
      if (prof.mobile) {
        await page.locator('#actionbar button', { hasText: '否' }).first().tap();
      } else {
        await page.keyboard.press('n');
      }
      await sleep(250);
      continue;
    }
    if (s.mode === 'text' || s.mode === 'more' || s.mode === 'getret' ||
        s.mode === 'menu') {
      if (prof.mobile) {
        const btn = page.locator(
          '#overlay:not([hidden]) #overlay-actions button, #actionbar button.primary').first();
        if (await btn.count()) await btn.tap();
        else await page.keyboard.press('Space');
      } else if (s.mode === 'menu') {
        await page.keyboard.press('Escape');
      } else {
        await page.keyboard.press('Space');
      }
      await sleep(250);
      continue;
    }
    await sleep(250);
  }
  return (await state(page)).over;
}

async function tapAct(page, text) {
  const b = page.locator('#actionbar button', { hasText: text }).first();
  await b.tap();
}
async function clickAct(page, text) {
  const b = page.locator('#actionbar button', { hasText: text }).first();
  await b.click();
}

async function playMainGame(page, prof) {
  console.log(`[${prof.name}] main game`);
  await page.goto(BASE + '/');
  await page.waitForSelector('#setup-form');
  await page.fill('#seed-input', '42');
  if (prof.mobile) await page.tap('#start-btn'); else await page.click('#start-btn');
  await waitFor(page, () => {
    const s = window.__airstring_debug.state();
    return s && s.started && s.heroPos;
  });
  let s = await state(page);
  const gameId = s.gameId;
  check('startup: intro text window shown', s.counters.text >= 1,
    'text=' + s.counters.text);
  check('main state reached after dismissals',
    await dismissToMain(page, prof));
  s = await state(page);
  check('--More-- covered at startup', s.counters.more >= 1,
    'more=' + s.counters.more);
  await page.screenshot({ path: path.join(EVID, prof.name + '-main.png') });

  /* --- eat: object-selection prompt (yn kind, choices=null) --- */
  if (prof.mobile) await tapAct(page, '吃'); else await page.keyboard.press('e');
  await waitMode(page, 'objprompt');
  s = await state(page);
  check('eat object prompt shown', /eat/.test(s.prompt.q || ''), s.prompt.q);
  const hint = /\[(\S) or \?\*\]/.exec(s.prompt.q || '');
  if (prof.mobile) {
    await page.locator('#actionbar button', { hasText: '就它' }).first().tap();
  } else {
    await page.keyboard.press(hint ? hint[1] : 'd');
  }
  await waitFor(page, () => {
    const st = window.__airstring_debug.state();
    return st.mode === 'main' || st.mode === 'more' || st.mode === 'text';
  });
  await dismissToMain(page, prof);
  s = await state(page);
  check('eat completed (prompt answered)', s.counters.yn >= 1,
    'yn=' + s.counters.yn);

  /* --- inventory menu --- */
  if (prof.mobile) await tapAct(page, '背包'); else await page.keyboard.press('i');
  await waitMode(page, 'menu');
  const itemCount = await page.locator('#overlay-body .item').count();
  check('inventory menu rendered', itemCount > 0, 'items=' + itemCount);
  await page.screenshot({ path: path.join(EVID, prof.name + '-menu.png') });
  await page.locator('#overlay-actions button', { hasText: 'Esc' }).first()
    .dispatchEvent('click');
  await waitFor(page, () => window.__airstring_debug.state().mode !== 'menu');
  await dismissToMain(page, prof);
  s = await state(page);
  check('menu covered', s.counters.menu >= 1, 'menu=' + s.counters.menu);

  /* --- open-door direction prompt (action bar direction state) --- */
  if (prof.mobile) {
    /* the common-row 开门 (second bar row), not a contextual one */
    await page.locator('#actionbar .bar-row').nth(1)
      .locator('button', { hasText: '开门' }).first().tap();
  } else {
    await page.keyboard.press('o');
  }
  await waitFor(page, () => {
    const m = window.__airstring_debug.state().mode;
    return m === 'dir' || m === 'dirprompt';
  });
  const padBtn = page.locator('#dirpad button').nth(3); /* west */
  if (prof.mobile) await padBtn.tap(); else await padBtn.click();
  await sleep(400);
  s = await state(page);
  check('direction prompt answered via pad', s.counters.dir >= 1,
    'dir=' + s.counters.dir + ' msg=' + (s.lastMessage || '').slice(0, 50));
  await dismissToMain(page, prof);

  /* --- command panel (search + tap sends the key sequence) --- */
  await page.click('#btn-commands');
  await page.waitForSelector('#panel:not([hidden])');
  await page.fill('#panel-search', '搜索');
  const keysBefore = (await state(page)).keysTotal;
  const cmdBtn = page.locator('#panel-list .cmd', { hasText: '搜索' }).first();
  if (prof.mobile) await cmdBtn.tap(); else await cmdBtn.click();
  await sleep(400);
  s = await state(page);
  check('command panel sent keys', s.keysTotal > keysBefore,
    `keys ${keysBefore} -> ${s.keysTotal}`);

  /* --- a couple of turns (wait always advances a turn; a west
         step is attempted too but wall bumps cost no turn) --- */
  const frameBefore = s.lastFrame ? s.lastFrame.frame : 0;
  if (prof.mobile) await page.locator('#dirpad button').nth(3).tap(); /* west */
  else await page.keyboard.press('h');
  await sleep(250);
  await dismissToMain(page, prof);
  for (let i = 0; i < 2; i++) {
    if (prof.mobile) await page.locator('#dirpad button').nth(4).tap(); /* wait */
    else await page.keyboard.press('.');
    await sleep(250);
    await dismissToMain(page, prof);
  }
  s = await state(page);
  check('frames advance with play',
    s.lastFrame && s.lastFrame.frame > frameBefore,
    `frame ${frameBefore} -> ${s.lastFrame && s.lastFrame.frame}`);

  /* --- #quit: line prompt (typed) + yn prompt --- */
  await page.click('#btn-commands');
  await page.waitForSelector('#panel:not([hidden])');
  await page.fill('#panel-search', '扩展命令');
  /* use the dedicated flow: press '#' via panel entry 扩展命令 is not
     a command; instead send '#' from the command list entry 退出游戏
     would send the whole sequence at once -- for line-input evidence
     we drive the line bar directly: */
  await page.click('#panel-close');
  /* '#' is not in the panel as a bare key; use keyboard on desktop,
     and on mobile use the panel's 退出游戏 entry (sends #quit\n as
     one original key sequence -- still passes the line prompt). */
  if (prof.mobile) {
    await page.click('#btn-commands');
    await page.waitForSelector('#panel:not([hidden])');
    await page.fill('#panel-search', '退出游戏');
    await page.locator('#panel-list .cmd', { hasText: '退出游戏' }).first().tap();
  } else {
    await page.keyboard.press('#');
    await waitMode(page, 'line');
    await page.fill('#line-input', 'quit');
    await page.click('#line-send');
  }
  await waitMode(page, 'yn');
  s = await state(page);
  check('line prompt covered', s.counters.line >= 1, 'line=' + s.counters.line);
  check('quit yn prompt shown', /quit/i.test(s.prompt.q || ''), s.prompt.q);
  await page.screenshot({ path: path.join(EVID, prof.name + '-yn.png') });
  if (prof.mobile) {
    await page.locator('#actionbar button', { hasText: '是' }).first().tap();
  } else {
    await page.keyboard.press('y');
  }
  check('game over via __airstring_game_over',
    await settleToGameOver(page, prof));
  s = await state(page);
  check('game over status 0', s.overStatus === 0, 'status=' + s.overStatus);
  check('five interaction types covered',
    s.counters.more >= 1 && s.counters.menu >= 1 && s.counters.dir >= 1 &&
    s.counters.yn >= 1 && s.counters.line >= 1,
    JSON.stringify(s.counters));
  return gameId;
}

/* verify the uploaded recording of a finished game: reconstruct the
   key stream, replay headlessly, compare the full hash chain */
async function verifyRecording(gameId, profName) {
  console.log(`[${profName}] recording verification for ${gameId}`);
  let text = null;
  for (let i = 0; i < 20; i++) {
    const r = await fetch(BASE + '/recordings/' + gameId + '.jsonl');
    if (r.ok) {
      text = await r.text();
      if (text.includes('"k":"end"')) break;
    }
    await sleep(500);
  }
  check('recording uploaded to stub', !!text);
  if (!text) return;
  const records = text.trim().split('\n').map((l) => JSON.parse(l));
  const header = records.find((r) => r.k === 'header');
  const turns = records.filter((r) => r.k === 'turn');
  const tail = records.find((r) => r.k === 'tail');
  const end = records.find((r) => r.k === 'end');
  check('recording has header/end', !!header && !!end,
    `turns=${turns.length}`);
  const keys = Buffer.concat(records
    .filter((r) => r.k === 'turn' || r.k === 'tail')
    .map((r) => Buffer.from(r.keys, 'base64')));
  const keysFile = path.join(EVID, profName + '-gameA.keys');
  fs.writeFileSync(keysFile, keys);
  const outPrefix = path.join(EVID, profName + '-replayA');
  execFileSync('node', [
    path.join(root, 'tools', 'run-node-s3.mjs'),
    '--keys', keysFile, '--mode', 'replay',
    '--seed', String(header.seed), '--options', header.options,
    '--out', outPrefix, '--quiet-keys',
  ], { cwd: root, stdio: 'pipe' });
  const framesText = fs.readFileSync(outPrefix + '.frames', 'utf8');
  /* one hero hash per frame: the first hash= inside each frame
     block (later hash= lines belong to sub-sections) */
  const replayHashes = framesText.split(/^frame \d+$/m).slice(1)
    .map((block) => /hash=([0-9a-f]{64})/.exec(block)[1]);
  const recordedHashes = turns.map((t) => t.hash);
  const allEqual = replayHashes.length === recordedHashes.length &&
    replayHashes.every((h, i) => h === recordedHashes[i]);
  check('frame hash chain: recording == headless replay (full chain)',
    allEqual, `recorded ${recordedHashes.length} frames, replay ${replayHashes.length}`);
  fs.writeFileSync(path.join(EVID, profName + '-recording.jsonl'), text);
}

async function playSaveAndRestore(page, prof) {
  console.log(`[${prof.name}] save / restore`);
  /* game B: save and exit */
  await page.click('#btn-newgame');
  await page.waitForSelector('#setup-form');
  if (prof.mobile) await page.tap('#start-btn'); else await page.click('#start-btn');
  await waitFor(page, () => {
    const s = window.__airstring_debug.state();
    return s && s.started && s.heroPos;
  });
  await dismissToMain(page, prof);
  /* play a few real turns so the save point has moves > 1 */
  for (let i = 0; i < 3; i++) {
    if (prof.mobile) await page.locator('#dirpad button').nth(4).tap();
    else await page.keyboard.press('.');
    await sleep(250);
    await dismissToMain(page, prof);
  }
  let s = await state(page);
  const saveFrame = s.lastFrame, savePos = s.heroPos;
  if (prof.mobile) await tapAct(page, '存档退出');
  else await page.keyboard.press('S');
  await waitMode(page, 'yn');
  if (prof.mobile) {
    await page.locator('#actionbar button', { hasText: '是' }).first().tap();
  } else {
    await page.keyboard.press('y');
  }
  await settleToGameOver(page, prof);
  await waitFor(page, () => window.__airstring_debug.state().saves.length > 0);
  s = await state(page);
  check('save produced in MEMFS', s.saves.length > 0, s.saves.join(','));
  /* keep the game's own save file name (e.g. "0fleck"): restore
     only recognises the uid+name pattern, so the import must use
     the original basename */
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.locator('#saves-box button').first().dispatchEvent('click'),
  ]);
  const savePath = path.join(EVID, prof.name + '-' + download.suggestedFilename());
  await download.saveAs(savePath);
  const saveSize = fs.statSync(savePath).size;
  check('save exported as blob', saveSize > 1000, saveSize + ' B');
  await page.screenshot({ path: path.join(EVID, prof.name + '-saved.png') });

  /* game C: restore from the exported save (the file name given
     to the input must be the game's own save name) */
  await page.click('#btn-newgame');
  await page.waitForSelector('#setup-form');
  await page.setInputFiles('#import-file', {
    name: path.basename(savePath).replace(/^desktop-|^mobile-/, ''),
    mimeType: 'application/octet-stream',
    buffer: fs.readFileSync(savePath),
  });
  await sleep(300);
  if (prof.mobile) await page.tap('#start-btn'); else await page.click('#start-btn');
  await waitFor(page, () => {
    const st = window.__airstring_debug.state();
    return st && st.started;
  }, 30000);
  /* a restored game can sit at a --More-- ("Restoring save
     file...") before the first map/frame: dismiss first */
  await dismissToMain(page, prof);
  await waitFor(page, () => {
    const st = window.__airstring_debug.state();
    return st && st.lastFrame && st.heroPos;
  }, 30000);
  s = await state(page);
  check('restored game resumes at saved turn',
    s.lastFrame && saveFrame && s.lastFrame.moves >= saveFrame.moves - 1 &&
    s.lastFrame.moves > 1,
    `saved moves=${saveFrame && saveFrame.moves}, restored moves=${s.lastFrame && s.lastFrame.moves}`);
  check('restored hero position matches save point',
    !!s.heroPos && !!savePos && s.heroPos.x === savePos.x && s.heroPos.y === savePos.y,
    `save=${JSON.stringify(savePos)} restored=${JSON.stringify(s.heroPos)}`);
  await dismissToMain(page, prof);
  /* end game C via #quit typed through the panel sequence */
  await page.click('#btn-commands');
  await page.waitForSelector('#panel:not([hidden])');
  await page.fill('#panel-search', '退出游戏');
  const qb = page.locator('#panel-list .cmd', { hasText: '退出游戏' }).first();
  if (prof.mobile) await qb.tap(); else await qb.click();
  await waitMode(page, 'yn');
  if (prof.mobile) {
    await page.locator('#actionbar button', { hasText: '是' }).first().tap();
  } else {
    await page.keyboard.press('y');
  }
  check('restored game ends cleanly', await settleToGameOver(page, prof));
}

const browser = await chromium.launch();
for (const prof of [
  { name: 'desktop', mobile: false,
    viewport: { width: 1280, height: 800 } },
  { name: 'mobile', mobile: true,
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true },
]) {
  if (ONLY && ONLY !== prof.name) continue;
  const ctx = await browser.newContext({
    viewport: prof.viewport,
    isMobile: !!prof.isMobile, hasTouch: !!prof.hasTouch,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) =>
    console.log(`[${prof.name}][pageerror]`, String(e).slice(0, 300)));
  try {
    const gameId = await playMainGame(page, prof);
    await verifyRecording(gameId, prof.name);
    await playSaveAndRestore(page, prof);
  } catch (e) {
    check(prof.name + ' run completed without driver error', false,
      String(e).slice(0, 300));
    await page.screenshot({ path: path.join(EVID, prof.name + '-error.png') })
      .catch(() => {});
  }
  summary.profiles[prof.name] = await state(page).catch(() => null);
  await ctx.close();
}
await browser.close();
fs.writeFileSync(path.join(EVID, 'drive-summary.json'),
  JSON.stringify(summary, null, 1));
console.log(summary.failures.length
  ? 'DRIVE FAILED: ' + summary.failures.join(' | ')
  : 'DRIVE ALL PASS');
process.exit(summary.failures.length ? 1 : 0);
