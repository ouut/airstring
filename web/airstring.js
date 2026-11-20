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
try { cloud = (await import('./firebase.js?v=p2fix1')).default; }
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

/* ---------------- setup lobby: Phase 2 YouTube-style verified replay gallery ---------------- */
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
  if ('arrayValue' in f) {
    return ((f.arrayValue && f.arrayValue.values) || []).map(fsVal);
  }
  return null;
}

function parseGameDoc(doc) {
  const f = (doc && doc.fields) || {};
  const gameId = fsVal(f.gameId) || (doc.name ? doc.name.split('/').pop() : '');
  const options = fsVal(f.options) || '';
  const opts = parseOptionMap(options);
  return {
    gameId,
    uid: fsVal(f.uid) || null,
    status: fsVal(f.status) || 'verified',
    seed: String(fsVal(f.seed) ?? '?'),
    seedSource: fsVal(f.seedSource) || 'given',
    options,
    name: opts.name || 'fleck',
    roleKey: opts.role || 'valkyrie',
    turns: fsVal(f.turns) ?? 0,
    frames: fsVal(f.framesMatched) ?? fsVal(f.frames) ?? 0,
    framesCompared: fsVal(f.framesCompared) ?? fsVal(f.frames) ?? 0,
    framesMatched: fsVal(f.framesMatched) ?? fsVal(f.frames) ?? 0,
    createdAt: fsVal(f.createdAt) || '',
    verifiedAt: fsVal(f.verifiedAt) || '',
    recordingSha256: fsVal(f.recordingSha256) || '',
    publicRecordingPath: fsVal(f.publicRecordingPath) || null,
    thumb: fsVal(f.thumb) || null,
    maxDlvl: fsVal(f.maxDlvl) ?? null,
    outcome: fsVal(f.outcome) || null,
    deathReason: fsVal(f.deathReason) || null,
    tags: Array.isArray(fsVal(f.tags)) ? fsVal(f.tags) : [],
    parentGameId: fsVal(f.parentGameId) || null,
    forkTurn: fsVal(f.forkTurn),
  };
}

function normalizePlainGame(d) {
  const options = d.options || '';
  const opts = parseOptionMap(options);
  return {
    gameId: d.gameId || d.id || '',
    uid: d.uid || null,
    status: d.status || 'pending',
    seed: String(d.seed ?? '?'),
    seedSource: d.seedSource || 'given',
    options,
    name: opts.name || 'fleck',
    roleKey: opts.role || 'valkyrie',
    turns: d.turns ?? 0,
    frames: d.framesMatched ?? d.frames ?? 0,
    framesCompared: d.framesCompared ?? d.frames ?? 0,
    framesMatched: d.framesMatched ?? d.frames ?? 0,
    createdAt: d.createdAt || '',
    verifiedAt: d.verifiedAt || '',
    recordingSha256: d.recordingSha256 || '',
    publicRecordingPath: d.publicRecordingPath || null,
    thumb: d.thumb || null,
    maxDlvl: d.maxDlvl ?? null,
    outcome: d.outcome || null,
    deathReason: d.deathReason || null,
    tags: Array.isArray(d.tags) ? d.tags : [],
    parentGameId: d.parentGameId || null,
    forkTurn: d.forkTurn != null ? d.forkTurn : null,
  };
}

function renderAsciiThumb(thumbJson) {
  let obj;
  try { obj = JSON.parse(thumbJson); } catch (e) { return null; }
  if (!obj || !Array.isArray(obj.r) || !obj.r.length) return null;
  const pre = document.createElement('pre');
  pre.className = 'ascii-thumb';
  for (let y = 0; y < obj.r.length; y++) {
    const rowStr = String(obj.r[y] || '');
    const colStr = String((obj.c && obj.c[y]) || '');
    const lineDiv = document.createElement('div');
    let runColor = null;
    let runText = '';
    const flush = () => {
      if (!runText) return;
      const sp = document.createElement('span');
      sp.className = 'c' + (runColor != null ? runColor : 7);
      sp.textContent = runText;
      lineDiv.appendChild(sp);
      runText = '';
    };
    for (let x = 0; x < rowStr.length; x++) {
      const ch = rowStr[x];
      const ci = parseInt(colStr[x] || '7', 16);
      const c = Number.isFinite(ci) ? (ci & 0xf) : 7;
      if (ch === '@') {
        flush();
        const heroSp = document.createElement('span');
        heroSp.className = 'c15 hero-at';
        heroSp.textContent = '@';
        lineDiv.appendChild(heroSp);
        runColor = null;
      } else if (c === runColor) {
        runText += ch;
      } else {
        flush();
        runColor = c;
        runText = ch;
      }
    }
    flush();
    pre.appendChild(lineDiv);
  }
  return pre;
}

function canWatchGame(g) {
  if (!g) return false;
  if (g.publicRecordingPath) return true;
  const u = cloud && cloud.currentUser();
  return !!(u && g.uid && g.uid === u.uid);
}

