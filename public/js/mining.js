// public/js/mining.js
//
// Mountable mine module (see mountMine() below). This pass adds:
// - a 100px-tall wall band at the top of each room + per-location floor
//   tint (placeholder colors standing in for the real wall/floor asset_id
//   art from GAME_SPEC.md - swap ROOM_THEME for real sprites later)
// - waypoints: walking into one changes location (replaces the old
//   dropdown - see app.js). Gated by energyMax vs LOCATION_MIN_ENERGY_MAX,
//   mirrored here from server/lib/ore-config.js since client and server
//   don't share a module system. Keep these two files in sync by hand.
// - a backpack icon (bottom-left) + live inventory panel, fed by a
//   Firestore listener on workers/{account}/inventory (mirrors the
//   nodes/throws listener pattern already used below)
// - the "ore flies from the node to the backpack" pickup animation, as a
//   plain absolutely-positioned DOM element (not drawn on canvas) so CSS
//   transitions can do the grow/slide/shrink for free

import { db, apiFetch } from './firebase-config.js?v=6';
import {
  collection, onSnapshot, query, orderBy, limit, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const ROOM_SIZE = 2000;
const CANVAS_SIZE = 800;
const SCALE = CANVAS_SIZE / ROOM_SIZE;
const HIT_RADIUS = 50;
const THROW_LEG_MS = 150;
const MAX_THROW_DISTANCE = 200; // px - must match server/index.js's MAX_THROW_DISTANCE
const WALL_HEIGHT = 100; // world units - must match server-side room definition in GAME_SPEC.md
const WAYPOINT_RADIUS = 60; // world units - how close you need to walk to trigger a transition

const ORE_COLORS = {
  stone: '#8a8a8a', iron: '#a5673f', gold: '#e8c547',
  diamond: '#7fe8e0', platinum: '#d8dee9', pesolarium: '#c561e8'
};

export const LOCATION_NAMES = [
  'Crag Hollow', 'Rustrock Cavern', 'Aurum Depths',
  'Shardfall Abyss', 'The Noble Chasm', 'Amaurosis'
];

// Mirrors server/lib/ore-config.js's LOCATION_MIN_ENERGY_MAX - keep in sync.
export const LOCATION_MIN_ENERGY_MAX = [0, 14, 34, 134, 634, 1334];

// Placeholder wall/floor tints per location, standing in for the real
// asset_id-based wall/floor art (asset ids 0/1, 2/3, 4/5, 6/7, 8/9, 10/11
// per GAME_SPEC.md) until that art exists.
const ROOM_THEME = [
  { wall: '#5b5b5b', floor: '#3a3a3a' }, // Crag Hollow - stone
  { wall: '#7a4a2d', floor: '#4a2f1c' }, // Rustrock Cavern - iron
  { wall: '#a8862f', floor: '#5c4a1c' }, // Aurum Depths - gold
  { wall: '#3f9d94', floor: '#204d47' }, // Shardfall Abyss - diamond
  { wall: '#9aa3ad', floor: '#4d525a' }, // The Noble Chasm - platinum
  { wall: '#7a3f9d', floor: '#3d2050' }  // Amaurosis - pesolarium
];

// Simple linear chain: each location waypoints to its neighbors. Walking
// into one attempts a transition to `to`, gated by LOCATION_MIN_ENERGY_MAX[to].
function buildWaypoints(locationId) {
  const points = [];
  if (locationId > 0) points.push({ to: locationId - 1, x: 100, y: 1000 });
  if (locationId < LOCATION_NAMES.length - 1) points.push({ to: locationId + 1, x: ROOM_SIZE - 100, y: 1000 });
  return points;
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLElement} opts.toastEl
 * @param {string} opts.account
 * @param {number} opts.locationId
 * @param {boolean} [opts.spectator] - if true, no pickaxe is drawn/thrown
 *   for the local player; the cave and everyone else's activity still render.
 * @param {number} [opts.energyMax] - gates which waypoints the player can
 *   actually walk through (0 for spectators, so they're confined to
 *   wherever they were dropped - normally location 0, which is free for everyone).
 * @param {(toLocationId:number, name:string) => void} [opts.onLocationChange] -
 *   called right after a successful waypoint transition (or a manual
 *   setLocation() call) so the caller can update a HUD label.
 * @returns {{ setLocation(id:number): void, destroy(): void }}
 */
export function mountMine({ canvas, toastEl, account, locationId, spectator = false, energyMax = 0, onLocationChange }) {
  const ctx = canvas.getContext('2d');

  let currentLocationId = locationId;
  let nodes = new Map(); // nodeId -> node
  let waypoints = buildWaypoints(locationId);
  const player = { x: 1000, y: 1000 };
  const keys = {};
  let throws = [];
  let unsubNodes = null;
  let unsubThrows = null;
  let unsubInventory = null;
  let rafId = null;
  let destroyed = false;
  let transitioning = false; // true while a waypoint fade/swap is in flight - blocks re-triggering
  // Reset per connect() (see below), not just once at mount - otherwise
  // switching locations and switching back replays that location's whole
  // recent throw history in one burst, since a fresh onSnapshot() always
  // reports its initial docs as 'added'.
  let sessionStartedAt = Timestamp.now();

  function toast(msg) {
    const div = document.createElement('div');
    div.textContent = msg;
    toastEl.appendChild(div);
    setTimeout(() => div.remove(), 2500);
  }

  function toCanvas(x, y) {
    return [x * SCALE, y * SCALE];
  }

  // --- Backpack UI ---------------------------------------------------
  // Fixed HUD elements, independent of whichever location is mounted.
  // Owned entirely by this module and cleaned up in destroy().

  const backpackBtn = document.createElement('button');
  backpackBtn.className = 'backpack-btn';
  backpackBtn.textContent = '🎒';
  backpackBtn.title = 'Inventory';

  const backpackPanel = document.createElement('div');
  backpackPanel.className = 'backpack-panel hidden';
  backpackPanel.innerHTML = '<h3>Inventory</h3><div class="backpack-list">Nothing mined yet.</div>';

  const fxLayer = document.createElement('div');
  fxLayer.className = 'fx-layer';

  if (!spectator) {
    document.body.appendChild(backpackBtn);
    document.body.appendChild(backpackPanel);
  }
  document.body.appendChild(fxLayer);

  backpackBtn.onclick = () => backpackPanel.classList.toggle('hidden');

  let inventory = {}; // oreType -> amount
  function renderInventory() {
    const list = backpackPanel.querySelector('.backpack-list');
    const entries = Object.entries(inventory).filter(([, amount]) => amount > 0);
    if (entries.length === 0) {
      list.innerHTML = 'Nothing mined yet.';
      return;
    }
    list.innerHTML = entries
      .map(([oreType, amount]) => `
        <div class="backpack-row">
          <span class="backpack-swatch" style="background:${ORE_COLORS[oreType] || '#fff'}"></span>
          <span class="backpack-name">${oreType}</span>
          <span class="backpack-amount">${amount}</span>
        </div>
      `)
      .join('');
  }

  if (!spectator) {
    const invRef = collection(db, 'workers', account, 'inventory');
    unsubInventory = onSnapshot(invRef, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type === 'removed') {
          delete inventory[change.doc.id];
        } else {
          inventory[change.doc.id] = change.doc.data().amount || 0;
        }
      });
      renderInventory();
    });
  }

  /** Animates a small ore swatch flying from a world position to the backpack icon, then removes itself. */
  function flyOreToBackpack(worldX, worldY, oreType) {
    const canvasRect = canvas.getBoundingClientRect();
    const [cx, cy] = toCanvas(worldX, worldY);
    const startX = canvasRect.left + cx * (canvasRect.width / canvas.width);
    const startY = canvasRect.top + cy * (canvasRect.height / canvas.height);
    const backpackRect = backpackBtn.getBoundingClientRect();
    const endX = backpackRect.left + backpackRect.width / 2;
    const endY = backpackRect.top + backpackRect.height / 2;

    const el = document.createElement('div');
    el.className = 'fx-ore';
    el.style.background = ORE_COLORS[oreType] || '#fff';
    el.style.left = `${startX}px`;
    el.style.top = `${startY}px`;
    fxLayer.appendChild(el);

    // Grow first (two rAFs so the initial styles are committed before we
    // change them, otherwise the browser coalesces both into one frame
    // and there's nothing to transition from).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transform = 'translate(-50%, -50%) scale(1.6)';
        setTimeout(() => {
          el.style.left = `${endX}px`;
          el.style.top = `${endY}px`;
          el.style.transform = 'translate(-50%, -50%) scale(0.2)';
          el.style.opacity = '0';
        }, 150);
      });
    });
    setTimeout(() => el.remove(), 750);
  }

  // --- Location connect ------------------------------------------------

  function connect(id) {
    currentLocationId = id;
    waypoints = buildWaypoints(id);
    nodes = new Map();
    throws = [];
    sessionStartedAt = Timestamp.now(); // fresh cutoff for *this* join, see note above

    if (unsubNodes) unsubNodes();
    if (unsubThrows) unsubThrows();

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

    // Only react to throws added after we joined, so we don't replay history.
    const throwsRef = query(
      collection(db, 'locations', String(currentLocationId), 'throws'),
      orderBy('createdAt', 'desc'),
      limit(20)
    );
    unsubThrows = onSnapshot(throwsRef, (snap) => {
      snap.docChanges().forEach((change) => {
        if (change.type !== 'added') return;
        const t = change.doc.data();
        if (!t.createdAt || t.createdAt.toMillis() < sessionStartedAt.toMillis()) return;
        // Our own throws are already animated optimistically in
        // onCanvasClick below - pushing them again here (using the
        // server's clamped/corrected coordinates) is what caused the
        // "throws far, snaps back, then throws again at the right
        // length" double-animation.
        if (t.account === account) return;
        throws.push({ thrower: t.account, fromX: t.fromX, fromY: t.fromY, toX: t.toX, toY: t.toY, start: performance.now() });
      });
    });
  }

  function onKeyDown(e) { keys[e.key.toLowerCase()] = true; }
  function onKeyUp(e) { keys[e.key.toLowerCase()] = false; }
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  function updateMovement() {
    const speed = 4;
    if (keys['w']) player.y -= speed;
    if (keys['s']) player.y += speed;
    if (keys['a']) player.x -= speed;
    if (keys['d']) player.x += speed;
    player.x = Math.max(0, Math.min(ROOM_SIZE, player.x));
    // The top WALL_HEIGHT px are wall, not floor - can't walk into it.
    player.y = Math.max(WALL_HEIGHT, Math.min(ROOM_SIZE, player.y));
  }

  /** Checks whether the player has walked into a waypoint and, if eligible, transitions. */
  function checkWaypoints() {
    if (transitioning) return;
    for (const wp of waypoints) {
      if (Math.hypot(player.x - wp.x, player.y - wp.y) <= WAYPOINT_RADIUS) {
        attemptTransition(wp.to);
        return;
      }
    }
  }

  function attemptTransition(toLocationId) {
    const required = LOCATION_MIN_ENERGY_MAX[toLocationId] || 0;
    if (energyMax < required) {
      toast(`Requires energy_max \u2265 ${required} to enter ${LOCATION_NAMES[toLocationId]}`);
      return;
    }
    transitioning = true;
    connect(toLocationId);
    // Re-spawn a little inside the room, away from the waypoint we just
    // walked into, so we don't immediately re-trigger it going the other way.
    player.x = toLocationId > currentLocationId ? 250 : ROOM_SIZE - 250;
    player.y = 1000;
    if (onLocationChange) onLocationChange(toLocationId, LOCATION_NAMES[toLocationId]);
    setTimeout(() => { transitioning = false; }, 500);
  }

  async function onCanvasClick(e) {
    if (spectator || !account) return; // spectators have no pickaxe to throw
    const rect = canvas.getBoundingClientRect();
    // canvas.width/height is the fixed internal drawing resolution (800x800),
    // but rect.width/height is however big CSS actually renders it on screen
    // (#world-canvas has max-width:90vmin/max-height:70vh, so on most
    // screens it's shown smaller than 800px). Dividing straight by the
    // constant SCALE assumed rect size === CANVAS_SIZE, so on any screen
    // where CSS shrinks the canvas, clicks landed on the wrong world
    // coordinate - the pickaxe flew off toward a spot near, but not at,
    // the cursor, and near-miss clicks on a node never found it within
    // HIT_RADIUS. Converting through the *actual* displayed size first
    // fixes both.
    const displayToInternalX = canvas.width / rect.width;
    const displayToInternalY = canvas.height / rect.height;
    const clickX = ((e.clientX - rect.left) * displayToInternalX) / SCALE;
    const clickY = ((e.clientY - rect.top) * displayToInternalY) / SCALE;

    let target = null;
    let bestDist = HIT_RADIUS;
    for (const node of nodes.values()) {
      const d = Math.hypot(node.x - clickX, node.y - clickY);
      if (d < bestDist) {
        bestDist = d;
        target = node;
      }
    }

    const targetX = target ? target.x : clickX;
    const targetY = target ? target.y : clickY;

    // Clamp the same way the server does before animating - otherwise a
    // far-off click animates a full-length throw locally, then a second,
    // shorter "corrected" one once the server's clamped result comes back.
    const dx = targetX - player.x;
    const dy = targetY - player.y;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, MAX_THROW_DISTANCE);
    const angle = Math.atan2(dy, dx);
    const finalX = player.x + Math.cos(angle) * clampedDist;
    const finalY = player.y + Math.sin(angle) * clampedDist;

    // Optimistic local animation - server broadcast (via the throws
    // listener) will also show this to other players.
    throws.push({ thrower: account, fromX: player.x, fromY: player.y, toX: finalX, toY: finalY, start: performance.now() });

    try {
      const result = await apiFetch('/throwPickaxe', {
        method: 'POST',
        authRequired: true,
        body: { account, locationId: currentLocationId, nodeId: target ? target.id : null, charX: player.x, charY: player.y, targetX, targetY }
      });
      if (result.depleted) {
        toast(`+1 ${result.oreType} (${result.value} coin value)`);
        flyOreToBackpack(target ? target.x : finalX, target ? target.y : finalY, result.oreType);
      }
    } catch (err) {
      console.error('throwPickaxe failed:', err);
    }
  }
  canvas.addEventListener('click', onCanvasClick);

  function drawRoom() {
    const theme = ROOM_THEME[currentLocationId] || ROOM_THEME[0];
    ctx.fillStyle = theme.floor;
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.fillStyle = theme.wall;
    ctx.fillRect(0, 0, CANVAS_SIZE, WALL_HEIGHT * SCALE);
  }

  function drawWaypoints() {
    for (const wp of waypoints) {
      const [cx, cy] = toCanvas(wp.x, wp.y);
      const required = LOCATION_MIN_ENERGY_MAX[wp.to] || 0;
      const locked = energyMax < required;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = locked ? '#552222' : '#d4af37';
      ctx.fillRect(-14, -14, 28, 28);
      ctx.strokeStyle = '#000';
      ctx.strokeRect(-14, -14, 28, 28);
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      const label = locked ? `${LOCATION_NAMES[wp.to]} (needs ${required})` : LOCATION_NAMES[wp.to];
      ctx.fillText(label, cx, cy - 22);
      ctx.textAlign = 'left';
    }
  }

  function drawNode(node) {
    const [cx, cy] = toCanvas(node.x, node.y);
    const color = ORE_COLORS[node.oreType] || '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();

    const pct = node.strikesRemaining / node.maxStrikes;
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - 16, cy - 24, 32, 4);
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(cx - 16, cy - 24, 32 * pct, 4);
  }

  function drawCharacter(x, y, label) {
    const [cx, cy] = toCanvas(x, y);
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = spectator ? '#999' : '#3aa0ff';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '10px sans-serif';
    ctx.fillText(label, cx - 10, cy - 14);
  }

  function drawThrows(now) {
    throws = throws.filter((t) => now - t.start < THROW_LEG_MS * 2);
    for (const t of throws) {
      const elapsed = now - t.start;
      let px, py;
      if (elapsed < THROW_LEG_MS) {
        const progress = elapsed / THROW_LEG_MS;
        px = t.fromX + (t.toX - t.fromX) * progress;
        py = t.fromY + (t.toY - t.fromY) * progress;
      } else {
        const progress = (elapsed - THROW_LEG_MS) / THROW_LEG_MS;
        px = t.toX + (t.fromX - t.toX) * progress;
        py = t.toY + (t.fromY - t.toY) * progress;
      }
      const [cx, cy] = toCanvas(px, py);
      const size = 50 * SCALE;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = '#c0c0c0';
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.strokeStyle = '#555';
      ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.restore();
    }
  }

  function loop() {
    if (destroyed) return;
    if (!spectator) {
      updateMovement();
      checkWaypoints();
    }
    drawRoom();
    drawWaypoints();
    for (const node of nodes.values()) drawNode(node);
    if (!spectator) drawCharacter(player.x, player.y, account || '');
    drawThrows(performance.now());
    rafId = requestAnimationFrame(loop);
  }

  connect(currentLocationId);
  rafId = requestAnimationFrame(loop);

  return {
    setLocation(id) {
      connect(id);
      if (onLocationChange) onLocationChange(id, LOCATION_NAMES[id]);
    },
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (unsubNodes) unsubNodes();
      if (unsubThrows) unsubThrows();
      if (unsubInventory) unsubInventory();
      canvas.removeEventListener('click', onCanvasClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      backpackBtn.remove();
      backpackPanel.remove();
      fxLayer.remove();
    }
  };
}
