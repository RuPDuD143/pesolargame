// public/js/app.js — same UI flow as before, backend calls swapped for
// Firebase callables. Logic (render functions, stopwatch, eyelid
// transition) is otherwise unchanged from the SQL slice.

import { CONFIG, apiFetch } from './firebase-config.js?v=11';
import * as Wallet from './wallet.js?v=11';
import { mountMine, LOCATION_NAMES } from './mining.js?v=11';
import { mountInventory } from './inventory.js?v=11';
import { mountCaveRefreshCountdown } from './cave-refresh.js?v=11';

const screen = document.getElementById('screen');
let activeMine = null; // torn down whenever we re-render away from the world
let activeInventory = null; // same - only exists while in the world
let activeCaveRefresh = null; // same - the "H:MM:SS until cave refresh" countdown

function render(html) {
  if (activeMine) {
    activeMine.destroy();
    activeMine = null;
  }
  if (activeInventory) {
    activeInventory.destroy();
    activeInventory = null;
  }
  if (activeCaveRefresh) {
    activeCaveRefresh.destroy();
    activeCaveRefresh = null;
  }
  screen.innerHTML = html;
}

function renderLogin() {
  render(`
    <div class="panel">
      <h1>Pesolar Mine</h1>
      <button id="btn-login">Connect Wallet</button>
    </div>
  `);
  document.getElementById('btn-login').onclick = async () => {
    try {
      await Wallet.login();
      boot();
    } catch (err) {
      console.error(err);
      render(`<div class="panel"><p>Login failed or cancelled.</p><button id="retry">Try again</button></div>`);
      document.getElementById('retry').onclick = renderLogin;
    }
  };
}

function renderRegisterChoice(account) {
  render(`
    <div class="panel">
      <h1>Welcome, ${account}</h1>
      <p>You're not registered as a worker yet.</p>
      <button id="btn-register-wax">Register as a Worker - 100 WAX</button>
      <button id="btn-register-pesolar">Register as a Worker - 10,000 PESOLAR</button>
      <button id="btn-spectate" class="secondary">Spectate the Mine</button>
    </div>
  `);
  document.getElementById('btn-register-wax').onclick = () =>
    register(account, CONFIG.WAX_TOKEN_CONTRACT, CONFIG.REGISTER_COST_WAX, CONFIG.REGISTER_MEMO_WAX);
  document.getElementById('btn-register-pesolar').onclick = () =>
    register(account, CONFIG.PESOLAR_TOKEN_CONTRACT, CONFIG.REGISTER_COST_PESOLAR, CONFIG.REGISTER_MEMO_PESOLAR);
  document.getElementById('btn-spectate').onclick = () => enterWorld(account, { spectator: true });
}

async function register(account, tokenContract, quantity, memo) {
  render(`<div class="panel"><p>Confirm the transaction in your wallet...</p></div>`);
  try {
    await Wallet.sendRegistrationTransfer({ tokenContract, quantity, memo });
    render(`<div class="panel"><p>Registered! Setting up your worker...</p></div>`);
    setTimeout(() => checkWorker(account), 2000);
  } catch (err) {
    console.error(err);
    render(`<div class="panel"><p>Transaction failed or was rejected.</p><button id="retry">Back</button></div>`);
    document.getElementById('retry').onclick = () => renderRegisterChoice(account);
  }
}

function renderResting(account, status) {
  render(`
    <div class="panel">
      <h1>Resting</h1>
      <p>Energy: <span id="energy-val">${status.currentEnergy}</span> / ${status.energyMax}</p>
      <p id="stopwatch">00:00:00</p>
      <button id="btn-wake">Wake up</button>
    </div>
  `);

  const startedAt = Date.now() - (status.secondsElapsed || 0) * 1000;
  const stopwatch = document.getElementById('stopwatch');
  const timer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    stopwatch.textContent = `${h}:${m}:${s}`;
  }, 1000);

  document.getElementById('btn-wake').onclick = async () => {
    clearInterval(timer);
    render(`<div class="panel"><p>Waking up...</p></div>`);
    const updated = await apiFetch('/wakeWorker', { method: 'POST', body: { account }, authRequired: true });
    enterWorld(account, { spectator: false, energy: updated.currentEnergy, energyMax: updated.energyMax });
  };
}

