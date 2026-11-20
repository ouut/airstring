/* airstring frontend (S5/S6 core + Phase 1 modern Curses & mobile full-screen UI).
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

/* S6 cloud transport (web/firebase.js): when a real Firebase
 * config is present AND a user is signed in, recording chunks go
 * to Cloud Storage and the finished game is indexed in Firestore.
 * In every other case `cloud` is null (or reports no user) and the
 * upload path below is the S5 local-stub behaviour, unchanged. */
let cloud = null;
try { cloud = (await import('./firebase.js')).default; }
catch (e) { cloud = null; }
function cloudActive() { return !!(cloud && cloud.currentUser()); }

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

/* ---------------- UI preferences (mobile zoom & hand flip) ---------------- */
const mobileMQ = window.matchMedia('(max-width: 768px), (pointer: coarse)');
function isMobileMode() { return mobileMQ.matches; }

let mobileZoomed = true; /* mobile portrait default: follow-@ zoomed viewport */
let rightHandPad = false;
try { rightHandPad = localStorage.getItem('airstring_hand_right') === '1'; } catch (e) { }

function fillSetupForm() {
  const roleSel = $('opt-role'), raceSel = $('opt-race'), alignSel = $('opt-align');
  const cardsBox = $('role-cards');
  for (const [k, v] of Object.entries(ROLES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.zh + ' (' + k + ')';
    roleSel.appendChild(o);

    if (cardsBox) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'role-chip';
      chip.dataset.role = k;
      chip.append(document.createTextNode(v.zh));
      const en = document.createElement('span');
      en.className = 'en';
      en.textContent = k;
      chip.appendChild(en);
      chip.addEventListener('click', () => {
        roleSel.value = k;
        roleSel.dispatchEvent(new Event('change'));
      });
      cardsBox.appendChild(chip);
    }
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
    if (cardsBox) {
      for (const el of cardsBox.children) {
        el.classList.toggle('active', el.dataset.role === roleSel.value);
      }
    }
  };
  roleSel.addEventListener('change', sync);
  sync();
}

