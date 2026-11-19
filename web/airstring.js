/* airstring S5 frontend.
 *
 * Renders the S2/S3 window contract event stream, feeds every
 * input -- physical keyboard, action-bar taps, map taps, command
 * panel -- into the single async key queue installed by
 * tools/pre-s3.js (__airstring_push_keys).  There is no other
 * input path: taps are translated to the original key sequences.
 *
 * Recording: the recorder listens to the shim's own `key` audit
 * events (src=queue) and to the streamed frame callbacks
 * (__airstring_frame).  Per turn it stores the bytes consumed
 * since the previous frame plus that frame's hash -- an
 * interleaved, turn-indexed stream (see docs/recording-format.md).
 * Verification only ever looks at this key stream.
 *
 * Completion: the host completion signal is
 * __airstring_game_over(status) (S3 addendum); the module factory
 * promise is never used as a completion signal.
 */
import { COMMANDS, DIRS, dirByte } from './commands.js';

const FIXED_DATE = 1700000000; /* spec SS2.2: pinned, passport value */
const $ = (id) => document.getElementById(id);

/* ---------------- role / race / alignment matrix (3.6.7) ---------------- */
const ROLES = {
  archeologist: { zh: '考古学家', races: ['human', 'dwarf', 'gnome'], aligns: ['lawful', 'neutral'] },
  barbarian:    { zh: '野蛮人',   races: ['human', 'orc'],           aligns: ['neutral', 'chaotic'] },
  caveman:      { zh: '穴居人',   races: ['human', 'dwarf', 'gnome'], aligns: ['lawful', 'neutral'] },
  healer:       { zh: '医者',     races: ['human', 'gnome'],          aligns: ['neutral'] },
  knight:       { zh: '骑士',     races: ['human'],                   aligns: ['lawful'] },
  monk:         { zh: '武僧',     races: ['human'],                   aligns: ['lawful', 'neutral', 'chaotic'] },
  priest:       { zh: '祭司',     races: ['human', 'elf'],            aligns: ['lawful', 'neutral', 'chaotic'] },
  ranger:       { zh: '游侠',     races: ['human', 'elf', 'gnome', 'orc'], aligns: ['neutral', 'chaotic'] },
  rogue:        { zh: '盗贼',     races: ['human', 'orc'],            aligns: ['chaotic'] },
  samurai:      { zh: '武士',     races: ['human'],                   aligns: ['lawful'] },
  tourist:      { zh: '游客',     races: ['human'],                   aligns: ['neutral'] },
  valkyrie:     { zh: '女武神',   races: ['human', 'dwarf'],          aligns: ['lawful', 'neutral'], gender: 'female' },
  wizard:       { zh: '巫师',     races: ['human', 'elf', 'gnome', 'orc'], aligns: ['neutral', 'chaotic'] },
};
const RACE_ZH = { human: '人类', elf: '精灵', dwarf: '矮人', gnome: '侏儒', orc: '兽人' };
const ALIGN_ZH = { lawful: '守序', neutral: '中立', chaotic: '混沌' };

