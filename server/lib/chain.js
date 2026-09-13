// functions/lib/chain.js
// Read-only get_table_rows / get_account wrapper. Node 20 has global fetch,
// no extra dependency needed for this file.

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://wax.greymass.com';
const CONTRACT_NAME = process.env.CONTRACT_NAME || 'pesolargame1';

async function getTableRow({ code, table, scope, key }) {
  const res = await fetch(`${RPC_ENDPOINT}/v1/chain/get_table_rows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      json: true,
      code,
      scope: scope || code,
      table,
      lower_bound: key,
      upper_bound: key,
      limit: 1
    })
  });
  if (!res.ok) throw new Error(`Chain RPC error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.rows && data.rows.length > 0 ? data.rows[0] : null;
}

/** Row shape per your contract spec: { name, energy_max } */
async function getContractWorker(accountName) {
  return getTableRow({ code: CONTRACT_NAME, table: 'workers', scope: CONTRACT_NAME, key: accountName });
}

// Singleton row on the contract holding the live game economy (this is
// what "resources" actually means on-chain - votes/other contract
// actions change it, and Firestore's sysdata/main.resources is meant to
// mirror it, not be hand-edited forever). Per the contract's ABI: table
// "sysdata", row type "sysdata_row" = { treasury: int64 } - a bare
// single-field struct with no primary_key() visible in the ABI, which is
// exactly what eosio::singleton<"sysdata"_n, sysdata_row> looks like from
// the outside (the template supplies primary_key() itself). If that's
// what this contract uses, the row's real primary key on-chain isn't 0 -
// it's the name "sysdata" encoded as a uint64 (14389162870375972864,
// computed by the same base32 packing eosio.cdt's name.hpp uses).
//
// getContractSysdata() tries, in order: an explicit CONTRACT_SYSDATA_KEY
// env var if set, then plain key 0, then the singleton-encoded key -
// returning whichever first finds a row. That first-match key is logged,
// so once you see it succeed in the logs (or via GET /debugSysdata) you
// can pin it down permanently with CONTRACT_SYSDATA_KEY and skip the
// extra RPC round-trips going forward.
const SYSDATA_TABLE = process.env.CONTRACT_SYSDATA_TABLE || 'sysdata';
const SYSDATA_SCOPE = process.env.CONTRACT_SYSDATA_SCOPE || CONTRACT_NAME;
const SYSDATA_SINGLETON_KEY = '14389162870375972864'; // name("sysdata").value
const SYSDATA_KEY_CANDIDATES = process.env.CONTRACT_SYSDATA_KEY
  ? [process.env.CONTRACT_SYSDATA_KEY]
  : [0, SYSDATA_SINGLETON_KEY];

/** Row shape per the contract's ABI: { treasury: int64 }. */
async function getContractSysdata() {
  for (const key of SYSDATA_KEY_CANDIDATES) {
    const row = await getTableRow({ code: CONTRACT_NAME, table: SYSDATA_TABLE, scope: SYSDATA_SCOPE, key });
    if (row) {
      if (SYSDATA_KEY_CANDIDATES.length > 1) {
        console.log(`getContractSysdata: found the row at key=${key} - set CONTRACT_SYSDATA_KEY=${key} to skip the other candidate next time`);
      }
      return row;
    }
  }
  return null;
}

/**
 * Fetches an account's permissions (used to verify a login signature -
 * we need the account's real active-permission public key(s) from the
 * chain, never trust a client-supplied key).
 */
async function getAccount(accountName) {
  const res = await fetch(`${RPC_ENDPOINT}/v1/chain/get_account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_name: accountName })
  });
  if (!res.ok) throw new Error(`Chain RPC error ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Returns the list of public keys authorized on a given permission (e.g. 'active'). */
async function getPermissionKeys(accountName, permissionName = 'active') {
  const account = await getAccount(accountName);
  const perm = (account.permissions || []).find((p) => p.perm_name === permissionName);
  if (!perm) return [];
  return (perm.required_auth.keys || []).map((k) => k.key);
}

async function getAbi(accountName) {
  const res = await fetch(`${RPC_ENDPOINT}/v1/chain/get_abi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_name: accountName })
  });
  if (!res.ok) throw new Error(`Chain RPC error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.abi;
}

module.exports = {
  getContractWorker,
  getContractSysdata,
  getTableRow,
  getAccount,
  getPermissionKeys,
  getAbi,
  CONTRACT_NAME,
  RPC_ENDPOINT,
  SYSDATA_TABLE,
  SYSDATA_SCOPE,
  SYSDATA_KEY_CANDIDATES
};