function buildGalleryCard(g, fromPage) {
  const roleZh = (ROLES[g.roleKey] && ROLES[g.roleKey].zh) || g.roleKey;
  const when = g.createdAt
    ? new Date(g.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  const watchable = canWatchGame(g);

  const card = document.createElement('article');
  card.className = 'vgame-card';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'vgame-thumb-wrap';
  const pre = g.thumb ? renderAsciiThumb(g.thumb) : null;
  if (pre) {
    thumbWrap.appendChild(pre);
  } else {
    const ph = document.createElement('div');
    ph.className = 'ascii-thumb-placeholder';
    ph.textContent = `@  #${g.seed}\n${g.name} · ${roleZh}\n` +
      (watchable ? '点击播放本地 WASM 回放' : '（历史局无公开录像）');
    thumbWrap.appendChild(ph);
  }

  const outPill = document.createElement('span');
  outPill.className = 'thumb-pill-tl' +
    (g.outcome === 'ascended' ? ' ascended' : g.outcome === 'died' ? ' died' : '');
  outPill.textContent = g.status === 'pending' ? '⏳ 待验真'
    : g.status === 'rejected' ? '✗ 未通过'
    : g.outcome === 'ascended' ? '🏆 飞升'
    : g.outcome === 'died' ? '💀 阵亡'
    : g.parentGameId ? '⚡ 分叉局' : '✓ 已验真';
  thumbWrap.appendChild(outPill);

  const framePill = document.createElement('span');
  framePill.className = 'thumb-pill-tr';
  framePill.textContent = g.status === 'verified' ? `✓ ${g.framesMatched} 帧` : `${g.frames} 帧`;
  thumbWrap.appendChild(framePill);

  const statPill = document.createElement('span');
  statPill.className = 'thumb-pill-br';
  statPill.textContent = (g.maxDlvl ? `Dlvl:${g.maxDlvl} · ` : '') + `T:${g.turns}`;
  thumbWrap.appendChild(statPill);

  if (watchable) {
    thumbWrap.title = '点击观看录像与分叉';
    thumbWrap.addEventListener('click', () => openReplay(g, { fromPage }));
  }

  const body = document.createElement('div');
  body.className = 'vgame-body';

  const top = document.createElement('div');
  top.className = 'vgame-top';
  const title = document.createElement('span');
  title.textContent = `${g.name} · ${roleZh} · #${g.seed}`;
  top.appendChild(title);
  if (g.parentGameId) {
    const fb = document.createElement('span');
    fb.className = 'ag-badge fork';
    fb.textContent = `⚡ T${g.forkTurn ?? 0}`;
    top.appendChild(fb);
  }

  const meta = document.createElement('div');
  meta.className = 'vgame-meta';
  const m1 = document.createElement('span');
  m1.textContent = g.gameId;
  const m2 = document.createElement('span');
  m2.textContent = when;
  meta.append(m1, m2);

  body.append(top, meta);
  if (g.deathReason) {
    const rs = document.createElement('div');
    rs.className = 'vgame-reason';
    rs.textContent = g.deathReason;
    rs.title = g.deathReason;
    body.appendChild(rs);
  }

  const foot = document.createElement('div');
  foot.className = 'vgame-foot';

  if (watchable) {
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'mini-btn play-btn';
    playBtn.textContent = '▶ 回放 / 分叉';
    playBtn.addEventListener('click', () => openReplay(g, { fromPage }));
    foot.appendChild(playBtn);
  }

  const sameBtn = document.createElement('button');
  sameBtn.type = 'button';
  sameBtn.className = 'mini-btn';
  sameBtn.textContent = '同种子开局';
  sameBtn.addEventListener('click', () => {
    showSetup();
    const givenRadio = document.querySelector('input[name="seedmode"][value="given"]');
    if (givenRadio) givenRadio.checked = true;
    if (/^\d+$/.test(String(g.seed))) $('seed-input').value = String(g.seed);
    if (ROLES[g.roleKey]) {
      $('opt-role').value = g.roleKey;
      $('opt-role').dispatchEvent(new Event('change'));
    }
    $('start-btn').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  foot.appendChild(sameBtn);

  body.appendChild(foot);
  card.append(thumbWrap, body);
  return card;
}

let verifiedGamesCache = [];
let lobbyFilter = 'all';

function renderVerifiedGallery() {
  const box = $('verified-list');
  if (!box) return;
  const q = (($('lobby-search') && $('lobby-search').value) || '').trim().toLowerCase();

  const list = verifiedGamesCache.filter((g) => {
    if (lobbyFilter === 'ascended' && g.outcome !== 'ascended') return false;
    if (lobbyFilter === 'died' && g.outcome !== 'died') return false;
    if (lobbyFilter === 'fork' && !g.parentGameId) return false;
    if (q) {
      const roleZh = (ROLES[g.roleKey] && ROLES[g.roleKey].zh) || '';
      const hay = `${g.name} ${g.roleKey} ${roleZh} ${g.seed} ${g.gameId} ${g.deathReason || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (!list.length) {
    box.innerHTML = '<div class="hint">没有匹配筛选条件的公开已验真对局。</div>';
    return;
  }

  box.innerHTML = '';
  for (const g of list) {
    box.appendChild(buildGalleryCard(g, 'setup'));
  }
}

async function loadVerifiedLobby() {
  const box = $('verified-list');
  if (!box) return;
  const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG;
  const project = cfg && cfg.projectId;
  if (!project || project.startsWith('REPLACE_')) {
    box.innerHTML = '<div class="hint">本地桩模式：未连接云端录像大厅。</div>';
    return;
  }
  box.innerHTML = '<div class="hint">加载公开已验真录像…</div>';
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
          limit: 36,
        },
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    verifiedGamesCache = rows
      .filter((x) => x.document && x.document.fields)
      .map((x) => parseGameDoc(x.document));
    if (!verifiedGamesCache.length) {
      box.innerHTML = '<div class="hint">暂无公开已验真对局，开一局成为第一人！</div>';
      return;
    }
    renderVerifiedGallery();
  } catch (e) {
    box.innerHTML = '<div class="hint">暂时无法拉取已验真列表（不影响离线或正常游玩）。</div>';
  }
}

async function fetchGameDocById(gameId) {
  const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG;
  const project = cfg && cfg.projectId;
  if (!project || project.startsWith('REPLACE_')) return null;
  const url = 'https://firestore.googleapis.com/v1/projects/' +
    encodeURIComponent(project) + '/databases/(default)/documents/games/' +
    encodeURIComponent(gameId);
  const r = await fetch(url);
  if (!r.ok) return null;
  const doc = await r.json();
  return doc && doc.fields ? parseGameDoc(doc) : null;
}

/* ---------------- IndexedDB local persistence (signed-in uid only) ---------------- */
const IDB_NAME = 'airstring_active_v1';
const IDB_STORE = 'games';
const SHELVE_AGE_MS = 30 * 24 * 3600 * 1000; /* 30 days */
const MAX_ACTIVE_SOFT_CAP = 50;

let idbPromise = null;
function openIdb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { resolve(null); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const st = db.createObjectStore(IDB_STORE, { keyPath: 'pk' });
        st.createIndex('by_uid', 'uid', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return idbPromise;
}
async function idbPutGame(uid, snap) {
  if (!uid || !snap || !snap.gameId) return;
  const db = await openIdb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({ ...snap, uid, pk: uid + ':' + snap.gameId });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}
async function idbGetGame(uid, gameId) {
  if (!uid || !gameId) return null;
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(uid + ':' + gameId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function idbListGames(uid) {
  if (!uid) return [];
  const db = await openIdb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const idx = tx.objectStore(IDB_STORE).index('by_uid');
      const req = idx.getAll(uid);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (e) { resolve([]); }
  });
}
async function idbDeleteGame(uid, gameId) {
  if (!uid || !gameId) return;
  const db = await openIdb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(uid + ':' + gameId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}

/* ---------------- same-device multi-tab lock (BroadcastChannel) ---------------- */
const TAB_ID = (crypto.randomUUID ? crypto.randomUUID()
  : ('tab-' + Date.now() + '-' + Math.random().toString(16).slice(2)));
const tabChannel = (typeof BroadcastChannel !== 'undefined')
  ? new BroadcastChannel('airstring_session_lock') : null;

function broadcastTabClaim(gameId) {
  if (!tabChannel || !gameId) return;
  try { tabChannel.postMessage({ type: 'claim', gameId, tabId: TAB_ID }); } catch (e) { }
}
if (tabChannel) {
  tabChannel.onmessage = (ev) => {
    const msg = ev && ev.data;
    if (!msg || msg.type !== 'claim' || msg.tabId === TAB_ID) return;
    if (S && !S.over && S.id === msg.gameId) {
      S.tabLocked = true;
      const ov = $('tab-lock-overlay');
      if (ov) ov.hidden = false;
    }
  };
}

let toastTimer = null;
function showToast(text, durationMs = 4200) {
  const el = $('game-toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, durationMs);
}

function b64ToBytes(b64) {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}
function concatReplayBytes(records, pendingKeys) {
  const parts = [];
  let total = 0;
  for (const r of records || []) {
    if (r && (r.k === 'turn' || r.k === 'tail') && r.keys) {
      const b = b64ToBytes(r.keys);
      if (b.length) { parts.push(b); total += b.length; }
    }
  }
  if (Array.isArray(pendingKeys) && pendingKeys.length) {
    const pb = Uint8Array.from(pendingKeys, (v) => v & 0xff);
    parts.push(pb); total += pb.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ---------------- session state ---------------- */
let S = null; /* active session or null */
let activeSessionToken = 0;
let autoResumeAttempted = false;
let localSaveTimer = null;

function newSession(cfg) {
  return {
    sid: cfg.sid,
    id: cfg.gameId, seed: cfg.seed, seedSource: cfg.seedSource,
    date: FIXED_DATE, options: cfg.options,
    startedAt: cfg.startedAt || new Date().toISOString(),
    parentGameId: cfg.parentGameId || null,
    forkTurn: cfg.forkTurn != null ? cfg.forkTurn : null,
    sessionId: (crypto.randomUUID ? crypto.randomUUID()
      : ('ses-' + Date.now() + '-' + Math.random().toString(16).slice(2))),
    started: false, over: false, overStatus: null, exited: false,
    tabLocked: false,
    /* buffer fast-forward state */
    buffering: !!cfg.buffering,
    bufferMode: cfg.bufferMode || null, /* 'resume' | 'fork' */
    bufferTargetTurns: cfg.bufferTargetTurns || 0,
    bufferTotalBytes: cfg.bufferTotalBytes || 0,
    bufferFedBytes: 0,
    bufferExpectedHashes: cfg.bufferExpectedHashes || [],
    bufferHashMismatch: false,
    bufferReplayBytes: cfg.bufferReplayBytes || null,
    bufferPumpStarted: false,
    logBuffer: [],
    lastTextEv: null,
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
    /* recorder & sync */
    pendingKeys: [], records: [], recSeq: 0, keysTotal: 0, rngLines: 0,
    dirtyCloud: false, lastCloudTurns: cfg.baseCloudTurns || 0,
    lastCloudSyncAt: 0, syncChain: Promise.resolve(),
    cloudSyncStatus: '',
    uploadOk: 0, uploadFailed: false,
    saves: [],
  };
}

function uiMode() {
  if (!S) return 'boot';
  if (S.over) return 'over';
  if (S.buffering) return 'boot';
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
  const next = open == null ? el.hidden : !!open;
  el.hidden = !next;
  if (next) updateDrawerSyncBanner();
}

/* ---------------- the one input funnel ---------------- */
function sendBytes(data) {
  if (!S || S.over || S.buffering || S.tabLocked) return;
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
  const fast = !!S.buffering;
  (S.eventTail = S.eventTail || []).push(ev.t);
  if (S.eventTail.length > 40) S.eventTail.shift();
  if (S.textClosePending && ev.t !== 'key') {
    if (ev.t !== 'text') { S.textActive = false; if (!fast) hideOverlay(); }
    S.textClosePending = false;
  }
  switch (ev.t) {
    case 'init':
      S.started = true;
      if (S.buffering && !S.bufferPumpStarted) {
        S.bufferPumpStarted = true;
        pumpBuffer(S.sid);
      }
      break;
    case 'map': onMap(ev); break;
    case 'status':
      if (ev.lines && ev.lines.length) S.statusLines = ev.lines;
      if (!fast) renderStatus();
      break;
    case 'message':
      S.messages.push(ev.text);
      if (S.messages.length > 300) S.messages.shift();
      if (fast) {
        S.logBuffer.push(ev.text);
        if (S.logBuffer.length > 200) S.logBuffer.shift();
      } else {
        renderMessages();
        appendLog(ev.text);
      }
      break;
    case 'raw':
      S.messages.push(ev.text);
      if (S.messages.length > 300) S.messages.shift();
      if (fast) {
        S.logBuffer.push('[!] ' + ev.text);
        if (S.logBuffer.length > 200) S.logBuffer.shift();
      } else {
        renderMessages();
        appendLog('[!] ' + ev.text);
      }
      break;
    case 'more':
      S.moreActive = true; S.counters.more++;
      if (!fast) renderMessages();
      break;
    case 'prompt':
      if (ev.kind === 'yn' && ev.choices == null &&
          /direction/i.test(ev.q || '')) {
        ev.dirPrompt = true;
        S.counters.dir++;
      }
      S.prompt = ev;
      if (ev.kind === 'yn') S.counters.yn++;
      if (ev.kind === 'line') {
        S.counters.line++;
        if (!fast) showLineBar(ev.q);
      }
      if (ev.q) {
        S.messages.push(ev.q);
        if (S.messages.length > 300) S.messages.shift();
        if (!fast) renderMessages();
      }
      break;
    case 'prompt-end':
      if (S.prompt && S.prompt.kind === 'line' && !fast) hideLineBar();
      S.prompt = null;
      S.expectingDir = null;
      if (S.dirAfterLine) { S.expectingDir = '#'; S.dirAfterLine = false; }
      break;
    case 'menu':
      S.menu = ev; S.counters.menu++;
      if (!fast) renderMenu(ev);
      break;
    case 'menu-end':
      S.menu = null;
      if (!fast) hideOverlay();
      break;
    case 'text':
      S.textActive = true; S.counters.text++;
      S.lastTextEv = ev;
      if (!fast) renderText(ev);
      break;
    case 'getret': S.getretActive = true; break;
    case 'askname':
      S.prompt = { kind: 'line', q: '你的名字？' };
      S.counters.line++;
      if (!fast) showLineBar('你的名字？');
      break;
    case 'rip':
      S.ripActive = true;
      if (!fast) showOverlay('R.I.P.', null, 'rip');
      break;
    case 'key':
      S.counters.keys++;
      if (ev.src === 'queue') {
        S.pendingKeys.push(ev.code & 0xff);
        S.keysTotal++;
        if (!fast && !S.tabLocked && cloudActive()) {
          S.dirtyCloud = true;
          scheduleLocalSave();
        }
      }
      if (S.moreActive) {
        if (S.textActive) S.textClosePending = true;
        S.moreActive = false;
        if (!fast) renderMessages();
      }
      if (S.getretActive) S.getretActive = false;
      break;
    case 'exit': S.exited = true; break;
  }
  if (!fast) renderBar();
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
  if (S.textActive && !S.ripActive) {
    S.textActive = false;
    if (!S.buffering) hideOverlay();
  }
  if (!S.buffering) renderGrid();
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
    const turns = S.lastFrame ? S.lastFrame.turn : 0;
    ctxBtns = [actBtn('回开局页', '', () => showSetup(), true)];
    if (turns >= 2) {
      const ft = Math.max(1, turns - 1);
      ctxBtns.push(actBtn('死前分叉', `第 ${ft} 回合`, () => forkSessionAt(S, ft)));
    }
  } else if (mode === 'boot') {
    ctxBtns = [actBtn(S.buffering ? '缓冲恢复中…' : '游戏启动中…', '', () => { })];
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
  if (!S || S.over || S.buffering || S.tabLocked || $('game').hidden) return;
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
  if (!S || S.over || S.buffering || S.tabLocked || !S.heroPos) return;
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

  if (S.buffering) {
    const idx = f.frame != null ? f.frame : (S.records.length - 2);
    const exp = S.bufferExpectedHashes && S.bufferExpectedHashes[idx];
    if (exp && f.hash && exp !== f.hash) {
      S.bufferHashMismatch = true;
    }
    return;
  }

  renderStatus();
  if (!S.tabLocked && cloudActive()) {
    saveLocalSnapshot();
    S.dirtyCloud = true;
    const curTurns = f.turn || 0;
    if (curTurns - (S.lastCloudTurns || 0) >= 50) {
      syncActiveToCloud(false);
    }
  }
}
function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* ---------------- active persistence: IndexedDB (every turn) + Cloud single-file ---------------- */
function hasMeaningfulProgress(sess) {
  if (!sess) return false;
  return sess.keysTotal >= 1 || (sess.lastFrame && sess.lastFrame.turn >= 2);
}

function buildActiveSnapshot(sess) {
  const lf = sess.lastFrame || {};
  return {
    version: 1,
    gameId: sess.id,
    seed: sess.seed,
    seedSource: sess.seedSource,
    date: sess.date,
    options: sess.options,
    playerName: sess.playerName || 'fleck',
    roleEn: sess.roleEn || 'valkyrie',
    startedAt: sess.startedAt,
    updatedAt: new Date().toISOString(),
    sessionId: sess.sessionId,
    parentGameId: sess.parentGameId || null,
    forkTurn: sess.forkTurn != null ? sess.forkTurn : null,
    turns: lf.turn || 0,
    dlvl: lf.dlevel || 1,
    hp: lf.hp != null ? lf.hp : null,
    hpmax: lf.hpmax != null ? lf.hpmax : null,
    keysTotal: sess.keysTotal || 0,
    records: sess.records.slice(),
    pendingKeys: sess.pendingKeys.slice(),
  };
}

function scheduleLocalSave() {
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(() => {
    localSaveTimer = null;
    saveLocalSnapshot();
  }, 250);
}

function saveLocalSnapshot() {
  if (!S || S.over || S.buffering || S.tabLocked) return;
  const user = cloud && cloud.currentUser();
  if (!user || !hasMeaningfulProgress(S)) return;
  const snap = buildActiveSnapshot(S);
  idbPutGame(user.uid, snap);
  try { sessionStorage.setItem('airstring_last_active_game', S.id); } catch (e) { }
}

function findCommonPrefixTurns(recordsA, recordsB) {
  const turnsA = (recordsA || []).filter((r) => r && r.k === 'turn');
  const turnsB = (recordsB || []).filter((r) => r && r.k === 'turn');
  const n = Math.min(turnsA.length, turnsB.length);
  let common = 0;
  for (let i = 0; i < n; i++) {
    if (turnsA[i].hash === turnsB[i].hash && turnsA[i].keys === turnsB[i].keys) {
      common = turnsA[i].turn || (i + 1);
    } else {
      break;
    }
  }
  return { common, lenA: turnsA.length, lenB: turnsB.length };
}

function updateSeedBanner() {
  if (!S) return;
  const forkNote = S.parentGameId
    ? `\n分叉来源：${S.parentGameId}（第 ${S.forkTurn} 回合）` : '';
  $('seed-banner').textContent = (S.seedSource === 'random'
    ? `种子：随机（局终揭晓）`
    : `种子：${S.seed}（${S.seedSource === 'fork' ? '分叉' : '指定'}）`) +
    `\n日期固定 · 局 ID：${S.id}` + forkNote;
}

function updateDrawerSyncBanner() {
  const box = $('drawer-auth-banner');
  const btnFork = $('btn-fork-now');
  const btnLeave = $('btn-newgame');
  if (!box) return;
  box.innerHTML = '';
  const user = cloud && cloud.currentUser();
  if (!user) {
    box.className = 'drawer-sync-box is-guest';
    const msg = document.createElement('div');
    msg.textContent = '游客试玩中：刷新页面不会保存本局进度。现在登录 Google 即可自动认领并保存本局。';
    box.appendChild(msg);
    if (cloud && cloud.signIn) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '登录 Google 并认领本局';
      b.addEventListener('click', () => {
        cloud.signIn().catch((e) => {
          showToast('登录未完成：' + (e && e.message ? e.message : '请检查弹窗设置'));
        });
      });
      box.appendChild(b);
    }
    if (btnLeave) btnLeave.textContent = '返回开局页（游客局不保存）';
  } else {
    box.className = 'drawer-sync-box';
    const statusText = S && S.cloudSyncStatus
      ? S.cloudSyncStatus
      : '已登录：每回合本地即时落盘，自动云端同步。';
    const msg = document.createElement('div');
    msg.textContent = statusText;
    box.appendChild(msg);
    if (btnLeave) btnLeave.textContent = '保存并返回开局页';
  }
  if (btnFork) {
    const turns = S && S.lastFrame ? S.lastFrame.turn : 0;
    btnFork.disabled = !S || S.over || S.buffering || turns < 1;
    btnFork.textContent = turns >= 1
      ? `从当前回合（第 ${turns} 回合）分叉新局`
      : '从当前回合分叉新局';
  }
}

function syncActiveToCloud(force) {
  if (!S || S.over || S.buffering || S.tabLocked) return Promise.resolve();
  const user = cloud && cloud.currentUser();
  if (!user || !hasMeaningfulProgress(S)) return Promise.resolve();
  if (!force && !S.dirtyCloud) return Promise.resolve();

  const sess = S;
  const uid = user.uid;
  sess.dirtyCloud = false;

  sess.syncChain = sess.syncChain.then(async () => {
    if (!cloudActive() || cloud.currentUser().uid !== uid) return;
    if (sess.over || sess.tabLocked) return;
    let snap = buildActiveSnapshot(sess);
    try {
      /* Cross-device conflict check -> automatic in-place fork */
      const remote = await cloud.loadActiveGame(sess.id);
      if (remote && remote.sessionId && remote.sessionId !== sess.sessionId) {
        const cmp = findCommonPrefixTurns(remote.records, snap.records);
        const remoteBehindOrSame = cmp.lenA <= cmp.lenB && cmp.common === cmp.lenA;
        if (!remoteBehindOrSame) {
          const oldGameId = sess.id;
          const newGameId = makeGameId(sess.seed);
          const commonTurn = Math.max(0, cmp.common);
          /* Keep remote copy locally under oldGameId so both timelines exist */
          await idbPutGame(uid, remote);
          /* Mutate current live session into forked timeline */
          sess.id = newGameId;
          sess.seedSource = 'fork';
          sess.parentGameId = oldGameId;
          sess.forkTurn = commonTurn;
          if (sess.records[0] && sess.records[0].k === 'header') {
            sess.records[0] = {
              ...sess.records[0],
              gameId: newGameId,
              seedSource: 'fork',
              parentGameId: oldGameId,
              forkTurn: commonTurn,
            };
          }
          snap = buildActiveSnapshot(sess);
          await idbPutGame(uid, snap);
          try { sessionStorage.setItem('airstring_last_active_game', newGameId); } catch (e) { }
          broadcastTabClaim(newGameId);
          updateSeedBanner();
          showToast('检测到本局在另一设备推进，已自动将当前路线分叉保存为新局，两边进度均已保留！', 6000);
        }
      }
      await cloud.saveActiveGame(snap);
      sess.lastCloudTurns = snap.turns;
      sess.lastCloudSyncAt = Date.now();
      sess.uploadOk = (sess.uploadOk || 0) + 1;
      sess.uploadFailed = false;
      const tStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      sess.cloudSyncStatus = `已云端同步（第 ${snap.turns} 回合 · ${tStr}）`;
      if ($('game-drawer') && !$('game-drawer').hidden) updateDrawerSyncBanner();
    } catch (e) {
      sess.uploadFailed = true;
      sess.dirtyCloud = true;
      sess.cloudSyncStatus = '离线/云端暂不可达（本地已即时保存，联网后自动补同步）';
      if ($('game-drawer') && !$('game-drawer').hidden) updateDrawerSyncBanner();
    }
  });
  return sess.syncChain;
}

setInterval(() => {
  if (S && !S.over && !S.buffering && !S.tabLocked && S.dirtyCloud) {
    syncActiveToCloud(false);
  }
}, 30000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && S && !S.over && !S.buffering && !S.tabLocked) {
    saveLocalSnapshot();
    syncActiveToCloud(true);
  }
});
window.addEventListener('pagehide', () => {
  if (S && !S.over && !S.buffering && !S.tabLocked) {
    saveLocalSnapshot();
    syncActiveToCloud(true);
  }
});
window.addEventListener('online', () => {
  if (S && !S.over && !S.buffering && !S.tabLocked && cloudActive()) {
    syncActiveToCloud(true);
  }
});

function recordingText() {
  const lines = S.records.map((r) => JSON.stringify(r));
  return lines.join('\n') + '\n';
}

/* ---------------- video-style Buffer Fast-Forward engine ---------------- */
function updateBufferUi() {
  if (!S || !S.buffering) return;
  const curTurn = S.lastFrame ? (S.lastFrame.turn || 0) : 0;
  const targetTurns = Math.max(1, S.bufferTargetTurns || 1);
  const byteRatio = S.bufferTotalBytes > 0 ? (S.bufferFedBytes / S.bufferTotalBytes) : 1;
  const turnRatio = Math.min(1, curTurn / targetTurns);
  const pct = Math.min(99, Math.max(1, Math.round(Math.max(byteRatio, turnRatio) * 100)));
  const fill = $('buffer-bar-fill');
  if (fill) fill.style.width = pct + '%';
  const det = $('buffer-detail');
  if (det) {
    det.textContent = `正在缓冲：${curTurn} / ${S.bufferTargetTurns || '?'} 回合（${pct}%）`;
  }
}

function pumpBuffer(sid) {
  if (!S || S.sid !== sid || !S.buffering) return;
  const replayBytes = S.bufferReplayBytes;
  if (!replayBytes || !replayBytes.length) {
    finishBuffering(sid);
    return;
  }
  let offset = 0;
  const CHUNK = 48;

  function step() {
    if (!S || S.sid !== sid || !S.buffering) return;
    if (S.over) {
      finishBuffering(sid);
      return;
    }
    const q = globalThis.__airstring_key_queue;
    if (q && q.pos < q.bytes.length) {
      updateBufferUi();
      setTimeout(step, 4);
      return;
    }
    if (offset < replayBytes.length) {
      const end = Math.min(offset + CHUNK, replayBytes.length);
      const slice = replayBytes.subarray(offset, end);
      offset = end;
      S.bufferFedBytes = offset;
      globalThis.__airstring_push_keys(slice);
      updateBufferUi();
      setTimeout(step, 0);
      return;
    }
    /* All bytes pushed and consumed by WASM; brief settle for final frame/map events */
    setTimeout(() => {
      if (!S || S.sid !== sid || !S.buffering) return;
      const q2 = globalThis.__airstring_key_queue;
      if (q2 && q2.pos < q2.bytes.length) {
        setTimeout(step, 4);
        return;
      }
      finishBuffering(sid);
    }, 35);
  }
  step();
}

function finishBuffering(sid) {
  if (!S || S.sid !== sid) return;
  S.buffering = false;
  S.bufferReplayBytes = null;
  const fill = $('buffer-bar-fill');
  if (fill) fill.style.width = '100%';
  const ov = $('buffer-overlay');
  if (ov) ov.hidden = true;

  /* Hydrate msglog once from buffered messages */
  const log = $('msglog');
  if (log) {
    log.innerHTML = '';
    for (const line of S.logBuffer) {
      const div = document.createElement('div');
      div.textContent = line;
      log.appendChild(div);
    }
  }
  S.logBuffer = [];

  renderMessages();
  renderGrid();
  renderStatus();
  updateZoomButton();
  renderBar();

  /* Restore any active prompt/menu/text overlay */
  if (S.prompt && S.prompt.kind === 'line') {
    showLineBar(S.prompt.q);
  } else if (S.menu) {
    renderMenu(S.menu);
  } else if (S.textActive && S.lastTextEv) {
    renderText(S.lastTextEv);
  } else if (S.ripActive) {
    showOverlay('R.I.P.', null, 'rip');
  }

  updateDrawerSyncBanner();

  if (S.bufferHashMismatch) {
    showToast('缓冲恢复完成（检测到部分帧校验不一致，请确认构建版本）', 5000);
  } else if (S.bufferMode === 'fork') {
    showToast(`分叉完成：已从第 ${S.forkTurn} 回合开启新时间线`, 3500);
    if (cloudActive()) {
      saveLocalSnapshot();
      syncActiveToCloud(true);
    }
  }
}

/* ---------------- setup active games list, My Games page & auth sync ---------------- */
function setTopNavActive(which) {
  if ($('nav-lobby')) $('nav-lobby').classList.toggle('active', which === 'setup');
  if ($('nav-mygames')) $('nav-mygames').classList.toggle('active', which === 'mygames');
}

function updateMyCountBadge(count) {
  const b = $('nav-my-count');
  if (!b) return;
  if (count > 0) {
    b.textContent = String(count);
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

function renderActiveGameCard(item, uid, fromPage = 'setup') {
  const card = document.createElement('div');
  card.className = 'active-game-item';
  const roleZh = (ROLES[item.roleEn] && ROLES[item.roleEn].zh) || item.roleEn || '冒险者';

  const top = document.createElement('div');
  top.className = 'ag-top';
  const title = document.createElement('span');
  title.textContent = `${item.playerName || 'fleck'} · ${roleZh}`;
  const badge = document.createElement('span');
  badge.className = 'ag-badge' + (item.parentGameId ? ' fork' : '');
  badge.textContent = item.parentGameId
    ? `分叉 · T${item.turns || 0}`
    : `进行中 · T${item.turns || 0}`;
  top.append(title, badge);

  const meta = document.createElement('div');
  meta.className = 'ag-meta';
  const hpStr = (item.hp != null && item.hpmax != null) ? `HP ${item.hp}/${item.hpmax}` : '';
  const dlvlStr = item.dlvl ? `Dlvl:${item.dlvl}` : '';
  const seedStr = item.seedSource === 'random' ? '种子:随机' : `种子:#${item.seed}`;
  const forkStr = item.parentGameId ? `源:${item.parentGameId}(T${item.forkTurn ?? 0})` : '';
  const when = item.updatedAt
    ? new Date(item.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  meta.textContent = [dlvlStr, hpStr, seedStr, forkStr, when].filter(Boolean).join(' · ');

  const acts = document.createElement('div');
  acts.className = 'ag-actions';

  const bResume = document.createElement('button');
  bResume.type = 'button';
  bResume.className = 'primary';
  bResume.textContent = '继续游玩';
  bResume.addEventListener('click', () => resumeActiveGameById(uid, item.gameId, false));

  const bWatch = document.createElement('button');
  bWatch.type = 'button';
  bWatch.textContent = '▶ 回放 / 选回合分叉';
  bWatch.addEventListener('click', () => watchActiveGameById(uid, item.gameId, fromPage));

  const bFork = document.createElement('button');
  bFork.type = 'button';
  bFork.textContent = '⚡ 末尾分叉';
  bFork.addEventListener('click', () => resumeActiveGameById(uid, item.gameId, true));

  const bDel = document.createElement('button');
  bDel.type = 'button';
  bDel.className = 'danger';
  bDel.textContent = '放弃';
  bDel.addEventListener('click', async () => {
    if (!confirm(`确定放弃「${item.playerName || 'fleck'} · ${roleZh}（第 ${item.turns || 0} 回合）」？放弃后将从进行中列表移除。`)) return;
    await idbDeleteGame(uid, item.gameId);
    try { await cloud.deleteActiveGame(item.gameId); } catch (e) { }
    await refreshActiveGames(true);
    if ($('mygames') && !$('mygames').hidden) refreshMyGamesPage(false);
  });

  acts.append(bResume, bWatch, bFork, bDel);
  card.append(top, meta, acts);
  return card;
}

let cachedActiveAll = [];

async function fetchMergedActiveGames(uid, forceCloud) {
  const merged = new Map();
  const localList = await idbListGames(uid);
  for (const g of localList) {
    if (g && g.gameId) merged.set(g.gameId, { ...g, _source: 'local' });
  }
  let cloudErr = false;
  try {
    const idx = await cloud.loadActiveIndex(forceCloud);
    for (const [gid, meta] of Object.entries((idx && idx.games) || {})) {
      if (!meta || !meta.gameId) continue;
      const cur = merged.get(gid);
      if (!cur || (meta.turns || 0) > (cur.turns || 0) ||
          ((meta.turns || 0) === (cur.turns || 0) && String(meta.updatedAt || '') > String(cur.updatedAt || ''))) {
        merged.set(gid, { ...meta, _source: 'cloud' });
      }
    }
  } catch (e) {
    cloudErr = true;
  }
  const all = Array.from(merged.values()).sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  cachedActiveAll = all;
  return { all, cloudErr };
}

function renderActiveListInto(all, uid, listEl, shelvedWrap, shelvedList, shelvedSum, fromPage) {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (shelvedList) shelvedList.innerHTML = '';
  const now = Date.now();
  const recent = [];
  const shelved = [];
  for (const item of all) {
    const ts = item.updatedAt ? Date.parse(item.updatedAt) : now;
    if (now - ts > SHELVE_AGE_MS) shelved.push(item);
    else recent.push(item);
  }
  if (!recent.length) {
    listEl.innerHTML = '<div class="hint">' +
      (shelved.length ? '近期无进行中对局，下方可展开 30 天前已搁置的对局。' : '暂无进行中对局，开一局试试！') +
      '</div>';
  } else {
    for (const item of recent) listEl.appendChild(renderActiveGameCard(item, uid, fromPage));
  }
  if (shelvedWrap && shelvedList && shelvedSum) {
    shelvedWrap.hidden = shelved.length === 0;
    shelvedSum.textContent = `已搁置对局（${shelved.length} 局 · 超过 30 天未操作，随时可续打或分叉）`;
    for (const item of shelved) shelvedList.appendChild(renderActiveGameCard(item, uid, fromPage));
  }
}

async function refreshActiveGames(forceCloud = false) {
  const guestBanner = $('guest-banner');
  const activeCard = $('active-games-card');
  const syncHint = $('active-sync-hint');

  const user = cloud && cloud.currentUser();
  if (!user) {
    cachedActiveAll = [];
    updateMyCountBadge(0);
    if (guestBanner) guestBanner.hidden = false;
    if (activeCard) activeCard.hidden = true;
    return [];
  }
  if (guestBanner) guestBanner.hidden = true;
  if (syncHint) syncHint.textContent = '同步中…';

  const uid = user.uid;
  const { all, cloudErr } = await fetchMergedActiveGames(uid, forceCloud);
  updateMyCountBadge(all.length);
  if (syncHint) syncHint.textContent = cloudErr ? '云端暂不可达，已显示本机缓存' : '';

  if (activeCard) {
    activeCard.hidden = all.length === 0;
    if (all.length) {
      renderActiveListInto(
        all, uid,
        $('active-games-list'), $('shelved-games-wrap'),
        $('shelved-games-list'), $('shelved-games-summary'), 'setup',
      );
    }
  }
  return all;
}

async function refreshMyGamesPage(forceCloud = true) {
  const guestBox = $('mygames-guest');
  const contentBox = $('mygames-content');
  const user = cloud && cloud.currentUser();
  if (!user) {
    if (guestBox) guestBox.hidden = false;
    if (contentBox) contentBox.hidden = true;
    return;
  }
  if (guestBox) guestBox.hidden = true;
  if (contentBox) contentBox.hidden = false;

  const uid = user.uid;
  const allActive = await refreshActiveGames(forceCloud);
  if ($('my-active-count')) $('my-active-count').textContent = `共 ${allActive.length} 局`;
  renderActiveListInto(
    allActive, uid,
    $('my-active-list'), $('my-shelved-wrap'),
    $('my-shelved-list'), $('my-shelved-summary'), 'mygames',
  );

  const finBox = $('my-finished-list');
  const finCount = $('my-finished-count');
  if (finBox) finBox.innerHTML = '<div class="hint">加载我的已结束对局…</div>';
  try {
    const raw = await cloud.listMyGames(50);
    const games = raw.map(normalizePlainGame);
    if (finCount) finCount.textContent = `共 ${games.length} 局`;
    if (!games.length) {
      if (finBox) finBox.innerHTML = '<div class="hint">暂无已结束对局。完成一局（通关/死亡/#quit）后会自动出现在这里，支持回放与分叉。</div>';
      return;
    }
    if (finBox) {
      finBox.innerHTML = '';
      for (const g of games) finBox.appendChild(buildGalleryCard(g, 'mygames'));
    }
  } catch (e) {
    if (finBox) finBox.innerHTML = '<div class="hint">暂时无法拉取已结束对局：' + (e && e.message ? e.message : e) + '</div>';
  }
}

async function showMyGames(forceCloud = true) {
  if (S && !S.over && !S.buffering && !S.tabLocked && cloudActive()) {
    saveLocalSnapshot();
    await Promise.race([syncActiveToCloud(true), new Promise((r) => setTimeout(r, 2000))]);
  }
  try { sessionStorage.removeItem('airstring_last_active_game'); } catch (e) { }
  stopReplayPlayback();
  R = null;
  teardownCurrentSession();
  S = null;
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => { });
  }
  document.body.classList.remove('in-game');
  toggleGameDrawer(false);
  toggleMsgLog(false);
  $('buffer-overlay').hidden = true;
  $('tab-lock-overlay').hidden = true;
  $('game').hidden = true;
  $('setup').hidden = true;
  if ($('replay')) $('replay').hidden = true;
  if ($('mygames')) $('mygames').hidden = false;
  setTopNavActive('mygames');
  try { history.replaceState(null, '', '#mygames'); } catch (e) { }
  await refreshMyGamesPage(forceCloud);
}

async function watchActiveGameById(uid, gameId, fromPage = 'mygames') {
  const snap = await loadBestSnapshot(uid, gameId);
  if (!snap) {
    alert('未找到该对局记录，可能已被清理。');
    refreshMyGamesPage(true);
    return;
  }
  const opts = parseOptionMap(snap.options || '');
  const gameDoc = {
    gameId: snap.gameId,
    uid,
    status: 'playing',
    seed: String(snap.seed ?? '?'),
    seedSource: snap.seedSource || 'given',
    options: snap.options || '',
    name: snap.playerName || opts.name || 'fleck',
    roleKey: snap.roleEn || opts.role || 'valkyrie',
    turns: snap.turns || 0,
    frames: snap.turns || 0,
    framesCompared: snap.turns || 0,
    framesMatched: snap.turns || 0,
    createdAt: snap.startedAt || '',
    recordingSha256: '',
    publicRecordingPath: null,
    maxDlvl: snap.dlvl || 1,
    outcome: null,
    deathReason: '进行中对局',
    parentGameId: snap.parentGameId || null,
    forkTurn: snap.forkTurn != null ? snap.forkTurn : null,
  };
  openReplay(gameDoc, { snapshot: snap, fromPage });
}

async function loadBestSnapshot(uid, gameId) {
  const local = await idbGetGame(uid, gameId);
  let remote = null;
  try {
    if (cloudActive()) remote = await cloud.loadActiveGame(gameId);
  } catch (e) { }
  if (!local && !remote) return null;
  if (local && !remote) return local;
  if (!local && remote) return remote;
  const lt = local.turns || 0;
  const rt = remote.turns || 0;
  if (rt > lt) return remote;
  if (lt > rt) return local;
  return String(remote.updatedAt || '') > String(local.updatedAt || '') ? remote : local;
}

async function resumeActiveGameById(uid, gameId, asFork) {
  const snap = await loadBestSnapshot(uid, gameId);
  if (!snap) {
    alert('未找到该对局记录，可能已被清理。');
    refreshActiveGames(true);
    return;
  }
  const turns = (snap.records || []).filter((r) => r && r.k === 'turn');
  const expectedHashes = turns.map((t) => t.hash);
  const replayBytes = asFork
    ? concatReplayBytes(turns, null)
    : concatReplayBytes(snap.records, snap.pendingKeys);
  const expectedTurns = turns.length ? (turns[turns.length - 1].turn || turns.length) : 0;

  if (asFork) {
    await startGame({
      mode: 'fork',
      seed: snap.seed,
      seedSource: 'fork',
      options: snap.options,
      parentGameId: snap.gameId,
      forkTurn: expectedTurns,
      replayBytes,
      expectedTurns,
      expectedHashes,
    });
  } else {
    await startGame({
      mode: 'resume',
      gameId: snap.gameId,
      seed: snap.seed,
      seedSource: snap.seedSource || 'given',
      options: snap.options,
      startedAt: snap.startedAt,
      parentGameId: snap.parentGameId || null,
      forkTurn: snap.forkTurn != null ? snap.forkTurn : null,
      baseCloudTurns: snap.turns || 0,
      replayBytes,
      expectedTurns,
      expectedHashes,
    });
  }
}

async function forkSessionAt(sess, targetTurn) {
  if (!sess) return;
  /* Persist the parent active game BEFORE tearing it down to launch the fork! */
  if (!sess.over && !sess.buffering && !sess.tabLocked && cloudActive() && hasMeaningfulProgress(sess)) {
    saveLocalSnapshot();
    await Promise.race([syncActiveToCloud(true), new Promise((r) => setTimeout(r, 2500))]);
  }
  const allTurns = (sess.records || []).filter((r) => r && r.k === 'turn');
  const sliced = targetTurn != null
    ? allTurns.filter((t) => (t.turn || 0) <= targetTurn)
    : allTurns;
  const forkTurn = sliced.length ? (sliced[sliced.length - 1].turn || sliced.length) : 0;
  const replayBytes = concatReplayBytes(sliced, null);
  const expectedHashes = sliced.map((t) => t.hash);
  await startGame({
    mode: 'fork',
    seed: sess.seed,
    seedSource: 'fork',
    options: sess.options,
    parentGameId: sess.id,
    forkTurn,
    replayBytes,
    expectedTurns: forkTurn,
    expectedHashes,
  });
}

async function onAuthChanged(user) {
  await refreshActiveGames(true);
  if (verifiedGamesCache.length) renderVerifiedGallery();
  if ($('mygames') && !$('mygames').hidden) {
    await refreshMyGamesPage(true);
  }
  /* Update drawer if currently in game */
  if (S) {
    updateDrawerSyncBanner();
    if (user && !S.over && !S.buffering && !S.tabLocked) {
      if (hasMeaningfulProgress(S)) {
        saveLocalSnapshot();
        S.dirtyCloud = true;
        syncActiveToCloud(true);
        showToast('已登录！当前试玩进度已自动认领并保存至你的账号。', 4500);
      } else {
        showToast('已登录，开始行动后将自动保存进度。', 3000);
      }
    }
    return;
  }
  /* Auto-resume exact game on browser F5 refresh for signed-in user */
  if (user && !autoResumeAttempted && !location.hash.startsWith('#replay/') && location.hash !== '#mygames') {
    autoResumeAttempted = true;
    let lastId = null;
    try { lastId = sessionStorage.getItem('airstring_last_active_game'); } catch (e) { }
    if (lastId) {
      const snap = await loadBestSnapshot(user.uid, lastId);
      if (snap && ((snap.turns || 0) >= 1 || (snap.keysTotal || 0) >= 1)) {
        resumeActiveGameById(user.uid, lastId, false);
      } else {
        try { sessionStorage.removeItem('airstring_last_active_game'); } catch (e) { }
      }
    }
  }
}

/* ---------------- game lifecycle ---------------- */
function randomSeed64() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return ((BigInt(a[0]) << 32n) | BigInt(a[1])).toString(10);
}
function makeGameId(seed) {
  return 'g-' + seed + '-' +
    new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' +
    Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
}

function teardownCurrentSession() {
  activeSessionToken++;
  if (localSaveTimer) { clearTimeout(localSaveTimer); localSaveTimer = null; }
  if (typeof globalThis.__airstring_close_keys === 'function') {
    try { globalThis.__airstring_close_keys(); } catch (e) { }
  }
}

async function startGame(plan) {
  let name, role, race, gender, align, seed, seedSource, options, gameId;
  let startedAt = new Date().toISOString();
  let parentGameId = null, forkTurn = null, baseCloudTurns = 0;

  if (plan) {
    options = plan.options;
    const optMap = parseOptionMap(options);
    name = optMap.name || 'fleck';
    role = optMap.role || 'valkyrie';
    seed = String(plan.seed);
    seedSource = plan.seedSource || 'given';
    gameId = plan.mode === 'resume' && plan.gameId ? plan.gameId : makeGameId(seed);
    startedAt = plan.startedAt || startedAt;
    parentGameId = plan.parentGameId || null;
    forkTurn = plan.forkTurn != null ? plan.forkTurn : null;
    baseCloudTurns = plan.baseCloudTurns || 0;
  } else {
    /* Soft cap check for fresh games when signed in */
    const user = cloud && cloud.currentUser();
    if (user) {
      try {
        const localGames = await idbListGames(user.uid);
        if (localGames.length >= MAX_ACTIVE_SOFT_CAP) {
          alert(`当前已有 ${localGames.length} 局进行中对局，请先放弃部分旧对局再开新局。`);
          return;
        }
      } catch (e) { }
    }
    name = $('opt-name').value.trim() || 'fleck';
    role = $('opt-role').value;
    race = $('opt-race').value;
    gender = $('opt-gender').value;
    align = $('opt-align').value;
    const seedMode = document.querySelector('input[name="seedmode"]:checked').value;
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
    options = `name:${name},role:${role},race:${race},gender:${gender},align:${align}`;
    gameId = makeGameId(seed);
  }

  teardownCurrentSession();
  const sid = activeSessionToken;
  const hasBuffer = !!(plan && plan.replayBytes && plan.replayBytes.length > 0);

  S = newSession({
    sid, gameId, seed, seedSource, options, startedAt,
    parentGameId, forkTurn, baseCloudTurns,
    buffering: hasBuffer,
    bufferMode: plan ? plan.mode : null,
    bufferTargetTurns: plan ? (plan.expectedTurns || 0) : 0,
    bufferTotalBytes: hasBuffer ? plan.replayBytes.length : 0,
    bufferExpectedHashes: plan ? (plan.expectedHashes || []) : [],
    bufferReplayBytes: hasBuffer ? plan.replayBytes : null,
  });
  S.playerName = name; S.roleEn = role;

  const headerRec = {
    k: 'header', gameId, seed, seedSource, date: FIXED_DATE, options,
    startedAt, ua: navigator.userAgent, restored: null,
  };
  if (parentGameId) {
    headerRec.parentGameId = parentGameId;
    headerRec.forkTurn = forkTurn != null ? forkTurn : 0;
  }
  S.records.push(headerRec);

  broadcastTabClaim(gameId);
  if (cloudActive()) {
    try { sessionStorage.setItem('airstring_last_active_game', gameId); } catch (e) { }
  }

  stopReplayPlayback();
  R = null;
  if ($('replay')) $('replay').hidden = true;
  if ($('mygames')) $('mygames').hidden = true;
  if (location.hash === '#mygames' || location.hash.startsWith('#replay/')) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  }
  document.body.classList.add('in-game');
  $('setup').hidden = true;
  $('game').hidden = false;
  $('gameover').hidden = true;
  $('tab-lock-overlay').hidden = true;
  $('grid').innerHTML = '';
  lastGridDims = '';
  $('msglog').innerHTML = '';
  hideOverlay(); hideLineBar(); togglePanel(false);
  toggleMsgLog(false); toggleGameDrawer(false);
  updateSeedBanner();
  updateDrawerSyncBanner();

  const bufOv = $('buffer-overlay');
  if (bufOv) {
    bufOv.hidden = !hasBuffer;
    if (hasBuffer) {
      $('buffer-title').textContent = plan.mode === 'fork'
        ? `正在分叉至第 ${forkTurn} 回合…` : '正在缓冲恢复对局…';
      $('buffer-bar-fill').style.width = '2%';
      $('buffer-detail').textContent = `准备引擎（目标 ${plan.expectedTurns || '?'} 回合）…`;
    }
  }

  renderMessages();
  renderStatus();
  updateZoomButton();
  renderBar();

  globalThis.__airstring_config = {
    seed, date: FIXED_DATE, options, mode: 'async',
    exportPath: '/fleck.frames', rngPath: '/fleck.rng',
  };
  globalThis.__airstring_key_queue = { bytes: [], pos: 0, closed: false };
  globalThis.__airstring_event = (json) => { if (S && S.sid === sid) handleEvent(json); };
  globalThis.__airstring_frame = (text) => { if (S && S.sid === sid) handleFrame(text); };
  globalThis.__airstring_rngline = () => { if (S && S.sid === sid) S.rngLines++; };
  globalThis.__airstring_game_over = (status) => { if (S && S.sid === sid) handleGameOver(status); };

  const modArg = {
    print: (s) => { if (S && S.sid === sid && !S.buffering) appendLog('[out] ' + s); },
    printErr: (s) => { if (S && S.sid === sid && !S.buffering) appendLog('[err] ' + s); },
  };
  try {
    const { default: createModule } = await import('./nethack.js');
    const mod = await createModule(modArg);
    if (S && S.sid === sid) S.module = mod;
  } catch (e) {
    if (S && S.sid === sid) {
      if (S.buffering) finishBuffering(sid);
      appendLog('模块启动异常：' + (e && e.message ? e.message : e));
    }
  }
}

function handleGameOver(status) {
  if (!S || S.over) return;
  if (S.buffering) finishBuffering(S.sid);
  S.over = true; S.overStatus = status;
  try { sessionStorage.removeItem('airstring_last_active_game'); } catch (e) { }

  if (S.pendingKeys.length) {
    S.records.push({ k: 'tail', keys: bytesToB64(S.pendingKeys) });
    S.pendingKeys = [];
  }
  const turns = S.lastFrame ? S.lastFrame.turn : 0;
  const frames = S.lastFrame ? S.lastFrame.frame + 1 : 0;
  S.records.push({ k: 'end', status, turns, frames, keysTotal: S.keysTotal });

  const useCloud = cloudActive();
  const user = cloud && cloud.currentUser();
  if (user) {
    idbDeleteGame(user.uid, S.id);
  }
  if (useCloud) {
    const endRec = S.records[S.records.length - 1];
    const sess = S;
    sess.syncChain = sess.syncChain.then(async () => {
      try {
        await cloud.finalizeGame({
          gameId: sess.id, seed: sess.seed, seedSource: sess.seedSource,
          date: sess.date, options: sess.options,
          parentGameId: sess.parentGameId || null,
          forkTurn: sess.forkTurn != null ? sess.forkTurn : null,
          restored: null,
          end: status, turns: endRec.turns, frames: endRec.frames,
          keysTotal: endRec.keysTotal,
          recordingText: recordingText(),
        });
      } catch (e) { sess.uploadFailed = true; }
    });
  }

  const go = $('gameover');
  go.hidden = false;
  go.innerHTML = '';
  go.append(document.createTextNode(
    `本局结束（共 ${turns} 回合）。` +
    (useCloud
      ? '已自动归档上云（Storage＋Firestore），正在触发后台验真。'
      : '游客试玩局未上云；登录 Google 后每局均可自动保存、验真并入榜。')));
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
  acts.appendChild(bNew);

  if (turns >= 2) {
    const ft = Math.max(1, turns - 1);
    const bFork = document.createElement('button');
    bFork.type = 'button';
    bFork.textContent = `从死前（第 ${ft} 回合）分叉再试`;
    bFork.addEventListener('click', () => forkSessionAt(S, ft));
    acts.appendChild(bFork);
  }
  go.appendChild(acts);

  updateZoomButton();
  renderBar();
}

async function showSetup() {
  stopReplayPlayback();
  R = null;
  if ($('replay')) $('replay').hidden = true;
  if ($('mygames')) $('mygames').hidden = true;
  if (location.hash && (location.hash.startsWith('#replay/') || location.hash === '#mygames')) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  }
  if (S && !S.over && !S.buffering && !S.tabLocked && cloudActive()) {
    saveLocalSnapshot();
    await Promise.race([syncActiveToCloud(true), new Promise((r) => setTimeout(r, 2000))]);
  }
  try { sessionStorage.removeItem('airstring_last_active_game'); } catch (e) { }
  teardownCurrentSession();
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => { });
  }
  document.body.classList.remove('in-game');
  toggleGameDrawer(false);
  toggleMsgLog(false);
  $('buffer-overlay').hidden = true;
  $('tab-lock-overlay').hidden = true;
  $('game').hidden = true;
  $('setup').hidden = false;
  setTopNavActive('setup');
  S = null;
  refreshActiveGames(true);
  loadVerifiedLobby();
}

