// public/js/inventory.js
//
// Bottom-left inventory button + slide-up panel. Reads live from
// workers/{account}/inventory the same way mining.js reads nodes/throws:
// straight from the Firestore client SDK (see firestore.rules - clients
// read directly, all writes go through the server). No new backend
// endpoint needed for this.
//
// Mount once per worker session (index.html's enterWorld() does this);
// call destroy() when leaving the world so the listener doesn't leak.

import { db } from './firebase-config.js?v=5';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { ORE_COLORS } from './mining.js?v=5';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container - element to mount the button+panel into.
 *   Both are position:fixed, so any container already in the DOM works.
 * @param {string} opts.account
 * @returns {{ destroy(): void }}
 */
export function mountInventory({ container, account }) {
  let items = new Map(); // oreType -> { amount, itemName }
  let open = false;

  const root = document.createElement('div');
  root.className = 'inventory-root';
  root.innerHTML = `
    <button id="inventory-toggle" class="inventory-toggle" aria-label="Open inventory" title="Inventory">🎒</button>
    <div id="inventory-panel" class="inventory-panel hidden">
      <div class="inventory-panel-header">
        <h2>Inventory</h2>
        <button id="inventory-close" class="inventory-close" aria-label="Close inventory">✕</button>
      </div>
      <div id="inventory-grid" class="inventory-grid"></div>
    </div>
  `;
  container.appendChild(root);

  const toggleBtn = root.querySelector('#inventory-toggle');
  const panel = root.querySelector('#inventory-panel');
  const closeBtn = root.querySelector('#inventory-close');
  const grid = root.querySelector('#inventory-grid');

  function renderGrid() {
    if (items.size === 0) {
      grid.innerHTML = '<p class="inventory-empty">No ore mined yet - go strike a node!</p>';
      return;
    }
    grid.innerHTML = [...items.values()]
      .sort((a, b) => a.itemName.localeCompare(b.itemName))
      .map((item) => `
        <div class="inventory-item">
          <div class="inventory-swatch" style="background:${ORE_COLORS[item.itemName] || '#fff'}"></div>
          <div class="inventory-item-name">${item.itemName}</div>
          <div class="inventory-item-amount">×${item.amount}</div>
        </div>
      `).join('');
  }

  function setOpen(next) {
    open = next;
    panel.classList.toggle('hidden', !open);
  }

  toggleBtn.onclick = () => setOpen(!open);
  closeBtn.onclick = () => setOpen(false);
  renderGrid(); // show the "empty" state immediately, before the first snapshot arrives

  const invRef = collection(db, 'workers', account, 'inventory');
  const unsub = onSnapshot(
    invRef,
    (snap) => {
      items = new Map();
      snap.forEach((doc) => {
        const data = doc.data();
        items.set(doc.id, { amount: data.amount || 0, itemName: data.itemName || doc.id });
      });
      renderGrid();
    },
    (err) => console.error('inventory listener failed:', err)
  );

  return {
    destroy() {
      unsub();
      root.remove();
    }
  };
}
