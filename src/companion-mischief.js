"use strict";

// Pure "mischief" brain for the opt-in "Clawd Alive" companion.
// Trigger detection (cursor lurking, parked cursor, boo), cooldowns, day windows
// and personality weights. No Electron, no timers: the clock, random and hour
// are injected so the runtime arbiter (and tests) stay in control.

const MISCHIEF_IDS = [
  "catch", "pounce", "fakeNap", "poke", "reachClose", "wall",
  "sitEdge", "dayRhythm", "welcome", "stretchBack", "toy",
];

const MISCHIEF_COOLDOWN_MS = {
  catch: 90000,
  pounce: 300000,
  fakeNap: 10800000,
  poke: 1200000,
  reachClose: 3600000,
  wall: 1200000,
  sitEdge: 1200000,
  toy: 1200000,
  welcome: 0,
  stretchBack: 0,
  dayRhythm: 0,
};

// Cursor trigger tuning.
const STILL_PX = 3;
const POUNCE_MIN_PX = 40;
const POUNCE_MAX_PX = 220;
const POUNCE_DWELL_MS = 2500;
const POKE_IDLE_MS = 20000;
const POKE_MIN_CENTER_PX = 300;
const BOO_RANGE_PX = 120;
const LOW_ENERGY = 25;
const OBSERVE_CHANCE = 0.5;

const GLOBAL_COOLDOWN_CALM_MS = 900000; // activity 0
const GLOBAL_COOLDOWN_ACTIVE_MS = 480000; // activity 1

// Reactive triggers never consume (nor are blocked by) the global cooldown.
const REACTIVE_IDS = new Set(["catch", "pounce", "boo", "welcome", "stretchBack"]);
// Autonomous ids that walk across the screen: roam mode only.
const WALKING_IDS = new Set(["poke", "reachClose", "wall", "sitEdge"]);
// Zeroed when the pet is too tired to be jumpy.
const LOW_ENERGY_BLOCKED = new Set(["pounce", "poke", "reachClose", "wall"]);

const AUTONOMOUS_IDS = ["fakeNap", "reachClose", "wall", "sitEdge", "dayRhythm", "toy"];

// Order: balanced, playful, curious, calm, shy.
const WEIGHT_TABLE = {
  fakeNap:    { balanced: 0.2, playful: 1,   curious: 0.2, calm: 0,   shy: 0 },
  reachClose: { balanced: 0.6, playful: 0.8, curious: 1.2, calm: 0.3, shy: 0.4 },
  wall:       { balanced: 0.8, playful: 1,   curious: 1.2, calm: 0.5, shy: 0.6 },
  sitEdge:    { balanced: 0.8, playful: 0.6, curious: 0.6, calm: 1,   shy: 0.8 },
  dayRhythm:  { balanced: 1,   playful: 0.8, curious: 0.8, calm: 1.4, shy: 1 },
  toy:        { balanced: 1,   playful: 1.4, curious: 1,   calm: 1.2, shy: 0.8 },
  pounce:     { balanced: 0.6, playful: 1,   curious: 0.8, calm: 0.2, shy: 0 },
  boo:        { balanced: 0.2, playful: 1,   curious: 0.2, calm: 0,   shy: 0 },
};

const DAY_VARIANTS = {
  morning: ["morningStretch", "coffee"],
  night: ["nightSleepy"],
};
const TOY_VARIANTS = ["toyBall", "toyYoyo", "toyPlane"];

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function personalityRow(id, personality) {
  const row = WEIGHT_TABLE[id];
  if (!row) return null;
  return Object.prototype.hasOwnProperty.call(row, personality) ? row[personality] : row.balanced;
}

// Weight used both as the base pick weight and, for pounce/boo, as the chance
// multiplier when accepting a reactive trigger. Other ids react with weight 1.
function reactWeight(id, personality) {
  const w = personalityRow(id, personality);
  return w === null ? 1 : w;
}

function globalCooldownMs(traits) {
  const activity = clamp(traits && Number.isFinite(traits.activity) ? traits.activity : 0.5, 0, 1);
  return GLOBAL_COOLDOWN_CALM_MS + (GLOBAL_COOLDOWN_ACTIVE_MS - GLOBAL_COOLDOWN_CALM_MS) * activity;
}