/* ---------------- wiring ---------------- */
$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  startGame(null);
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
$('btn-fork-now').addEventListener('click', () => {
  if (!S || S.over || S.buffering) return;
  const t = S.lastFrame ? S.lastFrame.turn : 0;
  if (t < 1) return;
  toggleGameDrawer(false);
  forkSessionAt(S, t);
});
$('btn-newgame').addEventListener('click', () => showSetup());

/* Multi-tab lock actions */
$('btn-tab-back').addEventListener('click', () => showSetup());
$('btn-tab-reclaim').addEventListener('click', async () => {
  if (!S) return;
  const gid = S.id;
  const user = cloud && cloud.currentUser();
  S.tabLocked = false;
  $('tab-lock-overlay').hidden = true;
  broadcastTabClaim(gid);
  if (user) {
    const latest = await loadBestSnapshot(user.uid, gid);
    const curTurns = S.lastFrame ? (S.lastFrame.turn || 0) : 0;
    if (latest && (latest.turns || 0) > curTurns) {
      resumeActiveGameById(user.uid, gid, false);
    }
  }
});

/* Guest sign-in & active list refresh */
$('btn-guest-signin').addEventListener('click', () => {
  if (cloud && cloud.signIn) {
    cloud.signIn().catch((e) => {
      alert('Google 登录未完成：' + (e && e.message ? e.message : '请检查浏览器弹窗拦截或域名授权'));
    });
  } else {
    alert('当前环境未连接 Firebase 登录服务。');
  }
});
$('btn-refresh-active').addEventListener('click', () => refreshActiveGames(true));

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