function fillSetupForm() {
  const roleSel = $('opt-role'), raceSel = $('opt-race'), alignSel = $('opt-align');
  for (const [k, v] of Object.entries(ROLES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.zh + ' (' + k + ')';
    roleSel.appendChild(o);
  }
  roleSel.value = 'valkyrie';
  const sync = () => {
    const r = ROLES[roleSel.value];
    const keepRace = raceSel.value, keepAlign = alignSel.value;
    raceSel.innerHTML = ''; alignSel.innerHTML = '';
    for (const race of r.races) {
      const o = document.createElement('option');
      o.value = race; o.textContent = RACE_ZH[race];
      raceSel.appendChild(o);
    }
    for (const al of r.aligns) {
      const o = document.createElement('option');
      o.value = al; o.textContent = ALIGN_ZH[al];
      alignSel.appendChild(o);
    }
    if (r.races.includes(keepRace)) raceSel.value = keepRace;
    if (r.aligns.includes(keepAlign)) alignSel.value = keepAlign;
    const g = $('opt-gender');
    if (r.gender) { g.value = r.gender; g.disabled = true; }
    else g.disabled = false;
  };
  roleSel.addEventListener('change', sync);
  sync();
}

/* ---------------- session state ---------------- */
let S = null;            /* active session or null */
let pendingImport = null; /* {name, bytes:Uint8Array} */

function newSession(cfg) {
  return {
    id: cfg.gameId, seed: cfg.seed, seedSource: cfg.seedSource,
    date: FIXED_DATE, options: cfg.options,
    started: false, over: false, overStatus: null, exited: false,
    /* UI state derived from contract events */
    prompt: null,        /* {kind:'yn'|'line', q, choices, def} */
    menu: null,          /* last menu event */
    textActive: false, ripActive: false,
    moreActive: false, getretActive: false,
    expectingDir: null,  /* command char waiting for a direction */
    dirAfterLine: false, /* #chat-style: direction follows line prompt */
    mapRows: null, mapColors: null, heroPos: null, underHero: '.',
    lastFrame: null, statusLines: null,
    messages: [],
    counters: { more: 0, menu: 0, yn: 0, line: 0, dir: 0, text: 0, keys: 0 },
    /* recorder */
    pendingKeys: [], records: [], recSeq: 0, keysTotal: 0, rngLines: 0,
    uploadTimer: null, uploadChain: Promise.resolve(),
    saves: [],
  };
}

function uiMode() {
  if (!S) return 'boot';
  if (S.over) return 'over';
  if (S.prompt && S.prompt.kind === 'line') return 'line';
  if (S.prompt && S.prompt.dirPrompt) return 'dirprompt';
  if (S.prompt && S.prompt.kind === 'yn' && S.prompt.choices == null) return 'objprompt';
  if (S.prompt && S.prompt.kind === 'yn') return 'yn';
  if (S.menu) return 'menu';
  if (S.textActive) return 'text';
  if (S.moreActive) return 'more';
  if (S.getretActive) return 'getret';
  if (S.expectingDir) return 'dir';
  if (!S.started) return 'boot';
  return 'main';
}

/* ---------------- the one input funnel ---------------- */
function sendBytes(data) {
  if (!S || S.over) return;
  const bytes = typeof data === 'string'
    ? Array.from(data, (c) => c.charCodeAt(0) & 0xff)
    : Array.from(data, (b) => b & 0xff);
  if (!bytes.length) return;
  /* local direction-expectation bookkeeping (UI state only; the
     bytes themselves are untouched) */
  const mode = uiMode();
  if ((mode === 'main' || mode === 'dir') && bytes.length === 1) {
    const b = bytes[0];
    if (S.expectingDir && dirByteAll().includes(b)) {
      S.counters.dir++; S.expectingDir = null;
    } else if (mode === 'main' && (b === 0x6f || b === 0x63)) { /* o / c */
      S.expectingDir = String.fromCharCode(b);
    } else if (mode === 'main' && b === 0x46) { /* F */
      S.expectingDir = 'F';
    }
  }
  globalThis.__airstring_push_keys(new Uint8Array(bytes));
  renderBar();
}
function dirByteAll() {
  return [104, 106, 107, 108, 121, 117, 98, 110, 46]; /* hjklyubn. */
}
function sendKey(ch) { sendBytes(ch); }

/* ---------------- contract event handling ---------------- */
function handleEvent(json) {
  if (!S) return;
  let ev;
  try { ev = JSON.parse(json); } catch (e) { return; }
  (S.eventTail = S.eventTail || []).push(ev.t);
  if (S.eventTail.length > 40) S.eventTail.shift();
  /* a text window ends when its dmore dismissal key has been
     consumed and the next event is not another text page; no map
     event is guaranteed to follow (an "Unknown command" turn does
     not dirty the map), so the close is resolved here */
  if (S.textClosePending && ev.t !== 'key') {
    if (ev.t !== 'text') { S.textActive = false; hideOverlay(); }
    S.textClosePending = false;
  }
  switch (ev.t) {
    case 'init': S.started = true; break;
    case 'map': onMap(ev); break;
    case 'status':
      if (ev.lines && ev.lines.length) S.statusLines = ev.lines;
      renderStatus();
      break;
    case 'message':
      S.messages.push(ev.text);
      $('msg').textContent = ev.text;
      appendLog(ev.text);
      break;
    case 'raw':
      S.messages.push(ev.text);
      appendLog('[!] ' + ev.text);
      break;
    case 'more':
      S.moreActive = true; S.counters.more++;
      $('msg').innerHTML = '';
      $('msg').append(document.createTextNode(S.messages[S.messages.length - 1] || ''));
      const m = document.createElement('span');
      m.className = 'moreflag'; m.textContent = ' --More--';
      $('msg').append(m);
      break;
    case 'prompt':
      /* this build also surfaces direction questions as prompts
         (kind yn, choices null, "In what direction?") -- classify
         them as direction prompts, not object selections */
      if (ev.kind === 'yn' && ev.choices == null &&
          /direction/i.test(ev.q || '')) {
        ev.dirPrompt = true;
        S.counters.dir++;
      }
      S.prompt = ev;
      if (ev.kind === 'yn') S.counters.yn++;
      if (ev.kind === 'line') { S.counters.line++; showLineBar(ev.q); }
      break;
    case 'prompt-end':
      if (S.prompt && S.prompt.kind === 'line') hideLineBar();
      S.prompt = null;
      S.expectingDir = null;
      if (S.dirAfterLine) { S.expectingDir = '#'; S.dirAfterLine = false; }
      break;
    case 'menu':
      S.menu = ev; S.counters.menu++;
      renderMenu(ev);
      break;
    case 'menu-end':
      S.menu = null; hideOverlay();
      break;
    case 'text':
      S.textActive = true; S.counters.text++;
      renderText(ev);
      break;
    case 'getret': S.getretActive = true; break;
    case 'askname':
      S.prompt = { kind: 'line', q: '你的名字？' };
      S.counters.line++; showLineBar('你的名字？');
      break;
    case 'rip':
      S.ripActive = true;
      showOverlay('R.I.P.', null);
      break;
    case 'key':
      S.counters.keys++;
      if (ev.src === 'queue') {
        S.pendingKeys.push(ev.code & 0xff);
        S.keysTotal++;
      }
      if (S.moreActive) {
        if (S.textActive) S.textClosePending = true;
        S.moreActive = false;
      }
      if (S.getretActive) S.getretActive = false;
      break;
    case 'exit': S.exited = true; break;
  }
  renderBar();
}

function onMap(ev) {
  const prev = S.mapRows, prevHero = S.heroPos;
  S.mapRows = ev.rows; S.mapColors = ev.colors;
  let hero = null;
  for (let y = 0; y < ev.rows.length; y++) {
    const x = ev.rows[y].indexOf('@');
    if (x >= 0) { hero = { x, y }; break; }
  }
  if (hero) {
    if (prev && prevHero && (hero.x !== prevHero.x || hero.y !== prevHero.y)) {
      /* the cell the hero just stepped onto was visible in the
         previous snapshot */
      const under = prev[hero.y] && prev[hero.y][hero.x];
      if (under && under !== '@') S.underHero = under;
    }
    S.heroPos = hero;
  }
  if (S.textActive && !S.ripActive) { S.textActive = false; hideOverlay(); }
  renderGrid();
}

function renderGrid() {
  const grid = $('grid');
  if (!S || !S.mapRows) return;
  if (!grid.children.length) {
    for (let y = 0; y < 21; y++) {
      const row = document.createElement('div');
      row.className = 'row';
      for (let x = 0; x < 80; x++) {
        const c = document.createElement('span');
        c.dataset.x = x; c.dataset.y = y;
        c.textContent = ' ';
        row.appendChild(c);
      }
      grid.appendChild(row);
    }
  }
  for (let y = 0; y < 21; y++) {
    const chars = S.mapRows[y] || '';
    const colors = (S.mapColors && S.mapColors[y]) || [];
    const rowEl = grid.children[y];
    for (let x = 0; x < 80; x++) {
      const cell = rowEl.children[x];
      const ch = chars[x] || ' ';
      if (cell.textContent !== ch) cell.textContent = ch;
      const cls = 'c' + (((colors[x] | 0) & 0x1f) % 16);
      if (cell.className !== cls) cell.className = cls;
    }
  }
  fitGridFont();
}

function fitGridFont() {
  const grid = $('grid');
  if (!grid.clientWidth) return;
  const fs = Math.max(8, Math.floor((grid.clientWidth - 10) / 80 / 0.601));
  grid.style.fontSize = fs + 'px';
}
window.addEventListener('resize', fitGridFont);

/* status: contract `status` events win when present; in the
   current build they never fire (see REPORT), so the streamed
   frame's [hero] fields are the working source. */
function renderStatus() {
  const el = $('status');
  if (!S) { el.textContent = ''; return; }
  if (S.statusLines) { el.textContent = S.statusLines.join('\n'); return; }
  const f = S.lastFrame;
  if (!f) { el.textContent = ''; return; }
  const hungerWord = f.hunger == null ? '' :
    f.hunger < 0 ? '昏厥' : f.hunger < 50 ? '虚弱' :
    f.hunger < 150 ? '饥饿' : f.hunger > 1000 ? '饱足' : '';
  el.textContent =
    `${f.name}  ${f.role}  Dlvl:${f.dlevel}  $:${f.gold}  HP:${f.hp}/${f.hpmax}` +
    `  Pw:${f.pw}/${f.pwmax}  AC:${f.ac}\n` +
    `XL:${f.xl}  回合:${f.moves}  ${hungerWord}`;
}

function appendLog(text) {
  const log = $('msglog');
  const div = document.createElement('div');
  div.textContent = text;
  log.appendChild(div);
  while (log.children.length > 200) log.removeChild(log.firstChild);
}

/* ---------------- overlays: menu / text ---------------- */
function showOverlay(title, bodyPre) {
  $('overlay').hidden = false;
  $('overlay-title').textContent = title || '';
  const body = $('overlay-body');
  body.innerHTML = '';
  if (bodyPre != null) {
    const pre = document.createElement('pre');
    pre.textContent = bodyPre;
    body.appendChild(pre);
  }
  $('overlay-actions').innerHTML = '';
  return body;
}
function hideOverlay() {
  $('overlay').hidden = true;
  $('overlay-body').innerHTML = '';
  $('overlay-actions').innerHTML = '';
}
function overlayAction(label, fn, primary) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  if (primary) b.className = 'primary';
  b.addEventListener('click', fn);
  $('overlay-actions').appendChild(b);
}

