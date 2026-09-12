// public/js/wallet.js
//
// Same WharfKit setup as before (still CDN-loaded for zero build step -
// pin versions and self-host before going live, same caveat as last time:
// double-check these exact package names/versions against WharfKit's
// current docs, this library moves fast).
//
// NEW in this version: after wallet login, we don't just trust the
// account name the wallet reports - we run a signature-proof round trip
// against Cloud Functions (requestNonce -> sign a no-op transaction ->
// verifyLoginAndMintToken) and sign into Firebase Auth with the result.
// Every other Cloud Function then checks request.auth.uid, which Firebase
// itself guarantees wasn't forged. This is untested against a live wallet
// from here - test the actual signing prompt end-to-end before shipping.

// No `?bundle` here on purpose: that param makes esm.sh inline each
// package's own private copy of its dependencies instead of letting them
// share one. All five of these packages depend on @wharfkit/antelope, so
// with ?bundle each one got its own separate copy - same class, different
// module instance - which is exactly what triggers wharfkit's own "alien
// instance of bytes/logo... more than one version of @wharfkit/antelope"
// runtime check (instanceof fails across the duplicate copies). Dropping
// ?bundle lets esm.sh resolve @wharfkit/antelope to one shared module for
// the whole page, so instanceof checks between these packages agree again.
import { SessionKit } from 'https://esm.sh/@wharfkit/session@1';
import { WalletPluginAnchor } from 'https://esm.sh/@wharfkit/wallet-plugin-anchor@1';
import { WalletPluginCloudWallet } from 'https://esm.sh/@wharfkit/wallet-plugin-cloudwallet@1';
import { WalletPluginWombat } from 'https://esm.sh/@wharfkit/wallet-plugin-wombat@1';
import { WebRenderer } from 'https://esm.sh/@wharfkit/web-renderer@1';

import { CONFIG, auth, apiFetch, signInWithCustomToken } from './firebase-config.js?v=9';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

// Firebase Auth persists its own session (IndexedDB, default persistence)
// and silently refreshes ID tokens on its own - it doesn't need us to
// mint a new custom token on every page load. onAuthStateChanged() fires
// once, synchronously-ish, with whatever session Firebase already
// restored from disk, before we've done anything.
let firebaseRestorePromise = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => {
    unsub();
    resolve(user);
  });
});

const sessionKit = new SessionKit({
  appName: 'Pesolar Mine',
  chains: [{ id: CONFIG.CHAIN_ID, url: CONFIG.RPC_ENDPOINT }],
  ui: new WebRenderer(),
  walletPlugins: [new WalletPluginAnchor(), new WalletPluginCloudWallet(), new WalletPluginWombat()]
});

let activeSession = null;

export async function restoreSession() {
  const session = await sessionKit.restore();
  if (session) {
    activeSession = session;
    const account = String(session.actor);

    // Skip the greymassnoop::noop signing prompt entirely if Firebase
    // already has a live session for this exact WAX account - that's the
    // whole point of Firebase Auth persisting login across reloads. We
    // only need a fresh signature when there's no session yet (first
    // login ever, cleared browser storage, explicit logout, or switching
    // to a different WAX account than the one Firebase has on file).
    const existingUser = await firebaseRestorePromise;
    if (existingUser && existingUser.uid === account) {
      return session;
    }

    await proveIdentityToFirebase(session);
  }
  return session;
}

export async function login() {
  const { session } = await sessionKit.login();
  activeSession = session;
  await proveIdentityToFirebase(session);
  return session;
}

export async function logout() {
  if (activeSession) await sessionKit.logout(activeSession);
  activeSession = null;
  await auth.signOut();
}

export function getSession() {
  return activeSession;
}

export function getAccountName() {
  return activeSession ? String(activeSession.actor) : null;
}

/**
 * The login-proof round trip. After this resolves, auth.currentUser.uid
 * === the WAX account name, and Cloud Functions can trust request.auth.
 */
async function proveIdentityToFirebase(session) {
  const account = String(session.actor);
  const { nonce } = await apiFetch('/requestNonce', { method: 'POST', body: { account } });

  // Sign a harmless no-op transaction embedding the nonce, without
  // broadcasting it to the chain - this only proves key ownership.
  const result = await session.transact(
    {
      action: {
        account: 'greymassnoop',
        name: 'noop',
        authorization: [session.permissionLevel],
        data: { data: nonce }
      }
    },
    { broadcast: false }
  );

  // NOTE: the exact shape of `result` (where the resolved transaction JSON
  // and signature strings live) depends on the WharfKit version - verify
  // against current docs. This assumes result.resolved.transaction gives
  // a plain-object transaction and result.signatures is an array of
  // signature strings.
  const { customToken } = await apiFetch('/verifyLoginAndMintToken', {
    method: 'POST',
    body: {
      account,
      nonce,
      transaction: result.resolved.transaction,
      signatures: result.signatures.map(String),
      chainId: CONFIG.CHAIN_ID
    }
  });

  await signInWithCustomToken(auth, customToken);
}

export async function sendRegistrationTransfer({ tokenContract, quantity, memo }) {
  if (!activeSession) throw new Error('Not logged in');
  return activeSession.transact({
    action: {
      account: tokenContract,
      name: 'transfer',
      authorization: [activeSession.permissionLevel],
      data: { from: activeSession.actor, to: CONFIG.CONTRACT_NAME, quantity, memo }
    }
  });
}
