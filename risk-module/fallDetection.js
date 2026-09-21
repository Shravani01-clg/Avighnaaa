/**
 * Fall Detection Algorithm (Standalone)
 *
 * Detects worker falls using 3-axis accelerometer data (m/s²).
 *
 * Physics of a fall:
 *   1. Free-fall phase  — total acceleration drops near 0 (no gravity felt)
 *   2. Impact phase     — sudden spike (3–5x normal gravity)
 *   3. Orientation change — Z axis drops, X/Y picks up (person went from standing to lying)
 *
 * Two detection methods:
 *   - Primary: Free-fall + impact within a time window
 *   - Fallback: Impact spike + orientation change (no free-fall needed)
 */

// ─── Configuration ───────────────────────────────────────────

const THRESHOLDS = {
  // Free-fall detection
  freeFallG: 2.0,          // m/s² — below this = free-fall (normal is ~9.8)
  freeFallMinDuration: 1,  // minimum consecutive readings in free-fall

  // Impact detection
  impactG: 25.0,           // m/s² — above this = hard impact (~2.5g)
  impactWindow: 5,         // max readings between free-fall and impact

  // Orientation change (lying down)
  orientationThreshold: 4.0, // m/s² — change in Z axis from standing

  // Composite
  fallScoreThreshold: 70,  // 0-100 score needed to declare a fall
};

// ─── Fall State Progression ──────────────────────────────────
// Spec (Phase 3): Normal movement → Sudden movement → Possible fall → Fall confirmed

const FALL_STATES = {
  NORMAL: "NORMAL",                 // Normal movement
  SUDDEN_MOVEMENT: "SUDDEN_MOVEMENT", // Jerk/spike detected — watching closely
  POSSIBLE_FALL: "POSSIBLE_FALL",   // Fall signature forming — alert supervisors
  FALL_CONFIRMED: "FALL_CONFIRMED", // Fall algorithm confirmed — emergency
};

// Score at which a fall is considered "possible" (not yet confirmed)
const POSSIBLE_FALL_SCORE = 40;

// ─── State ───────────────────────────────────────────────────

const state = {
  history: [],
  historyMax: 20,
  freeFallStart: null,
  freeFallCount: 0,
  lastFreeFallIndex: null,   // index of last confirmed free-fall reading
  lastImpactIndex: null,
  standingZ: 9.8,
  isLyingDown: false,
  fallConfirmed: false,
  cooldown: 0,
};

// ─── Helpers ─────────────────────────────────────────────────

function totalAccel(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function pushHistory(value) {
  state.history.push(value);
  if (state.history.length > state.historyMax) {
    state.history.shift();
  }
}

// ─── Main Detection ──────────────────────────────────────────

/**
 * Analyze one accelerometer reading and return fall detection result.
 *
 * @param {number} accelX - X axis acceleration (m/s²)
 * @param {number} accelY - Y axis acceleration (m/s²)
 * @param {number} accelZ - Z axis acceleration (m/s²)
 * @returns {{ fallDetected: boolean, fallScore: number, phase: string, details: string }}
 */
function detectFall(accelX, accelY, accelZ) {
  if (state.cooldown > 0) {
    state.cooldown--;
    // Right after a confirmed fall the worker is usually still on the ground
    const fallState = state.isLyingDown ? FALL_STATES.FALL_CONFIRMED : FALL_STATES.NORMAL;
    return { fallDetected: false, fallScore: 0, phase: "cooldown", fallState, details: "Cooldown active" };
  }

  const total = totalAccel(accelX, accelY, accelZ);
  pushHistory(total);

  let fallScore = 0;
  let phases = [];
  let details = [];

  // Phase 1: Free-fall detection
  const isFreeFall = total < THRESHOLDS.freeFallG;

  if (isFreeFall) {
    state.freeFallCount++;
    state.lastFreeFallIndex = state.history.length - 1;
    phases.push("free-fall");

    if (state.freeFallCount >= THRESHOLDS.freeFallMinDuration) {
      fallScore += 40;
      details.push(`Free-fall detected (${state.freeFallCount} readings, ${total.toFixed(1)} m/s²)`);
    }
  } else {
    state.freeFallCount = 0;
  }

  // Phase 2: Impact detection
  const isImpact = total > THRESHOLDS.impactG;

  if (isImpact) {
    phases.push("impact");
    fallScore += 35;
    details.push(`Impact detected (${total.toFixed(1)} m/s²)`);
    state.lastImpactIndex = state.history.length - 1;
  }

  // Free-fall followed by impact (within the window) is THE fall signature —
  // award the window bonus even on the impact reading itself.
  if (state.lastFreeFallIndex !== null && !isFreeFall) {
    const gap = state.history.length - 1 - state.lastFreeFallIndex;
    if (gap <= THRESHOLDS.impactWindow) {
      fallScore += 15;
      details.push("Impact within free-fall window");
    }
  }

  // Phase 3: Orientation change
  const zDelta = Math.abs(state.standingZ - accelZ);
  if (zDelta > THRESHOLDS.orientationThreshold) {
    phases.push("orientation-change");
    fallScore += 25;
    details.push(`Orientation changed (Z: ${accelZ.toFixed(1)}, expected: ${state.standingZ.toFixed(1)})`);
    state.isLyingDown = true;
  } else {
    state.isLyingDown = false;
  }

  // Learn standing baseline
  if (!isFreeFall && !isImpact && zDelta < 1.5) {
    state.standingZ = state.standingZ * 0.99 + accelZ * 0.01;
  }

  // Clear the confirmed flag once the worker is back upright
  if (state.fallConfirmed && state.cooldown === 0 && !state.isLyingDown) {
    state.fallConfirmed = false;
  }

  fallScore = Math.min(fallScore, 100);

  let phase = "normal";
  if (phases.includes("free-fall")) phase = "free-fall";
  if (phases.includes("impact")) phase = "impact";
  if (phases.includes("orientation-change") && phase === "normal") phase = "lying";
  if (phases.length > 1) phase = phases.join("→");

  const fallDetected = fallScore >= THRESHOLDS.fallScoreThreshold;

  if (fallDetected) {
    state.fallConfirmed = true;
    state.cooldown = 10;
    details.push(`FALL CONFIRMED (score: ${fallScore})`);
  }

  // Map composite score + session state to the 4-state progression
  let fallState = FALL_STATES.NORMAL;
  if (fallDetected || (state.fallConfirmed && state.isLyingDown)) {
    fallState = FALL_STATES.FALL_CONFIRMED;
  } else if (fallScore >= POSSIBLE_FALL_SCORE) {
    fallState = FALL_STATES.POSSIBLE_FALL;
  } else if (fallScore > 0) {
    fallState = FALL_STATES.SUDDEN_MOVEMENT;
  }

  return {
    fallDetected,
    fallScore,
    fallState,
    phase,
    details: details.join(" | ") || "Normal acceleration",
    totalAccel: Math.round(total * 100) / 100,
  };
}

function resetState() {
  state.history = [];
  state.freeFallStart = null;
  state.freeFallCount = 0;
  state.lastFreeFallIndex = null;
  state.lastImpactIndex = null;
  state.standingZ = 9.8;
  state.isLyingDown = false;
  state.fallConfirmed = false;
  state.cooldown = 0;
}

module.exports = { detectFall, resetState, THRESHOLDS, FALL_STATES };