function itemLine(it) {
  return typeof it.text === 'string' ? it.text : '';
}
function renderMenu(ev) {
  const body = showOverlay(
    `菜单（${ev.page}/${ev.pages}）` + (ev.how === 'PICK_ANY' ? ' 可多选' :
      ev.how === 'PICK_ONE' ? ' 选一项' : ''), null);
  for (const it of ev.items || []) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'item' + (it.selected ? ' picked' : '');
    const sel = document.createElement('span');
    sel.className = 'sel'; sel.textContent = it.selector || '';
    b.append(sel, document.createTextNode(itemLine(it)));
    b.addEventListener('click', () => { if (it.selector) sendKey(it.selector); });
    body.appendChild(b);
  }
  overlayAction('翻页（空格）', () => sendKey(' '));
  if (ev.how === 'PICK_ANY') overlayAction('确认', () => sendBytes([13]), true);
  overlayAction('关闭/取消（Esc）', () => sendBytes([27]));
}
function renderText(ev) {
  const lines = (ev.lines || []).map((l) =>
    typeof l === 'string' ? l : (l && l.text) || '');
  const body = showOverlay(S.ripActive ? 'R.I.P.' : '文本', lines.join('\n'));
  body.scrollTop = 0;
  overlayAction('继续（空格）', () => sendKey(' '), true);
}

