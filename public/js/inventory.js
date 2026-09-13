// public/js/inventory.js
//
// Bottom-left inventory button + slide-up slot-grid panel (matches the
// reference mockup: dark "Inventory  X" header, grey framed grid of
// square slots below it). Reads live from workers/{account}/inventory
// the same way mining.js reads nodes/throws: straight from the Firestore
// client SDK (see firestore.rules - clients read directly, all writes go
// through the server). No new backend endpoint needed.
//
// Mount once per worker session (index.html's enterWorld() does this);
// call destroy() when leaving the world so the listener doesn't leak.

import { db } from './firebase-config.js?v=12';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { ORE_COLORS } from './mining.js?v=12';

const TOTAL_SLOTS = 35; // 5 columns x 7 rows, matches the reference mockup

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
      <div class="inventory-frame">
        <div id="inventory-grid" class="inventory-grid"></div>
      </div>
    </div>
  `;
  container.appendChild(root);

  const toggleBtn = root.querySelector('#inventory-toggle');
  const panel = root.querySelector('#inventory-panel');
  const closeBtn = root.querySelector('#inventory-close');
  const grid = root.querySelector('#inventory-grid');

  function renderGrid() {
    const filled = [...items.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));
    const slots = [];
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const item = filled[i];
      if (item) {
        slots.push(`
          <div class="inventory-slot filled" title="${item.itemName} ×${item.amount}">
            <div class="inventory-slot-swatch" style="background:${ORE_COLORS[item.itemName] || '#fff'}"></div>
            <span class="inventory-slot-amount">×${item.amount}</span>
          </div>
        `);
      } else {
        slots.push('<div class="inventory-slot"></div>');
      }
    }
    grid.innerHTML = slots.join('');
  }

  function setOpen(next) {
    open = next;
    panel.classList.toggle('hidden', !open);
  }

  toggleBtn.onclick = () => setOpen(!open);
  closeBtn.onclick = () => setOpen(false);
  renderGrid(); // show the empty grid immediately, before the first snapshot arrives

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
