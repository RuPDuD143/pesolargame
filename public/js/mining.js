// public/js/mining.js
//
// Same rendering/animation code as the Socket.io version. What changed:
// - 'location-state' + 'node-struck' + 'node-depleted' + 'node-spawned'
//   socket events are now just one onSnapshot() listener on the nodes
//   collection - Firestore tells us what changed via docChanges().
// - 'pickaxe-thrown' broadcasts are a listener on the 'throws'
//   subcollection, filtered to only 'added' docs so we don't replay old
//   throws when first connecting.
// - 'throw-pickaxe' emit is now a single throwPickaxe() callable.
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

const ORE_COLORS = {
  stone: '#8a8a8a', iron: '#a5673f', gold: '#e8c547',
  diamond: '#7fe8e0', platinum: '#d8dee9', pesolarium: '#c561e8'
};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const toastEl = document.getElementById('toast');

let account = null;
let locationId = 0;
let nodes = new Map(); // nodeId -> node
let player = { x: 1000, y: 1000 };
const keys = {};
let throws = [];
let unsubNodes = null;
let unsubThrows = null;
const sessionStartedAt = Timestamp.now();

function toast(msg) {
  const div = document.createElement('div');
  div.textContent = msg;
  toastEl.appendChild(div);
  setTimeout(() => div.remove(), 2500);
}

function toCanvas(x, y) {
  return [x * SCALE, y * SCALE];
}

function connect() {
  account = document.getElementById('account').value.trim() || 'player1';
  locationId = Number(document.getElementById('location').value);
  nodes = new Map();
  throws = [];

  if (unsubNodes) unsubNodes();
  if (unsubThrows) unsubThrows();

  const nodesRef = collection(db, 'locations', String(locationId), 'nodes');
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
    collection(db, 'locations', String(locationId), 'throws'),
    orderBy('createdAt', 'desc'),
    limit(20)
  );
  unsubThrows = onSnapshot(throwsRef, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      const t = change.doc.data();
      if (!t.createdAt || t.createdAt.toMillis() < sessionStartedAt.toMillis()) return;
      throws.push({ thrower: t.account, fromX: t.fromX, fromY: t.fromY, toX: t.toX, toY: t.toY, start: performance.now() });
      if (t.account === account) return; // our own throw already animates optimistically below
    });
  });
}

document.getElementById('join').onclick = connect;

window.addEventListener('keydown', (e) => (keys[e.key.toLowerCase()] = true));
window.addEventListener('keyup', (e) => (keys[e.key.toLowerCase()] = false));

function updateMovement() {
  const speed = 4;
  if (keys['w']) player.y -= speed;
  if (keys['s']) player.y += speed;
  if (keys['a']) player.x -= speed;
  if (keys['d']) player.x += speed;
  player.x = Math.max(0, Math.min(ROOM_SIZE, player.x));
  player.y = Math.max(0, Math.min(ROOM_SIZE, player.y));
}

canvas.addEventListener('click', async (e) => {
  if (!account) return;
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

  // Optimistic local animation - server broadcast (via the throws
  // listener) will also show this to other players.
  throws.push({ thrower: account, fromX: player.x, fromY: player.y, toX: targetX, toY: targetY, start: performance.now() });

  try {
    const result = await apiFetch('/throwPickaxe', {
      method: 'POST',
      authRequired: true,
      body: { account, locationId, nodeId: target ? target.id : null, charX: player.x, charY: player.y, targetX, targetY }
    });
    if (result.depleted) toast(`+1 ${result.oreType} (${result.value} coin value)`);
  } catch (err) {
    console.error('throwPickaxe failed:', err);
  }
});

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
  ctx.fillStyle = '#3aa0ff';
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
  updateMovement();
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  for (const node of nodes.values()) drawNode(node);
  drawCharacter(player.x, player.y, account || '');
  drawThrows(performance.now());
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
