// public/js/mining.js
//
// Refactored from a page-owned top-level script into a mountable module:
// mountMine() takes the canvas/toast elements and options instead of
// grabbing #canvas/#toast/#account/#location/#join off the page at import
// time. That's what lets index.html's enterWorld() embed the same cave
// rendering that mining.html used to be the only place you could see -
// previously enterWorld() was a placeholder <p> and never touched this
// file at all, so nobody ever saw the mine from the normal login flow.
//
// Same Firestore listener approach as before (onSnapshot() on the nodes
// collection). New in this pass:
// - spectator ("guest") mode now only disables mining - guests still get
//   a visible, movable character, camera follow, walls/collision, and
//   walkway travel like anyone else. Previously all of that was gated
//   behind `!spectator` too, which is why guests never saw a character
//   spawn at all - that was a bug, not intentional.
// - destroy()/setLocation() so callers can tear down or switch caves
//   without leaking listeners or stacking requestAnimationFrame loops.
// - zoomed-in camera that eases toward the character instead of showing
//   the whole 2000x2000 room flat on the canvas at all times (see ZOOM /
//   camera below). Node progress is now a "3/375"-style readout instead
//   of just a bar, since a bar alone made high-tier nodes look stuck.
// - real walkways between caves (LOCATION_EXITS below) replace the old
//   "Cave:" dropdown entirely: each cave is a link in a 0-1-2-3-4-5
//   chain, and walking through the gap in the east/west wall calls the
//   same connect() the dropdown used to, via onLocationChange so the UI
//   can show which cave you're in without polling. Cave 0 additionally
//   keeps a standalone locked "Cave Exit" walkway on its own wall.
// - mining a node out costs 1 energy server-side (see server/index.js's
//   /mineNode and node-manager.js's strikeNodeTx - only the hit that
//   actually depletes the node costs anything) - onEnergyChange lets the
//   caller keep an energy bar in sync without polling for it.
// - mining is no longer spam-click-a-throw-per-hit. Clicking an in-range
//   node (see MINING_RANGE - in-range nodes get a dashed outline) starts
//   a mining session: the character plants and a pickaxe orbits it,
//   landing one hit per orbit (see ORBIT_PERIOD_MS). The node's displayed
//   HP is predicted client-side the instant each hit lands rather than
//   waiting on a server round trip - spam-clicking used to feel laggy
//   for exactly that reason. Only one server call actually happens per
//   session, when it finishes (or is cancelled - clicking again or
//   pressing Escape while mining does that), carrying however many hits
//   landed; the server independently clamps that count against how much
//   real time the session has actually been open (see /startMining and
//   /mineNode in server/index.js) rather than trusting it outright.
//
// Movement/anti-cheat caveat from before still applies: charX/charY are
// still client-reported, not server-tracked - unchanged in this slice.
//
// This pass:
// - other players' orbits are now visible. The server publicly broadcasts
//   "account X is mining node Y from position (charX,charY)" on
//   /startMining and clears it on /mineNode (server/lib/mining-session.js,
//   locations/{id}/miningActivity/{account}) - connect() below subscribes
//   to that collection and drawOtherMiners() renders a dim ghost character
//   plus their swing for each entry. There's still no general
//   player-position sync in this codebase, so someone merely walking
//   around remains invisible to you - only someone actively mining shows
//   up, since that's the only thing broadcast.
// - the pickaxe no longer just orbits tight around the character - it
//   winds up, then swings out along the line toward the node and strikes
//   its edge (with a brief impact flash) before resetting, via
//   computeSwingPose()/drawPickaxeAt() - shared by both our own swing and
//   every other broadcast account's, so they read the same way.
// - "Validating..." replaces the node's HP number the instant a
//   prediction hits zero (or a cancel/snipe triggers finalizeMining with
//   hits pending), instead of the old flash back to the pre-mine count
//   while the session's one /mineNode call is in flight. It's driven by
//   the same public broadcast's `validating` flag, so anyone watching the
//   node sees it - not just whoever's swing triggered it - which is what
//   makes two people mining the same node simultaneously legible: if
//   someone else's batch finishes it first, node-manager.js's
//   strikeNodeTx now reports back who (`already_depleted`/`wonBy`), and
//   the loser gets a "beat you to it" toast instead of nothing happening.
//   The nodes listener also proactively cancels our own swing the same
//   way if we're sniped mid-orbit rather than after our own count hits
//   zero (see connect()'s nodesRef handler).
//
// This pass:
// - general player-position sync: someone merely walking around is now
//   visible too, not just someone actively mining. This lives in the
//   Realtime Database, not Firestore (see database.rules.json) - a
//   several-times-a-second position feed doesn't fit Firestore's Spark-
//   plan per-operation daily quota (a single continuously-moving player
//   could burn the whole app's daily write budget in ~2 hours), whereas
//   RTDB's Spark tier is metered by connections/bandwidth instead, which
//   is exactly this workload. It's also written straight from the client
//   (not through server/index.js) - there's no anti-cheat reason it
//   needs a server round trip, since charX/charY are already untrusted,
//   client-reported data everywhere else in this file too (see the
//   movement/anti-cheat caveat above). Each account's node lives under
//   an opaque push() key rather than the account name itself - RTDB
//   keys can't contain '.', which WAX account names commonly do (see
//   armPresenceForCurrentLocation() and database.rules.json). connect()
//   below subscribes to presence/{locationId} the same way it already
//   does for
//   miningActivity, and drawOtherPlayers() renders a ghost for each
//   entry; an account that's also actively mining is skipped there and
//   left entirely to drawOtherMiners(), so it isn't drawn twice.
//   sendPresenceIfNeeded() still throttles how often we actually write
//   (PRESENCE_MIN_SEND_INTERVAL_MS moving / PRESENCE_IDLE_RESEND_MS
//   idle) - not because RTDB bills per write, but to keep bandwidth and
//   the on-screen motion reasonable. Cleanup uses RTDB's onDisconnect(),
//   which the client registers on its own presence node the moment it
//   (re)connects (see the `.info/connected` listener near the bottom of
//   mountMine()) - the database itself removes that node the instant the
//   socket drops, no heartbeat-staleness guessing game required.
// - other players' node HP now actually ticks down while you watch them
//   mine, instead of sitting frozen until their session ends and either
//   jumps to a new number or the node just vanishes. Previously the only
//   Firestore write for a whole mining session happened once, at the
//   very end (see /mineNode) - so a bystander had nothing to read mid-
//   session. otherMinerProgressForNode() below predicts it the same way
//   we already predict our OWN hits locally: from elapsed real time
//   since the broadcast's startedAtMs, at one hit per ORBIT_PERIOD_MS,
//   subtracted from the node's last-confirmed strikesRemaining (which,
//   since nothing rewrites it mid-session, is exactly what it was when
//   they started). Once they go `validating`, their real final count is
//   up to the server, not predictable from elapsed time anymore, so it
//   falls back to the existing "Validating..." label at that point
//   rather than guessing further.

