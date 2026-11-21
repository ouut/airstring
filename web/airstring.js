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
try { cloud = (await import('./firebase.js?v=p2fix7')).default; }
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

/* ---------------- UI preferences (mobile zoom, hand flip, veteran QoL) ---------------- */
const mobileMQ = window.matchMedia('(max-width: 768px), (pointer: coarse)');
function isMobileMode() { return mobileMQ.matches; }

let mobileZoomed = true; /* mobile portrait default: follow-@ zoomed viewport */
let rightHandPad = false;
let termTheme = 'nao';
let termFontScale = 100;
let dangerGuardEnabled = true;
try {
  rightHandPad = localStorage.getItem('airstring_hand_right') === '1';
  termTheme = localStorage.getItem('airstring_term_theme') || 'nao';
  const fs = parseInt(localStorage.getItem('airstring_font_scale') || '100', 10);
  if (Number.isFinite(fs) && fs >= 75 && fs <= 140) termFontScale = fs;
  const dg = localStorage.getItem('airstring_danger_guard');
  if (dg === '0') dangerGuardEnabled = false;
} catch (e) { }

const EXTENDED_COMMANDS = [
  'adjust', 'annotate', 'attributes', 'chat', 'conduct', 'dip', 'enhance',
  'force', 'invoke', 'jump', 'loot', 'monster', 'name', 'offer', 'overview',
  'pray', 'quit', 'ride', 'rub', 'sit', 'terrain', 'tip', 'turn', 'twoweapon',
  'untrap', 'version', 'wipe', 'youpoly',
];

const DANGER_MSG_RE = /cockatrice|chickatrice|turning to stone|limbs are stiffening|mind flayer|deadly poison|food poisoning|turning into.*slime|you faint|fainting|starving|shopkeeper gets angry|demogorgon|pestilence|famine|death hits|low hitpoints|you feel very weak|sickness|touch of death/i;

function applyTerminalPrefs() {
  document.body.classList.remove('theme-nao', 'theme-classic', 'theme-amber');
  document.body.classList.add('theme-' + (termTheme || 'nao'));
  if ($('term-theme-select')) $('term-theme-select').value = termTheme;
  if ($('term-font-val')) $('term-font-val').textContent = termFontScale + '%';
  if ($('opt-danger-guard')) $('opt-danger-guard').checked = dangerGuardEnabled;
}

function loadSavedVetOptions() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('airstring_nh_opts_v1') || 'null'); } catch (_) { }
  if (!saved || typeof saved !== 'object') return;
  if ($('opt-autopickup') && typeof saved.autopickup === 'boolean') $('opt-autopickup').checked = saved.autopickup;
  if ($('opt-pickup-types') && typeof saved.pickupTypes === 'string') $('opt-pickup-types').value = saved.pickupTypes;
  if ($('opt-lit-corridor') && typeof saved.litCorridor === 'boolean') $('opt-lit-corridor').checked = saved.litCorridor;
  if ($('opt-hilite-pet') && typeof saved.hilitePet === 'boolean') $('opt-hilite-pet').checked = saved.hilitePet;
  if ($('opt-hilite-pile') && typeof saved.hilitePile === 'boolean') $('opt-hilite-pile').checked = saved.hilitePile;
  if ($('opt-paranoid') && typeof saved.paranoid === 'boolean') $('opt-paranoid').checked = saved.paranoid;
  if ($('opt-numpad') && typeof saved.numpad === 'boolean') $('opt-numpad').checked = saved.numpad;
  if ($('opt-showexp') && typeof saved.showexp === 'boolean') $('opt-showexp').checked = saved.showexp;
}