/* ---------------- line prompt ---------------- */
function showLineBar(q) {
  $('linebar').hidden = false;
  $('line-q').textContent = q || '';
  const inp = $('line-input');
  inp.value = '';
  /* focus summons the system keyboard on mobile -- only for
     genuine line prompts, per spec.  Guarded by visibility: a
     pre-queued answer can end the prompt before the timer fires,
     and focusing the then-hidden input would swallow later keys */
  setTimeout(() => {
    if (!$('linebar').hidden) inp.focus({ preventScroll: true });
  }, 30);
}
function hideLineBar() {
  $('linebar').hidden = true;
  /* drop focus, or later physical keys would be swallowed by the
     hidden input instead of reaching the game */
  if (document.activeElement === $('line-input')) $('line-input').blur();
}
function submitLine() {
  const inp = $('line-input');
  sendBytes(inp.value + '\n');
  inp.value = '';
}

/* ---------------- contextual action bar ---------------- */
function actBtn(label, sub, fn, primary) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'act' + (primary ? ' primary' : '');
  b.append(document.createTextNode(label));
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub'; s.textContent = sub;
    b.appendChild(s);
  }
  b.addEventListener('click', fn);
  return b;
}
function barRow(buttons) {
  const row = document.createElement('div');
  row.className = 'bar-row';
  for (const b of buttons) row.appendChild(b);
  return row;
}
function dirPad(selfLabel) {
  const pad = document.createElement('div');
  pad.id = 'dirpad';
  for (const d of DIRS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'act';
    b.textContent = d.dx === 0 && d.dy === 0 && selfLabel ? selfLabel : d.label;
    b.setAttribute('aria-label', '方向 ' + d.label);
    b.addEventListener('click', () => {
      const byte = dirByte(d.dx, d.dy);
      if (byte) sendKey(byte);
    });
    pad.appendChild(b);
  }
  return pad;
}
function adjacentCells() {
  /* chars of the 8 neighbours of the hero on the latest map */
  const out = [];
  if (!S || !S.mapRows || !S.heroPos) return out;
  for (const d of DIRS) {
    if (d.dx === 0 && d.dy === 0) continue;
    const x = S.heroPos.x + d.dx, y = S.heroPos.y + d.dy;
    const ch = (S.mapRows[y] || '')[x] || ' ';
    out.push({ dx: d.dx, dy: d.dy, ch });
  }
  return out;
}
const MONSTERISH = /[a-zA-Z&@';:]/;
function contextualMainButtons() {
  const btns = [];
  const under = S.underHero;
  btns.push(actBtn('拾取', ',', () => sendKey(',')));
  if (under === '<') btns.push(actBtn('上楼', '<', () => sendKey('<'), true));
  if (under === '>') btns.push(actBtn('下楼', '>', () => sendKey('>'), true));
  if (under === '_') btns.push(actBtn('献祭', '#offer', () => sendBytes('#offer\n')));
  if (under === '{') {
    btns.push(actBtn('蘸取', '#dip', () => sendBytes('#dip\n')));
    btns.push(actBtn('喝泉水', 'q', () => sendKey('q')));
  }
  if (under === '(') btns.push(actBtn('搜掠', '#loot', () => sendBytes('#loot\n')));
  const adj = adjacentCells();
  const door = adj.find((c) => c.ch === '+');
  if (door) {
    btns.push(actBtn('开门', 'o+方向', () => {
      sendBytes('o' + dirByte(door.dx, door.dy));
    }, true));
  }
  const mon = adj.find((c) => MONSTERISH.test(c.ch) && c.ch !== '@');
  if (mon) {
    btns.push(actBtn('交谈', '#chat', () => {
      S.dirAfterLine = true;
      sendBytes('#chat\n');
    }));
  }
  return btns;
}

function renderBar() {
  const bar = $('actionbar');
  bar.innerHTML = '';
  if (!S) return;
  const mode = uiMode();
  const label = document.createElement('div');
  label.className = 'bar-label';
  bar.appendChild(label);
  if (mode === 'over') {
    label.textContent = '本局已结束';
    bar.appendChild(barRow([actBtn('回开局页', '', () => showSetup(), true)]));
    return;
  }
  if (mode === 'boot') { label.textContent = '游戏启动中…'; return; }
  if (mode === 'line') {
    label.textContent = '请输入文本（上方输入框），提交即送入原按键序列';
    bar.appendChild(barRow([
      actBtn('取消（Esc）', '', () => sendBytes([27])),
    ]));
    return;
  }
  if (mode === 'yn') {
    const p = S.prompt;
    label.textContent = p.q || '请选择';
    const btns = [];
    const choices = p.choices || 'ynq';
    const zh = { y: '是', n: '否', q: '取消', a: '全部' };
    for (const ch of choices) {
      btns.push(actBtn((zh[ch] || ch) + '', ch, () => sendKey(ch),
        p.def === ch));
    }
    if (!choices.includes('\x1b'))
      btns.push(actBtn('取消（Esc）', '', () => sendBytes([27])));
    bar.appendChild(barRow(btns));
    return;
  }
  if (mode === 'objprompt') {
    const p = S.prompt;
    label.textContent = p.q || '选择物品';
    const btns = [
      actBtn('看列表', '?', () => sendKey('?'), true),
      actBtn('全部显示', '*', () => sendKey('*')),
    ];
    const m = /\[\s*(\S)\s+or\s+\?\*\]/.exec(p.q || '');
    if (m) btns.push(actBtn('就它（' + m[1] + '）', m[1], () => sendKey(m[1])));
    btns.push(actBtn('取消（Esc）', '', () => sendBytes([27])));
    bar.appendChild(barRow(btns));
    return;
  }
  if (mode === 'menu') {
    label.textContent = '菜单已打开（上方列表可点选）';
    return; /* overlay carries its own actions */
  }
  if (mode === 'text') {
    label.textContent = '文本窗（读完点继续）';
    bar.appendChild(barRow([actBtn('继续', '空格', () => sendKey(' '), true)]));
    return;
  }
  if (mode === 'more' || mode === 'getret') {
    label.textContent = mode === 'more' ? '还有更多消息' : '按继续';
    bar.appendChild(barRow([actBtn('继续', '空格', () => sendKey(' '), true)]));
    return;
  }
  if (mode === 'dir' || mode === 'dirprompt') {
    label.textContent = '选择方向（Esc 取消）';
    bar.appendChild(dirPad('自身'));
    bar.appendChild(barRow([actBtn('取消（Esc）', '', () => {
      S.expectingDir = null; sendBytes([27]);
    })]));
    return;
  }
  /* main command state */
  label.textContent = '主命令';
  bar.appendChild(barRow(contextualMainButtons()));
  bar.appendChild(barRow([
    actBtn('搜索', 's', () => sendKey('s')),
    actBtn('背包', 'i', () => sendKey('i')),
    actBtn('吃', 'e', () => sendKey('e')),
    actBtn('喝', 'q', () => sendKey('q')),
    actBtn('开门', 'o', () => sendKey('o')),
    actBtn('关门', 'c', () => sendKey('c')),
    actBtn('上楼', '<', () => sendKey('<')),
    actBtn('下楼', '>', () => sendKey('>')),
    actBtn('存档退出', 'S', () => sendKey('S')),
    actBtn('全部命令', '面板', () => togglePanel(true)),
  ]));
  bar.appendChild(dirPad(null));
}

/* ---------------- command panel ---------------- */
function togglePanel(open) {
  $('panel').hidden = !open;
  if (open) { renderPanel(''); $('panel-search').focus(); }
  else if (document.activeElement === $('panel-search'))
    $('panel-search').blur();
}
function renderPanel(filter) {
  const list = $('panel-list');
  list.innerHTML = '';
  const f = (filter || '').trim().toLowerCase();
  let lastCat = null;
  for (const cmd of COMMANDS) {
    if (f && !(cmd.name.toLowerCase().includes(f) ||
               cmd.desc.toLowerCase().includes(f) ||
               cmd.key.toLowerCase().includes(f))) continue;
    if (cmd.cat !== lastCat) {
      lastCat = cmd.cat;
      const h = document.createElement('div');
      h.className = 'cat'; h.textContent = lastCat;
      list.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'cmd';
    const left = document.createElement('span');
    left.textContent = cmd.name;
    const d = document.createElement('span');
    d.className = 'd'; d.textContent = cmd.desc;
    left.appendChild(d);
    const k = document.createElement('span');
    k.className = 'k'; k.textContent = cmd.key;
    b.append(left, k);
    b.addEventListener('click', () => {
      togglePanel(false);
      if (cmd.needsDir && cmd.seq.startsWith('#')) S.dirAfterLine = true;
      sendBytes(cmd.seq);
    });
    list.appendChild(b);
  }
}

/* ---------------- physical keyboard: full passthrough ---------------- */
document.addEventListener('keydown', (e) => {
  if (!S || S.over || $('game').hidden) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
            t.tagName === 'SELECT')) return; /* form fields keep keys */
  let byte = null;
  if (e.ctrlKey && e.key.length === 1) {
    byte = e.key.toUpperCase().charCodeAt(0) & 0x1f;
  } else if (e.altKey || e.metaKey) {
    return;
  } else if (e.key.length === 1) {
    byte = e.key.charCodeAt(0) & 0xff;
  } else {
    switch (e.key) {
      case 'Enter': byte = 13; break;
      case 'Escape': byte = 27; break;
      case 'Backspace': byte = 127; break;
      case 'Tab': byte = 9; break;
      case 'ArrowLeft': byte = 104; break;  /* h */
      case 'ArrowDown': byte = 106; break;  /* j */
      case 'ArrowUp': byte = 107; break;    /* k */
      case 'ArrowRight': byte = 108; break; /* l */
      default: return;
    }
  }
  if (byte == null) return;
  e.preventDefault();
  sendBytes([byte]);
});

