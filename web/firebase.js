/* airstring cloud transport (Firebase Auth + Firestore + Storage).
 *
 * Loaded lazily by web/airstring.js. When the config in
 * web/firebase-config.js is still placeholder -- or the SDK cannot
 * be loaded (offline, blocked CDN) -- this module's default export
 * is null and the frontend degrades gracefully to guest/offline mode.
 *
 * When configured, it provides:
 *   currentUser()            -> signed-in user or null
 *   isAuthReady()            -> whether initial onAuthStateChanged fired
 *   onUserChange(cb)         -> subscribe to auth changes (returns unsub)
 *   signIn()                 -> Google sign-in popup
 *   signOut()                -> sign out
 *   renderAuthBox()          -> Google sign-in/out UI in #auth-box
 *   loadActiveIndex()        -> reads saves/<uid>/_index.json
 *   loadActiveGame(gameId)   -> reads saves/<uid>/<gameId>.json
 *   saveActiveGame(snapshot) -> single-file overwrite saves/<uid>/<gameId>.json
 *                               + updates saves/<uid>/_index.json
 *                               (zero orphan chunk-*.json files)
 *   deleteActiveGame(gameId) -> removes active game & updates _index.json
 *   finalizeGame(info)       -> canonical recordings/<uid>/<gameId>.jsonl
 *                               + /games/<gameId> doc (pending)
 *                               + auto-trigger Cloud Run /verify
 *                               + cleans up active game slot
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
    let authReady = false;
    const listeners = new Set();
    let indexCache = null;
    let indexCacheUid = null;

    async function readJsonObject(path) {
      try {
        const buf = await stMod.getBytes(stMod.ref(storage, path));
        const text = new TextDecoder().decode(buf);
        const parsed = JSON.parse(text);
        if (parsed && parsed.deleted) return null;
        return parsed;
      } catch (e) {
        const code = e && e.code ? String(e.code) : '';
        if (code === 'storage/object-not-found' || code === 'storage/unauthorized') {
          return null;
        }
        throw e;
      }
    }

    async function writeJsonObject(path, obj) {
      await stMod.uploadString(
        stMod.ref(storage, path),
        JSON.stringify(obj),
        'raw',
        { contentType: 'application/json' },
      );
    }

    async function getActiveIndexInternal(forceReload) {
      if (!user) return { version: 1, games: {} };
      if (!forceReload && indexCache && indexCacheUid === user.uid) {
        return indexCache;
      }
      const data = await readJsonObject('saves/' + user.uid + '/_index.json');
      const idx = (data && typeof data.games === 'object' && data.games)
        ? { version: 1, games: { ...data.games } }
        : { version: 1, games: {} };
      indexCache = idx;
      indexCacheUid = user.uid;
      return idx;
    }

    async function putActiveIndexInternal(idx) {
      if (!user) return;
      indexCache = idx;
      indexCacheUid = user.uid;
      await writeJsonObject('saves/' + user.uid + '/_index.json', idx);
    }

    async function signIn() {
      const provider = new authMod.GoogleAuthProvider();
      return authMod.signInWithPopup(auth, provider);
    }

    async function signOut() {
      indexCache = null;
      indexCacheUid = null;
      return authMod.signOut(auth);
    }

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
        btn.addEventListener('click', () => signOut());
        box.append(label, document.createTextNode(' '), btn);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '使用 Google 登录（云端续打与上榜）';
        btn.addEventListener('click', () => signIn().catch((e) => {
          console.warn('[airstring] sign-in failed:', e && e.message || e);
        }));
        box.appendChild(btn);
      }
    }

    authMod.onAuthStateChanged(auth, (u) => {
      const prevUid = user ? user.uid : null;
      user = u;
      authReady = true;
      if (!u || u.uid !== prevUid) {
        indexCache = null;
        indexCacheUid = null;
      }
      renderAuthBox();
      for (const cb of listeners) {
        try { cb(u); } catch (e) { console.warn('[airstring] auth listener err:', e); }
      }
    });

    cloud = {
      currentUser: () => user,
      isAuthReady: () => authReady,
      onUserChange(cb) {
        listeners.add(cb);
        if (authReady) {
          try { cb(user); } catch (e) { /* ignore */ }
        }
        return () => listeners.delete(cb);
      },
      signIn,
      signOut,
      renderAuthBox,

      /* Legacy chunk upload retained for compatibility only */
      async uploadChunk(payload) {
        if (!user) throw new Error('not-signed-in');
        const ref = stMod.ref(storage,
          'recordings/' + user.uid + '/' + payload.gameId +
          '/chunk-' + payload.seq + '.json');
        await stMod.uploadString(ref, JSON.stringify(payload),
          'raw', { contentType: 'application/json' });
      },

      async loadActiveIndex(forceReload = false) {
        if (!user) return { version: 1, games: {} };
        return getActiveIndexInternal(forceReload);
      },

      async loadActiveGame(gameId) {
        if (!user) return null;
        return readJsonObject('saves/' + user.uid + '/' + gameId + '.json');
      },

      async saveActiveGame(snapshot) {
        if (!user) throw new Error('not-signed-in');
        const uid = user.uid;
        await writeJsonObject('saves/' + uid + '/' + snapshot.gameId + '.json', snapshot);
        const idx = await getActiveIndexInternal(false);
        idx.games[snapshot.gameId] = {
          gameId: snapshot.gameId,
          seed: snapshot.seed,
          seedSource: snapshot.seedSource,
          options: snapshot.options,
          playerName: snapshot.playerName || 'fleck',
          roleEn: snapshot.roleEn || 'valkyrie',
          turns: snapshot.turns || 0,
          dlvl: snapshot.dlvl || 1,
          hp: snapshot.hp != null ? snapshot.hp : null,
          hpmax: snapshot.hpmax != null ? snapshot.hpmax : null,
          startedAt: snapshot.startedAt || null,
          updatedAt: snapshot.updatedAt || new Date().toISOString(),
          sessionId: snapshot.sessionId || null,
          parentGameId: snapshot.parentGameId || null,
          forkTurn: snapshot.forkTurn != null ? snapshot.forkTurn : null,
        };
        await putActiveIndexInternal(idx);
      },

      async deleteActiveGame(gameId) {
        if (!user) return;
        const uid = user.uid;
        const objRef = stMod.ref(storage, 'saves/' + uid + '/' + gameId + '.json');
        try {
          await stMod.deleteObject(objRef);
        } catch (e) {
          /* Under S6 storage.rules where write requires request.resource.size,
             deleteObject returns unauthorized; tombstone with 16-byte payload instead. */
          try {
            await writeJsonObject('saves/' + uid + '/' + gameId + '.json', { deleted: true });
          } catch (_) { /* best-effort */ }
        }
        try {
          const idx = await getActiveIndexInternal(false);
          if (idx.games && idx.games[gameId]) {
            delete idx.games[gameId];
            await putActiveIndexInternal(idx);
          }
        } catch (_) { /* best-effort */ }
      },

      /* canonical recording + the games index doc (pending) + auto-verify */
      async finalizeGame(info) {
        if (!user) throw new Error('not-signed-in');
        const recRef = stMod.ref(storage,
          'recordings/' + user.uid + '/' + info.gameId + '.jsonl');
        await stMod.uploadString(recRef, info.recordingText,
          'raw', { contentType: 'application/x-ndjson' });
        const docData = {
          gameId: info.gameId,
          uid: user.uid,
          seed: info.seed,
          seedSource: info.seedSource,
          date: info.date,
          options: info.options,
          restored: null,
          status: 'pending',
          end: info.end,
          turns: info.turns,
          frames: info.frames,
          keysTotal: info.keysTotal,
          createdAt: fsMod.serverTimestamp(),
        };
        if (info.parentGameId) {
          docData.parentGameId = info.parentGameId;
          docData.forkTurn = info.forkTurn != null ? info.forkTurn : 0;
        }
        await fsMod.setDoc(fsMod.doc(db, 'games', info.gameId), docData);

        /* Clean up active slot once finalized */
        try { await cloud.deleteActiveGame(info.gameId); } catch (_) { }

        /* Auto-trigger verification */
        try {
          const vurl = globalThis.AIRSTRING_VERIFIER_URL;
          if (vurl) {
            const token = await user.getIdToken();
            const resp = await fetch(vurl + '/verify', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer ' + token,
              },
              body: JSON.stringify({
                storagePath: 'recordings/' + user.uid + '/' +
                  info.gameId + '.jsonl',
              }),
            });
            console.info('[airstring] verify trigger:', resp.status);
          }
        } catch (e) {
          console.warn('[airstring] verify trigger failed:',
            e && e.message || e);
        }
      },
    };
    renderAuthBox();
  }
} catch (e) {
  console.warn('[airstring] firebase inactive:', e && e.message || e);
  cloud = null;
}

export default cloud;