/* ---------------- setup lobby: read-only public verified games ---------------- */
function parseOptionMap(optStr) {
  const out = {};
  for (const part of String(optStr || '').split(',')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function fsVal(f) {
  if (!f) return null;
  if ('stringValue' in f) return f.stringValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return Number(f.doubleValue);
  if ('timestampValue' in f) return f.timestampValue;
  if ('booleanValue' in f) return f.booleanValue;
  return null;
}
async function loadVerifiedLobby() {
  const box = $('verified-list');
  if (!box) return;
  const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG;
  const project = cfg && cfg.projectId;
  if (!project || project.startsWith('REPLACE_')) {
    box.innerHTML = '<div class="hint">本地桩模式：未连接云端榜单。</div>';
    return;
  }
  box.innerHTML = '<div class="hint">加载已验真对局…</div>';
  try {
    const url = 'https://firestore.googleapis.com/v1/projects/' +
      encodeURIComponent(project) + '/databases/(default)/documents:runQuery';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'games' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'status' },
              op: 'EQUAL',
              value: { stringValue: 'verified' },
            },
          },
          orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
          limit: 12,
        },
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    const docs = rows.filter((x) => x.document && x.document.fields).map((x) => x.document);
    if (!docs.length) {
      box.innerHTML = '<div class="hint">暂无公开已验真对局，开一局成为第一人！</div>';
      return;
    }
    box.innerHTML = '';
    for (const doc of docs) {
      const f = doc.fields;
      const gameId = fsVal(f.gameId) || doc.name.split('/').pop();
      const seed = fsVal(f.seed) || '?';
      const turns = fsVal(f.turns) ?? 0;
      const frames = fsVal(f.framesMatched) ?? fsVal(f.frames) ?? 0;
      const opts = parseOptionMap(fsVal(f.options));
      const roleKey = opts.role || 'valkyrie';
      const roleZh = (ROLES[roleKey] && ROLES[roleKey].zh) || roleKey;
      const name = opts.name || 'fleck';
      const ts = fsVal(f.createdAt);
      const when = ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

      const item = document.createElement('div');
      item.className = 'vgame-item';
      const top = document.createElement('div');
      top.className = 'vgame-top';
      const title = document.createElement('span');
      title.textContent = `${name} · ${roleZh} · 种子 #${seed}`;
      const badge = document.createElement('span');
      badge.className = 'vgame-badge';
      badge.textContent = `✓ ${frames} 帧`;
      top.append(title, badge);

      const meta = document.createElement('div');
      meta.className = 'vgame-meta';
      const m1 = document.createElement('span');
      m1.textContent = `回合 ${turns} · ${gameId}`;
      const m2 = document.createElement('span');
      m2.textContent = when;
      meta.append(m1, m2);

      const foot = document.createElement('div');
      foot.className = 'vgame-foot';
      const sameBtn = document.createElement('button');
      sameBtn.type = 'button';
      sameBtn.className = 'mini-btn';
      sameBtn.textContent = '同种子开局';
      sameBtn.addEventListener('click', () => {
        const givenRadio = document.querySelector('input[name="seedmode"][value="given"]');
        if (givenRadio) givenRadio.checked = true;
        if (/^\d+$/.test(String(seed))) $('seed-input').value = String(seed);
        if (ROLES[roleKey]) {
          $('opt-role').value = roleKey;
          $('opt-role').dispatchEvent(new Event('change'));
        }
        $('start-btn').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      foot.appendChild(sameBtn);

      item.append(top, meta, foot);
      box.appendChild(item);
    }
  } catch (e) {
    box.innerHTML = '<div class="hint">暂时无法拉取已验真列表（不影响离线或正常游玩）。</div>';
  }
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

/* ---------------- drawers & overlays helpers ---------------- */
function toggleMsgLog(open) {
  const el = $('msglog-drawer');
  if (!el) return;
  const next = open == null ? el.hidden : !!open;
  el.hidden = !next;
  if (next) {
    const log = $('msglog');
    log.scrollTop = log.scrollHeight;
  }
  const btn = document.querySelector('#actionbar button.log-toggle-btn');
  if (btn) {
    btn.classList.toggle('log-open', next);
    btn.textContent = next ? '日志 ▴' : '日志 ▾';
  }
}
function toggleGameDrawer(open) {
  const el = $('game-drawer');
  if (!el) return;
  el.hidden = !(open == null ? el.hidden : !!open);
}

/* ---------------- the one input funnel ---------------- */
function sendBytes(data) {
  if (!S || S.over) return;
  /* auto-close message history drawer on any gameplay input */
  if ($('msglog-drawer') && !$('msglog-drawer').hidden) toggleMsgLog(false);
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

/* ---------------- 2-line message bar (same on desktop & mobile) ---------------- */
function renderMessages() {
  const prevEl = $('msg-prev');
  const curEl = $('msg');
  if (!S) {
    if (prevEl) prevEl.textContent = '';
    if (curEl) curEl.textContent = '';
    return;
  }
  const len = S.messages.length;
  const latest = len >= 1 ? S.messages[len - 1] : '';
  const prev = len >= 2 ? S.messages[len - 2] : '';
  if (prevEl) prevEl.textContent = prev;
  curEl.innerHTML = '';
  curEl.append(document.createTextNode(latest));
  if (S.moreActive) {
    const m = document.createElement('span');
    m.className = 'moreflag';
    m.textContent = ' --More--';
    curEl.appendChild(m);
  }
}

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
      renderMessages();
      appendLog(ev.text);
      break;
    case 'raw':
      S.messages.push(ev.text);
      renderMessages();
      appendLog('[!] ' + ev.text);
      break;
    case 'more':
      S.moreActive = true; S.counters.more++;
      renderMessages();
      break;
    case 'prompt':
      if (ev.kind === 'yn' && ev.choices == null &&
          /direction/i.test(ev.q || '')) {
        ev.dirPrompt = true;
        S.counters.dir++;
      }
      S.prompt = ev;
      if (ev.kind === 'yn') S.counters.yn++;
      if (ev.kind === 'line') { S.counters.line++; showLineBar(ev.q); }
      if (ev.q) {
        S.messages.push(ev.q);
        renderMessages();
      }
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
      showOverlay('R.I.P.', null, 'rip');
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
        renderMessages();
      }
      if (S.getretActive) S.getretActive = false;
      break;
    case 'exit': S.exited = true; break;
  }
  renderBar();
}