/* Phase 2 Gallery filters & search */
if ($('lobby-filters')) {
  $('lobby-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    lobbyFilter = btn.dataset.filter || 'all';
    for (const el of $('lobby-filters').querySelectorAll('button[data-filter]')) {
      el.classList.toggle('active', el === btn);
    }
    renderVerifiedGallery();
  });
}
if ($('lobby-search')) {
  $('lobby-search').addEventListener('input', () => renderVerifiedGallery());
}

/* ---------------- Phase 2: YouTube-style Replay Theater + Frame Cache + 1-Click Fork ---------------- */
let R = null; /* active replay theater session */

function stopReplayPlayback() {
  if (!R) return;
  R.playing = false;
  if (R.playTimer) { clearInterval(R.playTimer); R.playTimer = null; }
  const btn = $('btn-rep-play');
  if (btn) btn.textContent = '▶ 播放';
}

function closeReplay(goBack = true) {
  const fromPage = (R && R.fromPage) || 'setup';
  stopReplayPlayback();
  if (R) {
    teardownCurrentSession();
    R = null;
  }
  if ($('replay')) $('replay').hidden = true;
  if (location.hash && location.hash.startsWith('#replay/')) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  }
  if (goBack) {
    if (fromPage === 'mygames') {
      showMyGames(false);
    } else {
      $('game').hidden = true;
      if ($('mygames')) $('mygames').hidden = true;
      $('setup').hidden = false;
      setTopNavActive('setup');
      document.body.classList.remove('in-game');
      refreshActiveGames(false);
      loadVerifiedLobby();
    }
  }
}

