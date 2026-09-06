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

import { SessionKit } from 'https://esm.sh/@wharfkit/session@1?bundle';
import { WalletPluginAnchor } from 'https://esm.sh/@wharfkit/wallet-plugin-anchor@1?bundle';
import { WalletPluginCloudWallet } from 'https://esm.sh/@wharfkit/wallet-plugin-cloudwallet@1?bundle';
import { WalletPluginWombat } from 'https://esm.sh/@wharfkit/wallet-plugin-wombat@1?bundle';
import { WebRenderer } from 'https://esm.sh/@wharfkit/web-renderer@1?bundle';

import { CONFIG, auth, functions, httpsCallable, signInWithCustomToken } from './firebase-config.js';

const sessionKit = new SessionKit({
  appName: 'Pesolar Mine',
  chains: [{ id: CONFIG.CHAIN_ID, url: CONFIG.RPC_ENDPOINT }],
  ui: new WebRenderer(),
  walletPlugins: [new WalletPluginAnchor(), new WalletPluginCloudWallet(), new WalletPluginWombat()]
});

const requestNonce = httpsCallable(functions, 'requestNonce');
const verifyLoginAndMintToken = httpsCallable(functions, 'verifyLoginAndMintToken');

let activeSession = null;

export async function restoreSession() {
  const session = await sessionKit.restore();
  if (session) {
    activeSession = session;
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
  const { data: nonceData } = await requestNonce({ account });

  // Sign a harmless no-op transaction embedding the nonce, without
  // broadcasting it to the chain - this only proves key ownership.
  const result = await session.transact(
    {
      action: {
        account: 'greymassnoop',
        name: 'noop',
        authorization: [session.permissionLevel],
        data: { data: nonceData.nonce }
      }
    },
    { broadcast: false }
  );

  // NOTE: the exact shape of `result` (where the resolved transaction JSON
  // and signature strings live) depends on the WharfKit version - verify
  // against current docs. This assumes result.resolved.transaction gives
  // a plain-object transaction and result.signatures is an array of
  // signature strings.
  const { customToken } = (
    await verifyLoginAndMintToken({
      account,
      nonce: nonceData.nonce,
      transaction: result.resolved.transaction,
      signatures: result.signatures.map(String),
      chainId: CONFIG.CHAIN_ID
    })
  ).data;

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