/* ---------------- map viewport: full 80x21 + mobile follow-@ zoom ---------------- */
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
      const under = prev[hero.y] && prev[hero.y][hero.x];
      if (under && under !== '@') S.underHero = under;
    }
    S.heroPos = hero;
  }
  if (S.textActive && !S.ripActive) { S.textActive = false; hideOverlay(); }
  renderGrid();
}

function updateZoomButton() {
  const btn = $('btn-zoom');
  if (!btn) return;
  const show = !!S && !S.over && isMobileMode();
  btn.hidden = !show;
  if (show) {
    btn.textContent = mobileZoomed ? '🗺 全图' : '◎ 跟随';
  }
}

let lastGridDims = '';
function renderGrid() {
  const grid = $('grid');
  const stage = $('stage');
  if (!S || !S.mapRows || !grid || !stage) return;
  updateZoomButton();

  const sw = Math.max(120, stage.clientWidth - 8);
  const sh = Math.max(100, stage.clientHeight - 8);
  const useZoom = isMobileMode() && mobileZoomed && S.heroPos;

  let x0 = 0, y0 = 0, viewW = 80, viewH = 21, fs = 14;
  if (useZoom) {
    /* Crisp ~15.5px font on mobile portrait, hard-snapped centered on @ */
    fs = Math.max(13, Math.min(17, Math.floor(sw / 25 / 0.61)));
    viewW = Math.max(20, Math.min(80, Math.floor(sw / (fs * 0.61))));
    viewH = Math.max(11, Math.min(21, Math.floor(sh / (fs * 1.16))));
    x0 = Math.max(0, Math.min(80 - viewW, S.heroPos.x - Math.floor(viewW / 2)));
    y0 = Math.max(0, Math.min(21 - viewH, S.heroPos.y - Math.floor(viewH / 2)));
  } else {
    const fsW = Math.floor(sw / 80 / 0.605);
    const fsH = Math.floor(sh / 21 / 1.17);
    fs = Math.max(6, Math.min(24, fsW, fsH));
  }

  grid.style.fontSize = fs + 'px';
  const dimKey = viewW + 'x' + viewH;
  if (dimKey !== lastGridDims || grid.children.length !== viewH) {
    lastGridDims = dimKey;
    grid.innerHTML = '';
    for (let vy = 0; vy < viewH; vy++) {
      const row = document.createElement('div');
      row.className = 'row';
      for (let vx = 0; vx < viewW; vx++) {
        const c = document.createElement('span');
        c.textContent = ' ';
        row.appendChild(c);
      }
      grid.appendChild(row);
    }
  }

  for (let vy = 0; vy < viewH; vy++) {
    const mapY = y0 + vy;
    const chars = S.mapRows[mapY] || '';
    const colors = (S.mapColors && S.mapColors[mapY]) || [];
    const rowEl = grid.children[vy];
    for (let vx = 0; vx < viewW; vx++) {
      const mapX = x0 + vx;
      const cell = rowEl.children[vx];
      cell.dataset.x = mapX;
      cell.dataset.y = mapY;
      const ch = chars[mapX] || ' ';
      if (cell.textContent !== ch) cell.textContent = ch;
      const isHero = S.heroPos && mapX === S.heroPos.x && mapY === S.heroPos.y && ch === '@';
      const cls = isHero
        ? 'hero-cell'
        : ('c' + (((colors[mapX] | 0) & 0x1f) % 16));
      if (cell.className !== cls) cell.className = cls;
    }
  }
}

let resizeRaf = 0;
window.addEventListener('resize', () => {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    renderGrid();
    renderBar();
  });
});

