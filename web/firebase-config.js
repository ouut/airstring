/* airstring Firebase web config (S6).
 *
 * Loaded by web/index.html BEFORE the frontend module. Values are
 * those of the Web App registered in the Firebase console for
 * project `airstring-nethack` (filled in 2026-11-19 from the
 * console registration). These values are NOT secrets (Firebase
 * web config is a public client identifier; access control lives
 * in firestore.rules / storage.rules), so they are committed.
 * If apiKey/appId ever revert to placeholders, web/firebase.js
 * detects that, stays inactive, and the frontend keeps the S5
 * local-stub upload behaviour exactly.
 */
globalThis.AIRSTRING_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBKVMl2QVXyvkdwpTxSPQJ8_f8RZIGRw3E',
  authDomain: 'airstring-nethack.firebaseapp.com',
  projectId: 'airstring-nethack',
  storageBucket: 'airstring-nethack.firebasestorage.app',
  messagingSenderId: '39704157599',
  appId: '1:39704157599:web:26fb071acd56ed5e42f1aa',
  measurementId: 'G-XKFXWLSHS6',
};
