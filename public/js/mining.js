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

import { db, apiFetch } from './firebase-config.js?v=12';
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
  let rafId = null;
  let destroyed = false;

  // Active mining session, or null when idle/moving freely. localStrikesRemaining
  // is the client's own running prediction of the node's HP (see loop()'s
  // orbit-completion check below) - only pendingHits actually gets sent to
  // the server, once, when the session ends (see finalizeMining).
  let miningState = null;

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

    if (unsubNodes) unsubNodes();

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
        lastCompletedOrbits: 0
      };
    } catch (err) {
      toast(err.message === 'out_of_range' ? 'Too far to mine - get closer.' : "Can't mine that right now.");
    }
  }

  // Ends the current mining session, however it ended (finished or
  // cancelled), and syncs whatever hits actually landed with the server -
  // this is the ONLY network call a whole session makes, no matter how
  // many orbits/hits happened locally.
  async function finalizeMining() {
    if (!miningState) return;
    const { nodeId, pendingHits } = miningState;
    miningState = null; // stop orbiting immediately - don't wait on the network for that

    if (pendingHits === 0) return; // cancelled before completing even one orbit - nothing to sync

    try {
      const result = await apiFetch('/mineNode', {
        method: 'POST',
        authRequired: true,
        body: { account, locationId: currentLocationId, nodeId, hitCount: pendingHits }
      });
      if (result.depleted) toast(`+1 ${result.oreType} (${result.value} coin value)`);
      if (typeof result.energy === 'number' && onEnergyChange) onEnergyChange(result.energy);
    } catch (err) {
      if (err.message === 'no_energy') {
        toast('⚡ Out of energy - go rest to recover.');
      } else {
        console.error('mineNode failed:', err);
        toast("Mining didn't register - try again.");
      }
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
    const shown = isTarget ? Math.max(0, miningState.localStrikesRemaining) : node.strikesRemaining;
    const label = `${shown}/${node.maxStrikes}`;
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
      ctx.fillText('Mining... click or Esc to cancel', cx, cy + PLAYER_RADIUS + 26);
    }
    ctx.textAlign = 'left';
  }

  // The orbiting pickaxe - one full revolution = one hit (see loop() for
  // where that's actually counted). Purely visual; only one can ever
  // exist per character since starting a session requires not already
  // being in one.
  function drawMiningPickaxe() {
    if (!miningState) return;
    const elapsed = performance.now() - miningState.orbitStartTime;
    const angle = ((elapsed % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS) * Math.PI * 2;
    const [cx, cy] = toCanvas(player.x, player.y);
    const orbitRadiusPx = PLAYER_RADIUS * 1.5;
    const px = cx + Math.cos(angle) * orbitRadiusPx;
    const py = cy + Math.sin(angle) * orbitRadiusPx;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(-8, -14, 16, 28);
    ctx.strokeStyle = '#555';
    ctx.strokeRect(-8, -14, 16, 28);
    ctx.restore();
  }

  function loop() {
    if (destroyed) return;
    updateMovement(); // guests move too now; frozen automatically while mining (see updateMovement)
    checkExitTravel();
    updateCamera();

    // Advance the mining swing, if any, and apply any newly-completed
    // orbit(s) as instant local hits. finalizeMining (triggered once HP
    // hits 0) is the only point any of this actually reaches the server.
    if (miningState) {
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
      canvas.removeEventListener('click', onCanvasClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    }
  };
}
