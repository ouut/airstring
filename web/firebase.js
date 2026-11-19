/* airstring S6 cloud transport (Firebase).
 *
 * Loaded lazily by web/airstring.js. When the config in
 * web/firebase-config.js is still placeholder -- or the SDK cannot
 * be loaded (offline, blocked CDN) -- this module's default export
 * is null and the frontend keeps the S5 behaviour byte-for-byte:
 * chunked POSTs to the local stub at ./upload.
 *
 * When configured, it provides:
 *   currentUser()          -> the signed-in user or null
 *   uploadChunk(payload)   -> one recording chunk object in
 *                             Storage (recordings/<uid>/<gameId>/
 *                             chunk-<seq>.json; seq-named, so a
 *                             retry overwrites the same object --
 *                             the idempotent-upload口径 of
 *                             docs/recording-format.md SS3)
 *   finalizeGame(info)     -> the canonical recordings/<uid>/
 *                             <gameId>.jsonl in Storage plus the
 *                             /games/<gameId> doc in Firestore
 *                             (status 'pending'; verdict fields are
 *                             verifier-only, see firestore.rules)
 *   renderAuthBox(el)      -> Google sign-in/out UI in #auth-box
 *
 * Auth is Google-only (spec SS4.1 OAuth-only). Playing is NOT
 * gated on sign-in: a signed-out session simply keeps using the
 * local stub transport, exactly as in S5.
 */
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const LOAD_TIMEOUT_MS = 8000;

function isConfigured(cfg) {
  return !!cfg && typeof cfg.apiKey === 'string' &&
    !cfg.apiKey.startsWith('REPLACE_') &&
    typeof cfg.appId === 'string' &&
    !cfg.appId.startsWith('REPLACE_');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' timeout')), ms)),
  ]);
}

let cloud = null;
try {
  const cfg = globalThis.AIRSTRING_FIREBASE_CONFIG;
  if (isConfigured(cfg)) {
    const load = (name) =>
      withTimeout(import(SDK + name), LOAD_TIMEOUT_MS, name);
    const [appMod, authMod, fsMod, stMod] = await Promise.all([
      load('firebase-app.js'),
      load('firebase-auth.js'),
      load('firebase-firestore.js'),
      load('firebase-storage.js'),
    ]);
    const app = appMod.initializeApp(cfg);
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);
    const storage = stMod.getStorage(app);

    let user = null;
    const userWaiters = [];
    authMod.onAuthStateChanged(auth, (u) => {
      user = u;
      renderAuthBox();
      for (const cb of userWaiters.splice(0)) cb(u);
    });

    function renderAuthBox() {
      const box = document.getElementById('auth-box');
      if (!box) return;
      box.innerHTML = '';
      if (user) {
        const label = document.createElement('span');
        label.className = 'auth-user';
        label.textContent = '已登录：' +
          (user.displayName || user.email || user.uid);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '登出';
        btn.addEventListener('click', () => authMod.signOut(auth));
        box.append(label, document.createTextNode(' '), btn);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '使用 Google 登录（成绩上云）';
        btn.addEventListener('click', async () => {
          const provider = new authMod.GoogleAuthProvider();
          await authMod.signInWithPopup(auth, provider);
        });
        box.appendChild(btn);
      }
    }

    cloud = {
      currentUser: () => user,
      renderAuthBox,

      /* one chunk object per flush, named by seq (idempotent) */
      async uploadChunk(payload) {
        if (!user) throw new Error('not-signed-in');
        const ref = stMod.ref(storage,
          'recordings/' + user.uid + '/' + payload.gameId +
          '/chunk-' + payload.seq + '.json');
        await stMod.uploadString(ref, JSON.stringify(payload),
          'raw', { contentType: 'application/json' });
      },

      /* canonical recording + the games index doc (pending) */
      async finalizeGame(info) {
        if (!user) throw new Error('not-signed-in');
        const recRef = stMod.ref(storage,
          'recordings/' + user.uid + '/' + info.gameId + '.jsonl');
        await stMod.uploadString(recRef, info.recordingText,
          'raw', { contentType: 'application/x-ndjson' });
        await fsMod.setDoc(fsMod.doc(db, 'games', info.gameId), {
          gameId: info.gameId,
          uid: user.uid,
          seed: info.seed,
          seedSource: info.seedSource,
          date: info.date,
          options: info.options,
          restored: info.restored,
          status: 'pending',
          end: info.end,
          turns: info.turns,
          frames: info.frames,
          keysTotal: info.keysTotal,
          createdAt: fsMod.serverTimestamp(),
        });
      },
    };
    renderAuthBox();
  }
} catch (e) {
  /* SDK unreachable or misconfigured: stay on the S5 stub path.
   * Logged, not fatal -- the game itself never depends on this. */
  console.warn('[airstring] firebase inactive:', e && e.message || e);
  cloud = null;
}

export default cloud;
