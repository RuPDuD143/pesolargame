// functions/lib/energy.js
//
// Ported unchanged from the earlier SQL slice. Same reinterpretation as
// before: "full energy_max regenerates over 24 hours" ->
//   secondsPerPoint = 86400 / energy_max
//   pointsRegenerated = floor(elapsedSeconds / secondsPerPoint)
// Flag me if the intended regen window isn't 24h.

const SECONDS_PER_DAY = 86400;

/**
 * @param {object} worker - Firestore worker doc data: { energy, lastrest (Timestamp), isresting }
 * @param {number} energyMax - from the contract's workers table
 */
function computeEnergyStatus(worker, energyMax) {
  const now = Date.now();
  const lastRestMs = worker.lastrest.toMillis
    ? worker.lastrest.toMillis()
    : new Date(worker.lastrest).getTime();
  const secondsElapsed = Math.max(0, Math.floor((now - lastRestMs) / 1000));

  if (!worker.isresting) {
    return { isResting: false, currentEnergy: worker.energy, secondsElapsed, secondsPerPoint: null };
  }

  const secondsPerPoint = SECONDS_PER_DAY / energyMax;
  const pointsRegenerated = Math.floor(secondsElapsed / secondsPerPoint);
  const currentEnergy = Math.min(energyMax, worker.energy + pointsRegenerated);

  return { isResting: true, currentEnergy, secondsElapsed, secondsPerPoint };
}

module.exports = { computeEnergyStatus, SECONDS_PER_DAY };
