// public/js/cave-refresh.js
//
// "H:MM:SS until cave refresh" countdown, reading straight off
// sysdata/main.lastSweep the same way inventory.js reads a worker's
// inventory: a live Firestore listener, no polling. sysdata/{doc} is
// world-readable (see firestore.rules), no auth needed - this mounts the
// same way for spectators and registered workers alike.
//
// When the countdown reaches zero, it calls the server's /runSweep
// endpoint once. That endpoint is safe to call speculatively: it just
// no-ops if the hour genuinely hasn't passed yet, or if someone else's
// countdown already triggered it a moment earlier (see
// server/lib/respawn-sweep.js's runSweepIfDue, which claims the sweep
// inside a Firestore transaction) - this file doesn't coordinate that
// itself, it just has to ask, and the server's response feeds back into
// resetting/holding the countdown correctly either way.

import { db, apiFetch } from './firebase-config.js?v=10';
import { doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

// Must match server/lib/respawn-sweep.js's SWEEP_HOURS - there's no
// runtime way to share this constant across the client/server boundary
// here, so if you change one, change the other.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.labelEl - its text content is fully owned by this module
 * @returns {{ destroy(): void }}
 */
export function mountCaveRefreshCountdown({ labelEl }) {
  let nextSweepAtMs = null; // lastSweep + SWEEP_INTERVAL_MS, once we've heard from Firestore
  let triggeredForThisWindow = false; // guards against re-POSTing /runSweep every second once we hit zero

  const sysdataRef = doc(db, 'sysdata', 'main');
  const unsub = onSnapshot(sysdataRef, (snap) => {
    const data = snap.data();
    if (!data || !data.lastSweep) {
      // Never swept yet - due immediately, matching runSweepIfDue()'s own
      // "missing lastSweep = due now" treatment server-side.
      nextSweepAtMs = Date.now();
    } else {
      nextSweepAtMs = data.lastSweep.toMillis() + SWEEP_INTERVAL_MS;
    }
    triggeredForThisWindow = false; // a (new) lastSweep value means a fresh window to count down
  }, (err) => console.error('cave-refresh listener failed:', err));

  function tick() {
    if (nextSweepAtMs === null) return; // haven't heard from Firestore yet
    const remaining = nextSweepAtMs - Date.now();

    if (remaining > 0) {
      labelEl.textContent = `${formatCountdown(remaining)} until cave refresh`;
      return;
    }

    labelEl.textContent = 'Cave refresh pending...';
    if (triggeredForThisWindow) return; // already asked - waiting on the Firestore listener to pick up the new lastSweep
    triggeredForThisWindow = true;

    apiFetch('/runSweep', { method: 'POST' }).catch((err) => {
      console.error('runSweep trigger failed:', err);
      triggeredForThisWindow = false; // let the next tick retry
    });
  }

  tick();
  const intervalId = setInterval(tick, 1000);

  return {
    destroy() {
      clearInterval(intervalId);
      unsub();
    }
  };
}