function renderReplayGrid(frameSnap) {
  const grid = $('rep-grid');
  const stage = $('rep-stage');
  if (!grid || !stage || !frameSnap || !frameSnap.mapRows) return;
  const sw = Math.max(120, stage.clientWidth - 12);
  const sh = Math.max(100, stage.clientHeight - 12);
  const fsW = Math.floor(sw / 80 / 0.605);
  const fsH = Math.floor(sh / 21 / 1.17);
  const fs = Math.max(5, Math.min(20, fsW, fsH));
  grid.style.fontSize = fs + 'px';

  if (grid.children.length !== 21) {
    grid.innerHTML = '';
    for (let y = 0; y < 21; y++) {
      const row = document.createElement('div');
      row.className = 'row';
      grid.appendChild(row);
    }
  }
  for (let y = 0; y < 21; y++) {
    const rowEl = grid.children[y];
    const line = String(frameSnap.mapRows[y] || '').padEnd(80, ' ');
    const cols = (frameSnap.mapColors && frameSnap.mapColors[y]) || [];
    rowEl.innerHTML = '';
    let runColor = null;
    let runText = '';
    const flush = () => {
      if (!runText) return;
      const sp = document.createElement('span');
      sp.className = 'c' + (runColor != null ? runColor : 7);
      sp.textContent = runText;
      rowEl.appendChild(sp);
      runText = '';
    };
    for (let x = 0; x < 80; x++) {
      const ch = line[x];
      const c = typeof cols[x] === 'number' ? (cols[x] & 0xf) : 7;
      if (ch === '@') {
        flush();
        const hs = document.createElement('span');
        hs.className = 'c15 hero-at';
        hs.textContent = '@';
        rowEl.appendChild(hs);
        runColor = null;
      } else if (c === runColor) {
        runText += ch;
      } else {
        flush();
        runColor = c;
        runText = ch;
      }
    }
    flush();
  }
}