function buildVetOptionsSuffix() {
  const autopickup = $('opt-autopickup') ? $('opt-autopickup').checked : true;
  const rawPickup = ($('opt-pickup-types') ? $('opt-pickup-types').value : '$?!"=/') || '';
  /* Strict whitelist for pickup_types symbols (NetHack object classes only, no commas/control chars) */
  const pickupTypes = rawPickup.replace(/[^$?!"=/+%()*[\]`0_]/g, '').slice(0, 16);
  const litCorridor = $('opt-lit-corridor') ? $('opt-lit-corridor').checked : true;
  const hilitePet = $('opt-hilite-pet') ? $('opt-hilite-pet').checked : true;
  const hilitePile = $('opt-hilite-pile') ? $('opt-hilite-pile').checked : true;
  const paranoid = $('opt-paranoid') ? $('opt-paranoid').checked : true;
  const numpad = $('opt-numpad') ? $('opt-numpad').checked : false;
  const showexp = $('opt-showexp') ? $('opt-showexp').checked : true;

  try {
    localStorage.setItem('airstring_nh_opts_v1', JSON.stringify({
      autopickup, pickupTypes, litCorridor, hilitePet, hilitePile, paranoid, numpad, showexp,
    }));
  } catch (_) { }

  const parts = [];
  parts.push(autopickup ? 'autopickup' : '!autopickup');
  if (autopickup && pickupTypes) parts.push('pickup_types:' + pickupTypes);
  if (litCorridor) parts.push('lit_corridor');
  if (hilitePet) parts.push('hilite_pet');
  if (hilitePile) parts.push('hilite_pile');
  if (paranoid) parts.push('paranoid_confirmation:pray quit die attack');
  if (numpad) parts.push('number_pad:1');
  if (showexp) parts.push('showexp', 'time');
  return parts.join(',');
}

function fillSetupForm() {
  const roleSel = $('opt-role'), raceSel = $('opt-race'), alignSel = $('opt-align');
  const cardsBox = $('role-cards');
  const lobbyRoleSel = $('lobby-role-filter');
  for (const [k, v] of Object.entries(ROLES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.zh + ' (' + k + ')';
    roleSel.appendChild(o);

    if (lobbyRoleSel) {
      const fo = document.createElement('option');
      fo.value = k; fo.textContent = v.zh;
      lobbyRoleSel.appendChild(fo);
    }

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

/* ---------------- setup lobby: YouTube-style verified replay gallery ---------------- */
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

function formatRelativeTime(iso) {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 7 * 86400) return `${Math.floor(diffSec / 86400)} 天前`;
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function buildClientAsciiThumb(mapRows, mapColors) {
  if (!Array.isArray(mapRows) || !mapRows.length) return null;
  const W = 35, H = 11;
  const colors = Array.isArray(mapColors) ? mapColors : [];
  let hx = 40, hy = 10;
  for (let y = 0; y < mapRows.length; y++) {
    const x = String(mapRows[y] || '').indexOf('@');
    if (x >= 0) { hx = x; hy = y; break; }
  }
  const mapH = Math.min(21, mapRows.length);
  const x0 = Math.max(0, Math.min(80 - W, hx - Math.floor(W / 2)));
  const y0 = Math.max(0, Math.min(Math.max(0, mapH - H), hy - Math.floor(H / 2)));
  const r = [];
  const c = [];
  for (let dy = 0; dy < H; dy++) {
    const my = y0 + dy;
    const line = String(mapRows[my] || '').padEnd(80, ' ');
    const cline = Array.isArray(colors[my]) ? colors[my] : [];
    r.push(line.slice(x0, x0 + W));
    let cs = '';
    for (let dx = 0; dx < W; dx++) {
      const col = cline[x0 + dx];
      cs += (typeof col === 'number' ? (col & 0xf) : 7).toString(16);
    }
    c.push(cs);
  }
  const json = JSON.stringify({ w: W, h: H, r, c });
  return json.length <= 2048 ? json : null;
}

function parseGameDoc(doc) {
  const f = (doc && doc.fields) || {};
  const gameId = fsVal(f.gameId) || (doc.name ? doc.name.split('/').pop() : '');
  const options = fsVal(f.options) || '';
  const opts = parseOptionMap(options);
  return {
    gameId,
    uid: fsVal(f.uid) || null,
    displayName: fsVal(f.displayName) || null,
    source: fsVal(f.source) || null,
    batch: fsVal(f.batch) || null,
    lineageId: fsVal(f.lineageId) || null,
    provenance: fsVal(f.provenance) || null,
    status: fsVal(f.status) || 'verified',
    hiddenByOwner: !!fsVal(f.hiddenByOwner),
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
    displayName: d.displayName || null,
    source: d.source || null,
    batch: d.batch || null,
    lineageId: d.lineageId || null,
    provenance: d.provenance || null,
    status: d.status || 'pending',
    hiddenByOwner: !!d.hiddenByOwner,
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
  const when = formatRelativeTime(g.createdAt);
  const watchable = canWatchGame(g);

  const card = document.createElement('article');
  card.className = 'vgame-card' + (watchable ? ' clickable' : '');
  if (watchable) {
    card.title = '点击观看录像并可从任意回合分叉';
    card.addEventListener('click', () => openReplay(g, { fromPage }));
  }

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'vgame-thumb-wrap';
  const pre = g.thumb ? renderAsciiThumb(g.thumb) : null;
  if (pre) {
    thumbWrap.appendChild(pre);
  } else {
    const ph = document.createElement('div');
    ph.className = 'ascii-thumb-placeholder';
    ph.textContent = `@  #${g.seed}\n${g.name} · ${roleZh}`;
    thumbWrap.appendChild(ph);
  }

  const outPill = document.createElement('span');
  outPill.className = 'thumb-pill-tl' +
    (g.outcome === 'ascended' ? ' ascended' : g.outcome === 'died' ? ' died' : '');
  outPill.textContent = g.status === 'pending' ? '⏳ 验真中'
    : g.status === 'rejected' ? '✗ 未通过'
    : g.outcome === 'ascended' ? '🏆 飞升'
    : g.outcome === 'died' ? '💀 阵亡'
    : g.parentGameId ? '⚡ 分叉' : '✓ 已验真';
  thumbWrap.appendChild(outPill);

  const framePill = document.createElement('span');
  framePill.className = 'thumb-pill-tr';
  framePill.textContent = g.status === 'verified' ? `✓ ${g.framesMatched} 帧` : `${g.frames} 帧`;
  thumbWrap.appendChild(framePill);

  const statPill = document.createElement('span');
  statPill.className = 'thumb-pill-br';
  statPill.textContent = (g.maxDlvl ? `Dlvl:${g.maxDlvl} · ` : '') + `T:${g.turns}`;
  thumbWrap.appendChild(statPill);

  const body = document.createElement('div');
  body.className = 'vgame-body';

  const top = document.createElement('div');
  top.className = 'vgame-top';
  const title = document.createElement('span');
  const who = g.displayName || g.name;
  title.textContent = `${roleZh} · ${who}`;
  top.appendChild(title);
  if (g.parentGameId) {
    const fb = document.createElement('span');
    fb.className = 'ag-badge fork';
    fb.textContent = `⚡ T${g.forkTurn ?? 0}`;
    top.appendChild(fb);
  }
  const seedTag = document.createElement('span');
  seedTag.className = 'vgame-seed-tag';
  seedTag.textContent = `#${g.seed}`;
  top.appendChild(seedTag);

  const subRow = document.createElement('div');
  subRow.className = 'vgame-subrow';
  const rs = document.createElement('span');
  rs.className = 'vgame-reason';
  rs.textContent = g.deathReason || (g.status === 'pending' ? '后台自动验真中…' : g.gameId);
  rs.title = rs.textContent;
  const wh = document.createElement('span');
  wh.className = 'vgame-when';
  wh.textContent = when;
  subRow.append(rs, wh);

  body.append(top, subRow);

  /* Only in "对局" (My Games) show subtle soft-delete link */
  if (fromPage === 'mygames') {
    const acts = document.createElement('div');
    acts.className = 'card-corner-actions';
    const bDel = document.createElement('button');
    bDel.type = 'button';
    bDel.className = 'card-link-act danger';
    bDel.textContent = '删除';
    bDel.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定删除（隐藏）「${roleZh} · ${who}（T${g.turns}）」？隐藏后将不再在大厅和对局列表显示。`)) return;
      try {
        await cloud.softDeleteGame(g.gameId);
        verifiedGamesCache = verifiedGamesCache.filter((x) => x.gameId !== g.gameId);
        renderVerifiedGallery();
        card.remove();
        refreshMyGamesPage(true);
      } catch (err) {
        alert('删除失败（若规则刚提交审核请稍后再试）：' + (err && err.message ? err.message : err));
      }
    });
    acts.appendChild(bDel);
    body.appendChild(acts);
  }

  card.append(thumbWrap, body);
  return card;
}

let verifiedGamesCache = [];
let lastLobbyFetchAt = 0;
let lobbyFilter = 'all';

function renderVerifiedGallery() {
  const box = $('verified-list');
  if (!box) return;
  const q = (($('lobby-search') && $('lobby-search').value) || '').trim().toLowerCase();
  const roleF = ($('lobby-role-filter') && $('lobby-role-filter').value) || 'all';
  const sortBy = ($('lobby-sort') && $('lobby-sort').value) || 'newest';

  const list = verifiedGamesCache.filter((g) => {
    if (g.hiddenByOwner) return false;
    if (lobbyFilter === 'ascended' && g.outcome !== 'ascended') return false;
    if (lobbyFilter === 'died' && g.outcome !== 'died') return false;
    if (lobbyFilter === 'fork' && !g.parentGameId) return false;
    if (lobbyFilter === 'deep' && (g.maxDlvl || 1) < 10) return false;
    if (roleF !== 'all' && g.roleKey !== roleF) return false;
    if (q) {
      const roleZh = (ROLES[g.roleKey] && ROLES[g.roleKey].zh) || '';
      const hay = `${g.displayName || ''} ${g.name} ${g.roleKey} ${roleZh} ${g.seed} ${g.gameId} ${g.deathReason || ''} ${g.batch || ''} ${g.lineageId || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (sortBy === 'dlvl') {
    list.sort((a, b) => ((b.maxDlvl || 1) - (a.maxDlvl || 1)) || ((b.turns || 0) - (a.turns || 0)));
  } else if (sortBy === 'turns') {
    list.sort((a, b) => (b.turns || 0) - (a.turns || 0));
  } else {
    list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  if (!list.length) {
    box.innerHTML = '<div class="hint">没有匹配筛选条件的公开已验真对局。</div>';
    return;
  }

  box.innerHTML = '';
  for (const g of list) {
    box.appendChild(buildGalleryCard(g, 'setup'));
  }
}

async function loadVerifiedLobby(force = false) {
  const box = $('verified-list');
  if (!box) return;
  const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG;
  const project = cfg && cfg.projectId;
  if (!project || project.startsWith('REPLACE_')) {
    box.innerHTML = '<div class="hint">本地桩模式：未连接云端录像大厅。</div>';
    return;
  }
  /* 30-second cache throttle to protect Firestore read quota */
  if (!force && verifiedGamesCache.length && (Date.now() - lastLobbyFetchAt < 30000)) {
    renderVerifiedGallery();
    return;
  }
  if (!verifiedGamesCache.length) {
    box.innerHTML = '<div class="hint">加载公开已验真录像…</div>';
  }
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
          limit: 100,
        },
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = await r.json();
    lastLobbyFetchAt = Date.now();
    verifiedGamesCache = rows
      .filter((x) => x.document && x.document.fields)
      .map((x) => parseGameDoc(x.document))
      .filter((g) => !g.hiddenByOwner);
    if (!verifiedGamesCache.length) {
      box.innerHTML = '<div class="hint">暂无公开已验真对局，往下滚动开一局成为第一人！</div>';
      return;
    }
    renderVerifiedGallery();
  } catch (e) {
    if (!verifiedGamesCache.length) {
      box.innerHTML = '<div class="hint">暂时无法拉取已验真列表（不影响离线或正常游玩）。</div>';
    }
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
      if (/you begin praying|you finish your prayer/i.test(ev.text || '')) {
        S.lastPrayTurn = S.lastFrame ? (S.lastFrame.turn || S.lastFrame.moves || 0) : 0;
        if (!fast) updateNotesPrayStatus();
      }
      if (/^Pick (an object|a location)|^Where do you want to travel/i.test(ev.text || '')) {
        if (!fast && S.heroPos) {
          S.cursorPos = {
            x: S.heroPos.x,
            y: S.heroPos.y,
            mode: /travel/i.test(ev.text || '') ? 'travel' : 'farlook',
          };
          updateCursorHint();
          renderGrid();
        }
      }
      if (fast) {
        S.logBuffer.push(ev.text);
        if (S.logBuffer.length > 200) S.logBuffer.shift();
      } else {
        renderMessages();
        appendLog(ev.text);
        maybeTriggerDangerGuard(ev.text);
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
        maybeTriggerDangerGuard(ev.text);
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
      if (S.cursorPos) clearCursorPos();
      if (!fast) renderMenu(ev);
      break;
    case 'menu-end':
      S.menu = null;
      if (!fast) hideOverlay();
      break;
    case 'text':
      S.textActive = true; S.counters.text++;
      S.lastTextEv = ev;
      if (S.cursorPos) clearCursorPos();
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

/* ---------------- danger guard shield & farlook/travel cursor helpers ---------------- */
let dangerLockUntil = 0;
let dangerClearTimer = null;

function clearDangerShield() {
  dangerLockUntil = 0;
  if (dangerClearTimer) { clearTimeout(dangerClearTimer); dangerClearTimer = null; }
  if ($('danger-shield')) $('danger-shield').hidden = true;
  if ($('msg-wrap')) $('msg-wrap').classList.remove('danger-flash');
}

function maybeTriggerDangerGuard(text) {
  if (!dangerGuardEnabled || !text || !S || S.buffering) return;
  if (!DANGER_MSG_RE.test(text)) return;
  dangerLockUntil = Date.now() + 650;
  if ($('msg-wrap')) $('msg-wrap').classList.add('danger-flash');
  const box = $('danger-shield');
  const lbl = $('danger-shield-text');
  if (box && lbl) {
    lbl.textContent = '🛑 高危警报：' + String(text).slice(0, 72) + '（已防手滑保护，按 Space 立即解除）';
    box.hidden = false;
  }
  if (dangerClearTimer) clearTimeout(dangerClearTimer);
  dangerClearTimer = setTimeout(() => {
    if ($('msg-wrap')) $('msg-wrap').classList.remove('danger-flash');
    if ($('danger-shield')) $('danger-shield').hidden = true;
  }, 4500);
}

function updateCursorHint() {
  const el = $('cursor-hint');
  if (!el) return;
  if (!S || !S.cursorPos) {
    el.hidden = true;
    return;
  }
  const tag = S.cursorPos.mode === 'travel' ? '_ 寻路光标' : '; 远看光标';
  el.textContent = `${tag} (${S.cursorPos.x}, ${S.cursorPos.y}) · 方向键/Shift×8/点击地图移动 · . 确认 · Esc 退出`;
  el.hidden = false;
}

function clearCursorPos() {
  if (S) S.cursorPos = null;
  updateCursorHint();
  if (S && !S.buffering) renderGrid();
}

/* ---------------- map viewport: full 80x21 + mobile follow-@ zoom ---------------- */
function onMap(ev) {
  const prev = S.mapRows, prevHero = S.heroPos;
  S.mapRows = ev.rows; S.mapColors = ev.colors;
  let hero = null;
  /* Prefer exact [hero] x/y from engine frame (immune to shopkeeper @ and polymorph!) */
  if (S.lastFrame && S.lastFrame.x != null && S.lastFrame.y != null &&
      S.lastFrame.x >= 0 && S.lastFrame.x < 80 && S.lastFrame.y >= 0 && S.lastFrame.y < 21) {
    hero = { x: S.lastFrame.x, y: S.lastFrame.y };
  } else {
    for (let y = 0; y < ev.rows.length; y++) {
      const x = ev.rows[y].indexOf('@');
      if (x >= 0) { hero = { x, y }; break; }
    }
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
  const scale = (termFontScale || 100) / 100;

  let x0 = 0, y0 = 0, viewW = 80, viewH = 21, fs = 14;
  if (useZoom) {
    /* Crisp ~15.5px font on mobile portrait, hard-snapped centered on @ */
    fs = Math.max(11, Math.min(22, Math.round(Math.max(13, Math.min(17, Math.floor(sw / 25 / 0.61))) * scale)));
    viewW = Math.max(16, Math.min(80, Math.floor(sw / (fs * 0.61))));
    viewH = Math.max(9, Math.min(21, Math.floor(sh / (fs * 1.16))));
    const focus = S.cursorPos || S.heroPos;
    x0 = Math.max(0, Math.min(80 - viewW, focus.x - Math.floor(viewW / 2)));
    y0 = Math.max(0, Math.min(21 - viewH, focus.y - Math.floor(viewH / 2)));
  } else {
    const fsW = Math.floor(sw / 80 / 0.605);
    const fsH = Math.floor(sh / 21 / 1.17);
    const fitFs = Math.max(6, Math.min(24, fsW, fsH));
    fs = Math.max(6, Math.min(fitFs, Math.round(fitFs * scale)));
    if (scale > 1.0) fs = Math.min(28, Math.round(fitFs * scale));
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
      const isCur = S.cursorPos && mapX === S.cursorPos.x && mapY === S.cursorPos.y;
      const isHero = S.heroPos && mapX === S.heroPos.x && mapY === S.heroPos.y;
      const cls = isCur
        ? 'cursor-cell'
        : isHero
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
    makeSpan('', `XL:${f.xl}` + (f.exp != null ? `/${f.exp}` : '')),
    makeSpan('', `T:${f.moves}`),
    makeSpan('', `包:${f.invCount ?? 0}`)
  );
  if (!isMobileMode() && Array.isArray(f.attrs) && f.attrs.length >= 6) {
    const [st, iq, wi, dx, co, ch] = f.attrs;
    el.append(makeSpan('desktop-only', `St:${st} Dx:${dx} Co:${co} In:${iq} Wi:${wi} Ch:${ch}`));
  }
  if (hungerWord) {
    el.append(makeSpan('st-hunger' + (hungerCrit ? ' crit' : ''), hungerWord));
  }
  if (f.burden > 0) {
    el.append(makeSpan('st-hunger' + (f.burden >= 3 ? ' crit' : ''), BURDEN_ZH[f.burden] || '负重'));
  }
  if (Array.isArray(f.cond) && f.cond.some((v) => v > 0)) {
    el.append(makeSpan('st-hunger crit', '⚠ 异常'));
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

/* ---------------- line prompt + # extended command Tab completion ---------------- */
function isExtendedCmdPrompt() {
  const q = ($('line-q') && $('line-q').textContent) || '';
  return q.trim().startsWith('#');
}
function matchingExtendedCmds(prefix) {
  const p = String(prefix || '').trim().toLowerCase();
  if (!p) return EXTENDED_COMMANDS.slice(0, 12);
  return EXTENDED_COMMANDS.filter((c) => c.startsWith(p));
}
function renderLineSuggestions() {
  const box = $('line-suggest');
  if (!box) return;
  if ($('linebar').hidden || !isExtendedCmdPrompt()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const val = ($('line-input') && $('line-input').value) || '';
  const matches = matchingExtendedCmds(val);
  if (!matches.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = '';
  matches.slice(0, 12).forEach((cmd, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'line-suggest-chip' + (i === 0 ? ' first' : '');
    b.textContent = '#' + cmd;
    b.addEventListener('click', () => {
      $('line-input').value = cmd;
      submitLine();
    });
    box.appendChild(b);
  });
}
function completeLineInput() {
  if (!isExtendedCmdPrompt()) return false;
  const inp = $('line-input');
  const val = (inp.value || '').trim().toLowerCase();
  const matches = matchingExtendedCmds(val);
  if (!matches.length) return false;
  if (matches.length === 1) {
    inp.value = matches[0];
  } else {
    let common = matches[0];
    for (let i = 1; i < matches.length; i++) {
      let j = 0;
      while (j < common.length && j < matches[i].length && common[j] === matches[i][j]) j++;
      common = common.slice(0, j);
    }
    inp.value = common.length > val.length ? common : matches[0];
  }
  renderLineSuggestions();
  return true;
}
function showLineBar(q) {
  $('linebar').hidden = false;
  $('line-q').textContent = q || '';
  const inp = $('line-input');
  inp.value = '';
  renderLineSuggestions();
  setTimeout(() => {
    if (!$('linebar').hidden) inp.focus({ preventScroll: true });
  }, 30);
}
function hideLineBar() {
  $('linebar').hidden = true;
  if ($('line-suggest')) { $('line-suggest').hidden = true; $('line-suggest').innerHTML = ''; }
  if (document.activeElement === $('line-input')) $('line-input').blur();
}
function submitLine() {
  const inp = $('line-input');
  sendBytes(inp.value + '\n');
  inp.value = '';
  if ($('line-suggest')) { $('line-suggest').hidden = true; $('line-suggest').innerHTML = ''; }
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

/* ---------------- physical keyboard: full veteran passthrough ---------------- */
let imeWarnTimer = null;
function showImeWarn() {
  const el = $('ime-warn');
  if (!el) return;
  el.hidden = false;
  if (imeWarnTimer) clearTimeout(imeWarnTimer);
  imeWarnTimer = setTimeout(() => { el.hidden = true; }, 4500);
}
function hideImeWarn() {
  if (imeWarnTimer) { clearTimeout(imeWarnTimer); imeWarnTimer = null; }
  if ($('ime-warn')) $('ime-warn').hidden = true;
}

function isNumpadSession() {
  return !!(S && /\bnumber_pad:1\b/i.test(S.options || ''));
}

function dirByteForSession(dx, dy) {
  if (isNumpadSession()) {
    const m = {
      '-1,1': '1', '0,1': '2', '1,1': '3',
      '-1,0': '4', '0,0': '.', '1,0': '6',
      '-1,-1': '7', '0,-1': '8', '1,-1': '9',
    };
    return m[`${dx},${dy}`] || null;
  }
  return dirByte(dx, dy);
}

const VI_DELTA = {
  104: [-1, 0, 1], 106: [0, 1, 1], 107: [0, -1, 1], 108: [1, 0, 1],
  121: [-1, -1, 1], 117: [1, -1, 1], 98: [-1, 1, 1], 110: [1, 1, 1],
  72: [-1, 0, 8], 74: [0, 1, 8], 75: [0, -1, 8], 76: [1, 0, 8],
  89: [-1, -1, 8], 85: [1, -1, 8], 66: [-1, 1, 8], 78: [1, 1, 8],
};
const NUM_DELTA = {
  49: [-1, 1, 1], 50: [0, 1, 1], 51: [1, 1, 1],
  52: [-1, 0, 1], 54: [1, 0, 1],
  55: [-1, -1, 1], 56: [0, -1, 1], 57: [1, -1, 1],
};

function isMoveByte(byte) {
  return isNumpadSession() ? !!NUM_DELTA[byte] : !!VI_DELTA[byte];
}

function applyCursorByte(byte) {
  if (!S || !S.cursorPos) return;
  const d = (isNumpadSession() ? NUM_DELTA[byte] : null) || VI_DELTA[byte];
  if (d) {
    S.cursorPos.x = Math.max(0, Math.min(79, S.cursorPos.x + d[0] * d[2]));
    S.cursorPos.y = Math.max(0, Math.min(20, S.cursorPos.y + d[1] * d[2]));
    updateCursorHint();
    renderGrid();
    return;
  }
  /* Confirming or cancelling farlook / travel exits cursor mode */
  if (byte === 27 || byte === 13 || byte === 46 || byte === 44 || byte === 59 || byte === 58 || byte === 32) {
    clearCursorPos();
  }
}

document.addEventListener('compositionstart', () => {
  if (!S || S.over || S.buffering || $('game').hidden) return;
  const t = document.activeElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  showImeWarn();
});

document.addEventListener('keydown', (e) => {
  if (!S || S.over || S.buffering || S.tabLocked || $('game').hidden) return;
  if ($('dumplog-modal') && !$('dumplog-modal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeDumplogModal(); }
    return;
  }
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
            t.tagName === 'SELECT')) {
    if (e.key === 'Escape' && t.id === 'notes-textarea') {
      e.preventDefault();
      toggleNotesDrawer(false);
    }
    return;
  }

  /* IME Chinese/CJK input guard */
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) {
    showImeWarn();
    e.preventDefault();
    return;
  }

  if (e.key === 'Escape') {
    if ($('notes-drawer') && !$('notes-drawer').hidden) { toggleNotesDrawer(false); return; }
    if ($('game-drawer') && !$('game-drawer').hidden) { toggleGameDrawer(false); return; }
    if ($('panel') && !$('panel').hidden) { togglePanel(false); return; }
    if ($('msglog-drawer') && !$('msglog-drawer').hidden) { toggleMsgLog(false); return; }
    if (dangerLockUntil > Date.now()) { clearDangerShield(); return; }
  }

  if (dangerLockUntil > Date.now()) {
    if (e.key === ' ') {
      e.preventDefault();
      clearDangerShield();
      return;
    }
  }

  let byte = null;
  /* Safe Shift+Alt aliases for browser-hijacked Ctrl shortcuts (Ctrl+T/P/R/D) */
  if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
    const code = e.code || '';
    if (code === 'KeyT') byte = 20;      /* Ctrl+T teleport */
    else if (code === 'KeyP') byte = 16; /* Ctrl+P prev messages */
    else if (code === 'KeyR') byte = 18; /* Ctrl+R redraw */
    else if (code === 'KeyD') byte = 4;  /* Ctrl+D kick */
  }
  /* Native NetHack Meta keys (Alt+a..z / Alt+2 -> 0x80 | ascii) */
  if (byte == null && e.altKey && !e.ctrlKey && !e.metaKey) {
    const code = e.code || '';
    if (/^Key([A-Z])$/.test(code)) {
      byte = 0x80 | code.slice(3).toLowerCase().charCodeAt(0);
    } else if (code === 'Digit2') {
      byte = 0x80 | 50; /* M-2 twoweapon */
    } else {
      return;
    }
  } else if (byte == null && e.ctrlKey && e.key.length === 1) {
    byte = e.key.toUpperCase().charCodeAt(0) & 0x1f;
  } else if (byte == null && e.metaKey) {
    return;
  } else if (byte == null && /^Numpad[1-9]$/.test(e.code || '')) {
    const n = parseInt(e.code.slice(6), 10);
    const map = {
      1: [-1, 1], 2: [0, 1], 3: [1, 1],
      4: [-1, 0], 5: [0, 0], 6: [1, 0],
      7: [-1, -1], 8: [0, -1], 9: [1, -1],
    };
    const [dx, dy] = map[n];
    const ch = dirByteForSession(dx, dy);
    if (ch) byte = ch.charCodeAt(0);
  } else if (byte == null && e.key.length === 1) {
    const cc = e.key.charCodeAt(0);
    if (cc > 127) { showImeWarn(); e.preventDefault(); return; }
    byte = cc & 0xff;
  } else if (byte == null) {
    const dKey = (dx, dy) => {
      const ch = dirByteForSession(dx, dy);
      return ch ? ch.charCodeAt(0) : null;
    };
    switch (e.key) {
      case 'Enter': byte = 13; break;
      case 'Escape': byte = 27; break;
      case 'Backspace': byte = 127; break;
      case 'Tab': byte = 9; break;
      case 'ArrowLeft': byte = dKey(-1, 0); break;
      case 'ArrowDown': byte = dKey(0, 1); break;
      case 'ArrowUp': byte = dKey(0, -1); break;
      case 'ArrowRight': byte = dKey(1, 0); break;
      case 'Home': byte = dKey(-1, -1); break;
      case 'PageUp': byte = dKey(1, -1); break;
      case 'End': byte = dKey(-1, 1); break;
      case 'PageDown': byte = dKey(1, 1); break;
      default: return;
    }
  }
  if (byte == null) return;
  hideImeWarn();

  /* Block accidental rapid movement during active danger shield */
  if (dangerLockUntil > Date.now() && isMoveByte(byte) && !S.cursorPos) {
    e.preventDefault();
    return;
  }

  e.preventDefault();
  if (S.cursorPos) {
    applyCursorByte(byte);
  } else if (uiMode() === 'main' && (byte === 59 || byte === 95) && S.heroPos) {
    /* Enter client-side cursor tracking immediately on ';' (farlook) or '_' (travel) */
    S.cursorPos = { x: S.heroPos.x, y: S.heroPos.y, mode: byte === 95 ? 'travel' : 'farlook' };
    updateCursorHint();
    renderGrid();
  }
  sendBytes([byte]);
});

/* map taps: cursor move in farlook/travel, adjacent = move/attack, hero = wait, far = travel */
$('grid').addEventListener('click', (e) => {
  if (!S || S.over || S.buffering || S.tabLocked || !S.heroPos) return;
  const cell = e.target.closest('span[data-x]');
  if (!cell) return;
  const x = +cell.dataset.x, y = +cell.dataset.y;
  if (S.cursorPos) {
    let cx = x - S.cursorPos.x, cy = y - S.cursorPos.y;
    let seq = '';
    while (cx !== 0 || cy !== 0) {
      const sx = Math.sign(cx), sy = Math.sign(cy);
      seq += dirByteForSession(sx, sy);
      cx -= sx; cy -= sy;
    }
    S.cursorPos.x = x; S.cursorPos.y = y;
    updateCursorHint();
    renderGrid();
    if (seq) sendBytes(seq);
    return;
  }
  const dx = x - S.heroPos.x, dy = y - S.heroPos.y;
  const mode = uiMode();
  if (mode !== 'main' && mode !== 'dir' && mode !== 'dirprompt') return;
  if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
    const b = dirByteForSession(dx, dy);
    if (b) sendKey(b);
    return;
  }
  if (mode === 'dir' || mode === 'dirprompt') return;
  let seq = '_', cx = dx, cy = dy;
  while (cx !== 0 || cy !== 0) {
    const sx = Math.sign(cx), sy = Math.sign(cy);
    seq += dirByteForSession(sx, sy);
    cx -= sx; cy -= sy;
  }
  seq += '.';
  sendBytes(seq);
});

/* ---------------- streamed frames: status + recorder ---------------- */
function parseFrame(text) {
  const get = (re) => { const m = re.exec(text); return m ? m[1] : null; };
  const num = (re) => { const v = get(re); return v == null ? null : +v; };
  const attrStr = get(/^attr=([0-9,\-]+)$/m);
  const attrs = attrStr ? attrStr.split(',').map((n) => parseInt(n, 10)) : null;
  const condStr = get(/^cond=([0-9,\-]+)$/m);
  const cond = condStr ? condStr.split(',').map((n) => parseInt(n, 10)) : null;
  let invCount = 0;
  const invIdx = text.indexOf('\n[inventory]\n');
  if (invIdx >= 0) {
    const rest = text.slice(invIdx + 13);
    for (const line of rest.split('\n')) {
      if (!line || line.startsWith('hash=') || line.startsWith('framehash=') || line === 'end') break;
      invCount++;
    }
  }
  return {
    frame: num(/^frame (\d+)$/m),
    turn: num(/^turn (\d+)$/m),
    hash: get(/hash=([0-9a-f]{64})/),
    name: S ? S.playerName : '',
    role: S ? S.roleEn : '',
    x: num(/\bx=(\d+)/), y: num(/\by=(\d+)/),
    hp: num(/hp=(-?\d+)/), hpmax: num(/hpmax=(\d+)/),
    pw: num(/pw=(-?\d+)/), pwmax: num(/pwmax=(\d+)/),
    ac: num(/ac=(-?\d+)/), xl: num(/xl=(\d+)/),
    exp: num(/exp=(\d+)/),
    gold: num(/gold=(\d+)/), hunger: num(/hunger=(-?\d+)/),
    luck: num(/luck=(-?\d+)/),
    dnum: num(/dnum=(\d+)/), dlevel: num(/dlevel=(\d+)/),
    burden: num(/burden=(\d+)/),
    moves: num(/moves=(\d+)/),
    attrs, cond, invCount,
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

  if (f.x != null && f.y != null && f.x >= 0 && f.x < 80 && f.y >= 0 && f.y < 21) {
    S.heroPos = { x: f.x, y: f.y };
  }
  renderStatus();
  if ($('notes-drawer') && !$('notes-drawer').hidden) updateNotesPrayStatus();
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
    thumb: buildClientAsciiThumb(sess.mapRows, sess.mapColors),
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
  } else if (document.visibilityState === 'visible' && !S) {
    if ($('setup') && !$('setup').hidden) loadVerifiedLobby(false);
    else if ($('mygames') && !$('mygames').hidden) refreshMyGamesPage(false);
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
  const CHUNK = 256;

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

function renderActiveGameCard(item, uid, fromPage = 'mygames') {
  const roleZh = (ROLES[item.roleEn] && ROLES[item.roleEn].zh) || item.roleEn || '冒险者';
  const when = formatRelativeTime(item.updatedAt);

  const card = document.createElement('article');
  card.className = 'vgame-card clickable';
  card.title = '点击继续游玩';
  card.addEventListener('click', () => resumeActiveGameById(uid, item.gameId, false, 'mygames'));

  /* Pure-black 35x11 ASCII thumbnail (consistent with finished cards) */
  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'vgame-thumb-wrap';
  const pre = item.thumb ? renderAsciiThumb(item.thumb) : null;
  if (pre) {
    thumbWrap.appendChild(pre);
  } else {
    const ph = document.createElement('div');
    ph.className = 'ascii-thumb-placeholder';
    ph.textContent = `@  #${item.seedSource === 'random' ? '随机' : item.seed}\n${item.playerName || 'fleck'} · ${roleZh}\n点击继续冒险`;
    thumbWrap.appendChild(ph);
  }

  const tl = document.createElement('span');
  tl.className = 'thumb-pill-tl';
  tl.textContent = item.parentGameId ? '⚡ 进行中分叉' : '▶ 进行中';
  thumbWrap.appendChild(tl);

  if (item.hp != null && item.hpmax != null) {
    const tr = document.createElement('span');
    tr.className = 'thumb-pill-tr';
    tr.textContent = `HP ${item.hp}/${item.hpmax}`;
    thumbWrap.appendChild(tr);
  }

  const br = document.createElement('span');
  br.className = 'thumb-pill-br';
  br.textContent = `Dlvl:${item.dlvl || 1} · T:${item.turns || 0}`;
  thumbWrap.appendChild(br);

  const body = document.createElement('div');
  body.className = 'vgame-body';

  const top = document.createElement('div');
  top.className = 'vgame-top';
  const title = document.createElement('span');
  title.textContent = `${roleZh} · ${item.playerName || 'fleck'}`;
  top.appendChild(title);
  if (item.parentGameId) {
    const fb = document.createElement('span');
    fb.className = 'ag-badge fork';
    fb.textContent = `⚡ T${item.forkTurn ?? 0}`;
    top.appendChild(fb);
  }
  const seedTag = document.createElement('span');
  seedTag.className = 'vgame-seed-tag';
  seedTag.textContent = item.seedSource === 'random' ? '#随机' : `#${item.seed}`;
  top.appendChild(seedTag);

  const subRow = document.createElement('div');
  subRow.className = 'vgame-subrow';
  const hint = document.createElement('span');
  hint.className = 'vgame-reason';
  hint.textContent = '点击卡片继续游玩';
  const wh = document.createElement('span');
  wh.className = 'vgame-when';
  wh.textContent = when;
  subRow.append(hint, wh);

  const acts = document.createElement('div');
  acts.className = 'card-corner-actions';

  const bWatch = document.createElement('button');
  bWatch.type = 'button';
  bWatch.className = 'card-link-act';
  bWatch.textContent = '▶ 回放';
  bWatch.addEventListener('click', (e) => {
    e.stopPropagation();
    watchActiveGameById(uid, item.gameId, fromPage);
  });

  const bDel = document.createElement('button');
  bDel.type = 'button';
  bDel.className = 'card-link-act danger';
  bDel.textContent = '删除';
  bDel.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`确定删除进行中对局「${roleZh} · ${item.playerName || 'fleck'}（第 ${item.turns || 0} 回合）」？`)) return;
    await idbDeleteGame(uid, item.gameId);
    try { await cloud.deleteActiveGame(item.gameId); } catch (err) { }
    await refreshActiveGames(true);
    if ($('mygames') && !$('mygames').hidden) refreshMyGamesPage(true);
  });

  acts.append(bWatch, bDel);
  body.append(top, subRow, acts);
  card.append(thumbWrap, body);
  return card;
}

let cachedActiveAll = [];
let lastMyGamesFetchAt = 0;
let pendingPollTimers = [];

function clearPendingPolls() {
  for (const t of pendingPollTimers) clearTimeout(t);
  pendingPollTimers = [];
}

function schedulePendingPoll(games) {
  clearPendingPolls();
  const now = Date.now();
  const hasFreshPending = (games || []).some((g) => {
    if (g.status !== 'pending' || g.hiddenByOwner) return false;
    const ts = g.createdAt ? Date.parse(g.createdAt) : 0;
    return ts > 0 && (now - ts) < 90000;
  });
  if (!hasFreshPending) return;
  for (const delayMs of [3000, 8000, 18000]) {
    pendingPollTimers.push(setTimeout(() => {
      if ($('mygames') && !$('mygames').hidden) {
        refreshMyGamesPage(true);
      } else if ($('setup') && !$('setup').hidden) {
        loadVerifiedLobby(true);
      }
    }, delayMs));
  }
}

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
      } else if (cur && !cur.thumb && meta.thumb) {
        cur.thumb = meta.thumb;
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
      (shelved.length ? '近期无进行中对局，下方可展开 30 天前已搁置的对局。' : '暂无进行中对局，点右上角「+ 开新局」试试！') +
      '</div>';
  } else {
    for (const item of recent) listEl.appendChild(renderActiveGameCard(item, uid, fromPage));
  }
  if (shelvedWrap && shelvedList && shelvedSum) {
    shelvedWrap.hidden = shelved.length === 0;
    shelvedSum.textContent = `已搁置对局（${shelved.length} 局 · 超过 30 天未操作，随时可续打或回放）`;
    for (const item of shelved) shelvedList.appendChild(renderActiveGameCard(item, uid, fromPage));
  }
}

async function refreshActiveGames(forceCloud = false) {
  const guestBanner = $('guest-banner');
  const user = cloud && cloud.currentUser();
  if (!user) {
    cachedActiveAll = [];
    updateMyCountBadge(0);
    if (guestBanner) guestBanner.hidden = false;
    return [];
  }
  if (guestBanner) guestBanner.hidden = true;
  const { all } = await fetchMergedActiveGames(user.uid, forceCloud);
  updateMyCountBadge(all.length);
  return all;
}

async function refreshMyGamesPage(forceCloud = false) {
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
  const needCloud = forceCloud || (Date.now() - lastMyGamesFetchAt >= 30000);
  const allActive = await refreshActiveGames(needCloud);
  if ($('my-active-count')) $('my-active-count').textContent = `共 ${allActive.length} 局`;
  renderActiveListInto(
    allActive, uid,
    $('my-active-list'), $('my-shelved-wrap'),
    $('my-shelved-list'), $('my-shelved-summary'), 'mygames',
  );

  const finBox = $('my-finished-list');
  const finCount = $('my-finished-count');
  if (!needCloud && finBox && finBox.children.length > 0 && !finBox.querySelector('.hint')) {
    return;
  }
  if (finBox && !finBox.children.length) {
    finBox.innerHTML = '<div class="hint">加载我的已结束对局…</div>';
  }
  try {
    const raw = await cloud.listMyGames(50);
    lastMyGamesFetchAt = Date.now();
    const games = raw.map(normalizePlainGame).filter((g) => !g.hiddenByOwner);
    schedulePendingPoll(games);
    if (finCount) finCount.textContent = `共 ${games.length} 局`;
    if (!games.length) {
      if (finBox) finBox.innerHTML = '<div class="hint">暂无已结束对局。完成一局（通关/死亡/#quit）后会自动出现在这里。</div>';
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
  if ($('newgame')) $('newgame').hidden = true;
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

async function resumeActiveGameById(uid, gameId, asFork, returnPage = 'setup') {
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
      returnPage,
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
      returnPage,
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
  if (R) {
    updateReplayCommentAuthUi();
    renderReplayComments();
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
  if (user && !autoResumeAttempted && !location.hash.startsWith('#replay/') && location.hash !== '#mygames' && location.hash !== '#new') {
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
    const vetSuffix = buildVetOptionsSuffix();
    options = `name:${name},role:${role},race:${race},gender:${gender},align:${align}` + (vetSuffix ? ',' + vetSuffix : '');
    gameId = makeGameId(seed);
  }

  teardownCurrentSession();
  clearDangerShield();
  hideImeWarn();
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
  S.cursorPos = null; S.lastPrayTurn = null;
  updateCursorHint();
  loadGameNotes(gameId);

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

  gameReturnPage = plan
    ? (plan.returnPage || gameReturnPage || 'setup')
    : (newGameFromPage || 'setup');
  const gameBackBtn = $('btn-game-back');
  if (gameBackBtn) {
    gameBackBtn.textContent = gameReturnPage === 'mygames' ? '← 对局' : '← 大厅';
    gameBackBtn.title = gameReturnPage === 'mygames' ? '保存并返回对局列表' : '保存并返回大厅';
  }
  stopReplayPlayback();
  R = null;
  if ($('replay')) $('replay').hidden = true;
  if ($('mygames')) $('mygames').hidden = true;
  if ($('newgame')) $('newgame').hidden = true;
  if (location.hash === '#mygames' || location.hash === '#new' || location.hash.startsWith('#replay/')) {
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
  toggleMsgLog(false); toggleGameDrawer(false); toggleNotesDrawer(false);
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
    exportPath: '/dev/null', rngPath: '/dev/null',
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
  clearDangerShield();
  clearCursorPos();
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
  bNew.type = 'button'; bNew.className = 'primary'; bNew.textContent = '返回大厅';
  bNew.addEventListener('click', showSetup);
  acts.appendChild(bNew);

  const bDump = document.createElement('button');
  bDump.type = 'button';
  bDump.textContent = '📜 完整战报 (Dumplog)';
  const snapSess = S;
  bDump.addEventListener('click', () => openDumplogFromGame(snapSess));
  acts.appendChild(bDump);

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

let newGameFromPage = 'setup';
let gameReturnPage = 'setup';

function leaveGame() {
  if (S && !S.over && !S.buffering && !cloudActive() && hasMeaningfulProgress(S)) {
    if (!confirm('当前为游客试玩，返回将丢失本局进度（登录 Google 可自动保存）。确定返回吗？')) {
      return;
    }
  }
  if (gameReturnPage === 'mygames') showMyGames(true);
  else showSetup();
}

async function showSetup() {
  stopReplayPlayback();
  closeDumplogModal();
  clearDangerShield();
  clearCursorPos();
  hideImeWarn();
  toggleNotesDrawer(false);
  R = null;
  if ($('replay')) $('replay').hidden = true;
  if ($('mygames')) $('mygames').hidden = true;
  if ($('newgame')) $('newgame').hidden = true;
  if (location.hash && (location.hash.startsWith('#replay/') || location.hash === '#mygames' || location.hash === '#new')) {
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

async function showNewGame(prefill = null, fromPage = 'setup') {
  newGameFromPage = fromPage || 'setup';
  stopReplayPlayback();
  R = null;
  if (S && !S.over && !S.buffering && !S.tabLocked && cloudActive()) {
    saveLocalSnapshot();
    await Promise.race([syncActiveToCloud(true), new Promise((r) => setTimeout(r, 2000))]);
  }
  try { sessionStorage.removeItem('airstring_last_active_game'); } catch (e) { }
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
  if ($('mygames')) $('mygames').hidden = true;
  if ($('newgame')) $('newgame').hidden = false;
  const backBtn = $('btn-newgame-back');
  if (backBtn) backBtn.textContent = newGameFromPage === 'mygames' ? '← 返回对局' : '← 返回大厅';
  setTopNavActive('');
  try { history.replaceState(null, '', '#new'); } catch (e) { }

  if (prefill) {
    if (prefill.seed != null && /^\d+$/.test(String(prefill.seed))) {
      const givenRadio = document.querySelector('input[name="seedmode"][value="given"]');
      if (givenRadio) givenRadio.checked = true;
      $('seed-input').value = String(prefill.seed);
    }
    if (prefill.roleKey && ROLES[prefill.roleKey]) {
      $('opt-role').value = prefill.roleKey;
      $('opt-role').dispatchEvent(new Event('change'));
    }
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ---------------- wiring ---------------- */
$('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  startGame(null);
});
$('line-send').addEventListener('click', submitLine);
$('line-cancel').addEventListener('click', () => sendBytes([27]));
$('line-input').addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    if (completeLineInput()) { e.preventDefault(); e.stopPropagation(); return; }
  }
  if (e.key === 'Enter') { e.preventDefault(); submitLine(); }
  else if (e.key === 'Escape') { e.preventDefault(); sendBytes([27]); }
  e.stopPropagation();
});
$('line-input').addEventListener('input', () => renderLineSuggestions());

/* ---------------- In-game Per-Game Notepad & Prayer Cooldown Timer ---------------- */
function toggleNotesDrawer(open) {
  const el = $('notes-drawer');
  if (!el) return;
  const want = open == null ? el.hidden : !!open;
  el.hidden = !want;
  if ($('btn-notes')) $('btn-notes').classList.toggle('active', want);
  if (want) {
    toggleGameDrawer(false);
    togglePanel(false);
    toggleMsgLog(false);
    updateNotesPrayStatus();
    if ($('notes-textarea')) $('notes-textarea').focus({ preventScroll: true });
  } else if (document.activeElement === $('notes-textarea')) {
    $('notes-textarea').blur();
  }
}

function loadGameNotes(gameId) {
  const ta = $('notes-textarea');
  if (!ta) return;
  try {
    ta.value = localStorage.getItem('airstring_notes_' + gameId) || '';
  } catch (_) {
    ta.value = '';
  }
  updateNotesPrayStatus();
}

function updateNotesPrayStatus() {
  const el = $('notes-pray-status');
  if (!el) return;
  if (!S || S.lastPrayTurn == null) {
    el.className = 'pray-ok';
    el.textContent = '🙏 祈祷冷却：本局尚未祈祷（安全）';
    return;
  }
  const curT = S.lastFrame ? (S.lastFrame.turn || S.lastFrame.moves || 0) : 0;
  const diff = Math.max(0, curT - S.lastPrayTurn);
  if (diff >= 300) {
    el.className = 'pray-ok';
    el.textContent = `🙏 祈祷已安全（上次 T${S.lastPrayTurn}，已过 ${diff} 回合 ≥ 300）`;
  } else {
    el.className = 'pray-wait';
    el.textContent = `🙏 祈祷冷却中（上次 T${S.lastPrayTurn}，已过 ${diff}/300 回合）`;
  }
}
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
if ($('btn-game-back')) {
  $('btn-game-back').addEventListener('click', () => leaveGame());
}

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

/* Phase 2b Gallery filters, role select, sort, search & +开新局 anchor */
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
if ($('lobby-role-filter')) {
  $('lobby-role-filter').addEventListener('change', () => renderVerifiedGallery());
}
if ($('lobby-sort')) {
  $('lobby-sort').addEventListener('change', () => renderVerifiedGallery());
}
if ($('lobby-search')) {
  $('lobby-search').addEventListener('input', () => renderVerifiedGallery());
}
if ($('btn-open-newgame')) {
  $('btn-open-newgame').addEventListener('click', () => showNewGame(null, 'setup'));
}
if ($('btn-newgame-back')) {
  $('btn-newgame-back').addEventListener('click', () => {
    if (newGameFromPage === 'mygames') showMyGames(false);
    else showSetup();
  });
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
  closeInspectModal();
  stopReplayPlayback();
  if (R) {
    teardownCurrentSession();
    R = null;
  }
  if ($('replay')) $('replay').hidden = true;
  if ($('newgame')) $('newgame').hidden = true;
  if (location.hash && location.hash.startsWith('#replay/')) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
  }
  if (goBack) {
    if (fromPage === 'mygames') {
      showMyGames(false);
    } else {
      $('game').hidden = true;
      if ($('mygames')) $('mygames').hidden = true;
      if ($('newgame')) $('newgame').hidden = true;
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

const BURDEN_ZH = ['正常', '负重', '吃力', '过重', '超载', '动弹不得'];
function hungerLabel(h) {
  if (h == null) return { text: '未知', crit: false };
  if (h < 0) return { text: '昏厥', crit: true };
  if (h < 50) return { text: '虚弱', crit: true };
  if (h < 150) return { text: '饥饿', crit: false };
  if (h > 1000) return { text: '饱足', crit: false };
  return { text: '正常', crit: false };
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
    mk('', `XL:${frameSnap.xl ?? 1}`),
    mk(hpCls, `HP:${hp}/${hpmax}`),
    mk('st-pw', `Pw:${frameSnap.pw ?? 0}/${frameSnap.pwmax ?? 0}`),
    mk('', `AC:${frameSnap.ac ?? 0}`),
    mk('st-gold', `$:${frameSnap.gold ?? 0}`),
    mk('', `背包:${frameSnap.invCount ?? 0}`),
    mk('', `T:${frameSnap.turn ?? 0}`),
  );
  const hl = hungerLabel(frameSnap.hunger);
  if (hl.text !== '正常' && hl.text !== '未知') {
    el.append(mk('st-hunger' + (hl.crit ? ' crit' : ''), hl.text));
  }
  if (frameSnap.burden > 0) {
    el.append(mk('st-hunger' + (frameSnap.burden >= 3 ? ' crit' : ''), BURDEN_ZH[frameSnap.burden] || '负重'));
  }
  if (Array.isArray(frameSnap.cond) && frameSnap.cond.some((v) => v > 0)) {
    el.append(mk('st-hunger crit', '⚠ 异常状态'));
  }
}

function renderReplayHeroCard(frameSnap) {
  const attrsBox = $('rep-hero-attrs');
  const metaBox = $('rep-hero-meta');
  const turnEl = $('rep-hero-turn');
  if (!attrsBox || !metaBox || !frameSnap) return;
  if (turnEl) turnEl.textContent = `T${frameSnap.turn ?? 0}`;

  const names = ['力 Str', '智 Int', '慧 Wis', '敏 Dex', '体 Con', '魅 Cha'];
  const vals = Array.isArray(frameSnap.attrs) && frameSnap.attrs.length >= 6
    ? frameSnap.attrs : ['-', '-', '-', '-', '-', '-'];
  attrsBox.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const cell = document.createElement('div');
    cell.className = 'rep-attr-cell';
    const k = document.createElement('span');
    k.className = 'ak'; k.textContent = names[i].split(' ')[0];
    cell.title = names[i];
    const v = document.createElement('span');
    v.className = 'av'; v.textContent = String(vals[i]);
    cell.append(k, v);
    attrsBox.appendChild(cell);
  }

  metaBox.innerHTML = '';
  const kv = (k, v) => {
    const row = document.createElement('div');
    row.className = 'rep-kv';
    const ks = document.createElement('span');
    ks.className = 'k'; ks.textContent = k;
    const vs = document.createElement('span');
    vs.className = 'v'; vs.textContent = v;
    row.append(ks, vs);
    metaBox.appendChild(row);
  };
  const hl = hungerLabel(frameSnap.hunger);
  const bTxt = BURDEN_ZH[frameSnap.burden || 0] || '正常';
  const hasCond = Array.isArray(frameSnap.cond) && frameSnap.cond.some((v) => v > 0);
  kv('等级 / 经验', `XL ${frameSnap.xl ?? 1}（Exp ${frameSnap.exp ?? 0}）`);
  kv('生命 / 魔力', `HP ${frameSnap.hp ?? 0}/${frameSnap.hpmax ?? 0} · Pw ${frameSnap.pw ?? 0}/${frameSnap.pwmax ?? 0}`);
  kv('护甲 / 金币', `AC ${frameSnap.ac ?? 0} · $${frameSnap.gold ?? 0}`);
  kv('饥饿 / 负重', `${hl.text}${frameSnap.hunger != null ? ` (${frameSnap.hunger})` : ''} · ${bTxt}`);
  kv('背包物品', `${frameSnap.invCount ?? 0} 件（点下方透视详情）`);
  if (frameSnap.luck != null && frameSnap.luck !== 0) kv('幸运值', String(frameSnap.luck));
  if (hasCond) kv('异常状态', '⚠ 存在异常（点透视查明细）');
}

function renderReplayMsgLog() {
  const box = $('rep-msglog');
  const toggle = $('rep-msg-toggle');
  if (!box || !R) return;
  if (toggle) toggle.textContent = R.msgLogOpen ? '日志 ▴' : '日志 ▾';
  box.hidden = !R.msgLogOpen;
  if (!R.msgLogOpen) return;
  const curTurn = (R.frames && R.frames[R.curIdx]) ? (R.frames[R.curIdx].turn || 0) : 0;
  const upto = (R.allMsgs || []).filter((m) => m.turn <= curTurn);
  const slice = upto.slice(-120);
  box.innerHTML = '';
  if (!slice.length) {
    box.innerHTML = '<div class="hint">截至当前回合暂无消息记录。</div>';
    return;
  }
  for (const m of slice) {
    const row = document.createElement('div');
    row.className = 'rep-msglog-row' + (m.turn === curTurn ? ' cur' : '');
    const ts = document.createElement('span');
    ts.className = 'rep-msglog-turn';
    ts.textContent = `T${m.turn}`;
    const txt = document.createElement('span');
    txt.textContent = m.text;
    row.append(ts, txt);
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
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
  renderReplayHeroCard(snap);
  renderReplayMsgLog();

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
  const inspBtn = $('btn-rep-inspect');
  if (inspBtn) {
    inspBtn.disabled = false;
    inspBtn.textContent = `🔍 透视第 ${snap.turn} 回合`;
  }
  const inspSide = $('btn-rep-inspect-side');
  if (inspSide) inspSide.disabled = false;
  const turnLbl = $('rep-comment-turn-label');
  if (turnLbl) {
    turnLbl.textContent = `📍 关联当前第 ${snap.turn} 回合`;
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
  if (g.displayName) kv('玩家', g.displayName);
  kv('角色', `${g.name} · ${roleZh}`);
  kv('种子', `#${g.seed}（${g.seedSource}）`);
  kv('最深层数', g.maxDlvl ? `Dlvl ${g.maxDlvl}` : 'Dlvl 1');
  kv('结局', g.outcome === 'ascended' ? '🏆 飞升' : g.outcome === 'died' ? '💀 阵亡' : '退出/结束');
  if (g.deathReason) kv('战报', g.deathReason);
  if (g.batch) kv('批次', g.batch + (g.provenance ? ` (${g.provenance})` : ''));
  if (g.lineageId) {
    const linSpan = document.createElement('span');
    linSpan.className = 'v';
    linSpan.title = g.lineageId;
    linSpan.textContent = g.lineageId.length > 26
      ? g.lineageId.slice(0, 10) + '…' + g.lineageId.slice(-14)
      : g.lineageId;
    kv('谱系', '', linSpan);
  }
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
  if ($('newgame')) $('newgame').hidden = true;
  if ($('mygames')) $('mygames').hidden = true;
  $('replay').hidden = false;
  setTopNavActive('');
  if (!snapshot) {
    try { history.replaceState(null, '', '#replay/' + encodeURIComponent(gameDoc.gameId)); } catch (e) { }
  }

  const roleZh = (ROLES[gameDoc.roleKey] && ROLES[gameDoc.roleKey].zh) || gameDoc.roleKey;
  $('rep-title').textContent = `${gameDoc.displayName || gameDoc.name} · ${roleZh} · 种子 #${gameDoc.seed}`;
  $('rep-badge').textContent = snapshot ? `进行中 · T${gameDoc.turns}`
    : gameDoc.status === 'pending' ? '⏳ 待验真（本人录像）'
    : gameDoc.outcome === 'ascended' ? '🏆 飞升 · 已验真'
    : gameDoc.outcome === 'died' ? '💀 阵亡 · 已验真'
    : `✓ ${gameDoc.framesMatched} 帧已验真`;
  $('btn-rep-back').textContent = fromPage === 'mygames' ? '← 返回对局' : '← 返回大厅';
  $('btn-rep-share').hidden = !gameDoc.publicRecordingPath;
  $('btn-rep-fork').disabled = true;
  if ($('btn-rep-inspect')) $('btn-rep-inspect').disabled = true;
  if ($('btn-rep-inspect-side')) $('btn-rep-inspect-side').disabled = true;
  if ($('rep-msglog')) $('rep-msglog').hidden = true;
  if ($('rep-msg-toggle')) $('rep-msg-toggle').textContent = '日志 ▾';
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
    isSnapshot: !!snapshot,
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
    pendingMsgs: [],
    allMsgs: [],
    msgLogOpen: false,
    inspectCache: new Map(),
  };
  loadReplayComments(gameDoc, !!snapshot);

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
      const CHUNK = 192;
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
      exportPath: '/dev/null',
      rngPath: '/dev/null',
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
        const clean = String(ev.text).trim();
        if (clean) {
          R.msgs.push(clean);
          if (R.msgs.length > 20) R.msgs.shift();
          R.pendingMsgs.push(clean);
        }
      }
    };
    globalThis.__airstring_frame = (frameText) => {
      if (!R || R.sid !== sid) return;
      const pf = parseFrame(frameText);
      const tVal = pf.turn ?? (R.frames.length + 1);
      if (R.pendingMsgs.length) {
        for (const txt of R.pendingMsgs) {
          R.allMsgs.push({ turn: tVal, text: txt });
        }
        R.pendingMsgs.length = 0;
      }
      const len = R.msgs.length;
      R.frames.push({
        turn: tVal,
        frame: pf.frame ?? R.frames.length,
        hp: pf.hp, hpmax: pf.hpmax, pw: pf.pw, pwmax: pf.pwmax,
        ac: pf.ac, xl: pf.xl, exp: pf.exp, gold: pf.gold,
        hunger: pf.hunger, luck: pf.luck, dnum: pf.dnum,
        dlvl: pf.dlevel, burden: pf.burden,
        attrs: pf.attrs, cond: pf.cond, invCount: pf.invCount,
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

/* ---------------- Read-Only Sandbox Character Inspector (Zero-Fork) ---------------- */
let inspectToken = 0;
let activeSandbox = null; /* { token, turn, alive, onEvent, busy } */
let activeInspectData = null;
let activeInspectTab = 'inv';

function closeInspectModal() {
  inspectToken++;
  if (activeSandbox) {
    activeSandbox.alive = false;
    activeSandbox.onEvent = null;
    if (typeof globalThis.__airstring_close_keys === 'function') {
      try { globalThis.__airstring_close_keys(); } catch (e) { }
    }
    activeSandbox = null;
  }
  const modal = $('rep-inspect-modal');
  if (modal) modal.hidden = true;
}

function isContainerItemText(txt) {
  return /\b(bag of holding|bag of tricks|oilskin sack|sack|chest|large box|ice box)\b/i.test(String(txt || ''));
}

function renderInspectorContent() {
  const box = $('rep-insp-content');
  if (!box || !activeInspectData) return;
  const tabsEl = $('rep-insp-tabs');
  if (tabsEl) {
    for (const b of tabsEl.querySelectorAll('button[data-tab]')) {
      b.classList.toggle('active', b.dataset.tab === activeInspectTab);
    }
  }
  box.innerHTML = '';

  if (activeInspectTab === 'inv') {
    const items = activeInspectData.inv || [];
    if (!items.length) {
      box.innerHTML = '<div class="hint">背包为空或未能读取背包列表。</div>';
      return;
    }
    for (const it of items) {
      const txt = String(it.text || '');
      if (!it.sel && !it.pickable) {
        const hdr = document.createElement('div');
        hdr.className = 'insp-cat';
        hdr.textContent = txt;
        box.appendChild(hdr);
        continue;
      }
      const wrap = document.createElement('div');
      const cls = ['insp-item'];
      if (/\(being worn|\(weapon in hand|\(alternate weapon|\(on (left|right) hand|\(wielded/i.test(txt)) cls.push('worn');
      else if (/\bblessed\b/i.test(txt)) cls.push('blessed');
      else if (/\bcursed\b/i.test(txt)) cls.push('cursed');
      wrap.className = cls.join(' ');

      const row = document.createElement('div');
      row.className = 'insp-item-row';
      const main = document.createElement('div');
      main.className = 'insp-item-main';
      if (it.sel) {
        const sel = document.createElement('span');
        sel.className = 'insp-sel';
        sel.textContent = it.sel + ' -';
        main.appendChild(sel);
      }
      const sp = document.createElement('span');
      sp.className = 'insp-item-txt';
      sp.textContent = txt;
      main.appendChild(sp);
      row.appendChild(main);

      let bagBox = null;
      if (it.sel && isContainerItemText(txt)) {
        const bBtn = document.createElement('button');
        bBtn.type = 'button';
        bBtn.className = 'insp-bag-btn';
        const cachedBag = activeInspectData.bags && activeInspectData.bags[it.sel];
        bBtn.textContent = cachedBag ? '🎒 已展开' : '🎒 查看袋内';
        bagBox = document.createElement('div');
        bagBox.className = 'insp-bag-contents';
        bagBox.hidden = !cachedBag;
        if (cachedBag) fillBagContentsBox(bagBox, cachedBag);

        bBtn.addEventListener('click', async () => {
          if (activeInspectData.bags && activeInspectData.bags[it.sel]) {
            bagBox.hidden = !bagBox.hidden;
            bBtn.textContent = bagBox.hidden ? '🎒 查看袋内' : '🎒 收起袋内';
            return;
          }
          bBtn.disabled = true;
          bBtn.textContent = '读取中…';
          try {
            const res = await peekBagInSandbox(it.sel);
            if (!activeInspectData.bags) activeInspectData.bags = {};
            activeInspectData.bags[it.sel] = res;
            fillBagContentsBox(bagBox, res);
            bagBox.hidden = false;
            bBtn.textContent = '🎒 收起袋内';
          } catch (err) {
            bagBox.hidden = false;
            bagBox.textContent = '读取袋内失败：' + (err && err.message ? err.message : err);
            bBtn.textContent = '🎒 重试';
          } finally {
            bBtn.disabled = false;
          }
        });
        row.appendChild(bBtn);
      }
      wrap.appendChild(row);
      if (bagBox) wrap.appendChild(bagBox);
      box.appendChild(wrap);
    }
    return;
  }

  const lines = activeInspectTab === 'attrs' ? (activeInspectData.attrs || [])
    : activeInspectTab === 'disc' ? (activeInspectData.disc || [])
    : (activeInspectData.overview || []);
  if (!lines.length) {
    box.innerHTML = '<div class="hint">本回合该面板无记录内容。</div>';
    return;
  }
  for (const l of lines) {
    const div = document.createElement('div');
    const txt = String(l.text || '');
    const isHdr = l.hdr || (!txt.startsWith(' ') && txt.endsWith(':'));
    div.className = 'insp-plain-line' + (isHdr ? ' hdr' : '');
    div.textContent = txt || '\u00a0';
    box.appendChild(div);
  }
}

function fillBagContentsBox(el, bagRes) {
  el.innerHTML = '';
  if (bagRes.items && bagRes.items.length) {
    for (const it of bagRes.items) {
      const d = document.createElement('div');
      d.textContent = (it.sel ? `${it.sel} - ` : '') + (it.text || '');
      if (!it.sel && !it.pickable) d.style.color = 'var(--accent)';
      el.appendChild(d);
    }
  } else if (bagRes.messages && bagRes.messages.length) {
    el.textContent = bagRes.messages.join(' / ');
  } else {
    el.textContent = '（袋子为空或无法直接打开）';
  }
}

function runSandboxCmd(sb, bytes, opts = {}) {
  return new Promise((resolve) => {
    const items = [];
    const lines = [];
    const messages = [];
    let settleTimer = null;
    let hardTimer = null;
    let done = false;
    let sawContent = false;
    const seenPages = new Set();

    const finish = () => {
      if (done) return;
      done = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      if (sb.onEvent === handler) sb.onEvent = null;
      resolve({ items, lines, messages });
    };
    const bumpSettle = (ms = 130) => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const q = globalThis.__airstring_key_queue;
        if (q && q.pos < q.bytes.length) { bumpSettle(60); return; }
        finish();
      }, ms);
    };

    const handler = (ev) => {
      if (!sb.alive || done) return;
      if (ev.t === 'menu' && Array.isArray(ev.items)) {
        if (opts.bagMode) {
          const takeOut = ev.items.find((x) => x.sel && /take something out/i.test(x.text || ''));
          if (takeOut && !sawContent) {
            globalThis.__airstring_push_keys([takeOut.sel.charCodeAt(0)]);
            bumpSettle(260);
            return;
          }
        }
        sawContent = true;
        const pKey = `m:${ev.win}:${ev.page}:${ev.pages}:${ev.items.length}`;
        if (!seenPages.has(pKey)) {
          seenPages.add(pKey);
          for (const it of ev.items) items.push(it);
        }
        if (typeof ev.page === 'number' && typeof ev.pages === 'number' && ev.page + 1 < ev.pages) {
          globalThis.__airstring_push_keys([32]); /* space for next page */
          bumpSettle(240);
        } else {
          globalThis.__airstring_push_keys([27]); /* Esc to close menu */
          bumpSettle(120);
        }
      } else if (ev.t === 'text' && Array.isArray(ev.lines)) {
        sawContent = true;
        for (const l of ev.lines) {
          const txt = typeof l === 'string' ? l : (l && l.text) || '';
          const hdr = !!(l && l.attr && l.attr > 0);
          lines.push({ text: txt, hdr });
        }
        globalThis.__airstring_push_keys([32]); /* advance/dismiss text pager */
        bumpSettle(180);
      } else if (ev.t === 'yn') {
        const qText = String(ev.question || '');
        if (opts.bagMode) {
          if (/take something out|look inside/i.test(qText)) {
            globalThis.__airstring_push_keys([121]); /* 'y' */
            bumpSettle(260);
          } else {
            globalThis.__airstring_push_keys([110]); /* 'n' */
            bumpSettle(140);
          }
        } else {
          globalThis.__airstring_push_keys([27]);
          bumpSettle(120);
        }
      } else if (ev.t === 'more') {
        globalThis.__airstring_push_keys([32]);
        bumpSettle(180);
      } else if ((ev.t === 'message' || ev.t === 'raw') && ev.text) {
        const txt = String(ev.text).trim();
        if (txt && txt !== '#') messages.push(txt);
        if (sawContent || opts.bagMode) bumpSettle(160);
      }
    };

    sb.onEvent = handler;
    hardTimer = setTimeout(() => {
      try { globalThis.__airstring_push_keys([27, 27]); } catch (_) { }
      finish();
    }, opts.timeoutMs || 2200);
    globalThis.__airstring_push_keys(bytes);
    bumpSettle(opts.initialWaitMs || 350);
  });
}

async function ensureSandboxAtTurn(targetTurn, myTok) {
  if (activeSandbox && activeSandbox.alive && activeSandbox.turn === targetTurn) {
    return activeSandbox;
  }
  if (activeSandbox) {
    activeSandbox.alive = false;
    activeSandbox.onEvent = null;
    if (typeof globalThis.__airstring_close_keys === 'function') {
      try { globalThis.__airstring_close_keys(); } catch (_) { }
    }
    activeSandbox = null;
  }
  const sliced = R.turns.filter((t) => (t.turn || 0) <= targetTurn);
  const prefixBytes = concatReplayBytes(sliced, null);
  const totalTarget = Math.max(1, sliced.length);

  return new Promise(async (resolve, reject) => {
    const sb = { token: myTok, turn: targetTurn, alive: true, onEvent: null, busy: false, dead: false };
    activeSandbox = sb;
    let framesSeen = 0;
    let pumpStarted = false;
    let settled = false;

    const failDead = () => {
      if (settled) return;
      settled = true;
      sb.alive = false;
      sb.dead = true;
      reject(new Error('GAME_OVER_AT_TURN'));
    };

    function pumpPrefix() {
      let off = 0;
      const CHUNK = 256;
      function step() {
        if (!sb.alive || inspectToken !== myTok) return;
        const q = globalThis.__airstring_key_queue;
        if (q && q.pos < q.bytes.length) { setTimeout(step, 4); return; }
        if (off < prefixBytes.length) {
          const end = Math.min(off + CHUNK, prefixBytes.length);
          globalThis.__airstring_push_keys(prefixBytes.subarray(off, end));
          off = end;
          const pct = Math.min(92, Math.max(5, Math.round((framesSeen / totalTarget) * 90)));
          if ($('rep-insp-bar')) $('rep-insp-bar').style.width = pct + '%';
          if ($('rep-insp-status')) {
            $('rep-insp-status').textContent = `只读沙盒快进中：${framesSeen} / ${totalTarget} 回合（${pct}%）`;
          }
          setTimeout(step, 0);
          return;
        }
        setTimeout(() => {
          if (!sb.alive || inspectToken !== myTok || settled) return;
          const q2 = globalThis.__airstring_key_queue;
          if (q2 && q2.pos < q2.bytes.length) { setTimeout(step, 4); return; }
          settled = true;
          resolve(sb);
        }, 70);
      }
      step();
    }

    globalThis.__airstring_config = {
      seed: String(R.header.seed),
      date: R.header.date || FIXED_DATE,
      options: R.header.options,
      mode: 'async',
      exportPath: '/dev/null',
      rngPath: '/dev/null',
    };
    globalThis.__airstring_key_queue = { bytes: [], pos: 0, closed: false };
    globalThis.__airstring_event = (json) => {
      if (!sb.alive || inspectToken !== myTok) return;
      let ev;
      try { ev = JSON.parse(json); } catch (_) { return; }
      if (ev.t === 'init' && !pumpStarted) {
        pumpStarted = true;
        pumpPrefix();
      } else if (sb.onEvent) {
        sb.onEvent(ev);
      }
    };
    globalThis.__airstring_frame = () => {
      if (!sb.alive || inspectToken !== myTok) return;
      framesSeen++;
    };
    globalThis.__airstring_rngline = () => { };
    globalThis.__airstring_game_over = () => {
      if (inspectToken === myTok) failDead();
    };

    try {
      const { default: createModule } = await import('./nethack.js');
      createModule({ print: () => { }, printErr: () => { } }).catch(() => { });
    } catch (e) {
      if (!settled) { settled = true; reject(e); }
    }
  });
}

async function peekBagInSandbox(letter) {
  if (!R || !activeInspectData) throw new Error('未打开透视会话');
  const myTok = inspectToken;
  const targetTurn = activeInspectData.turn;
  const sb = await ensureSandboxAtTurn(targetTurn, myTok);
  if (inspectToken !== myTok || !sb.alive) throw new Error('透视已取消');
  if (sb.busy) throw new Error('正在执行另一项查询，请稍候');
  sb.busy = true;
  try {
    const res = await runSandboxCmd(sb, [97, letter.charCodeAt(0)], { bagMode: true, timeoutMs: 2500 });
    /* Cleanly exit any lingering bag menu */
    await new Promise((r) => setTimeout(r, 40));
    try { globalThis.__airstring_push_keys([27, 27]); } catch (_) { }
    return res;
  } finally {
    sb.busy = false;
  }
}

async function openReplayInspector() {
  if (!R || R.buffering || !R.frames.length || !R.header) return;
  stopReplayPlayback();
  const snap = R.frames[R.curIdx];
  const targetTurn = snap.turn || (R.curIdx + 1);
  const myTok = ++inspectToken;

  const modal = $('rep-inspect-modal');
  const loading = $('rep-insp-loading');
  const errBox = $('rep-insp-error');
  const body = $('rep-insp-body');
  if (!modal) return;

  $('rep-insp-title').textContent = `🔍 第 ${targetTurn} 回合 · 角色深度透视（只读免分叉）`;
  modal.hidden = false;
  errBox.hidden = true;
  errBox.innerHTML = '';

  const cached = R.inspectCache && R.inspectCache.get(targetTurn);
  if (cached) {
    activeInspectData = cached;
    activeInspectTab = 'inv';
    loading.hidden = true;
    body.hidden = false;
    renderInspectorContent();
    return;
  }

  body.hidden = true;
  loading.hidden = false;
  $('rep-insp-bar').style.width = '4%';
  $('rep-insp-status').textContent = `启动只读沙盒，准备快进至第 ${targetTurn} 回合…`;

  try {
    const sb = await ensureSandboxAtTurn(targetTurn, myTok);
    if (inspectToken !== myTok || !sb.alive) return;

    $('rep-insp-bar').style.width = '94%';
    $('rep-insp-status').textContent = '读取背包 (i)、属性 (^X)、图鉴 (\\) 与地牢总览 (#overview)…';

    const invRes = await runSandboxCmd(sb, [105]);
    if (inspectToken !== myTok) return;
    const attrRes = await runSandboxCmd(sb, [24]);
    if (inspectToken !== myTok) return;
    const discRes = await runSandboxCmd(sb, [92]);
    if (inspectToken !== myTok) return;
    const ovBytes = Array.from('#overview\n').map((c) => c.charCodeAt(0));
    const ovRes = await runSandboxCmd(sb, ovBytes);
    if (inspectToken !== myTok) return;

    const attrLines = attrRes.items.length
      ? attrRes.items.map((x) => ({ text: x.text || '', hdr: !x.sel && String(x.text || '').endsWith(':') }))
      : attrRes.lines;
    const discLines = discRes.lines.length
      ? discRes.lines
      : discRes.items.map((x) => ({ text: (x.sel ? `${x.sel} - ` : '') + (x.text || ''), hdr: !x.sel && !x.pickable }));
    const ovLines = ovRes.lines.length
      ? ovRes.lines
      : ovRes.items.map((x) => ({ text: x.text || '', hdr: !x.sel && !x.pickable }));

    const result = {
      turn: targetTurn,
      inv: invRes.items,
      attrs: attrLines,
      disc: discLines,
      overview: ovLines,
      bags: {},
    };
    R.inspectCache.set(targetTurn, result);
    activeInspectData = result;
    activeInspectTab = 'inv';
    $('rep-insp-bar').style.width = '100%';
    loading.hidden = true;
    body.hidden = false;
    renderInspectorContent();
  } catch (e) {
    if (inspectToken !== myTok) return;
    loading.hidden = true;
    body.hidden = true;
    errBox.hidden = false;
    const isDead = e && e.message === 'GAME_OVER_AT_TURN';
    const p = document.createElement('div');
    p.textContent = isDead
      ? `第 ${targetTurn} 回合已是本局终局/阵亡点，引擎已结束无法再查菜单。可以后退 1 回合查看终局前的完整背包与属性！`
      : `透视失败：${e && e.message ? e.message : e}`;
    errBox.appendChild(p);
    if (isDead && R && R.curIdx > 0) {
      const bPrev = document.createElement('button');
      bPrev.type = 'button';
      bPrev.className = 'mini-btn primary-mini';
      bPrev.textContent = '← 后退 1 回合并重新透视';
      bPrev.addEventListener('click', () => {
        closeInspectModal();
        renderReplayFrame(R.curIdx - 1);
        openReplayInspector();
      });
      errBox.appendChild(bPrev);
    }
  }
}

function forkFromReplay() {
  if (!R || !R.frames.length || !R.header) return;
  closeInspectModal();
  const snap = R.frames[R.curIdx];
  const targetTurn = snap.turn || (R.curIdx + 1);
  const sliced = R.turns.filter((t) => (t.turn || 0) <= targetTurn);
  const forkTurn = sliced.length ? (sliced[sliced.length - 1].turn || sliced.length) : 0;
  const replayBytes = concatReplayBytes(sliced, null);
  const expectedHashes = sliced.map((t) => t.hash);
  const hdr = R.header;
  const parentId = R.game.gameId;
  const fromPage = R.fromPage || 'setup';

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
    returnPage: fromPage,
  });
}

/* ---------------- Phase 2b: Turn-anchored Replay Comments ---------------- */
let replayCommentsCache = [];
let lastCommentSentAt = 0;

function updateReplayCommentAuthUi() {
  const card = $('rep-comments-card');
  const form = $('rep-comment-form');
  const guest = $('rep-comment-guest');
  if (!card || !R) return;
  const isVerifiedPublic = R.game && R.game.status === 'verified' && !R.isSnapshot;
  card.hidden = !isVerifiedPublic;
  if (!isVerifiedPublic) return;
  const user = cloud && cloud.currentUser();
  if (form) form.hidden = !user;
  if (guest) guest.hidden = !!user;
}

function jumpReplayToTurn(targetTurn) {
  if (!R || !R.frames.length || R.buffering) return;
  stopReplayPlayback();
  let bestIdx = 0;
  for (let i = 0; i < R.frames.length; i++) {
    if ((R.frames[i].turn || 0) <= targetTurn) bestIdx = i;
    else break;
  }
  renderReplayFrame(bestIdx);
  const stage = $('rep-stage');
  if (stage) stage.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderReplayComments() {
  const list = $('rep-comments-list');
  const countEl = $('rep-comments-count');
  if (!list) return;
  if (countEl) countEl.textContent = replayCommentsCache.length ? `(${replayCommentsCache.length})` : '';
  if (!replayCommentsCache.length) {
    list.innerHTML = '<div class="hint">暂无留言，来写下第一条带回合锚点的点评吧！</div>';
    return;
  }
  const me = cloud && cloud.currentUser();
  const gameOwnerUid = R && R.game ? R.game.uid : null;
  list.innerHTML = '';
  for (const c of replayCommentsCache) {
    const item = document.createElement('div');
    item.className = 'rep-comment-item';

    const head = document.createElement('div');
    head.className = 'rep-comment-head';

    const left = document.createElement('span');
    left.className = 'rep-comment-author';
    if (c.turn != null && Number.isFinite(c.turn)) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'comment-turn-pill';
      pill.textContent = `T${c.turn}`;
      pill.title = `跳转到第 ${c.turn} 回合`;
      pill.addEventListener('click', () => jumpReplayToTurn(c.turn));
      left.appendChild(pill);
    }
    left.append(document.createTextNode(c.authorName || '冒险者'));

    const right = document.createElement('span');
    right.className = 'rep-comment-meta';
    right.append(document.createTextNode(formatRelativeTime(c.createdAt)));
    if (me && (c.uid === me.uid || (gameOwnerUid && gameOwnerUid === me.uid))) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'card-link-act danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        if (!R || !confirm('确定删除这条留言？')) return;
        try {
          await cloud.deleteReplayComment(R.game.gameId, c.id);
          replayCommentsCache = replayCommentsCache.filter((x) => x.id !== c.id);
          renderReplayComments();
        } catch (err) {
          alert('删除留言失败：' + (err && err.message ? err.message : err));
        }
      });
      right.appendChild(del);
    }

    head.append(left, right);
    const body = document.createElement('div');
    body.className = 'rep-comment-text';
    body.textContent = c.text || '';

    item.append(head, body);
    list.appendChild(item);
  }
}

async function loadReplayComments(gameDoc, isSnapshot) {
  replayCommentsCache = [];
  if (R) R.isSnapshot = !!isSnapshot;
  updateReplayCommentAuthUi();
  const list = $('rep-comments-list');
  const countEl = $('rep-comments-count');
  if (countEl) countEl.textContent = '';
  if (!list || isSnapshot || !gameDoc || gameDoc.status !== 'verified') return;

  const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG;
  const project = cfg && cfg.projectId;
  if (!project || project.startsWith('REPLACE_')) {
    list.innerHTML = '<div class="hint">本地模式暂不支持留言。</div>';
    return;
  }
  list.innerHTML = '<div class="hint">加载留言中…</div>';
  try {
    const url = 'https://firestore.googleapis.com/v1/projects/' +
      encodeURIComponent(project) + '/databases/(default)/documents/games/' +
      encodeURIComponent(gameDoc.gameId) + ':runQuery';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'comments' }],
          orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
          limit: 30,
        },
      }),
    });
    if (!r.ok) {
      if (r.status === 403) {
        list.innerHTML = '<div class="hint">留言区即将开放（等待后端规则审核生效）。</div>';
        return;
      }
      throw new Error('HTTP ' + r.status);
    }
    const rows = await r.json();
    replayCommentsCache = rows
      .filter((x) => x.document && x.document.fields)
      .map((x) => {
        const f = x.document.fields;
        return {
          id: x.document.name.split('/').pop(),
          uid: fsVal(f.uid) || '',
          authorName: fsVal(f.authorName) || '冒险者',
          text: fsVal(f.text) || '',
          turn: fsVal(f.turn),
          createdAt: fsVal(f.createdAt) || '',
        };
      });
    renderReplayComments();
  } catch (e) {
    list.innerHTML = '<div class="hint">留言暂不可用。</div>';
  }
}

/* Top nav & My Games page wiring */
$('nav-lobby').addEventListener('click', () => showSetup());
$('nav-mygames').addEventListener('click', () => showMyGames(false));
$('btn-mygames-new').addEventListener('click', () => showNewGame(null, 'mygames'));
$('btn-mygames-signin').addEventListener('click', () => {
  if (cloud && cloud.signIn) {
    cloud.signIn().catch((e) => {
      alert('Google 登录未完成：' + (e && e.message ? e.message : '请检查弹窗拦截'));
    });
  }
});

/* Replay controls & comment form wiring */
$('btn-rep-back').addEventListener('click', () => closeReplay(true));
$('btn-rep-sameseed').addEventListener('click', () => {
  if (!R || !R.game) return;
  const g = R.game;
  const fromPage = R.fromPage || 'setup';
  closeReplay(false);
  showNewGame({ seed: g.seed, roleKey: g.roleKey }, fromPage);
});
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
$('rep-comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!R || !R.game || !cloudActive()) return;
  const inp = $('rep-comment-input');
  const text = (inp.value || '').trim();
  if (!text) return;
  if (Date.now() - lastCommentSentAt < 5000) {
    alert('发言太快啦，请 5 秒后再试。');
    return;
  }
  const sendBtn = $('btn-rep-comment-send');
  const includeTurn = $('rep-comment-turn-chk') && $('rep-comment-turn-chk').checked;
  const curTurn = (R.frames && R.frames[R.curIdx]) ? (R.frames[R.curIdx].turn || 0) : null;
  if (sendBtn) sendBtn.disabled = true;
  try {
    const created = await cloud.addReplayComment(R.game.gameId, {
      text,
      turn: includeTurn ? curTurn : null,
    });
    lastCommentSentAt = Date.now();
    inp.value = '';
    replayCommentsCache.unshift(created);
    renderReplayComments();
  } catch (err) {
    alert('留言提交失败（若规则刚提交审核请稍后再试）：' + (err && err.message ? err.message : err));
  } finally {
    if (sendBtn) sendBtn.disabled = false;
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
if ($('btn-rep-inspect')) $('btn-rep-inspect').addEventListener('click', () => openReplayInspector());
if ($('btn-rep-inspect-side')) $('btn-rep-inspect-side').addEventListener('click', () => openReplayInspector());
if ($('btn-rep-insp-close')) $('btn-rep-insp-close').addEventListener('click', () => closeInspectModal());
if ($('btn-rep-insp-cancel')) $('btn-rep-insp-cancel').addEventListener('click', () => closeInspectModal());
if ($('rep-insp-backdrop')) $('rep-insp-backdrop').addEventListener('click', () => closeInspectModal());
if ($('rep-insp-tabs')) {
  $('rep-insp-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    activeInspectTab = btn.dataset.tab || 'inv';
    renderInspectorContent();
  });
}
if ($('rep-msg-wrap')) {
  $('rep-msg-wrap').addEventListener('click', () => {
    if (!R) return;
    R.msgLogOpen = !R.msgLogOpen;
    renderReplayMsgLog();
  });
}

/* ---------------- NAO-style Complete Dumplog (Game Over & Replay Theater) ---------------- */
let activeDumplogText = '';
let activeDumplogFilename = 'airstring-dumplog.txt';

function closeDumplogModal() {
  if ($('dumplog-modal')) $('dumplog-modal').hidden = true;
}

function formatDumplogText({ meta, mapRows, insp, recentMsgs }) {
  const hr = '--------------------------------------------------------------------------------';
  const out = [];
  out.push('airstring · NetHack 3.6.7 Dumplog');
  out.push(hr);
  out.push(`Game ID   : ${meta.gameId || '?'}`);
  if (meta.displayName) out.push(`Player    : ${meta.displayName}`);
  out.push(`Options   : ${meta.options || ''}`);
  out.push(`Seed      : ${meta.seed ?? '?'} (${meta.seedSource || 'given'})  Date: ${FIXED_DATE}`);
  out.push(`Turns     : ${meta.turns ?? '?'}   Max Dlvl: ${meta.maxDlvl ?? '?'}   Outcome: ${meta.outcome || 'ended'}`);
  if (meta.deathReason) out.push(`End Note  : ${meta.deathReason}`);
  if (meta.recordingSha256) out.push(`SHA-256   : ${meta.recordingSha256}`);
  if (meta.batch) out.push(`Batch     : ${meta.batch}  Lineage: ${meta.lineageId || '-'}`);
  out.push('');
  if (Array.isArray(mapRows) && mapRows.length) {
    out.push('=== Final Map Screenshot ===');
    for (const r of mapRows) out.push(String(r || ''));
    out.push('');
  }
  if (insp && insp.attrs && insp.attrs.length) {
    out.push('=== Attributes & Status (^X) ===');
    for (const l of insp.attrs) out.push(String(l.text || ''));
    out.push('');
  }
  if (insp && insp.inv && insp.inv.length) {
    out.push('=== Inventory & Equipment (i) ===');
    for (const it of insp.inv) {
      out.push((it.sel ? `${it.sel} - ` : '') + (it.text || ''));
    }
    out.push('');
  }
  if (insp && insp.overview && insp.overview.length) {
    out.push('=== Dungeon Overview (#overview) ===');
    for (const l of insp.overview) out.push(String(l.text || ''));
    out.push('');
  }
  if (insp && insp.disc && insp.disc.length) {
    out.push('=== Discoveries (\\) ===');
    for (const l of insp.disc) out.push(String(l.text || ''));
    out.push('');
  }
  if (Array.isArray(recentMsgs) && recentMsgs.length) {
    out.push('=== Latest Messages ===');
    for (const m of recentMsgs.slice(-40)) out.push(String(m));
    out.push('');
  }
  out.push(hr);
  out.push('Generated by https://airstring.org/ (deterministic WASM verifiable NetHack 3.6.7)');
  return out.join('\n');
}

async function runOneShotDumplogSandbox({ seed, date, options, prefixBytes }) {
  return new Promise(async (resolve, reject) => {
    const sb = { alive: true, onEvent: null };
    let pumpStarted = false;
    let settled = false;
    const stopSb = () => {
      sb.alive = false;
      sb.onEvent = null;
      if (typeof globalThis.__airstring_close_keys === 'function') {
        try { globalThis.__airstring_close_keys(); } catch (_) { }
      }
    };
    const runQueries = async () => {
      try {
        const invRes = await runSandboxCmd(sb, [105]);
        const attrRes = await runSandboxCmd(sb, [24]);
        const discRes = await runSandboxCmd(sb, [92]);
        const ovRes = await runSandboxCmd(sb, Array.from('#overview\n').map((c) => c.charCodeAt(0)));
        stopSb();
        resolve({
          inv: invRes.items,
          attrs: attrRes.items.length
            ? attrRes.items.map((x) => ({ text: x.text || '' }))
            : attrRes.lines,
          disc: discRes.lines.length
            ? discRes.lines
            : discRes.items.map((x) => ({ text: (x.sel ? `${x.sel} - ` : '') + (x.text || '') })),
          overview: ovRes.lines.length
            ? ovRes.lines
            : ovRes.items.map((x) => ({ text: x.text || '' })),
        });
      } catch (e) {
        stopSb();
        reject(e);
      }
    };
    function pump() {
      let off = 0;
      const CHUNK = 256;
      function step() {
        if (!sb.alive) return;
        const q = globalThis.__airstring_key_queue;
        if (q && q.pos < q.bytes.length) { setTimeout(step, 4); return; }
        if (off < prefixBytes.length) {
          const end = Math.min(off + CHUNK, prefixBytes.length);
          globalThis.__airstring_push_keys(prefixBytes.subarray(off, end));
          off = end;
          setTimeout(step, 0);
          return;
        }
        setTimeout(() => {
          if (!sb.alive || settled) return;
          const q2 = globalThis.__airstring_key_queue;
          if (q2 && q2.pos < q2.bytes.length) { setTimeout(step, 4); return; }
          settled = true;
          runQueries();
        }, 70);
      }
      step();
    }
    globalThis.__airstring_config = {
      seed: String(seed), date: date || FIXED_DATE, options,
      mode: 'async', exportPath: '/dev/null', rngPath: '/dev/null',
    };
    globalThis.__airstring_key_queue = { bytes: [], pos: 0, closed: false };
    globalThis.__airstring_event = (json) => {
      if (!sb.alive) return;
      let ev;
      try { ev = JSON.parse(json); } catch (_) { return; }
      if (ev.t === 'init' && !pumpStarted) { pumpStarted = true; pump(); }
      else if (sb.onEvent) sb.onEvent(ev);
    };
    globalThis.__airstring_frame = () => { };
    globalThis.__airstring_rngline = () => { };
    globalThis.__airstring_game_over = () => {
      if (!settled) { settled = true; stopSb(); resolve(null); }
    };
    try {
      const { default: createModule } = await import('./nethack.js');
      createModule({ print: () => { }, printErr: () => { } }).catch(() => { });
    } catch (e) {
      if (!settled) { settled = true; stopSb(); reject(e); }
    }
  });
}

async function openDumplogFromReplay() {
  if (!R || R.buffering || !R.frames.length || !R.header) return;
  stopReplayPlayback();
  closeInspectModal();
  const modal = $('dumplog-modal');
  const loading = $('dumplog-loading');
  const pre = $('dumplog-pre');
  if (!modal || !pre) return;

  const lastSnap = R.frames[R.frames.length - 1];
  const probeIdx = Math.max(0, R.frames.length - 2);
  const probeTurn = R.frames[probeIdx].turn || (probeIdx + 1);
  activeDumplogFilename = `airstring-${R.game.gameId || 'replay'}.dumplog.txt`;
  $('dumplog-title').textContent = `📜 Dumplog · ${R.game.gameId}`;
  modal.hidden = false;
  pre.textContent = '';
  loading.hidden = false;
  $('dumplog-status').textContent = `正在汇总第 ${probeTurn} 回合终局前完整装备/属性/图鉴…`;

  let insp = R.inspectCache && R.inspectCache.get(probeTurn);
  if (!insp) {
    const sliced = R.turns.filter((t) => (t.turn || 0) <= probeTurn);
    const prefixBytes = concatReplayBytes(sliced, null);
    try {
      insp = await runOneShotDumplogSandbox({
        seed: R.header.seed, date: R.header.date, options: R.header.options, prefixBytes,
      });
      if (insp) R.inspectCache.set(probeTurn, { turn: probeTurn, ...insp, bags: {} });
    } catch (_) { insp = null; }
  }
  loading.hidden = true;
  activeDumplogText = formatDumplogText({
    meta: {
      gameId: R.game.gameId,
      displayName: R.game.displayName,
      options: R.header.options,
      seed: R.header.seed,
      seedSource: R.header.seedSource,
      turns: lastSnap.turn,
      maxDlvl: R.game.maxDlvl || lastSnap.dlvl,
      outcome: R.game.outcome || 'ended',
      deathReason: R.game.deathReason,
      recordingSha256: R.game.recordingSha256,
      batch: R.game.batch,
      lineageId: R.game.lineageId,
    },
    mapRows: lastSnap.mapRows,
    insp,
    recentMsgs: (R.allMsgs || []).slice(-40).map((m) => `[T${m.turn}] ${m.text}`),
  });
  pre.textContent = activeDumplogText;
}

async function openDumplogFromGame(sess) {
  if (!sess) return;
  const modal = $('dumplog-modal');
  const loading = $('dumplog-loading');
  const pre = $('dumplog-pre');
  if (!modal || !pre) return;

  const allTurns = (sess.records || []).filter((r) => r && r.k === 'turn');
  const probeCount = Math.max(1, allTurns.length - 1);
  const sliced = allTurns.slice(0, probeCount);
  activeDumplogFilename = `airstring-${sess.id || 'game'}.dumplog.txt`;
  $('dumplog-title').textContent = `📜 Dumplog · ${sess.id}`;
  modal.hidden = false;
  pre.textContent = '';
  loading.hidden = false;
  $('dumplog-status').textContent = `正在只读沙盒中生成完整终局 Dumplog（共 ${allTurns.length} 回合）…`;

  let insp = null;
  if (sliced.length) {
    try {
      insp = await runOneShotDumplogSandbox({
        seed: sess.seed, date: sess.date, options: sess.options,
        prefixBytes: concatReplayBytes(sliced, null),
      });
    } catch (_) { insp = null; }
  }
  loading.hidden = true;
  activeDumplogText = formatDumplogText({
    meta: {
      gameId: sess.id,
      options: sess.options,
      seed: sess.seed,
      seedSource: sess.seedSource,
      turns: sess.lastFrame ? sess.lastFrame.turn : allTurns.length,
      maxDlvl: sess.lastFrame ? sess.lastFrame.dlevel : 1,
      outcome: 'ended',
    },
    mapRows: sess.mapRows,
    insp,
    recentMsgs: (sess.messages || []).slice(-40),
  });
  pre.textContent = activeDumplogText;
}

/* Veteran UI controls wiring (notepad, terminal themes, font scale, danger guard, Dumplog) */
if ($('btn-notes')) $('btn-notes').addEventListener('click', () => toggleNotesDrawer());
if ($('notes-close')) $('notes-close').addEventListener('click', () => toggleNotesDrawer(false));
if ($('notes-textarea')) {
  $('notes-textarea').addEventListener('input', (e) => {
    if (!S) return;
    try { localStorage.setItem('airstring_notes_' + S.id, e.target.value); } catch (_) { }
  });
}
if ($('btn-notes-stamp')) {
  $('btn-notes-stamp').addEventListener('click', () => {
    const ta = $('notes-textarea');
    if (!ta || !S) return;
    const dlvl = S.lastFrame ? (S.lastFrame.dlevel ?? 1) : 1;
    const turn = S.lastFrame ? (S.lastFrame.turn ?? 0) : 0;
    const prefix = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
    ta.value += `${prefix}[Dlvl:${dlvl} T:${turn}] `;
    try { localStorage.setItem('airstring_notes_' + S.id, ta.value); } catch (_) { }
    ta.focus();
  });
}
if ($('term-theme-select')) {
  $('term-theme-select').addEventListener('change', (e) => {
    termTheme = e.target.value || 'nao';
    try { localStorage.setItem('airstring_term_theme', termTheme); } catch (_) { }
    applyTerminalPrefs();
  });
}
if ($('btn-font-dec')) {
  $('btn-font-dec').addEventListener('click', () => {
    termFontScale = Math.max(75, termFontScale - 5);
    try { localStorage.setItem('airstring_font_scale', String(termFontScale)); } catch (_) { }
    applyTerminalPrefs();
    renderGrid();
  });
}
if ($('btn-font-inc')) {
  $('btn-font-inc').addEventListener('click', () => {
    termFontScale = Math.min(140, termFontScale + 5);
    try { localStorage.setItem('airstring_font_scale', String(termFontScale)); } catch (_) { }
    applyTerminalPrefs();
    renderGrid();
  });
}
if ($('opt-danger-guard')) {
  $('opt-danger-guard').addEventListener('change', (e) => {
    dangerGuardEnabled = !!e.target.checked;
    try { localStorage.setItem('airstring_danger_guard', dangerGuardEnabled ? '1' : '0'); } catch (_) { }
    if (!dangerGuardEnabled) clearDangerShield();
  });
}
if ($('btn-danger-dismiss')) $('btn-danger-dismiss').addEventListener('click', () => clearDangerShield());
if ($('btn-rep-dumplog')) $('btn-rep-dumplog').addEventListener('click', () => openDumplogFromReplay());
if ($('btn-dumplog-close')) $('btn-dumplog-close').addEventListener('click', () => closeDumplogModal());
if ($('dumplog-backdrop')) $('dumplog-backdrop').addEventListener('click', () => closeDumplogModal());
if ($('btn-dumplog-copy')) {
  $('btn-dumplog-copy').addEventListener('click', () => {
    if (!activeDumplogText) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(activeDumplogText).then(() => {
        const b = $('btn-dumplog-copy');
        b.textContent = '✓ 已复制';
        setTimeout(() => { b.textContent = '📋 复制'; }, 1800);
      });
    }
  });
}
if ($('btn-dumplog-download')) {
  $('btn-dumplog-download').addEventListener('click', () => {
    if (!activeDumplogText) return;
    const blob = new Blob([activeDumplogText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = activeDumplogFilename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

document.addEventListener('keydown', (e) => {
  if (!R || $('replay').hidden) return;
  if ($('dumplog-modal') && !$('dumplog-modal').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeDumplogModal(); }
    return;
  }
  const inspOpen = $('rep-inspect-modal') && !$('rep-inspect-modal').hidden;
  if (inspOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeInspectModal();
    }
    return;
  }
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

/* Deep links: #replay/<gameId>, #mygames, and #new */
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
    return;
  }
  if (h === '#new') {
    if ($('newgame') && $('newgame').hidden) showNewGame(null, 'setup');
    return;
  }
}
window.addEventListener('hashchange', checkRouteHash);

/* after a tap, drop focus from the button so a following Space /
   Enter keypress is a game key, not a second button activation */
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#game button');
  if (b) b.blur();
});

applyTerminalPrefs();
fillSetupForm();
loadSavedVetOptions();
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