/* map taps: adjacent = move/attack, hero = wait, far = travel */
$('grid').addEventListener('click', (e) => {
  if (!S || S.over || !S.heroPos) return;
  const cell = e.target.closest('span[data-x]');
  if (!cell) return;
  const x = +cell.dataset.x, y = +cell.dataset.y;
  const dx = x - S.heroPos.x, dy = y - S.heroPos.y;
  const mode = uiMode();
  if (mode !== 'main' && mode !== 'dir' && mode !== 'dirprompt') return;
  if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
    const b = dirByte(dx, dy);
    if (b) sendKey(b);
    return;
  }
  if (mode === 'dir' || mode === 'dirprompt') return;
  /* travel: '_' + cursor steps + '.' -- the tty getpos key
     sequence, byte for byte */
  let seq = '_', cx = dx, cy = dy;
  while (cx !== 0 || cy !== 0) {
    const sx = Math.sign(cx), sy = Math.sign(cy);
    seq += dirByte(sx, sy);
    cx -= sx; cy -= sy;
  }
  seq += '.';
  sendBytes(seq);
});

/* ---------------- streamed frames: status + recorder ---------------- */
function parseFrame(text) {
  const get = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  const num = (re) => { const v = get(re); return v == null ? null : +v; };
  return {
    frame: num(/^frame (\d+)$/m),
    turn: num(/^turn (\d+)$/m),
    hash: get(/hash=([0-9a-f]{64})/),
    name: S ? S.playerName : '',
    role: S ? S.roleEn : '',
    hp: num(/hp=(-?\d+)/), hpmax: num(/hpmax=(\d+)/),
    pw: num(/pw=(-?\d+)/), pwmax: num(/pwmax=(\d+)/),
    ac: num(/ac=(-?\d+)/), xl: num(/xl=(\d+)/),
    gold: num(/gold=(\d+)/), hunger: num(/hunger=(-?\d+)/),
    dlevel: num(/dlevel=(\d+)/), moves: num(/moves=(\d+)/),
  };
}
function handleFrame(text) {
  if (!S) return;
  const f = parseFrame(text);
  S.lastFrame = f;
  S.records.push({
    k: 'turn', turn: f.turn, frame: f.frame, hash: f.hash,
    keys: bytesToB64(S.pendingKeys),
  });
  S.pendingKeys = [];
  renderStatus();
  maybeFlush();
}
function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* ---------------- recorder upload (chunked, to local stub) -------- */
function pushRecord(rec) {
  S.records.push(rec);
  maybeFlush();
}
function maybeFlush() {
  const pending = S.records.length - (S.flushedCount || 0);
  if (pending >= 16) flushRecords(false);
}
function flushRecords(final) {
  if (!S) return Promise.resolve();
  const from = S.flushedCount || 0;
  const batch = S.records.slice(from);
  S.flushedCount = S.records.length;
  if (!batch.length && !final) return Promise.resolve();
  const payload = { gameId: S.id, seq: S.recSeq++, final: !!final, records: batch };
  S.uploadChain = S.uploadChain.then(async () => {
    try {
      const r = await fetch('./upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error('upload ' + r.status);
      S.uploadOk = (S.uploadOk || 0) + batch.length;
    } catch (e) {
      /* stub unreachable: records stay in memory; the download
         button below still yields the complete stream */
      S.uploadFailed = true;
    }
  });
  return S.uploadChain;
}
setInterval(() => { if (S && !S.over) flushRecords(false); }, 8000);

function recordingText() {
  const lines = S.records.map((r) => JSON.stringify(r));
  return lines.join('\n') + '\n';
}

/* ---------------- game lifecycle ---------------- */
function randomSeed64() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return ((BigInt(a[0]) << 32n) | BigInt(a[1])).toString(10);
}

