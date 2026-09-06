// functions/lib/ore-config.js — ported unchanged from the SQL slice.
//
// Spawn points used to be a fixed 12-point grid (gridSpawnPoints), which is
// why nodes always showed up in the same symmetric lattice every location.
// randomSpawnPoints replaces that: it rolls a random node count in
// [minCount, maxCount] and scatters that many points around the room,
// rejecting a candidate that lands too close to one already placed (so
// nodes don't spawn stacked on top of each other) before falling back to
// just accepting it after enough failed attempts, so it always terminates.
//
// This runs once per location at module load (LOCATIONS is built below),
// same timing as the old gridSpawnPoints() calls - the resulting array is
// then reused as-is for the server's lifetime, since node-manager.js
// indexes into config.spawnPoints by position (loc{id}-pt{index}) both when
// seeding and when respawning a depleted node.
function randomSpawnPoints(minCount = 25, maxCount = 50, roomSize = 2000, margin = 150, minSpacing = 90) {
  const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));
  const points = [];

  for (let i = 0; i < count; i++) {
    let point;
    let attempts = 0;
    do {
      point = {
        x: margin + Math.random() * (roomSize - margin * 2),
        y: margin + Math.random() * (roomSize - margin * 2)
      };
      attempts++;
    } while (
      attempts < 20 &&
      points.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < minSpacing)
    );
    points.push(point);
  }

  return points;
}

const RESPAWN_DELAY_MS = 5000;

// Per GAME_SPEC.md: location 0 is free for everyone; 1-5 require the
// worker's on-chain energy_max tier to be at least this much. Mirrored
// client-side in public/js/mining.js (LOCATION_MIN_ENERGY_MAX) for
// drawing locked waypoints - keep both in sync by hand.
const LOCATION_MIN_ENERGY_MAX = [0, 14, 34, 134, 634, 1334];

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
    spawnPoints: randomSpawnPoints()
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
    spawnPoints: randomSpawnPoints()
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
    spawnPoints: randomSpawnPoints()
  },
  3: {
    name: 'Shardfall Abyss',
    baseline: 'diamond',
    tiers: [
      { ore: 'diamond', chance: 0.65 },
      { ore: 'platinum', chance: 0.25 },
      { ore: 'pesolarium', chance: 0.10 }
    ],
    spawnPoints: randomSpawnPoints()
  },
  4: {
    name: 'The Noble Chasm',
    baseline: 'platinum',
    tiers: [
      { ore: 'platinum', chance: 0.75 },
      { ore: 'pesolarium', chance: 0.25 }
    ],
    spawnPoints: randomSpawnPoints()
  },
  5: {
    name: 'Amaurosis',
    baseline: 'pesolarium',
    tiers: [{ ore: 'pesolarium', chance: 1.0 }],
    spawnPoints: randomSpawnPoints()
  }
};

module.exports = { LOCATIONS, RESPAWN_DELAY_MS, LOCATION_MIN_ENERGY_MAX };