function renderReplayStatus(frameSnap) {
  const el = $('rep-status');
  const fill = $('rep-hp-fill');
  if (!el || !frameSnap) return;
  el.innerHTML = '';
  const mk = (cls, txt) => {
    const s = document.createElement('span');
    s.className = cls; s.textContent = txt;
    return s;
  };
  const hp = frameSnap.hp ?? 0, hpmax = frameSnap.hpmax ?? 1;
  const ratio = hpmax > 0 ? Math.max(0, Math.min(1, hp / hpmax)) : 1;
  const hpCls = ratio <= 0.25 ? 'st-hp-crit' : ratio <= 0.55 ? 'st-hp-warn' : 'st-hp-ok';
  if (fill) {
    fill.style.width = Math.round(ratio * 100) + '%';
    fill.style.background = ratio <= 0.25 ? 'var(--danger)' : ratio <= 0.55 ? 'var(--warn)' : 'var(--ok)';
  }
  const roleZh = (ROLES[R && R.game.roleKey] && ROLES[R.game.roleKey].zh) || (R && R.game.roleKey) || '';
  el.append(
    mk('st-name', (R && R.game.name) || 'fleck'),
    mk('st-role', roleZh),
    mk('st-dlvl', `Dlvl:${frameSnap.dlvl ?? 1}`),
    mk(hpCls, `HP:${hp}/${hpmax}`),
    mk('st-pw', `Pw:${frameSnap.pw ?? 0}/${frameSnap.pwmax ?? 0}`),
    mk('', `AC:${frameSnap.ac ?? 0}`),
    mk('st-gold', `$:${frameSnap.gold ?? 0}`),
    mk('', `T:${frameSnap.turn ?? 0}`),
  );
}

