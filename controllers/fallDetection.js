/**
 * Fall Detection Algorithm
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
  fallScoreThreshold: 70,  // 0-100 score needed to declare a fall (requires impact for confirmation)
};

// ─── State ───────────────────────────────────────────────────

const state = {
  // Ring buffer of recent acceleration magnitudes
  history: [],
  historyMax: 20,

  // Phase tracking
  freeFallStart: null,       // index where free-fall started
  freeFallCount: 0,          // consecutive free-fall readings
  lastImpactIndex: null,     // index of last impact detected
  standingZ: 9.8,            // baseline Z when standing (learned from normal data)
  isLyingDown: false,
  fallConfirmed: false,
  cooldown: 0,               // readings to wait before next fall detection
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
  // Cooldown after a fall is detected
  if (state.cooldown > 0) {
    state.cooldown--;
    return { fallDetected: false, fallScore: 0, phase: "cooldown", details: "Cooldown active" };
  }

  const total = totalAccel(accelX, accelY, accelZ);
  pushHistory(total);

  let fallScore = 0;
  let phases = [];
  let details = [];

  // ── Phase 1: Free-fall detection ──
  const isFreeFall = total < THRESHOLDS.freeFallG;

  if (isFreeFall) {
    state.freeFallCount++;
    phases.push("free-fall");

    if (state.freeFallCount >= THRESHOLDS.freeFallMinDuration) {
      // Strong free-fall signal
      fallScore += 40;
      details.push(`Free-fall detected (${state.freeFallCount} readings, ${total.toFixed(1)} m/s²)`);
    }
  } else {
    // Check if we just exited free-fall (impact might be happening)
    if (state.freeFallCount >= THRESHOLDS.freeFallMinDuration) {
      state.lastImpactIndex = state.history.length - 1;
    }
    state.freeFallCount = 0;
  }

  // ── Phase 2: Impact detection ──
  const isImpact = total > THRESHOLDS.impactG;

  if (isImpact) {
    phases.push("impact");
    fallScore += 35;
    details.push(`Impact detected (${total.toFixed(1)} m/s²)`);
    state.lastImpactIndex = state.history.length - 1;
  }

  // Check if impact happened shortly after free-fall
  if (state.lastImpactIndex !== null && !isFreeFall) {
    const gap = state.history.length - 1 - state.lastImpactIndex;
    if (gap <= THRESHOLDS.impactWindow && !isImpact) {
      // Recent impact after free-fall — bonus score
      fallScore += 15;
      details.push("Impact within free-fall window");
    }
  }

  // ── Phase 3: Orientation change (lying down) ──
  const zDelta = Math.abs(state.standingZ - accelZ);
  if (zDelta > THRESHOLDS.orientationThreshold) {
    phases.push("orientation-change");
    fallScore += 25;
    details.push(`Orientation changed (Z: ${accelZ.toFixed(1)}, expected: ${state.standingZ.toFixed(1)})`);
    state.isLyingDown = true;
  } else {
    state.isLyingDown = false;
  }

  // ── Learn standing baseline ──
  // If no danger signals, slowly learn what "standing" Z looks like
  if (!isFreeFall && !isImpact && zDelta < 1.5) {
    state.standingZ = state.standingZ * 0.99 + accelZ * 0.01;
  }

  // ── Composite fall score ──
  fallScore = Math.min(fallScore, 100);

  // ── Determine phase label ──
  let phase = "normal";
  if (phases.includes("free-fall")) phase = "free-fall";
  if (phases.includes("impact")) phase = "impact";
  if (phases.includes("orientation-change") && phase === "normal") phase = "lying";
  if (phases.length > 1) phase = phases.join("→");

  // ── Fall confirmation ──
  const fallDetected = fallScore >= THRESHOLDS.fallScoreThreshold;

  if (fallDetected) {
    state.fallConfirmed = true;
    state.cooldown = 10; // Don't detect the same fall again for 10 readings
    details.push(`FALL CONFIRMED (score: ${fallScore})`);
  }

  return {
    fallDetected,
    fallScore,
    phase,
    details: details.join(" | ") || "Normal acceleration",
    totalAccel: Math.round(total * 100) / 100,
  };
}

/**
 * Reset fall detection state (e.g., when a new device session starts)
 */
function resetState() {
  state.history = [];
  state.freeFallStart = null;
  state.freeFallCount = 0;
  state.lastImpactIndex = null;
  state.standingZ = 9.8;
  state.isLyingDown = false;
  state.fallConfirmed = false;
  state.cooldown = 0;
}

module.exports = {
  detectFall,
  resetState,
  THRESHOLDS,
};
