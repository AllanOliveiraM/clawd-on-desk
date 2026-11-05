"use strict";

// Pure petting-gesture detector. Fed with pointermove coordinates while the
// cursor hovers the pet (no button pressed). Owns no timers: the caller polls.
// Loaded both via require() (tests) and as a plain <script> (hit window).
(function () {
  const PET_STROKE = Object.freeze({
    minAmplitudePx: 12,
    jitterPx: 3,
    reversalsToStart: 3,
    windowMs: 1500,
    continueEveryMs: 1000,
    endAfterMs: 1000,
  });

  function createPetStrokeDetector({ now = Date.now } = {}) {
    let lastX = null;
    let dir = 0;            // current leg direction: -1, 0 (none), 1
    let legStart = 0;       // x where the current leg began
    let prevLeg = null;     // last counted leg, kept to absorb backsteps
    let legCounted = false; // current leg already reached minAmplitudePx
    let reversals = [];     // timestamps within windowMs (bounded)
    let active = false;
    let lastEmitAt = 0;
    let lastReversalAt = 0;
    let newReversal = false; // reversal seen since the last emitted event

    function reset() {
      lastX = null;
      dir = 0;
      legStart = 0;
      legCounted = false;
      prevLeg = null;
      reversals = [];
      active = false;
      lastEmitAt = 0;
      lastReversalAt = 0;
      newReversal = false;
    }

    function feed(x /* , y: vertical motion never counts */) {
      const t = now();
      if (lastX === null) {
        lastX = x;
        return null;
      }
      const dx = x - lastX;
      if (Math.abs(dx) >= PET_STROKE.jitterPx) {
        const s = dx > 0 ? 1 : -1;
        if (dir !== 0 && s !== dir) {
          if (legCounted) {
            // Remember the finished counted leg: a short backstep must not
            // end it for good. legStart uses the last accepted sample (the
            // extreme of the leg that just ended), not the jittery raw x.
            prevLeg = { dir, start: legStart };
            legStart = lastX;
            legCounted = false;
          } else if (prevLeg && s === prevLeg.dir) {
            // Sub-amplitude wobble against a counted leg: resume that leg
            // from its true start so it is not recounted.
            legStart = prevLeg.start;
            legCounted = true;
            prevLeg = null;
          } else {
            prevLeg = null;
            legStart = lastX;
            legCounted = false;
          }
        } else if (dir === 0) {
          legStart = lastX;
        }
        dir = s;
        lastX = x;
        // A stroke counts once its leg reaches the minimum amplitude.
        if (!legCounted && Math.abs(x - legStart) >= PET_STROKE.minAmplitudePx) {
          legCounted = true;
          reversals.push(t);
          lastReversalAt = t;
          newReversal = true;
        }
      }
      const cutoff = t - PET_STROKE.windowMs;
      if (reversals.length && reversals[0] < cutoff) {
        reversals = reversals.filter((r) => r >= cutoff);
      }
      if (!active) {
        if (reversals.length >= PET_STROKE.reversalsToStart) {
          active = true;
          lastEmitAt = t;
          newReversal = false;
          return "pet-start";
        }
        return null;
      }
      if (newReversal && t - lastEmitAt >= PET_STROKE.continueEveryMs) {
        lastEmitAt = t;
        newReversal = false;
        return "pet-continue";
      }
      return null;
    }

    function poll() {
      if (active && now() - lastReversalAt >= PET_STROKE.endAfterMs) {
        reset();
        return "pet-end";
      }
      return null;
    }

    // The cursor came back after a brief exit: the session gets a fresh end
    // delay, since no reversal could be seen while it was out.
    function touch() {
      if (active) lastReversalAt = now();
    }

    return { feed, poll, reset, touch, isActive: () => active };
  }

  const api = { createPetStrokeDetector, PET_STROKE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.ClawdPetStrokeDetector = api;
})();