async function startGame() {
  const name = $('opt-name').value.trim() || 'fleck';
  const role = $('opt-role').value;
  const race = $('opt-race').value;
  const gender = $('opt-gender').value;
  const align = $('opt-align').value;
  const seedMode = document.querySelector('input[name="seedmode"]:checked').value;
  let seed, seedSource;
  if (seedMode === 'given') {
    seed = $('seed-input').value.trim();
    if (!/^\d+$/.test(seed) || BigInt(seed) >= (1n << 64n)) {
      alert('种子须为 0 – 2^64-1 的整数');
      return;
    }
    seedSource = 'given';
  } else {
    seed = randomSeed64();
    seedSource = 'random';
  }
  const options =
    `name:${name},role:${role},race:${race},gender:${gender},align:${align}`;
  const gameId = 'g-' + seed + '-' +
    new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' +
    Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');

  S = newSession({ gameId, seed, seedSource, options });
  S.playerName = name; S.roleEn = role;
  S.records.push({
    k: 'header', gameId, seed, seedSource, date: FIXED_DATE, options,
    startedAt: new Date().toISOString(), ua: navigator.userAgent,
    restored: pendingImport ? pendingImport.name : null,
  });

  $('setup').hidden = true;
  $('game').hidden = false;
  $('gameover').hidden = true;
  $('grid').innerHTML = '';
  $('msglog').innerHTML = '';
  $('msg').textContent = '';
  $('saves-box').innerHTML = '';
  hideOverlay(); hideLineBar(); togglePanel(false);
  $('seed-banner').textContent = seedSource === 'given'
    ? `种子：${seed}（指定） · 日期固定 · 本局 id：${gameId}`
    : `种子：随机（局终揭晓） · 日期固定 · 本局 id：${gameId}`;
  renderBar();

  /* host-side contract wiring; pre-s3.js installs the queue API
     and default collectors only for callbacks we do not predefine */
  globalThis.__airstring_config = {
    seed, date: FIXED_DATE, options, mode: 'async',
    exportPath: '/fleck.frames', rngPath: '/fleck.rng',
  };
  globalThis.__airstring_key_queue = { bytes: [], pos: 0, closed: false };
  globalThis.__airstring_event = (json) => handleEvent(json);
  globalThis.__airstring_frame = (text) => handleFrame(text);
  globalThis.__airstring_rngline = () => { if (S) S.rngLines++; };
  globalThis.__airstring_game_over = (status) => handleGameOver(status);

  const modArg = {
    print: (s) => appendLog('[out] ' + s),
    printErr: (s) => appendLog('[err] ' + s),
  };
  if (pendingImport) {
    const imp = pendingImport;
    /* our preRun runs before pre-s3's (it is earlier in the
       array), i.e. before the MEMFS skeleton exists -- create
       /save ourselves */
    modArg.preRun = [function () {
      try { modArg.FS.mkdir('/save'); } catch (e) { /* exists */ }
      try {
        modArg.FS.writeFile('/save/' + imp.name, imp.bytes);
        appendLog('已写入导入存档 /save/' + imp.name +
          '（' + imp.bytes.length + ' B）');
      } catch (e) {
        appendLog('导入存档写入失败：' + (e.errno || '') + ' ' +
          (e.message || String(e)));
      }
    }];
  }
  try {
    const { default: createModule } = await import('./nethack.js');
    S.module = await createModule(modArg);
  } catch (e) {
    appendLog('模块启动异常：' + (e && e.message ? e.message : e));
  }
}

