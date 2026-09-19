// public/js/quota-overlay.js
//
// The F3 debug overlay. Exists to answer, at a glance, the question that
// cost a full day of debugging: when something stops working, is the
// code broken, or did the Firestore free quota just run out again?
//
// It pulls server-side operation counts from GET /debugQuota (see
// server/lib/quota-meter.js) and combines them with this tab's own
// direct-to-Firestore reads (see quota-client.js), because the browser
// reads Firestore directly via onSnapshot and the server genuinely
// cannot see any of that.
//
// The numbers are a FLOOR, not a project-wide total, for two reasons
// spelled out in the overlay footer so they can't be misread:
//   - server counts reset whenever the process restarts (Render's free
//     tier spins down when idle), so a fresh-looking number may just
//     mean a recent restart - process uptime is shown alongside;
//   - other people's browsers count their own reads in their own tabs.
// If the overlay says usage is low but Firestore is still returning
// 429s, that combination points at reads this meter can't see rather
// than at the game logic.

import { CONFIG } from './firebase-config.js?v=15';
import { clientQuotaSnapshot } from './quota-client.js?v=15';

const POLL_INTERVAL_MS = 5000;

function fmt(n) {
  return n.toLocaleString();
}

function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Colour shifts green -> amber -> red as a meter fills up. */
function barColor(pct) {
  if (pct >= 90) return '#ff5c5c';
  if (pct >= 70) return '#ffb44c';
  return '#5cd66b';
}

function meterRow(label, used, limit) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return `
    <div class="qo-row">
      <div class="qo-row-head">
        <span>${label}</span>
        <span class="qo-figure">${fmt(used)} <span class="qo-dim">/ ${fmt(limit)} (${pct.toFixed(1)}%)</span></span>
      </div>
      <div class="qo-bar"><div class="qo-bar-fill" style="width:${pct}%;background:${barColor(pct)}"></div></div>
    </div>`;
}

export function mountQuotaOverlay() {
  const el = document.createElement('div');
  el.id = 'quota-overlay';
  // Fixed to the viewport rather than nested near the canvas: the game's
  // existing layout has several stacked positioned ancestors, and a
  // debug panel that silently ends up clipped behind one of them is
  // worse than useless.
  el.style.cssText = [
    'position:fixed', 'top:10px', 'left:10px', 'z-index:9999',
    'width:330px', 'max-width:calc(100vw - 20px)',
    'max-height:calc(100vh - 20px)', 'overflow:auto',
    'background:rgba(8,8,10,0.94)', 'color:#eee',
    'border:1px solid #3a3a3a', 'border-radius:8px',
    'padding:12px 14px', 'display:none',
    "font-family:'SF Mono',Menlo,Consolas,monospace", 'font-size:11.5px',
    'line-height:1.5', 'pointer-events:none', 'white-space:normal'
  ].join(';');

  const style = document.createElement('style');
  style.textContent = `
    #quota-overlay h4 { margin:0 0 8px; font-size:12px; color:#d4af37; letter-spacing:.3px; }
    #quota-overlay .qo-section { margin-bottom:10px; }
    #quota-overlay .qo-section-title { color:#9ecbff; margin-bottom:5px; font-size:11px; }
    #quota-overlay .qo-row { margin-bottom:6px; }
    #quota-overlay .qo-row-head { display:flex; justify-content:space-between; gap:8px; }
    #quota-overlay .qo-figure { white-space:nowrap; }
    #quota-overlay .qo-dim { color:#888; }
    #quota-overlay .qo-bar { height:4px; background:#2a2a2a; border-radius:2px; margin-top:3px; overflow:hidden; }
    #quota-overlay .qo-bar-fill { height:100%; border-radius:2px; transition:width .3s, background .3s; }
    #quota-overlay .qo-kv { display:flex; justify-content:space-between; gap:8px; color:#bbb; }
    #quota-overlay .qo-note { color:#777; font-size:10px; border-top:1px solid #2a2a2a; padding-top:7px; margin-top:9px; }
    #quota-overlay .qo-err { color:#ff8080; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(el);

  let visible = false;
  let pollId = null;
  let serverData = null;
  let serverError = null;

  async function fetchServer() {
    try {
      const res = await fetch(`${CONFIG.API_BASE_URL}/debugQuota`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      serverData = await res.json();
      serverError = null;
    } catch (err) {
      serverError = err.message;
    }
    render();
  }

  function render() {
    if (!visible) return;
    const client = clientQuotaSnapshot();

    let serverHtml;
    if (serverError) {
      serverHtml = `<div class="qo-err">Couldn't reach /debugQuota: ${serverError}</div>
        <div class="qo-dim">If the backend is asleep (Render free tier) the first call can take ~50s.</div>`;
    } else if (!serverData) {
      serverHtml = '<div class="qo-dim">Loading…</div>';
    } else {
      const { counts, limits } = serverData;
      serverHtml =
        meterRow('Reads', counts.reads, limits.reads) +
        meterRow('Writes', counts.writes, limits.writes) +
        meterRow('Deletes', counts.deletes, limits.deletes) +
        `<div class="qo-kv"><span>Server uptime</span><span>${fmtDuration(serverData.serverUptimeMs)}</span></div>
         <div class="qo-kv"><span>Quota resets in</span><span>${fmtDuration(serverData.msUntilPacificMidnight)}</span></div>`;
    }

    const sources = Object.entries(client.bySource).sort((a, b) => b[1] - a[1]);
    const clientHtml =
      `<div class="qo-kv"><span>Reads (this tab)</span><span>${fmt(client.reads)}</span></div>` +
      (sources.length
        ? sources.map(([src, n]) => `<div class="qo-kv"><span class="qo-dim">&nbsp;&nbsp;${src}</span><span class="qo-dim">${fmt(n)}</span></div>`).join('')
        : '<div class="qo-dim">&nbsp;&nbsp;none yet</div>');

    el.innerHTML = `
      <h4>F3 — FIRESTORE QUOTA</h4>
      <div class="qo-section">
        <div class="qo-section-title">Server (all players)</div>
        ${serverHtml}
      </div>
      <div class="qo-section">
        <div class="qo-section-title">This browser tab (direct reads)</div>
        ${clientHtml}
      </div>
      <div class="qo-note">
        Counts are a floor, not a total. Server counts reset on restart
        (free tier sleeps when idle) — check uptime above. Other players'
        browsers count their own reads in their own tabs, not here.
        If these look low but you're still getting errors, the cause is
        reads this meter can't see — not the game logic.
      </div>`;
  }

  function show() {
    visible = true;
    el.style.display = 'block';
    render();
    fetchServer();
    // Only polls while actually open, so an overlay nobody's looking at
    // costs nothing. (These are plain HTTP calls to our own backend -
    // they don't touch Firestore, so the meter never inflates itself.)
    pollId = setInterval(() => { fetchServer(); render(); }, POLL_INTERVAL_MS);
  }

  function hide() {
    visible = false;
    el.style.display = 'none';
    if (pollId) { clearInterval(pollId); pollId = null; }
  }

  return {
    toggle() { visible ? hide() : show(); },
    destroy() {
      hide();
      el.remove();
      style.remove();
    }
  };
}
