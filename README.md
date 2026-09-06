# Pesolar Mine — free-tier rewrite (no Blaze plan needed)

> **See GAME_SPEC.md for the full design doc** (original spec + current
> implementation status). Keep it updated when the design changes - it's
> the actual persistence mechanism across chat sessions, since Claude
> doesn't remember past conversations.

This is the same game as the Cloud Functions version, with one change:
**the backend no longer runs on Firebase Cloud Functions / Cloud Tasks**
(both require the paid Blaze plan to deploy at all, even at $0 actual
cost). Instead:

- **Firebase Hosting + Firestore + Authentication** — unchanged, and all
  free on the default Spark plan.
- **`server/`** — a plain always-on Node/Express server that does what
  `functions/index.js` used to do, talking to the same Firestore project
  via the Admin SDK. Deploy it for free on Render (or Fly.io, Railway,
  etc. — any host that runs a long-lived Node process for free).
- **Node respawns** are handled by a 1-second poll loop in that server
  (`server/lib/respawn-sweep.js`) instead of Cloud Tasks. See the
  comment in that file for why this is fine on an always-on server even
  though it wouldn't have been reliable on serverless Cloud Functions.

Nothing about the game logic, Firestore data model, or security model
changed — only where the backend code physically runs.

## Setup walkthrough

1. **Create the Firebase project** — same as before: console.firebase.google.com
   → Add project → register a web app → keep the `firebaseConfig`
   snippet handy.
2. **Turn on Firestore and Authentication** — same as before (Build →
   Firestore Database → Create database, Start in production mode;
   Build → Authentication → Get started). Both are free on Spark.
3. **Create the `sysdata/main` Firestore doc by hand** — same as before:
   collection `sysdata`, document `main`, fields `resources` (Number,
   e.g. 1000000) and `minedResources` (Number, 0).
4. **Get your service account key** — same as before: Project settings
   → Service accounts → Generate new private key. You'll paste this
   JSON into two places now: a GitHub secret (step 7) *and* Render's
   dashboard (step 6) — same file, two destinations, never committed to
   the repo itself.
5. **Fill in `public/js/firebase-config.js`** — same as before: replace
   the `TODO` fields with your real config values. Leave
   `API_BASE_URL: 'TODO'` for now — you'll fill that in after step 6.
6. **Deploy the backend server to Render (free, no card required)**
   - Push this folder to GitHub first if you haven't (see step 7 below —
     you can do that step before this one if it's easier).
   - Go to render.com, sign up/sign in (GitHub sign-in is easiest),
     click **New +** → **Web Service**, connect your GitHub repo.
   - Set **Root Directory** to `server`.
   - **Runtime**: Node. **Build Command**: `npm install`. **Start
     Command**: `npm start`. **Instance Type**: Free.
   - Under **Environment**, add these variables:
     - `FIREBASE_SERVICE_ACCOUNT_JSON` — paste the *entire contents* of
       the .json file from step 4, as-is.
     - `ALLOWED_ORIGIN` — you can leave this unset for now (defaults to
       `*`); tighten it to `https://YOUR-PROJECT-ID.web.app` once the
       game is live.
   - Click **Create Web Service**. Wait for the first deploy to finish
     (a few minutes) — Render gives you a URL like
     `https://pesolar-backend.onrender.com`.
   - Go back to `public/js/firebase-config.js` and set `API_BASE_URL` to
     that exact URL (no trailing slash).
   - **Note:** Render's free tier spins the service down after ~15
     minutes of no traffic and takes 30-60 seconds to wake back up on
     the next request — fine for a personal/hobby game, just expect a
     slow first load after idle periods.
7. **Upload the folder to GitHub using GitHub Desktop** — identical to
   before: Add local repository → Commit → Publish repository.
8. **Add the one GitHub Secret Firebase Hosting still needs, then seed
   the world**
   - On github.com, open your repo → Settings → Secrets and variables →
     Actions → New repository secret: name it `FIREBASE_SERVICE_ACCOUNT`,
     value = the same .json contents from step 4. Add a second secret,
     `FIREBASE_PROJECT_ID`, with your Project ID.
   - Click the **Actions** tab — a "Deploy to Firebase" run should
     already be going; wait for the green checkmark (this one only
     deploys Firestore rules + Hosting, both free).
   - Open `https://YOUR-BACKEND-ON-RENDER.onrender.com/seedLocations`
     in a browser tab and press enter — it should say "ok".
   - Finally, open `https://YOUR-PROJECT-ID.web.app` to see the game
     live.

Local dev: `npm install -g firebase-tools`, `firebase emulators:start`
for Firestore/Hosting/Auth, and separately `cd server && npm install &&
npm start` (with a local `.env` — see `server/.env.example`, note
Render reads env vars from its dashboard, not a committed file) for the
backend.

## What's still not built

House/furniture editor, the marketplace UI, and server-tracked player
movement (the 200px throw clamp still trusts client-reported
`charX/charY` — unchanged from the Cloud Functions version).

## Files

```
.gitignore, .firebaserc.example
.github/workflows/deploy.yml   — deploys Firestore rules + Hosting only (free, Spark plan)
firebase.json, firestore.rules, firestore.indexes.json
server/                        — always-on Express backend (deploy to Render, not Firebase)
  .env.example                 — shape of the env vars Render needs
  index.js                     — all backend routes (was functions/index.js)
  lib/energy.js                — unchanged regen math
  lib/ore-types.js              — unchanged value/strikes table
  lib/ore-config.js             — unchanged locations/tiers/spawn grid
  lib/ore-asset-ids.js          — TODO: real asset_id values
  lib/chain.js                  — read-only WAX RPC (get_table_rows, get_account, get_abi)
  lib/nonces.js                 — login-proof nonce storage
  lib/verify-signature.js       — WAX signature verification
  lib/node-manager.js           — Firestore-backed spawn/strike logic
  lib/respawn-sweep.js          — replaces Cloud Tasks: polls for depleted nodes past their respawn time
public/
  index.html, mining.html, css/style.css
  js/firebase-config.js         — TODO: your real Firebase config + Render backend URL
  js/wallet.js                  — WharfKit + login-proof signing (now calls the REST backend)
  js/app.js                     — worker status/registration/wake UI (now calls the REST backend)
  js/mining.js                  — Firestore-listener mining client (now calls the REST backend)
```