import { db, rtdb, apiFetch } from './firebase-config.js?v=14';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import {
  ref, push, onValue, set, remove, onDisconnect, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js';

const ROOM_SIZE = 2000;
const CANVAS_SIZE = 800;
const BASE_SCALE = CANVAS_SIZE / ROOM_SIZE; // 0.4 - old "whole room fits on screen" scale
const ZOOM = 5; // enlarges the whole view so the character reads as ~100x100px
const SCALE = BASE_SCALE * ZOOM; // world units -> canvas pixels, zoomed in
const PLAYER_RADIUS = 50; // canvas px - 100px diameter, per the 100x100 ask
const NODE_RADIUS = 70; // canvas px - kept at the old node:player size ratio (14:10)
const CAMERA_FOLLOW = 0.08; // 0-1 per frame - how quickly the camera eases toward the character (lower = laggier/smoother)
const HIT_RADIUS = 50; // world units - click-proximity tolerance for "which node did you click", unrelated to pixel sizes above
const MINING_RANGE = 150; // world units - how close the character has to be to a node to mine it; must match server/lib/mining-session.js's MINING_RANGE
const ORBIT_PERIOD_MS = 500; // one orbit = one hit; must match server/lib/mining-session.js's MINE_ORBIT_PERIOD_MS

// General player-position heartbeat (see file header). Kept deliberately
// throttled - Firestore's free plan has a daily write quota, and this is
// the one thing here that scales with how long people just stand around
// with the tab open, not with how much they actually mine.
// General player-position heartbeat (see file header). This now lives in
// RTDB, which isn't billed per write on Spark - so this throttle exists
// for bandwidth/smoothness reasons, not to dodge a Firestore write quota.
const PRESENCE_MOVE_EPSILON = 4; // world units - smaller jitter than this doesn't count as "moved"
const PRESENCE_MIN_SEND_INTERVAL_MS = 150; // fastest we'll resend while actively moving
const PRESENCE_IDLE_RESEND_MS = 10000; // slowest we'll resend while standing still - mostly just keeps updatedAtMs fresh; onDisconnect (not this) is what actually guarantees cleanup
const PRESENCE_CLIENT_STALE_MS = 20000; // defensive client-side filter well above PRESENCE_IDLE_RESEND_MS, in case onDisconnect somehow didn't fire yet

export const ORE_COLORS = {
  stone: '#8a8a8a', iron: '#a5673f', gold: '#e8c547',
  diamond: '#7fe8e0', platinum: '#d8dee9', pesolarium: '#c561e8'
};

// Cave floor texture - one shared Image across every mountMine() instance
// (switching location doesn't need to refetch it). Drawn as a canvas
// pattern rather than a CSS background on the <canvas> element itself,
// so it's anchored to world coordinates and pans correctly with the
// camera instead of staying fixed to the screen.
const FLOOR_TILE_WORLD_SIZE = 150; // world units per texture tile - tweak to taste
const floorImg = new Image();
let floorImgLoaded = false;
floorImg.onload = () => { floorImgLoaded = true; };
floorImg.onerror = () => console.error('mining.js: failed to load img/cave_floor.png');
floorImg.src = './img/cave_floor.png';

export const LOCATION_NAMES = [
  'Crag Hollow', 'Rustrock Cavern', 'Aurum Depths',
  'Shardfall Abyss', 'The Noble Chasm', 'Amaurosis'
];

// Every cave's walkways, in world units. This is a straight-line chain -
// cave 0 only has an east exit to cave 1, caves 1-4 have both a west exit
// (back a step) and an east exit (forward a step), and cave 5 only has a
// west exit back to cave 4. Replaces the old single locked/dormant EXIT
// (and the "Cave:" dropdown in app.js) with real, walkable connections.
const EXIT_WIDTH = 220; // opening width
const EXIT_DEPTH = 160; // how far the passage alcove extends past the wall
const EXIT_CENTER = ROOM_SIZE / 2; // every walkway sits centered on its wall

function buildChainExits() {
  const exits = {};
  for (let id = 0; id < LOCATION_NAMES.length; id++) {
    const list = [];
    if (id > 0) list.push({ side: 'west', toLocationId: id - 1 });
    if (id < LOCATION_NAMES.length - 1) list.push({ side: 'east', toLocationId: id + 1 });
    exits[id] = list;
  }
  // Cave 0 additionally gets a standalone "Cave Exit" on its otherwise-
  // unused west wall - this is the original placeholder walkway from
  // before the 0-5 chain existed (meant to eventually lead somewhere
  // outside the numbered caves, e.g. back to a hub/surface). It has no
  // destination yet, so it's locked: visible (door-frame, iron bars,
  // padlock label) but not actually walkable, same as before.
  exits[0].push({ side: 'west', toLocationId: null, locked: true, label: 'Cave Exit' });
  return exits;
}
const LOCATION_EXITS = buildChainExits();

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLElement} opts.toastEl
 * @param {string} opts.account
 * @param {number} opts.locationId
 * @param {boolean} [opts.spectator] - "guest" mode: the character still
 *   spawns, moves, and can use walkways, but can't start mining a node.
 * @param {(id:number)=>void} [opts.onLocationChange] - fired whenever the
 *   active cave changes (initial mount and every walkway crossing), so the
 *   caller can show which cave you're in without polling.
 * @param {(energy:number)=>void} [opts.onEnergyChange] - fired whenever the
 *   server reports an updated energy value (after a mining session that
 *   actually depleted a node), so the caller can keep an energy bar in
 *   sync without polling.
 * @returns {{ setLocation(id:number): void, destroy(): void }}
 */
