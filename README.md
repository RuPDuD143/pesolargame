# Pesolar Mine — Firebase rewrite (auth + mining slices)

This replaces the earlier Express/Postgres/Socket.io version with:
- **Cloud Functions** (`functions/`) instead of an Express server
- **Firestore** instead of Postgres — `workers/{account}`, `sysdata/main`, `locations/{id}/nodes/{id}`, `locations/{id}/throws/{id}`
- **Firestore `onSnapshot` listeners** instead of Socket.io for real-time mining sync
- **A real WAX signature login proof**, closing the gap flagged in the last round: Cloud Functions used to trust a client-supplied `account` string with nothing backing it. Now:
  1. `requestNonce` hands the client a one-time nonce
  2. the client signs a harmless `greymassnoop::noop` transaction embedding it (never broadcast to chain — this is the standard Anchor/WharfKit login-proof pattern)
  3. `verifyLoginAndMintToken` recomputes the signing digest itself, recovers the public key from the signature, and checks that key is *actually* authorized on the account's active permission on-chain right now, before minting a Firebase custom token
  4. every other function checks `request.auth.uid`, which Firebase guarantees wasn't forged
- I unit-tested the crypto core of that flow against the real `@wharfkit/antelope@1.2.0` library in this session (digest construction, `Transaction.from(data, abi)` + `Serializer.encode`, and `PublicKey.equals()` for legacy/`PUB_K1_` key format handling all round-trip correctly with a generated keypair). The wallet-side call in `wallet.js` (`session.transact(..., {broadcast:false})`) is **not** tested end-to-end against a live wallet from here — verify the shape of `result.resolved.transaction` / `result.signatures` against a real Anchor/Wombat popup before shipping.

## Uploading this to GitHub

The zip is ready to go except for one file that only you can fill in (your Firebase project's config values, which don't exist until you create the project) and a couple of one-time clicks in the Firebase/Google Cloud consoles that I can't do on your behalf. `node_modules` is already excluded and `.gitignore` is already set up so you don't accidentally commit secrets later.

**See the step-by-step walkthrough for the exact click path** — this section is just the reference summary.

- `.firebaserc.example` is optional — only needed if you want to run `firebase emulators:start` locally. The GitHub Actions deploy doesn't need it (it passes `--project` explicitly using a secret).
- `functions/.env.example` is optional too — every value in it already has a working default baked into the code.
- The one file you must edit: `public/js/firebase-config.js` — paste in your real Firebase config object (from Project settings in the Firebase console) and it just works.

## Setup

Fill in `public/js/firebase-config.js` with your real Firebase project config, then:
- Create the Firestore doc `sysdata/main` manually once, with `{ resources: <int>, minedResources: 0 }`
- Create a Cloud Tasks queue named `pesolar-respawns` in region `us-central1` (needed for the 5s node-respawn delay — see `functions/lib/respawn-tasks.js` for why a bare `setTimeout` doesn't work reliably on serverless)
- After first deploy, visit the `seedLocations` URL once in your browser to populate mining nodes for all 6 locations (it's a plain HTTP endpoint now, not a callable — just paste the URL and hit enter)

Local dev: `npm install -g firebase-tools`, then `firebase emulators:start` from the project root.

## Deploying via GitHub Actions (closing the loop on your secrets question)

`.github/workflows/deploy.yml` is already wired up to deploy on every push to `main`. Your `pesolargame1` private key still never touches this repo or these functions — player actions are signed client-side by the player's own wallet, and this backend never calls `payoutearn` or anything requiring your contract's key in this slice. What the workflow *does* need is two repo secrets:

1. **`FIREBASE_SERVICE_ACCOUNT`** — Firebase console → Project settings → Service accounts → Generate new private key. Paste the entire downloaded JSON as the secret value.
2. **`FIREBASE_PROJECT_ID`** — your Firebase project id (not sensitive, but a secret is the easiest place to put it; a repo "Variable" instead of "Secret" would also work fine).

Add both under GitHub repo → Settings → Secrets and variables → Actions → New repository secret. Once both exist, push to `main` and the Actions tab will show the deploy running. This is exactly the "GitHub Secret feeds a GitHub Actions job" pattern from before — no always-on server needed since Cloud Functions/Hosting are what actually run your app.

## What's still not built

House/furniture editor, the marketplace UI, and server-tracked player movement (the 200px throw clamp still trusts client-reported `charX/charY` — same gap as the Socket.io version, now just living in `throwPickaxe` instead of the socket handler).

## Files

```
.gitignore, .firebaserc.example
.github/workflows/deploy.yml
firebase.json, firestore.rules, firestore.indexes.json
functions/
  .env.example              — TODO: copy to .env, fill in real values
  index.js                 — all Cloud Functions
  lib/energy.js             — unchanged regen math
  lib/ore-types.js           — unchanged value/strikes table
  lib/ore-config.js          — unchanged locations/tiers/spawn grid
  lib/ore-asset-ids.js       — TODO: real asset_id values
  lib/chain.js               — read-only WAX RPC (get_table_rows, get_account, get_abi)
  lib/nonces.js              — login-proof nonce storage
  lib/verify-signature.js    — WAX signature verification (tested crypto core)
  lib/node-manager.js        — Firestore-backed spawn/strike logic
  lib/respawn-tasks.js       — Cloud Tasks scheduling for delayed respawns
public/
  index.html, mining.html, css/style.css
  js/firebase-config.js      — TODO: your real Firebase project config
  js/wallet.js               — WharfKit + login-proof signing
  js/app.js                  — worker status/registration/wake UI
  js/mining.js                — Firestore-listener mining client
```