function renderReplayFrame(idx) {
  if (!R || !R.frames.length) return;
  const clamped = Math.max(0, Math.min(R.frames.length - 1, idx));
  R.curIdx = clamped;
  const snap = R.frames[clamped];
  $('rep-msg-prev').textContent = snap.msgPrev || '';
  $('rep-msg').textContent = snap.msgCur || '';
  renderReplayGrid(snap);
  renderReplayStatus(snap);

  const seek = $('rep-seek');
  if (seek) {
    seek.max = String(Math.max(0, R.frames.length - 1));
    seek.value = String(clamped);
  }
  const totalTurns = R.frames[R.frames.length - 1].turn || R.frames.length;
  $('rep-time').textContent = `回合 ${snap.turn} / ${totalTurns}`;
  const forkBtn = $('btn-rep-fork');
  if (forkBtn) {
    forkBtn.disabled = false;
    forkBtn.textContent = `⚡ 从第 ${snap.turn} 回合分叉由我来打`;
  }
}

function startReplayPlayback() {
  if (!R || !R.frames.length || R.buffering) return;
  if (R.curIdx >= R.frames.length - 1) renderReplayFrame(0);
  R.playing = true;
  $('btn-rep-play').textContent = '⏸ 暂停';
  if (R.playTimer) clearInterval(R.playTimer);
  const speed = parseFloat(($('rep-speed') && $('rep-speed').value) || '1') || 1;
  const intervalMs = Math.max(35, Math.round(360 / speed));
  R.playTimer = setInterval(() => {
    if (!R || !R.playing) return;
    if (R.curIdx >= R.frames.length - 1) {
      stopReplayPlayback();
      return;
    }
    renderReplayFrame(R.curIdx + 1);
  }, intervalMs);
}

function renderReplayPassport(g) {
  const box = $('rep-passport');
  if (!box) return;
  box.innerHTML = '';
  const kv = (k, v, node) => {
    const row = document.createElement('div');
    row.className = 'rep-kv';
    const ks = document.createElement('span');
    ks.className = 'k'; ks.textContent = k;
    row.appendChild(ks);
    if (node) {
      row.appendChild(node);
    } else {
      const vs = document.createElement('span');
      vs.className = 'v'; vs.textContent = v;
      row.appendChild(vs);
    }
    box.appendChild(row);
  };
  const roleZh = (ROLES[g.roleKey] && ROLES[g.roleKey].zh) || g.roleKey;
  kv('状态', `✓ 已验真（${g.framesMatched}/${g.framesCompared} 帧）`);
  kv('角色', `${g.name} · ${roleZh}`);
  kv('种子', `#${g.seed}（${g.seedSource}）`);
  kv('最深层数', g.maxDlvl ? `Dlvl ${g.maxDlvl}` : 'Dlvl 1');
  kv('结局', g.outcome === 'ascended' ? '🏆 飞升' : g.outcome === 'died' ? '💀 阵亡' : '退出/结束');
  if (g.deathReason) kv('战报', g.deathReason);
  if (g.recordingSha256) kv('SHA-256', g.recordingSha256.slice(0, 16) + '…');
  if (g.parentGameId) {
    const pBtn = document.createElement('button');
    pBtn.type = 'button';
    pBtn.className = 'rep-link-btn';
    pBtn.textContent = `${g.parentGameId} (T${g.forkTurn ?? 0})`;
    pBtn.addEventListener('click', () => openReplayById(g.parentGameId));
    kv('分叉来源', '', pBtn);
  }
}

async function loadForkTree(gameId) {
  const box = $('rep-forks-list');
  if (!box) return;
  const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG;
  const project = cfg && cfg.projectId;
  if (!project || project.startsWith('REPLACE_')) {
    box.innerHTML = '<div class="hint">本地模式无分叉树索引。</div>';
    return;
  }
  box.innerHTML = '<div class="hint">查询子分叉中…</div>';
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
            compositeFilter: {
              op: 'AND',
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: 'parentGameId' },
                    op: 'EQUAL',
                    value: { stringValue: gameId },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'status' },
                    op: 'EQUAL',
                    value: { stringValue: 'verified' },
                  },
                },
              ],
            },
          },
          orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
          limit: 20,
        },
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    const forks = rows
      .filter((x) => x.document && x.document.fields)
      .map((x) => parseGameDoc(x.document));
    if (!forks.length) {
      box.innerHTML = '<div class="hint">暂无公开已验真分叉。拖动进度条到任意回合，点左侧「分叉由我来打」成为第一条分支！</div>';
      return;
    }
    box.innerHTML = '';
    for (const fk of forks) {
      const roleZh = (ROLES[fk.roleKey] && ROLES[fk.roleKey].zh) || fk.roleKey;
      const item = document.createElement('div');
      item.className = 'fork-tree-item';
      const top = document.createElement('div');
      top.className = 'fork-tree-top';
      const nm = document.createElement('span');
      nm.textContent = `${fk.name} · ${roleZh}`;
      const badge = document.createElement('span');
      badge.className = 'ag-badge fork';
      badge.textContent = `从 T${fk.forkTurn ?? 0} 分叉`;
      top.append(nm, badge);

      const meta = document.createElement('div');
      meta.className = 'fork-tree-meta';
      meta.textContent = `Dlvl:${fk.maxDlvl || 1} · 共 ${fk.turns} 回合 · ${fk.deathReason || fk.outcome || '已验真'}`;

      item.append(top, meta);
      if (fk.publicRecordingPath) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mini-btn';
        b.textContent = '▶ 观看此分支';
        b.addEventListener('click', () => openReplay(fk));
        item.appendChild(b);
      }
      box.appendChild(item);
    }
  } catch (e) {
    box.innerHTML = '<div class="hint">分叉树查询暂不可用（索引构建中或网络不可达）。</div>';
  }
}

async function openReplayById(gameId) {
  const g = await fetchGameDocById(gameId);
  if (!g) {
    alert('未找到该公开已验真对局：' + gameId);
    return;
  }
  if (!canWatchGame(g)) {
    alert('该历史对局尚未生成公开录像文件。');
    return;
  }
  openReplay(g, { fromPage: 'setup' });
}