function handleGameOver(status) {
  if (!S || S.over) return;
  S.over = true; S.overStatus = status;
  if (S.pendingKeys.length) {
    S.records.push({ k: 'tail', keys: bytesToB64(S.pendingKeys) });
    S.pendingKeys = [];
  }
  S.records.push({
    k: 'end', status, turns: S.lastFrame ? S.lastFrame.turn : 0,
    frames: S.lastFrame ? S.lastFrame.frame + 1 : 0, keysTotal: S.keysTotal,
  });
  flushRecords(true);
  const go = $('gameover');
  go.hidden = false;
  go.innerHTML = '';
  go.append(document.createTextNode(
    `本局结束（status ${status}）。录制流 ${S.records.length} 条记录` +
    (S.uploadFailed ? '（上传桩不可达，已保留在页面内存，可用下方按钮下载）'
                    : '，已分块上传至后端桩') + '。'));
  if (S.seedSource === 'random') {
    const d = document.createElement('div');
    d.className = 'seed';
    d.textContent = '本局随机种子揭晓：' + S.seed;
    go.appendChild(d);
  }
  refreshSaves();
  renderBar();
}

function refreshSaves() {
  const box = $('saves-box');
  box.innerHTML = '';
  let saves = [];
  try { saves = globalThis.__airstring_list_saves() || []; } catch (e) { }
  S.saves = saves.filter((n) => n !== '.keep');
  for (const name of S.saves) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '导出存档 ' + name;
    b.addEventListener('click', () => {
      const bytes = globalThis.__airstring_read_save(name);
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    box.appendChild(b);
  }
}

function showSetup() {
  $('game').hidden = true;
  $('setup').hidden = false;
  S = null;
}

/* ---------------- wiring ---------------- */
$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  startGame();
});
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) { pendingImport = null; $('import-info').textContent = ''; return; }
  const buf = new Uint8Array(await f.arrayBuffer());
  pendingImport = { name: f.name, bytes: buf };
  $('import-info').textContent =
    `已选择存档 ${f.name}（${buf.length} B），开局将恢复`;
});
$('line-send').addEventListener('click', submitLine);
$('line-cancel').addEventListener('click', () => sendBytes([27]));
$('line-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitLine(); }
  e.stopPropagation();
});
$('btn-commands').addEventListener('click', () =>
  togglePanel($('panel').hidden));