function dayWindow(hour) {
  if (hour >= 6 && hour < 10) return "morning";
  if (hour >= 23 || hour < 3) return "night";
  return null;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

// Window key = local calendar date of the window start, so the night window
// 23:00-02:59 belongs to the date it started on (00:00-02:59 maps to the day before).
function windowKey(win, hour, nowMs) {
  const d = new Date(nowMs);
  if (win === "night" && hour < 3) d.setDate(d.getDate() - 1);
  return `${win}:${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Distance from a point to a rectangle: 0 inside, Euclidean to the border outside.
function distanceToRect(x, y, rect) {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function distanceToCenter(x, y, rect) {
  return Math.hypot(x - (rect.x + rect.width / 2), y - (rect.y + rect.height / 2));
}

function createMischiefBrain(options) {
  const opts = options || {};
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const getHour = typeof opts.getHour === "function" ? opts.getHour : () => new Date(now()).getHours();

  let cooldownUntil = {};
  let globalUntil = 0;
  let usedWindows = new Set();
  let lastTraits = null;
  let napping = false;

  // Cursor tracking state.
  let prev = null; // { x, y } of the previous non-null sample
  let stillSince = 0;
  let pokeFired = false;
  let bandSince = null;
  let pounceFired = false;
  let booFired = false;

  function resetCursorState() {
    prev = null;
    stillSince = 0;
    pokeFired = false;
    bandSince = null;
    pounceFired = false;
    booFired = false;
  }

  function observeCursor(sample) {
    if (!sample || !sample.petRect || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return null;
    const t = now();
    const { x, y, petRect } = sample;

    // Stillness is measured against the previous sample.
    const moved = prev ? Math.hypot(x - prev.x, y - prev.y) : Infinity;
    if (moved >= STILL_PX) {
      stillSince = t;
      pokeFired = false;
    }
    prev = { x, y };

    const edge = sample.overPet ? 0 : distanceToRect(x, y, petRect);

    if (napping) {
      // A napping pet only reacts to the cursor sneaking up (boo); no pounce.
      bandSince = null;
      if (edge < BOO_RANGE_PX) {
        if (!booFired) {
          booFired = true;
          return { id: "boo" };
        }
      } else {
        booFired = false;
      }
      return null;
    }
    booFired = false;

    // Pounce: lurking in the band around the pet, outside it, continuously.
    if (!sample.overPet && edge >= POUNCE_MIN_PX && edge <= POUNCE_MAX_PX) {
      if (bandSince === null) bandSince = t;
      if (!pounceFired && t - bandSince >= POUNCE_DWELL_MS) {
        pounceFired = true;
        const cx = petRect.x + petRect.width / 2;
        return { id: "pounce", side: x < cx ? "left" : "right" };
      }
    } else {
      bandSince = null;
      pounceFired = false;
    }

    // Poke: parked cursor far away from the pet.
    if (!pokeFired && t - stillSince >= POKE_IDLE_MS
      && distanceToCenter(x, y, petRect) > POKE_MIN_CENTER_PX) {
      pokeFired = true;
      return { id: "poke", target: { x, y } };
    }
    return null;
  }

  function setNapping(value) {
    napping = !!value;
    booFired = false;
    bandSince = null;
    pounceFired = false;
  }

  function canReact(id, at) {
    const until = cooldownUntil[id];
    return !(until > (Number.isFinite(at) ? at : now()));
  }

  function markPlayed(id, at, traits) {
    const t = Number.isFinite(at) ? at : now();
    cooldownUntil[id] = t + (MISCHIEF_COOLDOWN_MS[id] || 0);
    if (traits) lastTraits = traits;
    if (!REACTIVE_IDS.has(id) && AUTONOMOUS_IDS.concat("poke").includes(id)) {
      globalUntil = t + globalCooldownMs(lastTraits);
    }
    if (id === "dayRhythm") {
      const hour = getHour();
      const win = dayWindow(hour);
      if (win) usedWindows.add(windowKey(win, hour, t));
    }
  }

  function pickVariant(list, available) {
    const open = list.filter((v) => available.has(v));
    if (!open.length) return null;
    return open[Math.min(open.length - 1, Math.floor(random() * open.length))];
  }

  function pickAutonomous(args) {
    const { traits, state, mode, available, personality } = args || {};
    const t = Number.isFinite(args && args.now) ? args.now : now();
    const avail = available || new Set();
    if (traits) lastTraits = traits;
    if (t < globalUntil) return null;

    const mood = (state && state.mood) || {};
    const energy = Number.isFinite(mood.energy) ? mood.energy : 50;

    const hour = getHour();
    const win = dayWindow(hour);
    const winKey = win ? windowKey(win, hour, t) : null;

    const weights = {};
    for (const id of AUTONOMOUS_IDS) {
      let w = personalityRow(id, personality);
      if (!canReact(id, t)) w = 0;
      if (WALKING_IDS.has(id) && mode !== "roam") w = 0;
      if (energy < LOW_ENERGY && LOW_ENERGY_BLOCKED.has(id)) w = 0;
      if (id === "dayRhythm") {
        if (!win || usedWindows.has(winKey)) w = 0;
        else if (!DAY_VARIANTS[win].some((v) => avail.has(v))) w = 0;
      } else if (id === "toy") {
        if (!TOY_VARIANTS.some((v) => avail.has(v))) w = 0;
      } else if (!avail.has(id)) {
        w = 0;
      }
      weights[id] = w;
    }

    let total = 0;
    for (const id of AUTONOMOUS_IDS) total += weights[id];
    if (!(total > 0)) return null;

    // Observe gate: stay quiet half of the time to keep mischief rare.
    if (random() < OBSERVE_CHANCE) return null;

    const target = random() * total;
    let acc = 0;
    let chosen = null;
    for (const id of AUTONOMOUS_IDS) {
      if (!(weights[id] > 0)) continue;
      acc += weights[id];
      chosen = id;
      if (acc > target) break;
    }
    if (!chosen) return null;

    if (chosen === "dayRhythm") return { id: chosen, variant: pickVariant(DAY_VARIANTS[win], avail) };
    if (chosen === "toy") return { id: chosen, variant: pickVariant(TOY_VARIANTS, avail) };
    return { id: chosen };
  }

  function reset() {
    cooldownUntil = {};
    globalUntil = 0;
    usedWindows = new Set();
    lastTraits = null;
    napping = false;
    resetCursorState();
  }

  return { observeCursor, setNapping, pickAutonomous, canReact, markPlayed, reset };
}

module.exports = {
  MISCHIEF_IDS,
  MISCHIEF_COOLDOWN_MS,
  globalCooldownMs,
  dayWindow,
  reactWeight,
  createMischiefBrain,
};
