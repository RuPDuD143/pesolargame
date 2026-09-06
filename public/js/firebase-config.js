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
  appId: "1:835487257937:web:b1fcf57ff9753afa46af70"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export { signInWithCustomToken };

export const CONFIG = {
  CHAIN_ID: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea25',
  RPC_ENDPOINT: 'https://wax.greymass.com',
  CONTRACT_NAME: 'pesolargame1',
  WAX_TOKEN_CONTRACT: 'eosio.token',
  REGISTER_COST_WAX: '100.00000000 WAX',
  PESOLAR_TOKEN_CONTRACT: 'pesolargame1',
  REGISTER_COST_PESOLAR: '10000.0000 PESOLAR',
  REGISTER_MEMO: 'register',
  // TODO: the URL Render gives you after deploying the server/ folder
  // there, e.g. 'https://pesolar-backend.onrender.com' (no trailing slash)
  API_BASE_URL: 'https://pesolargame.onrender.com'
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
