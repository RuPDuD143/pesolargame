// functions/lib/verify-signature.js
//
// THE GAP THIS CLOSES:
// Cloud Functions are called with a client-claimed `account` string.
// Nothing stopped a modified client from calling e.g. wakeWorker with
// someone else's account name. This module proves the caller actually
// holds a private key authorized on that WAX account, using the same
// "sign a harmless no-op transaction" pattern Anchor/WharfKit use for
// login proofs (the `greymassnoop::noop` action exists on WAX/EOS
// specifically for this - it does nothing on-chain and this signature
// is never broadcast, only checked locally against the digest).
//
// Flow:
//   1. requestNonce(account)      -> server hands out a random nonce
//   2. client signs a transaction: greymassnoop::noop { data: nonce },
//      authorized by `account`, with session.transact({..., broadcast:false})
//   3. verifyLogin(account, nonce, transaction, signatures)
//        - recompute the signing digest ourselves (never trust a
//          client-supplied digest)
//        - recover the public key from each signature
//        - check that key is actually authorized on `account`'s active
//          permission on-chain right now
//        - check the signed data really is our nonce, and it's unused
//
// CAVEAT: this uses @wharfkit/antelope for serialization/signature
// recovery. That package's exact API surface moves between versions -
// pin a version in functions/package.json and confirm these calls
// (Signature.recoverDigest, Serializer.encode, Checksum256.hash)
// against its current docs before relying on this in production. The
// digest algorithm itself (sha256 of chain_id + packed_trx + zeroed
// context-free digest) is the stable, spec-level part and won't change.

const { Serializer, Signature, Checksum256, ABI, Bytes, Transaction, PublicKey } = require('@wharfkit/antelope');
const chain = require('./chain');
const { issueNonce, consumeNonce } = require('./nonces');

const NOOP_CONTRACT = 'greymassnoop';
const NOOP_ACTION = 'noop';

async function requestLoginNonce(db, account) {
  return issueNonce(db, account);
}

/**
 * @param {object} params
 * @param {string} params.account - claimed WAX account name
 * @param {string} params.nonce - nonce previously issued to this account
 * @param {object} params.transaction - the unsigned transaction object the client built and signed (JSON, antelope Transaction shape)
 * @param {string[]} params.signatures - signature strings returned by the wallet
 * @param {string} params.chainId - chain id the client signed against
 * @returns {Promise<void>} resolves if verified, throws otherwise
 */
async function verifyLogin(db, { account, nonce, transaction, signatures, chainId }) {
  if (!account || !nonce || !transaction || !signatures || !signatures.length) {
    throw new Error('missing_fields');
  }

  // 1. The nonce must be one we issued to this account, unused, unexpired.
  await consumeNonce(db, account, nonce);

  // 2. The transaction must be exactly the harmless noop we expect - not
  //    something with a real action (e.g. a token transfer) smuggled in.
  if (!transaction.actions || transaction.actions.length !== 1) {
    throw new Error('unexpected_transaction_shape');
  }
  const action = transaction.actions[0];
  if (action.account !== NOOP_CONTRACT || action.name !== NOOP_ACTION) {
    throw new Error('unexpected_action');
  }
  const authorizedAsClaimedAccount = (action.authorization || []).some((a) => a.actor === account);
  if (!authorizedAsClaimedAccount) {
    throw new Error('authorization_does_not_match_claimed_account');
  }
  if (action.data && action.data.data && action.data.data !== nonce) {
    throw new Error('nonce_not_embedded_in_signed_data');
  }

  // 3. Recompute the signing digest ourselves - never trust a client-sent digest.
  //    Verified against @wharfkit/antelope@1.2.0: Transaction.from(data, abi)
  //    resolves action.data against the ABI's struct definitions, then
  //    Serializer.encode({object: trx}) packs it exactly as the chain would.
  const abiJson = await chain.getAbi(NOOP_CONTRACT);
  const abi = ABI.from(abiJson);
  const trx = Transaction.from(transaction, abi);
  const packedTrx = Serializer.encode({ object: trx });

  const zeroDigest = Checksum256.from(new Uint8Array(32));
  const digestInput = Bytes.from(chainId, 'hex').appending(packedTrx).appending(zeroDigest.array);
  const digest = Checksum256.hash(digestInput);

  // 4. Recover the signing key from each signature and confirm it's
  //    really authorized on this account's active permission right now.
  const authorizedKeyStrings = await chain.getPermissionKeys(account, 'active');
  if (!authorizedKeyStrings.length) throw new Error('account_has_no_active_permission');
  const authorizedKeys = authorizedKeyStrings.map((k) => PublicKey.from(k));

  let matched = false;
  for (const sigStr of signatures) {
    const sig = Signature.from(sigStr);
    const recoveredKey = sig.recoverDigest(digest);
    if (authorizedKeys.some((k) => k.equals(recoveredKey))) {
      matched = true;
      break;
    }
  }

  if (!matched) throw new Error('signature_does_not_match_account_key');
}

module.exports = { requestLoginNonce, verifyLogin, NOOP_CONTRACT, NOOP_ACTION };