/* ---------------- statushilites HUD + 2px HP bar ---------------- */
function makeSpan(cls, text) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}
function renderStatus() {
  const el = $('status');
  const barFill = $('hp-bar-fill');
  if (!el) return;
  if (!S) {
    el.textContent = '';
    if (barFill) barFill.style.width = '0%';
    return;
  }
  if (S.statusLines) {
    el.textContent = S.statusLines.join('  ');
    return;
  }
  const f = S.lastFrame;
  el.innerHTML = '';
  if (!f) {
    el.append(
      makeSpan('st-name', S.playerName || 'fleck'),
      makeSpan('st-role', S.roleEn || ''),
      makeSpan('', '启动中…')
    );
    if (barFill) { barFill.style.width = '100%'; barFill.style.background = 'var(--ok)'; }
    return;
  }
  const hp = f.hp ?? 0, hpmax = Math.max(1, f.hpmax ?? 1);
  const pct = Math.max(0, Math.min(100, Math.round((hp / hpmax) * 100)));
  const hpCls = pct <= 25 ? 'st-hp-crit' : pct <= 55 ? 'st-hp-warn' : 'st-hp-ok';
  const barCol = pct <= 25 ? 'var(--danger)' : pct <= 55 ? 'var(--warn)' : 'var(--ok)';
  if (barFill) { barFill.style.width = pct + '%'; barFill.style.background = barCol; }

  const hungerWord = f.hunger == null ? '' :
    f.hunger < 0 ? '昏厥' : f.hunger < 50 ? '虚弱' :
    f.hunger < 150 ? '饥饿' : f.hunger > 1000 ? '饱足' : '';
  const hungerCrit = f.hunger != null && f.hunger < 50;

  el.append(
    makeSpan('st-name', f.name || S.playerName || ''),
    makeSpan('st-role', f.role || S.roleEn || ''),
    makeSpan(hpCls, `HP:${f.hp}/${f.hpmax}`),
    makeSpan('st-pw', `Pw:${f.pw}/${f.pwmax}`),
    makeSpan('', `AC:${f.ac}`),
    makeSpan('st-dlvl', `Dlvl:${f.dlevel}`),
    makeSpan('st-gold', `$:${f.gold}`),
    makeSpan('', `XL:${f.xl}`),
    makeSpan('', `T:${f.moves}`)
  );
  if (hungerWord) {
    el.append(makeSpan('st-hunger' + (hungerCrit ? ' crit' : ''), hungerWord));
  }
}

function appendLog(text) {
  const log = $('msglog');
  if (!log) return;
  const div = document.createElement('div');
  div.textContent = text;
  log.appendChild(div);
  while (log.children.length > 200) log.removeChild(log.firstChild);
  if ($('msglog-drawer') && !$('msglog-drawer').hidden) {
    log.scrollTop = log.scrollHeight;
  }
}

/* ---------------- true overlays: Curses right menu / centered text ---------------- */
function showOverlay(title, bodyPre, kind) {
  const ov = $('overlay');
  ov.hidden = false;
  ov.classList.toggle('mode-menu', kind === 'menu');
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
  const ov = $('overlay');
  ov.hidden = true;
  ov.classList.remove('mode-menu');
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
      ev.how === 'PICK_ONE' ? ' 选一项' : ''), null, 'menu');
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
  const body = showOverlay(S.ripActive ? 'R.I.P.' : '文本', lines.join('\n'), 'text');
  body.scrollTop = 0;
  overlayAction('继续（空格）', () => sendKey(' '), true);
}

/* ---------------- line prompt ---------------- */
function showLineBar(q) {
  $('linebar').hidden = false;
  $('line-q').textContent = q || '';
  const inp = $('line-input');
  inp.value = '';
  setTimeout(() => {
    if (!$('linebar').hidden) inp.focus({ preventScroll: true });
  }, 30);
}
function hideLineBar() {
  $('linebar').hidden = true;
  if (document.activeElement === $('line-input')) $('line-input').blur();
}
function submitLine() {
  const inp = $('line-input');
  sendBytes(inp.value + '\n');
  inp.value = '';
}

