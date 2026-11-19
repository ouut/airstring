/* airstring Firebase web config (S6).
 *
 * Loaded by web/index.html BEFORE the frontend module. The values
 * below are PLACEHOLDERS: replace them with the config of the Web
 * App registered in the Firebase console for project
 * `airstring-nethack`:
 *
 *   console.firebase.google.com/project/airstring-nethack
 *     -> Project settings (gear icon) -> General -> Your apps
 *     -> Web app (</>) -> register "airstring web" -> firebaseConfig
 *
 * These values are NOT secrets (Firebase web config is a public
 * client identifier; access control lives in firestore.rules /
 * storage.rules), so the real values may be committed. Until
 * apiKey/appId are replaced, web/firebase.js detects the
 * placeholders, stays inactive, and the frontend keeps the S5
 * local-stub upload behaviour exactly.
 */
globalThis.AIRSTRING_FIREBASE_CONFIG = {
  apiKey: 'REPLACE_WITH_WEB_API_KEY',
  // Defaults derived from the project id; confirm against the
  // console values when registering the app. Newer projects use
  // <project>.firebasestorage.app as the storage bucket.
  authDomain: 'airstring-nethack.firebaseapp.com',
  projectId: 'airstring-nethack',
  storageBucket: 'airstring-nethack.firebasestorage.app',
  messagingSenderId: 'REPLACE_WITH_SENDER_ID',
  appId: 'REPLACE_WITH_APP_ID',
};
