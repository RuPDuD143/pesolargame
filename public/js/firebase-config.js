// public/js/firebase-config.js
//
// TODO: paste your real config from Firebase Console -> Project settings
// -> General -> Your apps -> SDK setup and configuration.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAuth, signInWithCustomToken } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'TODO',
  authDomain: 'TODO.firebaseapp.com',
  projectId: 'TODO',
  storageBucket: 'TODO.appspot.com',
  messagingSenderId: 'TODO',
  appId: 'TODO'
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);
export { httpsCallable, signInWithCustomToken };

export const CONFIG = {
  CHAIN_ID: '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea25',
  RPC_ENDPOINT: 'https://wax.greymass.com',
  CONTRACT_NAME: 'pesolargame1',
  WAX_TOKEN_CONTRACT: 'eosio.token',
  REGISTER_COST_WAX: '100.00000000 WAX',
  PESOLAR_TOKEN_CONTRACT: 'TODO_pesolar_token_contract',
  REGISTER_COST_PESOLAR: '10000.0000 PESOLAR',
  REGISTER_MEMO: 'register'
};
