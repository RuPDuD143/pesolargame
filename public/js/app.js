// public/js/app.js — same UI flow as before, backend calls swapped for
// Firebase callables. Logic (render functions, stopwatch, eyelid
// transition) is otherwise unchanged from the SQL slice.

import { CONFIG, functions, httpsCallable } from './firebase-config.js';
import * as Wallet from './wallet.js';

const getWorkerStatus = httpsCallable(functions, 'getWorkerStatus');
const wakeWorker = httpsCallable(functions, 'wakeWorker');

const screen = document.getElementById('screen');

function render(html) {
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
    register(account, CONFIG.WAX_TOKEN_CONTRACT, CONFIG.REGISTER_COST_WAX);
  document.getElementById('btn-register-pesolar').onclick = () =>
    register(account, CONFIG.PESOLAR_TOKEN_CONTRACT, CONFIG.REGISTER_COST_PESOLAR);
  document.getElementById('btn-spectate').onclick = () => enterWorld(account, { spectator: true });
}

async function register(account, tokenContract, quantity) {
  render(`<div class="panel"><p>Confirm the transaction in your wallet...</p></div>`);
  try {
    await Wallet.sendRegistrationTransfer({ tokenContract, quantity, memo: CONFIG.REGISTER_MEMO });
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
    const { data: updated } = await wakeWorker({ account });
    enterWorld(account, { spectator: false, energy: updated.currentEnergy });
  };
}

function enterWorld(account, { spectator, energy }) {
  render(`
    <div class="eyelid eyelid-top"></div>
    <div class="eyelid eyelid-bottom"></div>
    <div class="world-stub panel">
      <h1>${account}${spectator ? ' [GUEST]' : ''}</h1>
      <p>${spectator ? 'You are spectating - no pickaxe.' : `Energy: ${energy}`}</p>
      <p><em>Game world / house scene loads here.</em></p>
    </div>
  `);
  void document.querySelector('.eyelid-top').offsetHeight;
  document.querySelector('.eyelid-top').classList.add('open');
  document.querySelector('.eyelid-bottom').classList.add('open');
}

async function checkWorker(account) {
  render(`<div class="panel"><p>Checking worker status...</p></div>`);
  const { data: status } = await getWorkerStatus({ account });

  if (!status.registered) return renderRegisterChoice(account);
  if (status.isResting) return renderResting(account, status);
  enterWorld(account, { spectator: false, energy: status.currentEnergy });
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
