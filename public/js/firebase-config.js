// public/js/firebase-config.js
//
// TODO: paste your real config from Firebase Console -> Project settings
// -> General -> Your apps -> SDK setup and configuration.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAuth, signInWithCustomToken } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyDrJSgCNjAx7eE263tQDwpi5rkYXl-L_Os",
  authDomain: "pesolargame.firebaseapp.com",
  projectId: "pesolargame",
  storageBucket: "pesolargame.firebasestorage.app",
  messagingSenderId: "835487257937",
  appId: "1:835487257937:web:b1fcf57ff9753afa46af70",
  databaseURL: "https://pesolargame-default-rtdb.firebaseio.com/"
};

// Fails loudly and immediately if this file ever gets deployed with the
// placeholder still in place, instead of letting it surface later as a
// cryptic "auth/api-key-not-valid" 400 from signInWithCustomToken deep in
// the login flow. If you hit this, it means whatever's actually being
// served isn't this file - check you deployed the latest public/ and that
// nothing (CDN, browser, service worker) is caching an older copy.
if (!firebaseConfig.apiKey || firebaseConfig.apiKey === 'TODO') {
  throw new Error('firebase-config.js: apiKey is missing/placeholder - paste your real config from the Firebase Console.');
}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export { signInWithCustomToken };

export const CONFIG = {
  CHAIN_ID: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4',
  RPC_ENDPOINT: 'https://wax.greymass.com',
  CONTRACT_NAME: 'pesolargame1',
  WAX_TOKEN_CONTRACT: 'eosio.token',
  REGISTER_COST_WAX: '100.00000000 WAX',
  PESOLAR_TOKEN_CONTRACT: 'pesolargame1',
  // PESOLAR is a 6-decimal token on-chain (symbol "PESOLAR,6") - the
  // contract asserts on the exact string "10000.000000 PESOLAR". This used
  // to be '10000.0000 PESOLAR' (4 decimals), which the contract rejects.
  REGISTER_COST_PESOLAR: '10000.000000 PESOLAR',
  // The contract's on_notify handler checks the memo verbatim per token,
  // not a single generic string - see the "register::wax" / "register::pesolar"
  // asserts baked into pesolar.wasm.
  REGISTER_MEMO_WAX: 'register::wax',
  REGISTER_MEMO_PESOLAR: 'register::pesolar',
  // TODO: the URL Render gives you after deploying the server/ folder
  // there, e.g. 'https://pesolar-backend.onrender.com' (no trailing slash)
  API_BASE_URL: 'rupdud143.github.io'
};

/**
 * Small fetch wrapper for the backend server (see server/index.js),
 * replacing the old Cloud Functions httpsCallable(). Pass
 * authRequired:true for any endpoint that used to check request.auth -
 * it attaches the signed-in user's Firebase ID token, which the server
 * verifies with the Admin SDK.
 */
export async function apiFetch(path, { method = 'GET', body, authRequired = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authRequired) {
    if (!auth.currentUser) throw new Error('not_authenticated');
    headers.Authorization = `Bearer ${await auth.currentUser.getIdToken()}`;
  }
  const res = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request_failed_${res.status}`);
  return data;
}