async function openReplay(gameDoc, opts = {}) {
  const snapshot = opts && opts.snapshot ? opts.snapshot : null;
  const fromPage = (opts && opts.fromPage) || 'setup';
  if (!gameDoc || (!snapshot && !canWatchGame(gameDoc))) {
    alert('该对局暂无可读取的录像文件。');
    return;
  }
  stopReplayPlayback();
  teardownCurrentSession();
  S = null;
  const sid = activeSessionToken;

  document.body.classList.remove('in-game');
  $('setup').hidden = true;
  $('game').hidden = true;
  if ($('mygames')) $('mygames').hidden = true;
  $('replay').hidden = false;
  setTopNavActive('');
  if (!snapshot) {
    try { history.replaceState(null, '', '#replay/' + encodeURIComponent(gameDoc.gameId)); } catch (e) { }
  }

  const roleZh = (ROLES[gameDoc.roleKey] && ROLES[gameDoc.roleKey].zh) || gameDoc.roleKey;
  $('rep-title').textContent = `${gameDoc.name} · ${roleZh} · 种子 #${gameDoc.seed}`;
  $('rep-badge').textContent = snapshot ? `进行中 · T${gameDoc.turns}`
    : gameDoc.status === 'pending' ? '⏳ 待验真（本人录像）'
    : gameDoc.outcome === 'ascended' ? '🏆 飞升 · 已验真'
    : gameDoc.outcome === 'died' ? '💀 阵亡 · 已验真'
    : `✓ ${gameDoc.framesMatched} 帧已验真`;
  $('btn-rep-back').textContent = fromPage === 'mygames' ? '← 返回我的对局' : '← 返回大厅';
  $('btn-rep-share').hidden = !gameDoc.publicRecordingPath;
  $('btn-rep-fork').disabled = true;
  $('rep-seek').value = '0';
  $('rep-seek').max = '0';
  $('rep-time').textContent = '缓冲中…';
  $('rep-buffer-overlay').hidden = false;
  $('rep-buffer-title').textContent = '正在缓冲回放帧…';
  $('rep-buffer-fill').style.width = '5%';
  $('rep-buffer-detail').textContent = snapshot ? '正在加载进行中进度…' : '正在下载录像流…';

  renderReplayPassport(gameDoc);
  loadForkTree(gameDoc.gameId);

  R = {
    sid,
    fromPage,
    game: gameDoc,
    header: null,
    turns: [],
    frames: [],
    curIdx: 0,
    playing: false,
    playTimer: null,
    buffering: true,
    curMapRows: null,
    curMapColors: null,
    msgs: [],
  };

  try {
    let records = [];
    if (snapshot) {
      records = Array.isArray(snapshot.records) ? snapshot.records : [];
    } else {
      let text = null;
      if (gameDoc.publicRecordingPath) {
        const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG || {};
        const bucket = cfg.storageBucket || ((cfg.projectId || 'airstring-nethack') + '.firebasestorage.app');
        const dlUrl = 'https://firebasestorage.googleapis.com/v0/b/' +
          encodeURIComponent(bucket) + '/o/' +
          encodeURIComponent(gameDoc.publicRecordingPath) + '?alt=media';
        const resp = await fetch(dlUrl);
        if (resp.ok) text = await resp.text();
      }
      if (text == null && cloudActive() && cloud.loadOwnRecording) {
        text = await cloud.loadOwnRecording(gameDoc.gameId);
      }
      if (!text) throw new Error('未能读取到录像流（请检查网络或确认登录账号）');
      if (!R || R.sid !== sid) return;
      const lines = text.split('\n').filter((l) => l.trim());
      records = lines.map((l) => JSON.parse(l));
    }

    const header = records.find((r) => r && r.k === 'header');
    const turns = records.filter((r) => r && r.k === 'turn');
    if (!header || !turns.length) throw new Error('录像无有效回合记录');
    R.header = header;
    R.turns = turns;
    const replayBytes = concatReplayBytes(records, snapshot ? snapshot.pendingKeys : null);

    $('rep-buffer-detail').textContent = `引擎重放缓存中：0 / ${turns.length} 回合`;

    let pumpStarted = false;
    function finishReplayBuffer() {
      if (!R || R.sid !== sid || !R.buffering) return;
      R.buffering = false;
      $('rep-buffer-fill').style.width = '100%';
      $('rep-buffer-overlay').hidden = true;
      if (typeof globalThis.__airstring_close_keys === 'function') {
        try { globalThis.__airstring_close_keys(); } catch (e) { }
      }
      if (R.frames.length) {
        renderReplayFrame(snapshot ? R.frames.length - 1 : 0);
      } else {
        $('rep-time').textContent = '无可显示帧';
      }
    }

    function pumpReplayKeys() {
      let off = 0;
      const CHUNK = 48;
      function step() {
        if (!R || R.sid !== sid || !R.buffering) return;
        const q = globalThis.__airstring_key_queue;
        if (q && q.pos < q.bytes.length) {
          setTimeout(step, 4);
          return;
        }
        if (off < replayBytes.length) {
          const end = Math.min(off + CHUNK, replayBytes.length);
          globalThis.__airstring_push_keys(replayBytes.subarray(off, end));
          off = end;
          const pct = Math.min(99, Math.max(5, Math.round((R.frames.length / Math.max(1, turns.length)) * 100)));
          $('rep-buffer-fill').style.width = pct + '%';
          $('rep-buffer-detail').textContent = `引擎重放缓存中：${R.frames.length} / ${turns.length} 回合（${pct}%）`;
          setTimeout(step, 0);
          return;
        }
        setTimeout(() => {
          if (!R || R.sid !== sid || !R.buffering) return;
          const q2 = globalThis.__airstring_key_queue;
          if (q2 && q2.pos < q2.bytes.length) { setTimeout(step, 4); return; }
          finishReplayBuffer();
        }, 45);
      }
      step();
    }

    globalThis.__airstring_config = {
      seed: String(header.seed),
      date: header.date || FIXED_DATE,
      options: header.options,
      mode: 'async',
      exportPath: '/fleck.frames',
      rngPath: '/fleck.rng',
    };
    globalThis.__airstring_key_queue = { bytes: [], pos: 0, closed: false };
    globalThis.__airstring_event = (json) => {
      if (!R || R.sid !== sid) return;
      let ev;
      try { ev = JSON.parse(json); } catch (e) { return; }
      if (ev.t === 'init' && !pumpStarted) {
        pumpStarted = true;
        pumpReplayKeys();
      } else if (ev.t === 'map' && Array.isArray(ev.rows)) {
        R.curMapRows = ev.rows.slice();
        R.curMapColors = Array.isArray(ev.colors)
          ? ev.colors.map((r) => (Array.isArray(r) ? r.slice() : [])) : null;
      } else if ((ev.t === 'message' || ev.t === 'raw') && ev.text) {
        R.msgs.push(ev.text);
        if (R.msgs.length > 20) R.msgs.shift();
      }
    };
    globalThis.__airstring_frame = (frameText) => {
      if (!R || R.sid !== sid) return;
      const pf = parseFrame(frameText);
      const len = R.msgs.length;
      R.frames.push({
        turn: pf.turn ?? (R.frames.length + 1),
        frame: pf.frame ?? R.frames.length,
        hp: pf.hp, hpmax: pf.hpmax, pw: pf.pw, pwmax: pf.pwmax,
        ac: pf.ac, xl: pf.xl, gold: pf.gold, dlvl: pf.dlevel,
        mapRows: R.curMapRows ? R.curMapRows.slice() : null,
        mapColors: R.curMapColors ? R.curMapColors.map((r) => r.slice()) : null,
        msgPrev: len >= 2 ? R.msgs[len - 2] : '',
        msgCur: len >= 1 ? R.msgs[len - 1] : '',
      });
    };
    globalThis.__airstring_rngline = () => { };
    globalThis.__airstring_game_over = () => {
      if (R && R.sid === sid && R.buffering) finishReplayBuffer();
    };

    const { default: createModule } = await import('./nethack.js');
    await createModule({ print: () => { }, printErr: () => { } });
  } catch (e) {
    if (R && R.sid === sid) {
      $('rep-buffer-title').textContent = '回放加载失败';
      $('rep-buffer-detail').textContent = String(e && e.message ? e.message : e);
    }
  }
}

function forkFromReplay() {
  if (!R || !R.frames.length || !R.header) return;
  const snap = R.frames[R.curIdx];
  const targetTurn = snap.turn || (R.curIdx + 1);
  const sliced = R.turns.filter((t) => (t.turn || 0) <= targetTurn);
  const forkTurn = sliced.length ? (sliced[sliced.length - 1].turn || sliced.length) : 0;
  const replayBytes = concatReplayBytes(sliced, null);
  const expectedHashes = sliced.map((t) => t.hash);
  const hdr = R.header;
  const parentId = R.game.gameId;

  closeReplay(false);
  startGame({
    mode: 'fork',
    seed: hdr.seed,
    seedSource: 'fork',
    options: hdr.options,
    parentGameId: parentId,
    forkTurn,
    replayBytes,
    expectedTurns: forkTurn,
    expectedHashes,
  });
}

/* Top nav & My Games page wiring */
$('nav-lobby').addEventListener('click', () => showSetup());
$('nav-mygames').addEventListener('click', () => showMyGames(true));
$('btn-goto-mygames').addEventListener('click', () => showMyGames(true));
$('btn-mygames-refresh').addEventListener('click', () => refreshMyGamesPage(true));
$('btn-mygames-new').addEventListener('click', () => showSetup());
$('btn-mygames-signin').addEventListener('click', () => {
  if (cloud && cloud.signIn) {
    cloud.signIn().catch((e) => {
      alert('Google 登录未完成：' + (e && e.message ? e.message : '请检查弹窗拦截'));
    });
  }
});

/* Replay controls wiring */
$('btn-rep-back').addEventListener('click', () => closeReplay(true));
$('btn-rep-share').addEventListener('click', () => {
  const url = location.href;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      const b = $('btn-rep-share');
      b.textContent = '✓ 已复制链接';
      setTimeout(() => { b.textContent = '🔗 复制链接'; }, 2000);
    }).catch(() => prompt('复制此回放链接：', url));
  } else {
    prompt('复制此回放链接：', url);
  }
});
$('btn-rep-start').addEventListener('click', () => { stopReplayPlayback(); renderReplayFrame(0); });
$('btn-rep-rew').addEventListener('click', () => { stopReplayPlayback(); if (R) renderReplayFrame(R.curIdx - 5); });
$('btn-rep-prev').addEventListener('click', () => { stopReplayPlayback(); if (R) renderReplayFrame(R.curIdx - 1); });
$('btn-rep-next').addEventListener('click', () => { stopReplayPlayback(); if (R) renderReplayFrame(R.curIdx + 1); });
$('btn-rep-fwd').addEventListener('click', () => { stopReplayPlayback(); if (R) renderReplayFrame(R.curIdx + 5); });
$('btn-rep-play').addEventListener('click', () => {
  if (!R || R.buffering) return;
  if (R.playing) stopReplayPlayback();
  else startReplayPlayback();
});
$('rep-speed').addEventListener('change', () => {
  if (R && R.playing) startReplayPlayback();
});
$('rep-seek').addEventListener('input', (e) => {
  stopReplayPlayback();
  renderReplayFrame(parseInt(e.target.value, 10) || 0);
});
$('btn-rep-fork').addEventListener('click', () => forkFromReplay());

document.addEventListener('keydown', (e) => {
  if (!R || $('replay').hidden) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  if (e.key === ' ') {
    e.preventDefault();
    if (R.playing) stopReplayPlayback(); else startReplayPlayback();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stopReplayPlayback();
    renderReplayFrame(R.curIdx - (e.shiftKey ? 5 : 1));
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    stopReplayPlayback();
    renderReplayFrame(R.curIdx + (e.shiftKey ? 5 : 1));
  } else if (e.key === 'Escape') {
    closeReplay(true);
  }
});
window.addEventListener('resize', () => {
  if (R && !R.buffering && R.frames.length && !$('replay').hidden) {
    renderReplayFrame(R.curIdx);
  }
});

/* Deep links: #replay/<gameId> and #mygames */
function checkRouteHash() {
  const h = location.hash || '';
  const m = /^#replay\/(.+)$/.exec(h);
  if (m) {
    const gid = decodeURIComponent(m[1]);
    if (!R || R.game.gameId !== gid) openReplayById(gid);
    return;
  }
  if (h === '#mygames') {
    if ($('mygames') && $('mygames').hidden) showMyGames(true);
  }
}
window.addEventListener('hashchange', checkRouteHash);

/* after a tap, drop focus from the button so a following Space /
   Enter keypress is a game key, not a second button activation */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#game button');
  if (b) b.blur();
});

fillSetupForm();
renderBar();
loadVerifiedLobby();
if (cloud && cloud.onUserChange) {
  cloud.onUserChange((u) => onAuthChanged(u));
} else {
  if ($('guest-banner')) $('guest-banner').hidden = false;
}
checkRouteHash();

/* read-only test/inspection hook (used by the S5 gate driver) */
window.__airstring_debug = {
  state: () => S ? {
    gameId: S.id, started: S.started, over: S.over,
    overStatus: S.overStatus, mode: uiMode(),
    buffering: !!S.buffering, tabLocked: !!S.tabLocked,
    parentGameId: S.parentGameId, forkTurn: S.forkTurn,
    counters: { ...S.counters }, keysTotal: S.keysTotal,
    lastFrame: S.lastFrame, underHero: S.underHero,
    heroPos: S.heroPos, records: S.records.length,
    uploadOk: S.uploadOk || 0, uploadFailed: !!S.uploadFailed,
    prompt: S.prompt, seed: S.seed, seedSource: S.seedSource,
    eventTail: S.eventTail || [],
    lastMessage: S.messages[S.messages.length - 1] || null,
  } : null,
  records: () => (S ? S.records : []),
};


