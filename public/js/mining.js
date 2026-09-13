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

import { db, apiFetch } from './firebase-config.js?v=13';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

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
  let rafId = null;
  let destroyed = false;

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

  function connect(id) {
    currentLocationId = id;
    nodes = new Map();
    otherMiners = new Map();

    if (unsubNodes) unsubNodes();
    if (unsubMiningActivity) unsubMiningActivity();

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

    if (onLocationChange) onLocationChange(id);
  }

  function onKeyDown(e) {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'Escape' && miningState) finalizeMining();
  }
  function onKeyUp(e) { keys[e.key.toLowerCase()] = false; }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

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
    try {
      await apiFetch('/startMining', {
        method: 'POST',
        authRequired: true,
        body: { account, locationId: currentLocationId, nodeId: node.id, charX: player.x, charY: player.y }
      });
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
        console.error('mineNode failed:', err);
        toast("Mining didn't register - try again.");
      }
    } finally {
      miningState = null; // only now, once the server has actually confirmed one way or another
    }
  }

  async function onCanvasClick(e) {
    if (spectator || !account) return; // guests can move and explore, but can't mine

    if (miningState) {
      // Already mining - a click during an active session cancels it.
      // Progress made so far still gets sent to the server (finalizeMining
      // only skips the network call if literally nothing landed yet).
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
    if (!target) return; // clicked empty ground - nothing to do

    if (distanceToNode(target) > MINING_RANGE) {
      toast('Too far to mine - get closer.');
      return;
    }

    startMining(target);
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

  // Is any OTHER account's broadcast currently validating (i.e. finishing
  // its /mineNode call) against this node? Returns their account name, or
  // null - used so a bystander (or a second concurrent miner) sees
  // "Validating..." too, not just the account whose swing triggered it.
  function otherValidatorFor(nodeId) {
    for (const miner of otherMiners.values()) {
      if (miner.nodeId === nodeId && miner.validating) return miner.account;
    }
    return null;
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
    // server broadcasts the same `validating` flag publicly.
    const otherValidator = !isTarget ? otherValidatorFor(node.id) : null;
    let label;
    if (isTarget && miningState.validating) {
      label = 'Validating...';
    } else if (otherValidator) {
      label = 'Validating...';
    } else {
      const shown = isTarget ? Math.max(0, miningState.localStrikesRemaining) : node.strikesRemaining;
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
  function drawOtherMiners() {
    for (const miner of otherMiners.values()) {
      const node = nodes.get(miner.nodeId);
      if (!node) continue; // depleted/unknown to us right now - nothing to anchor their swing to

      const [pcx, pcy] = toCanvas(miner.charX, miner.charY);
      const [ncx, ncy] = toCanvas(node.x, node.y);

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
      ctx.fillText(miner.account, pcx, pcy - PLAYER_RADIUS - 10);
      ctx.textAlign = 'left';

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
      canvas.removeEventListener('click', onCanvasClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    }
  };
}
