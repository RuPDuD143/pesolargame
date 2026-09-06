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
  getTableRow,
  getAccount,
  getPermissionKeys,
  getAbi,
  CONTRACT_NAME,
  RPC_ENDPOINT
};
