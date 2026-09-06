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
// Same Firestore listener approach as before ('location-state' etc. are
// just onSnapshot() on the nodes/throws collections). New in this pass:
// - spectator mode: canvas clicks don't call throwPickaxe and no pickaxe
//   is drawn for the local player; you still see everyone else's nodes
//   and throws update live.
// - destroy()/setLocation() so callers can tear down or switch caves
//   without leaking listeners or stacking requestAnimationFrame loops.
//
// Movement/anti-cheat caveat from before still applies: charX/charY are
// still client-reported, not server-tracked - unchanged in this slice.

import { db, apiFetch } from './firebase-config.js';
import {
  collection, onSnapshot, query, orderBy, limit, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const ROOM_SIZE = 2000;
const CANVAS_SIZE = 800;
const SCALE = CANVAS_SIZE / ROOM_SIZE;
const HIT_RADIUS = 50;
const THROW_LEG_MS = 150;
const MAX_THROW_DISTANCE = 200; // px - must match server/index.js's MAX_THROW_DISTANCE

const ORE_COLORS = {
  stone: '#8a8a8a', iron: '#a5673f', gold: '#e8c547',
  diamond: '#7fe8e0', platinum: '#d8dee9', pesolarium: '#c561e8'
};

export const LOCATION_NAMES = [
  'Crag Hollow', 'Rustrock Cavern', 'Aurum Depths',
  'Shardfall Abyss', 'The Noble Chasm', 'Amaurosis'
];

/**
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLElement} opts.toastEl
 * @param {string} opts.account
 * @param {number} opts.locationId
 * @param {boolean} [opts.spectator] - if true, no pickaxe is drawn/thrown
 *   for the local player; the cave and everyone else's activity still render.
 * @returns {{ setLocation(id:number): void, destroy(): void }}
 */
export function mountMine({ canvas, toastEl, account, locationId, spectator = false }) {
  const ctx = canvas.getContext('2d');

  let currentLocationId = locationId;
  let nodes = new Map(); // nodeId -> node
  const player = { x: 1000, y: 1000 };
  const keys = {};
  let throws = [];
  let unsubNodes = null;
  let unsubThrows = null;
  let rafId = null;
  let destroyed = false;
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

  function connect(id) {
    currentLocationId = id;
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
    player.y = Math.max(0, Math.min(ROOM_SIZE, player.y));
  }

  async function onCanvasClick(e) {
    if (spectator || !account) return; // spectators have no pickaxe to throw
    const rect = canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) / SCALE;
    const clickY = (e.clientY - rect.top) / SCALE;

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
      if (result.depleted) toast(`+1 ${result.oreType} (${result.value} coin value)`);
    } catch (err) {
      console.error('throwPickaxe failed:', err);
    }
  }
  canvas.addEventListener('click', onCanvasClick);

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
    if (!spectator) updateMovement();
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    for (const node of nodes.values()) drawNode(node);
    if (!spectator) drawCharacter(player.x, player.y, account || '');
    drawThrows(performance.now());
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
      if (unsubThrows) unsubThrows();
      canvas.removeEventListener('click', onCanvasClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    }
  };
}