function enterWorld(account, { spectator, energy, energyMax }) {
  const energyPct = (!spectator && energyMax) ? Math.max(0, Math.min(100, (energy / energyMax) * 100)) : 0;

  render(`
    <div class="eyelid eyelid-top"></div>
    <div class="eyelid eyelid-bottom"></div>
    <div class="world panel">
      <div class="world-hud">
        <h1>${account}${spectator ? ' [GUEST]' : ''}</h1>
        ${spectator ? '<p>You are spectating - no pickaxe.</p>' : `
          <div class="energy-bar-wrap" title="Energy">
            <div id="energy-bar-fill" class="energy-bar-fill" style="width:${energyPct}%"></div>
          </div>
          <p>Energy: <span id="energy-label-val">${energy}</span> / ${energyMax}</p>
        `}
        <p>Cave: <span id="world-cave-name">${LOCATION_NAMES[0]}</span></p>
        <p id="cave-refresh-label" class="cave-refresh-label"></p>
      </div>
      <div id="world-toast" class="world-toast"></div>
      <canvas id="world-canvas" width="800" height="800"></canvas>
    </div>
  `);
  void document.querySelector('.eyelid-top').offsetHeight;
  document.querySelector('.eyelid-top').classList.add('open');
  document.querySelector('.eyelid-bottom').classList.add('open');

  const canvas = document.getElementById('world-canvas');
  const toastEl = document.getElementById('world-toast');
  const caveNameEl = document.getElementById('world-cave-name');
  activeCaveRefresh = mountCaveRefreshCountdown({ labelEl: document.getElementById('cave-refresh-label') });
  activeMine = mountMine({
    canvas, toastEl, account, locationId: 0, spectator,
    // Walkways (see mining.js's LOCATION_EXITS) replace the old "Cave:"
    // dropdown - this just keeps the HUD label in sync as you walk
    // between caves instead of polling for the current location.
    onLocationChange: (id) => { caveNameEl.textContent = LOCATION_NAMES[id]; },
    // Every landed strike now costs 1 energy server-side - this keeps the
    // bar/label in sync the moment the server confirms it, no polling.
    onEnergyChange: (newEnergy) => {
      const labelEl = document.getElementById('energy-label-val');
      const fillEl = document.getElementById('energy-bar-fill');
      if (labelEl) labelEl.textContent = newEnergy;
      if (fillEl && energyMax) {
        fillEl.style.width = `${Math.max(0, Math.min(100, (newEnergy / energyMax) * 100))}%`;
      }
    }
  });

  // Spectators aren't registered workers, so there's no workers/{account}
  // doc (and no inventory subcollection) to read - only show the button
  // for people who can actually have ore.
  if (!spectator) {
    activeInventory = mountInventory({ container: document.querySelector('.world'), account });
  }
}

async function checkWorker(account) {
  render(`<div class="panel"><p>Checking worker status...</p></div>`);
  const status = await apiFetch(`/getWorkerStatus?account=${encodeURIComponent(account)}`, { authRequired: true });

  if (!status.registered) return renderRegisterChoice(account);
  if (status.isResting) return renderResting(account, status);
  enterWorld(account, { spectator: false, energy: status.currentEnergy, energyMax: status.energyMax });
}

async function boot() {
  const account = Wallet.getAccountName();
  if (account) checkWorker(account);
  else renderLogin();
}

(async function init() {
  render(`<div class="panel"><p>Checking for existing session...</p></div>`);
  try {
    const restored = await Wallet.restoreSession();
    if (restored) return boot();
  } catch (err) {
    console.error('Session restore/identity proof failed:', err);
  }
  renderLogin();
})();
