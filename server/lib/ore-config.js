// functions/lib/ore-config.js — ported unchanged from the SQL slice.
// Spawn point coordinates are still a placeholder 12-point grid; swap
// SPAWN_POINTS for hand-placed coordinates whenever you have them.

function gridSpawnPoints(count = 12, roomSize = 2000, margin = 200) {
  const points = [];
  const cols = 4;
  const rows = Math.ceil(count / cols);
  const stepX = (roomSize - margin * 2) / (cols - 1);
  const stepY = (roomSize - margin * 2) / (rows - 1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (points.length >= count) break;
      points.push({ x: margin + c * stepX, y: margin + r * stepY });
    }
  }
  return points;
}

const RESPAWN_DELAY_MS = 5000;

const LOCATIONS = {
  0: {
    name: 'Crag Hollow',
    baseline: 'stone',
    tiers: [
      { ore: 'stone', chance: 0.60 },
      { ore: 'iron', chance: 0.25 },
      { ore: 'gold', chance: 0.10 },
      { ore: 'diamond', chance: 0.03 },
      { ore: 'platinum', chance: 0.015 },
      { ore: 'pesolarium', chance: 0.005 }
    ],
    spawnPoints: gridSpawnPoints()
  },
  1: {
    name: 'Rustrock Cavern',
    baseline: 'iron',
    tiers: [
      { ore: 'iron', chance: 0.605 },
      { ore: 'gold', chance: 0.25 },
      { ore: 'diamond', chance: 0.10 },
      { ore: 'platinum', chance: 0.03 },
      { ore: 'pesolarium', chance: 0.015 }
    ],
    spawnPoints: gridSpawnPoints()
  },
  2: {
    name: 'Aurum Depths',
    baseline: 'gold',
    tiers: [
      { ore: 'gold', chance: 0.62 },
      { ore: 'diamond', chance: 0.25 },
      { ore: 'platinum', chance: 0.10 },
      { ore: 'pesolarium', chance: 0.03 }
    ],
    spawnPoints: gridSpawnPoints()
  },
  3: {
    name: 'Shardfall Abyss',
    baseline: 'diamond',
    tiers: [
      { ore: 'diamond', chance: 0.65 },
      { ore: 'platinum', chance: 0.25 },
      { ore: 'pesolarium', chance: 0.10 }
    ],
    spawnPoints: gridSpawnPoints()
  },
  4: {
    name: 'The Noble Chasm',
    baseline: 'platinum',
    tiers: [
      { ore: 'platinum', chance: 0.75 },
      { ore: 'pesolarium', chance: 0.25 }
    ],
    spawnPoints: gridSpawnPoints()
  },
  5: {
    name: 'Amaurosis',
    baseline: 'pesolarium',
    tiers: [{ ore: 'pesolarium', chance: 1.0 }],
    spawnPoints: gridSpawnPoints()
  }
};

module.exports = { LOCATIONS, RESPAWN_DELAY_MS };