/* ---------------- adaptive thumb control zone (mobile portrait + optional desktop) ---------------- */
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
function dirPad(selfLabel) {
  const pad = document.createElement('div');
  pad.id = 'dirpad';
  for (const d of DIRS) {
    const b = document.createElement('button');
    b.type = 'button';
    const isCenter = d.dx === 0 && d.dy === 0;
    if (isCenter) b.className = 'center-dot';
    b.textContent = isCenter ? (selfLabel || '休 .') : d.label;
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
  const adj = adjacentCells();
  const door = adj.find((c) => c.ch === '+');
  if (door) {
    btns.push(actBtn('开门', 'o+方向', () => {
      sendBytes('o' + dirByte(door.dx, door.dy));
    }, true));
  }
  if (under === '<') btns.push(actBtn('上楼', '<', () => sendKey('<'), true));
  if (under === '>') btns.push(actBtn('下楼', '>', () => sendKey('>'), true));
  if (under === '_') btns.push(actBtn('献祭', '#offer', () => sendBytes('#offer\n'), true));
  if (under === '{') {
    btns.push(actBtn('喝泉水', 'q', () => sendKey('q')));
    btns.push(actBtn('蘸取', '#dip', () => sendBytes('#dip\n')));
  }
  if (under === '(') btns.push(actBtn('搜掠', '#loot', () => sendBytes('#loot\n')));
  btns.push(actBtn('拾取', ',', () => sendKey(',')));
  const mon = adj.find((c) => MONSTERISH.test(c.ch) && c.ch !== '@');
  if (mon) {
    btns.push(actBtn('交谈', '#chat', () => {
      S.dirAfterLine = true;
      sendBytes('#chat\n');
    }));
  }
  /* Pad with core frequent actions up to 4 slots so muscle memory stays steady */
  const hpLow = S.lastFrame && S.lastFrame.hpmax > 0 &&
    (S.lastFrame.hp / S.lastFrame.hpmax) <= 0.55;
  if (btns.length < 4) btns.push(actBtn('喝药', 'q', () => sendKey('q'), hpLow));
  if (btns.length < 4) btns.push(actBtn('吃东西', 'e', () => sendKey('e')));
  if (btns.length < 4 && !door) btns.push(actBtn('开门', 'o', () => sendKey('o')));
  if (btns.length < 4) btns.push(actBtn('关门', 'c', () => sendKey('c')));
  return btns;
}

/* Pack arbitrary N context buttons cleanly into locked-height 1/2/3/4/6 grid */
function buildContextZone(buttons) {
  const zone = document.createElement('div');
  let list = buttons.slice();
  if (list.length > 6) {
    const rest = list.length - 5;
    list = list.slice(0, 5);
    list.push(actBtn(`更多 +${rest}`, '命令面板', () => togglePanel(true)));
  }
  const n = list.length;
  const cls = n <= 1 ? 'ctx-n1' : n === 2 ? 'ctx-n2' : n === 3 ? 'ctx-n3' :
    n === 4 ? 'ctx-n4' : 'ctx-n6';
  zone.className = 'ctx-zone ' + cls;
  for (const b of list) zone.appendChild(b);
  return zone;
}

function buildQuickStrip() {
  const row = document.createElement('div');
  row.className = 'thumb-quick';
  const mk = (text, fn, cls) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  };
  const logOpen = $('msglog-drawer') && !$('msglog-drawer').hidden;
  row.append(
    mk('背包 i', () => sendKey('i')),
    mk('搜索 s', () => sendKey('s')),
    mk(logOpen ? '日志 ▴' : '日志 ▾', () => toggleMsgLog(), 'log-toggle-btn' + (logOpen ? ' log-open' : '')),
    mk('命令', () => togglePanel(true)),
    mk('⇄', () => {
      rightHandPad = !rightHandPad;
      try { localStorage.setItem('airstring_hand_right', rightHandPad ? '1' : '0'); } catch (e) { }
      renderBar();
    }, 'flip-btn')
  );
  return row;
}