export function mountMine({ canvas, toastEl, account, locationId, spectator = false, onLocationChange, onEnergyChange }) {
  const ctx = canvas.getContext('2d');

  let currentLocationId = locationId;
  let nodes = new Map(); // nodeId -> node
  const player = { x: 1000, y: 1000 };
  // Camera is in world coordinates and marks what's drawn at canvas-center.
  const camera = { x: player.x, y: player.y };
  let floorPattern = null; // built lazily once floorImg has actually loaded
  let wasTouchingWall = false; // edge-detects wall contact so the toast fires once, not every frame
  const keys = {};
  let unsubNodes = null;
  let unsubMiningActivity = null;
  let unsubPresenceValue = null; // onValue() unsubscribe for the current location's presence/{locationId} node
  let unsubConnected = null; // onValue() unsubscribe for the one-time '.info/connected' listener, set up once below
  let rafId = null;
  let destroyed = false;

  // Presence heartbeat throttle state - see PRESENCE_* constants above.
  let lastPresenceSentAt = 0;
  let lastPresenceX = null;
  let lastPresenceY = null;

  // Active mining session, or null when idle/moving freely. localStrikesRemaining
  // is the client's own running prediction of the node's HP (see loop()'s
  // orbit-completion check below) - only pendingHits actually gets sent to
  // the server, once, when the session ends (see finalizeMining). `validating`
  // flips true the instant the local prediction hits zero (or a cancel/snipe
  // triggers finalizeMining with hits pending) - it freezes the swing and
  // swaps the node's HP readout to "Validating..." until the server responds.
  // `finalizing` just guards against finalizeMining running twice for the
  // same session (e.g. Esc pressed right as the last orbit completes).
  let miningState = null;

  // account -> { account, nodeId, charX, charY, startedAtMs, validating }
  // for every OTHER player currently mining in this cave, from the public
  // broadcast the server writes on /startMining and clears on /mineNode
  // (see server/lib/mining-session.js). Never includes our own account -
  // our own swing is drawn straight from miningState/player above.
  let otherMiners = new Map();

  // account -> { account, charX, charY, updatedAtMs } for every OTHER
  // player currently present in this cave (see the RTDB presence/
  // {locationId} node this subscribes to in connect(), and
  // sendPresenceIfNeeded() below). Never includes our own account.
  // Someone who's also actively mining still has an entry here, but
  // drawOtherPlayers() skips anyone present in otherMiners so they're
  // only ever drawn once, by drawOtherMiners(), with their swing.
  let otherPlayers = new Map();

  function toast(msg) {
    const div = document.createElement('div');
    div.textContent = msg;
    toastEl.appendChild(div);
    setTimeout(() => div.remove(), 2500);
  }

  function getExits() {
    return LOCATION_EXITS[currentLocationId] || [];
  }

  function distanceToNode(node) {
    return Math.hypot(node.x - player.x, node.y - player.y);
  }

  // World -> canvas, relative to wherever the camera currently is (see
  // updateCamera below) rather than a fixed room->canvas mapping - that's
  // what makes the view pan as the camera follows the character.
  function toCanvas(x, y) {
    return [
      (x - camera.x) * SCALE + CANVAS_SIZE / 2,
      (y - camera.y) * SCALE + CANVAS_SIZE / 2
    ];
  }

  // Eases the camera toward the character each frame instead of snapping
  // to it, so movement feels like a "follow" rather than the view being
  // rigidly locked to the player. Runs for guests too now - see the file
  // header note on why that wasn't happening before.
  function updateCamera() {
    camera.x += (player.x - camera.x) * CAMERA_FOLLOW;
    camera.y += (player.y - camera.y) * CAMERA_FOLLOW;
  }

  // Our own current presence node, as an actual DatabaseReference - not
  // derived from the account name, since RTDB keys can't contain '.' and
  // WAX account names commonly do (e.g. "foo.bar.wam" - this is exactly
  // what broke the first version of this). Instead each (re)connect
  // mints a fresh, opaque push() key (see armPresenceForCurrentLocation
  // below) and the real account name travels as a FIELD inside the
  // node's data instead of as its key - see database.rules.json for how
  // the security rule checks that field instead of the path.
  let myPresenceRef = null;

  // (Re-)establishes our presence in whichever cave is currently active:
  // mints a new push() key under presence/{locationId}, arms
  // onDisconnect().remove() on it (so the database itself clears it the
  // instant this socket drops, no heartbeat-staleness guessing needed),
  // and writes our current position + account name. Called once per
  // location from connect(), and again any time the client (re)connects
  // to RTDB at all (see the `.info/connected` listener below) - a fresh
  // connection needs its own onDisconnect registration, since the
  // previous one only applied to the connection that just dropped (and,
  // being a brand new key each time, never collides with whatever the
  // dropped connection's node was anyway).
  function armPresenceForCurrentLocation() {
    if (!account) return;
    myPresenceRef = push(ref(rtdb, `presence/${currentLocationId}`));
    onDisconnect(myPresenceRef).remove().catch(() => {});
    set(myPresenceRef, {
      account, charX: player.x, charY: player.y, updatedAtMs: serverTimestamp()
    }).catch((err) => {
      console.error('presence set failed (non-fatal):', err.message);
    });
    lastPresenceSentAt = Date.now();
    lastPresenceX = player.x;
    lastPresenceY = player.y;
  }

  // Explicit, immediate leave for a cave we're walking out of (as opposed
  // to onDisconnect, which only fires if the whole connection drops) -
  // cancels that node's onDisconnect registration too, so it doesn't sit
  // around pointed at a node we've already removed ourselves.
  function leavePresence(presenceRef) {
    if (!presenceRef) return;
    onDisconnect(presenceRef).cancel().catch(() => {});
    remove(presenceRef).catch(() => {});
  }

  function connect(id) {
    // Leaving a cave we were actually in (not the very first connect) -
    // tear down our presence node there immediately rather than leaving
    // it for onDisconnect, which only fires on an actual connection
    // drop, not a location change.
    leavePresence(myPresenceRef);

    currentLocationId = id;
    nodes = new Map();
    otherMiners = new Map();
    otherPlayers = new Map();

    if (unsubNodes) unsubNodes();
    if (unsubMiningActivity) unsubMiningActivity();
    if (unsubPresenceValue) unsubPresenceValue();

    const nodesRef = collection(db, 'locations', String(currentLocationId), 'nodes');
    unsubNodes = onSnapshot(nodesRef, (snap) => {
      snap.docChanges().forEach((change) => {
        const data = change.doc.data();
        if (change.type === 'removed') {
          nodes.delete(change.doc.id);
        } else if (data.state === 'active') {
          nodes.set(change.doc.id, { id: change.doc.id, ...data });
        } else {
          nodes.delete(change.doc.id); // depleted - hide until it respawns active again
          // If that was OUR target and we hadn't already started finalizing
          // ourselves, someone else's session just finished it off while we
          // were still mid-swing. Stop swinging and let finalizeMining's
          // server round trip report back who actually won it (see
          // node-manager.js's 'already_depleted' branch) instead of leaving
          // us stuck orbiting a node that's no longer there.
          if (miningState && miningState.nodeId === change.doc.id && !miningState.finalizing) {
            finalizeMining();
          }
        }
      });
    });

    // Public broadcast of every OTHER account's active mining session in
    // this cave (see server/lib/mining-session.js) - lets us draw their
    // swing/orbit and surface "Validating..." on a node someone else is
    // finishing, without needing a full player-position sync.
    const activityRef = collection(db, 'locations', String(currentLocationId), 'miningActivity');
    unsubMiningActivity = onSnapshot(activityRef, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.doc.id === account) return; // never render our own broadcast - we draw ourselves from local state
        if (change.type === 'removed') {
          otherMiners.delete(change.doc.id);
        } else {
          otherMiners.set(change.doc.id, { account: change.doc.id, ...change.doc.data() });
        }
      });
    });

    // General player-position broadcast (see file header) - RTDB's
    // onValue() hands back the WHOLE presence/{locationId} subtree every
    // time anything under it changes (unlike Firestore's incremental
    // docChanges()), so this just rebuilds otherPlayers wholesale each
    // callback rather than patching it - simple, and cheap enough for
    // however many players are realistically ever in one cave at once.
    const presenceListRef = ref(rtdb, `presence/${currentLocationId}`);
    unsubPresenceValue = onValue(presenceListRef, (snap) => {
      const val = snap.val() || {};
      const next = new Map();
      for (const data of Object.values(val)) {
        // Identity comes from the `account` FIELD, not the RTDB key - the
        // key is an opaque push() id (see armPresenceForCurrentLocation),
        // since account names can contain '.', which RTDB keys can't.
        if (!data || !data.account || data.account === account) continue; // skip malformed entries and our own broadcast
        next.set(data.account, data);
      }
      otherPlayers = next;
    });

    // (Re-)establish our own presence node in the new cave right away,
    // rather than waiting for the next loop() tick's throttled heartbeat -
    // otherwise we'd be invisible to anyone already there for up to
    // PRESENCE_IDLE_RESEND_MS after arriving.
    armPresenceForCurrentLocation();

    if (onLocationChange) onLocationChange(id);
  }

  // Re-arms presence (new onDisconnect + a fresh write) any time this
  // client (re)connects to RTDB at all - including the very first
  // connection. A dropped/restored network connection needs its own
  // onDisconnect registration, since the one from before the drop only
  // ever applied to that now-dead connection. Set up once here, not
  // per-connect() - it always targets whatever currentLocationId
  // currently is at the moment it fires.
  let everConnectedToRtdb = false;
  unsubConnected = onValue(
    ref(rtdb, '.info/connected'),
    (snap) => {
      if (snap.val() === true) {
        everConnectedToRtdb = true;
        armPresenceForCurrentLocation();
      }
    },
    (err) => console.error('[mining] RTDB .info/connected listener errored:', err)
  );
  // Diagnostic - if this never logs "connected", every other player stays
  // invisible to you no matter what (see the file header's presence
  // section). The most common cause is public/js/firebase-config.js's
  // databaseURL being wrong or a placeholder - go to Firebase Console ->
  // Build -> Realtime Database, confirm a database actually exists there
  // (not just Firestore), and copy its exact URL into that file.
  setTimeout(() => {
    if (!everConnectedToRtdb) {
      console.error(
        '[mining] Still not connected to Realtime Database after 5s - other players will not be visible. ' +
        'Check public/js/firebase-config.js\'s databaseURL against Firebase Console -> Build -> Realtime Database.'
      );
    }
  }, 5000);

  // Heartbeats our own position so other clients' presence listeners see
  // us move. Throttled for bandwidth/smoothness, not to dodge a write
  // quota (RTDB isn't billed per-operation on Spark - see file header):
  // resends promptly while actually moving (capped at
  // PRESENCE_MIN_SEND_INTERVAL_MS so holding a direction key doesn't spam
  // a write every frame), otherwise just occasionally while standing
  // still to keep updatedAtMs fresh - onDisconnect, not this, is what
  // actually guarantees cleanup.
  function sendPresenceIfNeeded() {
    if (!account || !myPresenceRef) return;
    const now = Date.now();
    const moved = lastPresenceX === null ||
      Math.hypot(player.x - lastPresenceX, player.y - lastPresenceY) > PRESENCE_MOVE_EPSILON;
    if (moved && now - lastPresenceSentAt < PRESENCE_MIN_SEND_INTERVAL_MS) return;
    if (!moved && now - lastPresenceSentAt < PRESENCE_IDLE_RESEND_MS) return;

    lastPresenceSentAt = now;
    lastPresenceX = player.x;
    lastPresenceY = player.y;
    // set() replaces the WHOLE node, so `account` has to be re-sent every
    // time too, not just on the initial write in
    // armPresenceForCurrentLocation() - otherwise the second heartbeat
    // would wipe it out from under the security rule's validation and
    // otherPlayers' rendering.
    set(myPresenceRef, {
      account, charX: player.x, charY: player.y, updatedAtMs: serverTimestamp()
    }).catch((err) => {
      // Best-effort, like the mining broadcast - a dropped update just
      // means we're stale to others until the next one lands.
      console.error('presence set failed (non-fatal):', err.message);
    });
  }

  function onKeyDown(e) {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Escape' && miningState) finalizeMining();
  }
  function onKeyUp(e) { keys[e.key.toLowerCase()] = false; }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // No pagehide/beforeunload handler needed for presence cleanup anymore -
  // RTDB's onDisconnect() (armed in armPresenceForCurrentLocation()) is a
  // server-side promise that fires the instant this socket actually
  // drops, tab-close/crash included, which is strictly better than a
  // best-effort handler racing the page's teardown.

  // The room rect plus, for whichever walls this cave actually has a
  // walkway on, the little alcove past that wall where the passage leads -
  // lets clampPlayerPosition()/drawFloor()/drawWalls() all share one
  // definition of "walkable ground" instead of drifting out of sync.
  function exitAlcoveWorldRect(exit) {
    const half = EXIT_WIDTH / 2;
    if (exit.side === 'east') {
      return { x0: ROOM_SIZE, y0: EXIT_CENTER - half, x1: ROOM_SIZE + EXIT_DEPTH, y1: EXIT_CENTER + half };
    }
    if (exit.side === 'west') {
      return { x0: -EXIT_DEPTH, y0: EXIT_CENTER - half, x1: 0, y1: EXIT_CENTER + half };
    }
    return null;
  }

  // How far the player is currently allowed to wander in x - ROOM_SIZE on
  // each side normally, extended into whichever alcove(s) this cave has a
  // walkway into, but only while y is actually within the opening.
  function computeClampLimits() {
    const half = EXIT_WIDTH / 2;
    const inGapY = player.y >= EXIT_CENTER - half && player.y <= EXIT_CENTER + half;
    // Locked exits (currently just cave 0's placeholder "Cave Exit") are
    // rendered like any other opening but stay functionally a wall - you
    // can walk up to the gap, you just can't pass through it yet.
    const westExit = getExits().find((e) => e.side === 'west' && !e.locked);
    const eastExit = getExits().find((e) => e.side === 'east' && !e.locked);
    return {
      minX: (inGapY && westExit) ? -EXIT_DEPTH : 0,
      maxX: (inGapY && eastExit) ? ROOM_SIZE + EXIT_DEPTH : ROOM_SIZE
    };
  }

  function clampPlayerPosition() {
    player.y = Math.max(0, Math.min(ROOM_SIZE, player.y));
    const { minX, maxX } = computeClampLimits();
    player.x = Math.max(minX, Math.min(maxX, player.x));
  }

  // Walking all the way through a walkway's alcove hands off to the same
  // connect() the old dropdown used, then drops the player just inside
  // the matching wall of the new cave (so you don't land back at the exit
  // you just used).
  function travelTo(destinationId, arriveSide) {
    connect(destinationId);
    player.x = arriveSide === 'west' ? 40 : ROOM_SIZE - 40;
    player.y = EXIT_CENTER;
    camera.x = player.x;
    camera.y = player.y;
    toast(`Entered ${LOCATION_NAMES[destinationId]}.`);
  }

  function checkExitTravel() {
    const half = EXIT_WIDTH / 2;
    const inGapY = player.y >= EXIT_CENTER - half && player.y <= EXIT_CENTER + half;
    if (!inGapY) return;

    const westExit = getExits().find((e) => e.side === 'west' && !e.locked);
    const eastExit = getExits().find((e) => e.side === 'east' && !e.locked);

    if (westExit && player.x <= -EXIT_DEPTH + 20) {
      travelTo(westExit.toLocationId, 'east'); // left via the west wall - appear by the new cave's east wall
    } else if (eastExit && player.x >= ROOM_SIZE + EXIT_DEPTH - 20) {
      travelTo(eastExit.toLocationId, 'west'); // left via the east wall - appear by the new cave's west wall
    }
  }

  function updateMovement() {
    if (miningState) return; // planted in place while mining - see the file header note
    const speed = 4;
    if (keys['w']) player.y -= speed;
    if (keys['s']) player.y += speed;
    if (keys['a']) player.x -= speed;
    if (keys['d']) player.x += speed;
    clampPlayerPosition();
  }

  async function startMining(node) {
    console.debug('[mining] POST /startMining', {
      account, locationId: currentLocationId, nodeId: node.id, charX: player.x, charY: player.y,
      hasCurrentUser: !!auth.currentUser
    });
    try {
      await apiFetch('/startMining', {
        method: 'POST',
        authRequired: true,
        body: { account, locationId: currentLocationId, nodeId: node.id, charX: player.x, charY: player.y }
      });
      console.debug('[mining] /startMining succeeded - swing should now be visible', { nodeId: node.id });
      miningState = {
        nodeId: node.id,
        localStrikesRemaining: node.strikesRemaining,
        pendingHits: 0,
        orbitStartTime: performance.now(),
        lastCompletedOrbits: 0,
        validating: false,
        finalizing: false
      };
    } catch (err) {
      // Previously only err.message reached the toast (out_of_range vs a
      // generic "can't mine that" catch-all) and the actual error object
      // was discarded entirely - so an auth failure, a CORS/network error,
      // or a 500 from the server all looked visually identical and left
      // nothing in the console to tell them apart. Logging the raw error
      // here is what turns "nothing happens" into an actual diagnosis.
      console.error('[mining] /startMining failed:', err);
      toast(err.message === 'out_of_range' ? 'Too far to mine - get closer.' : "Can't mine that right now.");
    }
  }

  // Ends the current mining session, however it ended (finished, cancelled,
  // or sniped by someone else finishing the node first), and syncs whatever
  // hits actually landed with the server - this is the ONLY network call a
  // whole session makes, no matter how many orbits/hits happened locally.
  // Always calls through to the server, even with zero hits, so the
  // server-side session and public broadcast doc always get cleaned up
  // rather than lingering (see mining-session.js's clearBroadcast).
  async function finalizeMining() {
    if (!miningState || miningState.finalizing) return;
    miningState.finalizing = true; // freezes the swing (see drawMiningPickaxe) and blocks re-entry
    const { nodeId, pendingHits } = miningState;
    // Only worth a "Validating..." label if we actually have hits pending
    // for the server to confirm - an instant cancel with nothing landed
    // has nothing to validate, so just let it clear quietly.
    if (pendingHits > 0) miningState.validating = true;

    try {
      const result = await apiFetch('/mineNode', {
        method: 'POST',
        authRequired: true,
        body: { account, locationId: currentLocationId, nodeId, hitCount: pendingHits }
      });
      console.debug('[mining] /mineNode result', result);
      if (result.depleted) {
        toast(`+1 ${result.oreType} (${result.value} coin value)`);
      } else if (result.alreadyDepleted) {
        toast(`Looks like ${result.wonBy || 'another miner'} beat you to it. Tough luck.`);
      }
      if (typeof result.energy === 'number' && onEnergyChange) onEnergyChange(result.energy);
    } catch (err) {
      if (err.message === 'no_energy') {
        toast('⚡ Out of energy - go rest to recover.');
      } else if (err.message !== 'no_active_session') {
        // no_active_session means this got triggered twice in a race (e.g.
        // the snipe-detector and a manual Esc landing back to back) - the
        // first call already resolved things server-side, nothing new to
        // report from the second.
        console.error('[mining] /mineNode failed:', err);
        toast("Mining didn't register - try again.");
      }
    } finally {
      miningState = null; // only now, once the server has actually confirmed one way or another
    }
  }

  async function onCanvasClick(e) {
    try {
      if (spectator || !account) return; // guests can move and explore, but can't mine

      if (miningState) {
        // Already mining - a click during an active session cancels it.
        // Progress made so far still gets sent to the server (finalizeMining
        // only skips the network call if literally nothing landed yet).
        console.debug('[mining] click while already mining - cancelling session', {
          nodeId: miningState.nodeId, pendingHits: miningState.pendingHits,
          finalizing: miningState.finalizing
        });
        finalizeMining();
        return;
      }

      const rect = canvas.getBoundingClientRect();
      // canvas.width/height is the fixed internal drawing resolution (800x800),
      // but rect.width/height is however big CSS actually renders it on screen
      // (#world-canvas has max-width:90vmin/max-height:70vh, so on most
      // screens it's shown smaller than 800px). Converting through the
      // *actual* displayed size first is what makes clicks land accurately.
      const displayToInternalX = canvas.width / rect.width;
      const displayToInternalY = canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * displayToInternalX;
      const canvasY = (e.clientY - rect.top) * displayToInternalY;
      const clickX = camera.x + (canvasX - CANVAS_SIZE / 2) / SCALE;
      const clickY = camera.y + (canvasY - CANVAS_SIZE / 2) / SCALE;

      let target = null;
      let bestDist = HIT_RADIUS;
      for (const node of nodes.values()) {
        const d = Math.hypot(node.x - clickX, node.y - clickY);
        if (d < bestDist) {
          bestDist = d;
          target = node;
        }
      }
      if (!target) {
        // Temporary diagnostic - if clicks stop registering again, open
        // DevTools (F12) -> Console right before clicking and read this
        // line: it shows exactly where the click was interpreted to land
        // in world space, how many nodes are known locally, and how close
        // the single nearest one actually was. If nodesSeen is 0 despite
        // rocks being visibly on screen, the nodes listener/render loop
        // are looking at different data than they should be. If
        // nearestDist is huge/NaN/way off from where you actually
        // clicked, it's a coordinate math or camera-desync bug. Remove
        // this whole `if (!target)` block once the click issue's confirmed
        // fixed - it's not meant to stay long-term.
        let nearestDist = null;
        for (const node of nodes.values()) {
          const d = Math.hypot(node.x - clickX, node.y - clickY);
          if (nearestDist === null || d < nearestDist) nearestDist = d;
        }
        console.debug('[mining] click found no node in range', {
          clickX, clickY, cameraX: camera.x, cameraY: camera.y,
          nodesSeen: nodes.size, nearestDist, hitRadius: HIT_RADIUS
        });
        return; // clicked empty ground - nothing to do
      }

      if (distanceToNode(target) > MINING_RANGE) {
        console.debug('[mining] target found but out of range', {
          nodeId: target.id, distance: distanceToNode(target), miningRange: MINING_RANGE,
          playerX: player.x, playerY: player.y, nodeX: target.x, nodeY: target.y
        });
        toast('Too far to mine - get closer.');
        return;
      }

      console.debug('[mining] target in range, starting mining session', { nodeId: target.id });
      startMining(target);
    } catch (err) {
      // Belt-and-suspenders: nothing above should throw synchronously, but
      // if it ever does, this is what turns a silent, invisible failure
      // into something you can actually see and report.
      console.error('[mining] onCanvasClick threw unexpectedly:', err);
      toast('Something went wrong trying to mine that - see console (F12).');
    }
  }
  canvas.addEventListener('click', onCanvasClick);

  function drawFloor() {
    // Everywhere outside the walkable area is solid black - reads as
    // "unexplored/off-limits" rather than more cave stretching on forever.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.save();
    ctx.beginPath();
    const [rx0, ry0] = toCanvas(0, 0);
    const [rx1, ry1] = toCanvas(ROOM_SIZE, ROOM_SIZE);
    ctx.rect(rx0, ry0, rx1 - rx0, ry1 - ry0);
    for (const exit of getExits()) {
      const alcove = exitAlcoveWorldRect(exit);
      if (!alcove) continue;
      const [ax0, ay0] = toCanvas(alcove.x0, alcove.y0);
      const [ax1, ay1] = toCanvas(alcove.x1, alcove.y1);
      ctx.rect(ax0, ay0, ax1 - ax0, ay1 - ay0);
    }
    ctx.clip(); // floor pattern below only paints inside the room + alcove(s) now

    if (!floorImgLoaded) {
      ctx.fillStyle = '#2b2118'; // fallback while cave_floor.png is still loading
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    } else {
      if (!floorPattern) floorPattern = ctx.createPattern(floorImg, 'repeat');
      // Scales+positions the tile pattern in world space (so it pans with the
      // camera like the floor is actually part of the cave) rather than
      // staying glued to the canvas the way a CSS background would.
      const texToCanvas = (SCALE * FLOOR_TILE_WORLD_SIZE) / floorImg.naturalWidth;
      floorPattern.setTransform(new DOMMatrix([
        texToCanvas, 0,
        0, texToCanvas,
        CANVAS_SIZE / 2 - camera.x * SCALE,
        CANVAS_SIZE / 2 - camera.y * SCALE
      ]));
      ctx.fillStyle = floorPattern;
      ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    }
    ctx.restore();
  }

  function drawWalls() {
    const [x0, y0] = toCanvas(0, 0);
    const [x1, y1] = toCanvas(ROOM_SIZE, ROOM_SIZE);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 16;
    ctx.lineCap = 'square';

    // North and south are always solid - this chain layout only ever puts
    // walkways on the east/west walls.
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y0);
    ctx.moveTo(x0, y1); ctx.lineTo(x1, y1);
    ctx.stroke();

    const westExit = getExits().find((e) => e.side === 'west');
    const eastExit = getExits().find((e) => e.side === 'east');
    drawSideWall('west', x0, y0, y1, westExit);
    drawSideWall('east', x1, y0, y1, eastExit);
  }

  function drawSideWall(side, wallX, y0, y1, exit) {
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 16;

    if (!exit) {
      ctx.beginPath();
      ctx.moveTo(wallX, y0);
      ctx.lineTo(wallX, y1);
      ctx.stroke();
      return;
    }

    const half = EXIT_WIDTH / 2;
    const gapTopWorld = EXIT_CENTER - half;
    const gapBottomWorld = EXIT_CENTER + half;
    const worldX = side === 'west' ? 0 : ROOM_SIZE;
    const [, gapTopY] = toCanvas(worldX, gapTopWorld);
    const [, gapBottomY] = toCanvas(worldX, gapBottomWorld);

    ctx.beginPath();
    ctx.moveTo(wallX, y0); ctx.lineTo(wallX, gapTopY);
    ctx.moveTo(wallX, gapBottomY); ctx.lineTo(wallX, y1);
    ctx.stroke();

    drawExit(side, wallX, gapTopWorld, gapBottomWorld, gapTopY, gapBottomY, exit);
  }

  function drawExit(side, wallX, gapTopWorld, gapBottomWorld, gapTopY, gapBottomY, exit) {
    const farWorldX = side === 'east' ? ROOM_SIZE + EXIT_DEPTH : -EXIT_DEPTH;
    const [farX, farTopY] = toCanvas(farWorldX, gapTopWorld);
    const [, farBottomY] = toCanvas(farWorldX, gapBottomWorld);

    // Door-frame around the alcove opening, left open on the room side.
    ctx.strokeStyle = '#3a2c1e';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(wallX, gapTopY);
    ctx.lineTo(farX, farTopY);
    ctx.lineTo(farX, farBottomY);
    ctx.lineTo(wallX, gapBottomY);
    ctx.stroke();

    if (exit.locked) {
      // Iron-bar gate across the opening - visually says "not open yet"
      // without needing the player to walk up and bounce off it to find out.
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 4;
      const barCount = 4;
      for (let i = 1; i <= barCount; i++) {
        const bx = wallX + ((farX - wallX) * i) / (barCount + 1);
        const by = gapTopY + ((farTopY - gapTopY) * i) / (barCount + 1);
        const byBottom = gapBottomY + ((farBottomY - gapBottomY) * i) / (barCount + 1);
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx, byBottom);
        ctx.stroke();
      }
    }

    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = exit.locked ? '#999' : '#e8c547';
    const arrow = side === 'east' ? '→' : '←';
    const label = exit.locked
      ? `🔒 ${exit.label || 'Cave Exit'}`
      : `${arrow} ${LOCATION_NAMES[exit.toLocationId]}`;
    ctx.fillText(label, (wallX + farX) / 2, gapTopY - 14);
    ctx.textAlign = 'left';
  }

  // Predicts how much progress every OTHER account currently mining this
  // node has made, the same way we predict our OWN hits locally (see
  // miningState.localStrikesRemaining in loop()): one hit per
  // ORBIT_PERIOD_MS elapsed since their broadcast's startedAtMs. This is
  // what makes a bystander see the HP count actually tick down while
  // someone else's swing plays, instead of it sitting frozen until their
  // session ends (see the file header on why nothing rewrites the node's
  // real Firestore doc mid-session).
  //
  // Once any of them flips into `validating`, their true final hit count
  // is up to the server, not predictable from elapsed time - `validating`
  // comes back true in that case, and the caller falls back to the
  // existing "Validating..." label rather than guessing further.
  function otherMinerProgressForNode(nodeId) {
    let hits = 0;
    let validating = false;
    for (const miner of otherMiners.values()) {
      if (miner.nodeId !== nodeId) continue;
      if (miner.validating) { validating = true; continue; }
      hits += Math.floor((Date.now() - miner.startedAtMs) / ORBIT_PERIOD_MS);
    }
    return { hits, validating };
  }

  function drawNode(node) {
    const [cx, cy] = toCanvas(node.x, node.y);
    const color = ORE_COLORS[node.oreType] || '#fff';
    const isTarget = miningState && miningState.nodeId === node.id;
    const inRange = !spectator && account && !miningState && distanceToNode(node) <= MINING_RANGE;

    // Dashed outline = "in reach, click to mine". Solid orange = "this is
    // what you're currently mining". Neither is drawn for out-of-range
    // nodes, guests, or (for the plain in-range ring) while already mining
    // something else, since you can't start a second session anyway.
    if (isTarget || inRange) {
      ctx.beginPath();
      ctx.arc(cx, cy, NODE_RADIUS + 8, 0, Math.PI * 2);
      ctx.strokeStyle = isTarget ? '#ff9d3a' : '#fff59d';
      ctx.lineWidth = isTarget ? 5 : 3;
      if (!isTarget) ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.arc(cx, cy, NODE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.stroke();

    // "3/375"-style progress readout instead of a plain bar - a bar alone
    // gave no sense of scale, so high-strike ore (diamond etc.) looked
    // permanently stuck rather than just needing a lot more hits. While
    // actively mining this node, show the client-predicted HP instead of
    // whatever Firestore last confirmed - that's the whole point of
    // predicting locally, see the file header note on why.
    //
    // "Validating..." replaces the number the instant a prediction hits
    // zero (or a cancel/snipe is being resolved) rather than letting it
    // flash back to the pre-mine count while the one /mineNode call for
    // this session is in flight - see finalizeMining. It shows for anyone
    // watching the node, not just whoever's swing triggered it, since the
    // server broadcasts the same `validating` flag publicly. Between that
    // and otherMinerProgressForNode()'s elapsed-time prediction above, a
    // bystander sees this node's HP actually counting down while someone
    // else mines it, not just a number that jumps once at the end.
    const otherProgress = !isTarget ? otherMinerProgressForNode(node.id) : null;
    let label;
    if (isTarget && miningState.validating) {
      label = 'Validating...';
    } else if (otherProgress && otherProgress.validating) {
      label = 'Validating...';
    } else {
      const shown = isTarget
        ? Math.max(0, miningState.localStrikesRemaining)
        : Math.max(0, node.strikesRemaining - (otherProgress ? otherProgress.hits : 0));
      label = `${shown}/${node.maxStrikes}`;
    }
    ctx.font = `bold ${Math.round(NODE_RADIUS * 0.34)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelY = cy - NODE_RADIUS - 16;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(label, cx, labelY);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, cx, labelY);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  function drawCharacter(x, y, label, touchingWall) {
    const [cx, cy] = toCanvas(x, y);
    ctx.beginPath();
    ctx.arc(cx, cy, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = spectator ? '#999' : '#3aa0ff';
    ctx.fill();
    // Red glowing outline = "you're pressed against a wall" - there was
    // previously no feedback at all for this, just a silent position clamp.
    if (touchingWall) {
      ctx.save();
      ctx.shadowColor = '#ff4d4d';
      ctx.shadowBlur = 20;
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = '#1c1c1c';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(PLAYER_RADIUS * 0.28)}px sans-serif`;
    ctx.fillText(label, cx, cy - PLAYER_RADIUS - 10);

    if (miningState) {
      ctx.font = '16px sans-serif';
      ctx.fillStyle = '#fff';
      const hint = miningState.validating ? 'Validating...' : 'Mining... click or Esc to cancel';
      ctx.fillText(hint, cx, cy + PLAYER_RADIUS + 26);
    }
    ctx.textAlign = 'left';
  }

  // Shared swing math for both our own pickaxe and every other broadcast
  // account's (see server/lib/mining-session.js) - takes everything in
  // canvas space so the same function draws any account's swing. One full
  // cycle (0..1) is a wind-up (0-0.35) followed by an accelerating strike
  // toward the node (0.35-1), rather than the old fixed-radius circle
  // around the character - that read as orbiting *near* the character
  // rather than actually hitting the node it's supposedly mining.
  // `frozen` holds the pose at the moment of impact (t=1) instead of
  // continuing to cycle - that's what "Validating..." looks like: the
  // pickaxe stopped mid-swing, waiting on the server to confirm the hit.
  function computeSwingPose(playerCanvasX, playerCanvasY, nodeCanvasX, nodeCanvasY, elapsedMs, frozen) {
    const dx = nodeCanvasX - playerCanvasX, dy = nodeCanvasY - playerCanvasY;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist; // unit vector from wielder toward the node
    const perpX = -uy, perpY = ux; // perpendicular, for a slight arc rather than a straight slide

    const t = frozen ? 1 : ((elapsedMs % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS);
    const restPx = PLAYER_RADIUS + 14; // resting distance from the wielder, between swings
    const strikePx = Math.max(restPx + 10, dist - NODE_RADIUS * 0.6); // reaches into the node's edge on impact

    let radius, arcOffset;
    if (t < 0.35) {
      // Wind-up: pull back past the rest point and out to the side.
      const wt = t / 0.35;
      const ease = wt * wt;
      radius = restPx - ease * (restPx * 0.5);
      arcOffset = ease * 26;
    } else {
      // Strike: ease-out cubic so it's slow leaving the wind-up and slams
      // the rest of the way, arcing back in line with the node by impact.
      const st = Math.min((t - 0.35) / 0.65, 1);
      const ease = 1 - Math.pow(1 - st, 3);
      radius = (restPx * 0.5) + ease * (strikePx - restPx * 0.5);
      arcOffset = 26 * (1 - ease);
    }

    return {
      x: playerCanvasX + ux * radius + perpX * arcOffset,
      y: playerCanvasY + uy * radius + perpY * arcOffset,
      angle: Math.atan2(uy, ux),
      impactFrac: Math.max(0, (t - 0.93) / 0.07) // 0..1 in the last sliver of the cycle, for a brief impact flash
    };
  }

  function drawPickaxeAt(pose, nodeCanvasX, nodeCanvasY) {
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);
    ctx.fillStyle = '#7a5230'; // handle - trails back toward whoever's swinging it
    ctx.fillRect(-24, -3, 20, 6);
    ctx.fillStyle = '#c0c0c0'; // head - leads toward the node
    ctx.fillRect(-4, -8, 22, 16);
    ctx.strokeStyle = '#555';
    ctx.strokeRect(-4, -8, 22, 16);
    ctx.restore();

    if (pose.impactFrac > 0) {
      ctx.save();
      ctx.globalAlpha = pose.impactFrac * 0.6;
      ctx.beginPath();
      ctx.arc(nodeCanvasX, nodeCanvasY, NODE_RADIUS + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Our own pickaxe - one full swing cycle = one hit (see loop() for where
  // that's actually counted). Frozen mid-swing once finalizing/validating,
  // since at that point the session's outcome is up to the server, not
  // another local orbit.
  function drawMiningPickaxe() {
    if (!miningState) return;
    const node = nodes.get(miningState.nodeId);
    if (!node) return; // vanished from the listener already - about to resolve via finalizeMining
    const elapsed = performance.now() - miningState.orbitStartTime;
    const [pcx, pcy] = toCanvas(player.x, player.y);
    const [ncx, ncy] = toCanvas(node.x, node.y);
    const pose = computeSwingPose(pcx, pcy, ncx, ncy, elapsed, miningState.finalizing);
    drawPickaxeAt(pose, ncx, ncy);
  }

  // Every OTHER account currently mining in this cave (see the
  // miningActivity broadcast in connect()) - a dim "ghost" character at
  // their frozen (server-reported) position, labeled with their account,
  // plus their own swing against whichever node they're targeting. This is
  // the whole reason other players are visible at all right now: there's
  // no general player-position sync in this codebase, only this
  // mining-specific broadcast - so someone merely walking around still
  // won't be visible to you, only someone actively mining.
  // Shared ghost-body-plus-label rendering for any other account, whether
  // they're just standing/walking (drawOtherPlayers) or mid-swing
  // (drawOtherMiners) - factored out so both read the same way as each
  // other and as this file's own drawCharacter().
  function drawGhostCharacter(pcx, pcy, label) {
    ctx.beginPath();
    ctx.arc(pcx, pcy, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(150,150,150,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(28,28,28,0.55)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(PLAYER_RADIUS * 0.28)}px sans-serif`;
    ctx.fillText(label, pcx, pcy - PLAYER_RADIUS - 10);
    ctx.textAlign = 'left';
  }

  // Every OTHER account just present in this cave (see the presence
  // broadcast in connect()/sendPresenceIfNeeded()) that ISN'T currently
  // mining - anyone actively mining is drawn by drawOtherMiners() instead
  // (with their swing), so they're skipped here to avoid a double-draw.
  // This is what makes someone merely walking around visible at all - see
  // the file header on why that wasn't true before this pass.
  function drawOtherPlayers() {
    for (const p of otherPlayers.values()) {
      if (otherMiners.has(p.account)) continue;
      if (Date.now() - p.updatedAtMs > PRESENCE_CLIENT_STALE_MS) continue; // defensive - onDisconnect should normally have removed this node already
      const [pcx, pcy] = toCanvas(p.charX, p.charY);
      drawGhostCharacter(pcx, pcy, p.account);
    }
  }

  function drawOtherMiners() {
    for (const miner of otherMiners.values()) {
      const node = nodes.get(miner.nodeId);
      if (!node) continue; // depleted/unknown to us right now - nothing to anchor their swing to

      const [pcx, pcy] = toCanvas(miner.charX, miner.charY);
      const [ncx, ncy] = toCanvas(node.x, node.y);

      drawGhostCharacter(pcx, pcy, miner.account);

      const elapsed = Date.now() - miner.startedAtMs; // server epoch ms - fine even with minor client/server clock drift for a 500ms cycle
      const pose = computeSwingPose(pcx, pcy, ncx, ncy, elapsed, miner.validating);
      drawPickaxeAt(pose, ncx, ncy);
    }
  }

  function loop() {
    if (destroyed) return;
    updateMovement(); // guests move too now; frozen automatically while mining (see updateMovement)
    checkExitTravel();
    updateCamera();
    sendPresenceIfNeeded();

    // Advance the mining swing, if any, and apply any newly-completed
    // orbit(s) as instant local hits. finalizeMining (triggered once HP
    // hits 0) is the only point any of this actually reaches the server.
    // Skipped once finalizing/validating - the swing is frozen mid-strike
    // at that point (see drawMiningPickaxe) and the outcome is up to the
    // server's response, not another local orbit.
    if (miningState && !miningState.finalizing) {
      const elapsed = performance.now() - miningState.orbitStartTime;
      const completedOrbits = Math.floor(elapsed / ORBIT_PERIOD_MS);
      if (completedOrbits > miningState.lastCompletedOrbits) {
        const newHits = completedOrbits - miningState.lastCompletedOrbits;
        miningState.lastCompletedOrbits = completedOrbits;
        miningState.pendingHits += newHits;
        miningState.localStrikesRemaining -= newHits;
        if (miningState.localStrikesRemaining <= 0) finalizeMining();
      }
    }

    const { minX, maxX } = computeClampLimits();
    const touchingWall = (
      player.x <= minX || player.x >= maxX || player.y <= 0 || player.y >= ROOM_SIZE
    );
    if (touchingWall && !wasTouchingWall) {
      // Distinguish "pressed against a locked walkway" from an ordinary
      // wall - the generic message was confusing right next to a visible
      // (but not yet usable) doorway.
      const half = EXIT_WIDTH / 2;
      const inGapY = player.y >= EXIT_CENTER - half && player.y <= EXIT_CENTER + half;
      const lockedExit = inGapY && getExits().find((e) => (
        (e.side === 'west' && player.x <= minX) || (e.side === 'east' && player.x >= maxX)
      ) && e.locked);
      toast(lockedExit ? "🔒 This walkway isn't connected to a cave yet." : 'You hit the cave wall.');
    }
    wasTouchingWall = touchingWall;

    drawFloor();
    drawWalls();
    for (const node of nodes.values()) drawNode(node);
    drawOtherPlayers();
    drawOtherMiners();
    drawCharacter(player.x, player.y, account || '', touchingWall);
    drawMiningPickaxe();
    rafId = requestAnimationFrame(loop);
  }

  connect(currentLocationId);
  rafId = requestAnimationFrame(loop);

  return {
    setLocation(id) { connect(id); },
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (unsubNodes) unsubNodes();
      if (unsubMiningActivity) unsubMiningActivity();
      if (unsubPresenceValue) unsubPresenceValue();
      if (unsubConnected) unsubConnected();
      leavePresence(myPresenceRef);
      canvas.removeEventListener('click', onCanvasClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    }
  };
}