$('panel-close').addEventListener('click', () => togglePanel(false));
$('panel-search').addEventListener('input', (e) => renderPanel(e.target.value));
$('btn-export-rec').addEventListener('click', () => {
  if (!S) return;
  const blob = new Blob([recordingText()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = S.id + '.jsonl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('btn-newgame').addEventListener('click', showSetup);
/* after a tap, drop focus from the button so a following Space /
   Enter keypress is a game key, not a second button activation */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#game button');
  if (b) b.blur();
});

fillSetupForm();
renderBar();

/* read-only test/inspection hook (used by the S5 gate driver) */
window.__airstring_debug = {
  state: () => S ? {
    gameId: S.id, started: S.started, over: S.over,
    overStatus: S.overStatus, mode: uiMode(),
    counters: { ...S.counters }, keysTotal: S.keysTotal,
    lastFrame: S.lastFrame, underHero: S.underHero,
    heroPos: S.heroPos, saves: S.saves, records: S.records.length,
    uploadOk: S.uploadOk || 0, uploadFailed: !!S.uploadFailed,
    prompt: S.prompt, seed: S.seed, seedSource: S.seedSource,
    eventTail: S.eventTail || [],
    lastMessage: S.messages[S.messages.length - 1] || null,
  } : null,
  records: () => (S ? S.records : []),
};
