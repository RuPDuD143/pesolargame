// functions/lib/ore-types.js — ported unchanged from the SQL slice.
const ORE_TYPES = {
  stone: { value: 1, strikes: 3 },
  iron: { value: 5, strikes: 15 },
  gold: { value: 25, strikes: 75 },
  diamond: { value: 125, strikes: 375 },
  platinum: { value: 625, strikes: 1875 },
  pesolarium: { value: 3125, strikes: 9375 }
};

module.exports = { ORE_TYPES };
