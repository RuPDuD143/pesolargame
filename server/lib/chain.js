// functions/lib/chain.js
// Read-only get_table_rows / get_account wrapper. Node 20 has global fetch,
// no extra dependency needed for this file.

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://wax.greymass.com';
const CONTRACT_NAME = process.env.CONTRACT_NAME || 'pesolargame1';

// Plain fetch() has no default timeout in Node - if the RPC endpoint
// stalls (slow, overloaded, or blocking this server's IP specifically,
// which can differ from what a browser sees), the caller just hangs
// forever with nothing to catch and nothing to log. This wraps every
// chain call so it fails loudly after RPC_TIMEOUT_MS instead, since a
// clear timeout error is far easier to diagnose than an indefinitely
// pending request (e.g. verifyLoginAndMintToken never resolving).
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS) || 8000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Chain RPC timed out after ${RPC_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getTableRow({ code, table, scope, key }) {
  const res = await fetchWithTimeout(`${RPC_ENDPOINT}/v1/chain/get_table_rows`, {
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

// throwPickaxe checks location eligibility (energy_max tier) on every
// single strike, which would otherwise mean one chain RPC call per click.
// Short TTL cache - a worker's on-chain energy_max only ever changes via
// a real re-registration transfer, so a few seconds of staleness here is
// harmless, and this is NOT used for anything security-critical beyond
// "which caves can you currently swing a pickaxe in."
const WORKER_CACHE_TTL_MS = 30000;
const workerCache = new Map(); // accountName -> { row, expiresAt }

async function getContractWorkerCached(accountName) {
  const cached = workerCache.get(accountName);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  const row = await getContractWorker(accountName);
  workerCache.set(accountName, { row, expiresAt: Date.now() + WORKER_CACHE_TTL_MS });
  return row;
}

/**
 * Fetches an account's permissions (used to verify a login signature -
 * we need the account's real active-permission public key(s) from the
 * chain, never trust a client-supplied key).
 */
async function getAccount(accountName) {
  const res = await fetchWithTimeout(`${RPC_ENDPOINT}/v1/chain/get_account`, {
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
  const res = await fetchWithTimeout(`${RPC_ENDPOINT}/v1/chain/get_abi`, {
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
  getContractWorkerCached,
  getTableRow,
  getAccount,
  getPermissionKeys,
  getAbi,
  CONTRACT_NAME,
  RPC_ENDPOINT
};