function renderBar() {
  const bar = $('actionbar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!S) return;
  const mode = uiMode();

  const mainRow = document.createElement('div');
  mainRow.className = 'thumb-main' + (rightHandPad ? ' hand-right' : '');

  let ctxBtns = [];
  let padCenter = null;

  if (mode === 'over') {
    ctxBtns = [
      actBtn('回开局页', '', () => showSetup(), true),
      actBtn('下载录制流', '.jsonl', () => $('btn-export-rec').click()),
    ];
  } else if (mode === 'boot') {
    ctxBtns = [actBtn('游戏启动中…', '', () => { })];
  } else if (mode === 'line') {
    ctxBtns = [
      actBtn('提交', 'Enter', () => submitLine(), true),
      actBtn('取消', 'Esc', () => sendBytes([27])),
    ];
  } else if (mode === 'yn') {
    const p = S.prompt;
    const choices = p.choices || 'ynq';
    const zh = { y: '是', n: '否', q: '取消', a: '全部' };
    for (const ch of choices) {
      ctxBtns.push(actBtn((zh[ch] || ch) + '', ch, () => sendKey(ch), p.def === ch));
    }
    if (!choices.includes('\x1b')) {
      ctxBtns.push(actBtn('取消', 'Esc', () => sendBytes([27])));
    }
  } else if (mode === 'objprompt') {
    const p = S.prompt;
    ctxBtns = [
      actBtn('看列表', '?', () => sendKey('?'), true),
      actBtn('全部显示', '*', () => sendKey('*')),
    ];
    const m = /\[\s*(\S)\s+or\s+\?\*\]/.exec(p.q || '');
    if (m) ctxBtns.push(actBtn('就它（' + m[1] + '）', m[1], () => sendKey(m[1])));
    ctxBtns.push(actBtn('取消', 'Esc', () => sendBytes([27])));
  } else if (mode === 'menu') {
    ctxBtns = [
      actBtn('翻页', '空格', () => sendKey(' ')),
      actBtn('关闭菜单', 'Esc', () => sendBytes([27])),
    ];
  } else if (mode === 'text' || mode === 'more' || mode === 'getret') {
    ctxBtns = [actBtn('继续', '空格', () => sendKey(' '), true)];
  } else if (mode === 'dir' || mode === 'dirprompt') {
    padCenter = '自身 .';
    ctxBtns = [
      actBtn('选方向', '点左侧方向盘', () => { }),
      actBtn('取消', 'Esc', () => { S.expectingDir = null; sendBytes([27]); }),
    ];
  } else {
    ctxBtns = contextualMainButtons();
  }

  mainRow.append(dirPad(padCenter), buildContextZone(ctxBtns));
  bar.append(mainRow, buildQuickStrip());
}

/* ---------------- command panel ---------------- */
function togglePanel(open) {
  $('panel').hidden = !open;
  if (open) {
    toggleGameDrawer(false);
    toggleMsgLog(false);
    renderPanel('');
    $('panel-search').focus();
  } else if (document.activeElement === $('panel-search')) {
    $('panel-search').blur();
  }
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
            t.tagName === 'SELECT')) return;
  if (e.key === 'Escape') {
    if ($('game-drawer') && !$('game-drawer').hidden) { toggleGameDrawer(false); return; }
    if ($('panel') && !$('panel').hidden) { togglePanel(false); return; }
    if ($('msglog-drawer') && !$('msglog-drawer').hidden) { toggleMsgLog(false); return; }
  }
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

/* map taps: adjacent = move/attack, hero = wait, far = travel (works in both full & zoomed view!) */
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

/* ---------------- recorder upload (unchanged S5/S6 contract) -------- */
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
      if (cloudActive()) {
        await cloud.uploadChunk(payload);
        S.cloudTransport = true;
      } else {
        const r = await fetch('./upload', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error('upload ' + r.status);
      }
      S.uploadOk = (S.uploadOk || 0) + batch.length;
    } catch (e) {
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

  document.body.classList.add('in-game');
  $('setup').hidden = true;
  $('game').hidden = false;
  $('gameover').hidden = true;
  $('grid').innerHTML = '';
  lastGridDims = '';
  $('msglog').innerHTML = '';
  $('saves-box').innerHTML = '';
  hideOverlay(); hideLineBar(); togglePanel(false);
  toggleMsgLog(false); toggleGameDrawer(false);
  $('seed-banner').textContent = seedSource === 'given'
    ? `种子：${seed}（指定）\n日期固定 · 局 ID：${gameId}`
    : `种子：随机（局终揭晓）\n日期固定 · 局 ID：${gameId}`;
  renderMessages();
  renderStatus();
  updateZoomButton();
  renderBar();

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
  const useCloud = cloudActive();
  if (useCloud) {
    const endRec = S.records[S.records.length - 1];
    const header = S.records[0];
    S.uploadChain = S.uploadChain.then(async () => {
      try {
        await cloud.finalizeGame({
          gameId: S.id, seed: S.seed, seedSource: S.seedSource,
          date: S.date, options: S.options,
          restored: header && header.k === 'header'
            ? header.restored : null,
          end: status, turns: endRec.turns, frames: endRec.frames,
          keysTotal: endRec.keysTotal,
          recordingText: recordingText(),
        });
      } catch (e) { S.uploadFailed = true; }
    });
  }
  const go = $('gameover');
  go.hidden = false;
  go.innerHTML = '';
  go.append(document.createTextNode(
    `本局结束（status ${status}）。录制流 ${S.records.length} 条记录` +
    (S.uploadFailed ? '（上传不可达，已保留在页面内存，可下载）'
     : useCloud ? '，已上云（Storage＋Firestore，自动触发验真中）'
                : '，已分块上传至本地桩') + '。'));
  if (S.seedSource === 'random') {
    const d = document.createElement('div');
    d.className = 'seed';
    d.textContent = '本局随机种子揭晓：' + S.seed;
    go.appendChild(d);
  }
  const acts = document.createElement('div');
  acts.className = 'go-actions';
  const bNew = document.createElement('button');
  bNew.type = 'button'; bNew.className = 'primary'; bNew.textContent = '返回开局页';
  bNew.addEventListener('click', showSetup);
  const bRec = document.createElement('button');
  bRec.type = 'button'; bRec.textContent = '下载录制流';
  bRec.addEventListener('click', () => $('btn-export-rec').click());
  acts.append(bNew, bRec);
  go.appendChild(acts);

  refreshSaves();
  updateZoomButton();
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
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => { });
  }
  document.body.classList.remove('in-game');
  toggleGameDrawer(false);
  toggleMsgLog(false);
  $('game').hidden = true;
  $('setup').hidden = false;
  S = null;
  loadVerifiedLobby();
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

/* Phase 1 UI controls */
$('msg-wrap').addEventListener('click', () => toggleMsgLog());
$('msglog-close').addEventListener('click', () => toggleMsgLog(false));
$('btn-drawer').addEventListener('click', () => toggleGameDrawer());
$('btn-drawer-close').addEventListener('click', () => toggleGameDrawer(false));
$('game-drawer-backdrop').addEventListener('click', () => toggleGameDrawer(false));
$('btn-drawer-log').addEventListener('click', () => {
  toggleGameDrawer(false);
  toggleMsgLog(true);
});
$('btn-zoom').addEventListener('click', () => {
  mobileZoomed = !mobileZoomed;
  renderGrid();
});
$('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => { });
    }
  } else if (document.exitFullscreen) {
    document.exitFullscreen().catch(() => { });
  }
});
document.addEventListener('fullscreenchange', () => {
  $('btn-fullscreen').classList.toggle('active', !!document.fullscreenElement);
  requestAnimationFrame(() => renderGrid());
});
$('btn-toggle-touch').addEventListener('click', () => {
  const on = document.body.classList.toggle('show-touchbar');
  $('btn-toggle-touch').classList.toggle('active', on);
  requestAnimationFrame(() => renderGrid());
});
$('overlay-close-x').addEventListener('click', () => {
  if (!S) return;
  const mode = uiMode();
  if (mode === 'menu') sendBytes([27]);
  else sendKey(' ');
});
$('btn-refresh-lobby').addEventListener('click', () => loadVerifiedLobby());

/* after a tap, drop focus from the button so a following Space /
   Enter keypress is a game key, not a second button activation */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#game button');
  if (b) b.blur();
});

fillSetupForm();
renderBar();
loadVerifiedLobby();

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
