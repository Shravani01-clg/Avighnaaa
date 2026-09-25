/**
 * Enhanced Risk Engine (Standalone)
 *
 * Calculates risk score (0–100) and level (LOW / MEDIUM / HIGH / CRITICAL)
 * from sensor readings. Includes:
 *   - Individual sensor thresholds (temperature, gas, water)
 *   - Fall detection score (from accelerometer)
 *   - SOS emergency flag
 *   - Combined danger multiplier (multiple dangers = exponential risk)
 *
 * INPUT:  { temperature_c, gas_raw, water_level_cm, acceleration_x_ms2, acceleration_y_ms2, acceleration_z_ms2, sos }
 * OUTPUT: { risk_score, risk_level, reason }
 */

const { detectFall, resetState: resetFallState, FALL_STATES } = require("./fallDetection");
const rollingWindow = require("./rollingWindow");

// ─── Thresholds ──────────────────────────────────────────────

const THRESHOLDS = {
  temperature: {
    elevated: 38,
    high: 45,
    critical: 55,
  },
  gasRaw: {
    elevated: 400,
    high: 600,
    critical: 800,
  },
  waterLevelCm: {
    elevated: 15,
    high: 25,
    critical: 40,
  },
};

// ─── Individual Sensor Scoring ───────────────────────────────

function scoreTemperature(temp) {
  if (temp >= THRESHOLDS.temperature.critical) return { score: 35, level: "critical", label: "Extreme temperature" };
  if (temp >= THRESHOLDS.temperature.high) return { score: 30, level: "high", label: "High temperature" };
  if (temp >= THRESHOLDS.temperature.elevated) return { score: 10, level: "elevated", label: "Elevated temperature" };
  return { score: 0, level: "safe", label: null };
}

function scoreGas(gas) {
  if (gas >= THRESHOLDS.gasRaw.critical) return { score: 35, level: "critical", label: "Extreme gas level" };
  if (gas >= THRESHOLDS.gasRaw.high) return { score: 30, level: "high", label: "High gas level" };
  if (gas >= THRESHOLDS.gasRaw.elevated) return { score: 10, level: "elevated", label: "Elevated gas level" };
  return { score: 0, level: "safe", label: null };
}

function scoreWater(water) {
  if (water >= THRESHOLDS.waterLevelCm.critical) return { score: 30, level: "critical", label: "Extreme water level" };
  if (water >= THRESHOLDS.waterLevelCm.high) return { score: 25, level: "high", label: "High water level" };
  if (water >= THRESHOLDS.waterLevelCm.elevated) return { score: 10, level: "elevated", label: "Rising water level" };
  return { score: 0, level: "safe", label: null };
}

function scoreSOS(sos) {
  if (sos === true) return { score: 40, level: "critical", label: "SOS activated" };
  return { score: 0, level: "safe", label: null };
}

// ─── Rule-Based Anomaly Detection ────────────────────────────
// Detects readings that don't match ANY normal operating pattern —
// the rule-based complement to the ML Isolation Forest.
//
// Normal envelope (from simulator + MPU6050 physics):
//   temperature 20–36 °C, gas 80–350 raw, water 0–12 cm,
//   |a| ≈ 9.8 m/s² (± 15%), Z between 4 and 10.5 m/s².

const ANOMALY_ENVELOPE = {
  temperatureC: { min: 5, max: 60 },     // outside = implausible reading (60+ is beyond CRITICAL — likely sensor fault)
  gasRaw: { min: 0, max: 380 },          // normal idle range; higher = hazard, not anomaly
  waterLevelCm: { min: 0, max: 14 },     // higher = hazard, not anomaly
  totalAccelG: { min: 3.0, max: 16.0 },  // |a| far from 9.8 with no fall signature
  accelSpikeG: 18.0,                     // single-reading spike without fall context
};

/**
 * Rule-based anomaly check on a single reading.
 * Hazard levels (hot/gas/wet) are NOT anomalies — they're known danger states.
 * An anomaly is a reading that is implausible as a device state at all
 * (sensor fault, tampering, data corruption) or a motion signature that
 * doesn't match any known pattern.
 *
 * @returns {{ anomalyDetected: boolean, anomalyScore: number, anomalyReasons: string[] }}
 */
function detectAnomaly(sensorData) {
  const reasons = [];
  let score = 0;

  const temp = sensorData.temperature_c;
  const gas = sensorData.gas_raw;
  const water = sensorData.water_level_cm;
  const hasAccel =
    sensorData.acceleration_x_ms2 !== undefined &&
    sensorData.acceleration_y_ms2 !== undefined &&
    sensorData.acceleration_z_ms2 !== undefined;

  // Implausible environment values (sensor fault / tampering / corruption)
  if (typeof temp === "number") {
    if (temp < ANOMALY_ENVELOPE.temperatureC.min || temp > ANOMALY_ENVELOPE.temperatureC.max) {
      reasons.push(`Implausible temperature (${temp}°C)`);
      score += 40;
    }
  }
  if (typeof gas === "number" && gas < ANOMALY_ENVELOPE.gasRaw.min) {
    reasons.push(`Implausible gas reading (${gas})`);
    score += 40;
  }
  if (typeof water === "number" && water < ANOMALY_ENVELOPE.waterLevelCm.min) {
    reasons.push(`Implausible water level (${water}cm)`);
    score += 40;
  }

  // Motion signature that matches no known pattern
  if (hasAccel) {
    const total = Math.sqrt(
      sensorData.acceleration_x_ms2 ** 2 +
      sensorData.acceleration_y_ms2 ** 2 +
      sensorData.acceleration_z_ms2 ** 2
    );
    if (total < ANOMALY_ENVELOPE.totalAccelG.min || total > ANOMALY_ENVELOPE.totalAccelG.max) {
      reasons.push(`Abnormal motion signature (|a| = ${total.toFixed(1)} m/s²)`);
      score += 30;
    }
    const maxAxis = Math.max(
      Math.abs(sensorData.acceleration_x_ms2),
      Math.abs(sensorData.acceleration_y_ms2),
      Math.abs(sensorData.acceleration_z_ms2)
    );
    if (maxAxis > ANOMALY_ENVELOPE.accelSpikeG) {
      reasons.push(`Acceleration spike without fall context (${maxAxis.toFixed(1)} m/s²)`);
      score += 30;
    }
  }

  // Missing sensor data is itself an anomaly (device misbehaving)
  if (temp === undefined && gas === undefined && water === undefined) {
    reasons.push("No sensor fields present");
    score += 50;
  }

  return {
    anomalyDetected: reasons.length > 0,
    anomalyScore: Math.min(score, 100),
    anomalyReasons: reasons,
  };
}

// ─── Danger Count (for combined logic) ───────────────────────

function countDangerSignals(scores) {
  let count = 0;
  if (scores.temperature.level === "high" || scores.temperature.level === "critical") count++;
  if (scores.gas.level === "high" || scores.gas.level === "critical") count++;
  if (scores.water.level === "high" || scores.water.level === "critical") count++;
  if (scores.sos.level === "critical") count++;
  if (scores.fall.level === "critical" || scores.fall.level === "high") count++;
  return count;
}

// ─── Alert Stability (hysteresis) ─────────────────────────────
//
// A single noisy reading right at a threshold (score 29 ↔ 30) would
// otherwise flip the reported level LOW ↔ MEDIUM every few seconds and
// make the dashboard and alerts flicker. Two rules keep alerts trustworthy:
//
//   1. Escalation is ALWAYS immediate — danger never waits.
//   2. De-escalation requires HYSTERESIS_HOLD_READINGS consecutive readings
//      below the held level. While holding, the engine keeps reporting the
//      held score/level AND the reason that established it, annotated with
//      the hold counter so the output stays self-explanatory.
//
// State is keyed per device, so one device's emergency never bleeds into
// another device's report (fall detection predates this and is global —
// documented separately).

const LEVEL_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const HYSTERESIS_HOLD_READINGS = 3;

const hysteresisState = new Map(); // device_id → { level, score, reason, holdCount }

function applyHysteresis(deviceId, rawScore, rawLevel, rawReason) {
  const key = deviceId || "__default__";
  const held = hysteresisState.get(key);

  const adopt = () => {
    hysteresisState.set(key, {
      level: rawLevel,
      score: rawScore,
      reason: rawReason,
      holdCount: 0,
    });
    return { score: rawScore, level: rawLevel, reason: rawReason, holding: false };
  };

  if (!held) return adopt();

  // Rising (or steady) danger — adopt the new reading immediately.
  if (LEVEL_RANK[rawLevel] >= LEVEL_RANK[held.level]) return adopt();

  // Raw level dropped below the held level — count stable readings.
  held.holdCount += 1;
  if (held.holdCount >= HYSTERESIS_HOLD_READINGS) {
    return adopt(); // hold window expired: stand down to the current reading
  }

  return {
    score: held.score,
    level: held.level,
    reason:
      `${held.reason}; Alert stability: holding ${held.level} ` +
      `(${held.holdCount}/${HYSTERESIS_HOLD_READINGS} stable readings before standing down)`,
    holding: true,
  };
}

// ─── Rescue Recommendation (v2) ──────────────────────────────
//
// Turns "how dangerous" into "what to do". Pure function of the FINAL
// (post-hysteresis) assessment, computed inside the rule engine so the
// advice exists even when the Python AI server is offline — guidance must
// never depend on a service that might be down.
//
// v2 (Day 2): also incorporates sequence intelligence — frozen sensors
// and pre-threshold trend warnings — so the advice covers "your data may
// be lying to you" and "danger is still N minutes away", not just the
// current reading.
//
// Exported for tests; the field it builds ships as `recommendation` on
// every calculateRisk() result (and travels to the backend through
// controllers/aiIntegration.js).

function buildRecommendation({ level, fallState, anomalyDetected, sos, dangerCount, stuckSensors = [], trendWarnings = [] }) {
  const anomalyNote = anomalyDetected
    ? " Also verify sensor/device health — the reading was flagged implausible."
    : "";

  const addenda = [];
  if (stuckSensors.length > 0) {
    addenda.push(
      ` Sensor frozen (${stuckSensors.map((f) => rollingWindow.LABELS[f]).join("/")}) — ` +
      "affected readings are unreliable; dispatch a device check."
    );
  }
  if (trendWarnings.length > 0) {
    addenda.push(
      ` Pre-emptive: ${trendWarnings.map((w) => w.message).join("; ")} — ` +
      "prepare before the threshold is crossed."
    );
  }
  const seqNote = addenda.join("");

  if (level === "CRITICAL") {
    if (fallState === FALL_STATES.FALL_CONFIRMED) {
      return "CRITICAL: evacuate the sector and dispatch the rescue team to the worker's last known location; assign first-aid on arrival." + anomalyNote + seqNote;
    }
    if (sos === true) {
      return "CRITICAL: emergency SOS active — dispatch the rescue team immediately and evacuate nearby workers." + anomalyNote + seqNote;
    }
    const hazards = dangerCount >= 2 ? `${dangerCount} simultaneous hazards exceed safe limits` : "a hazard exceeds the critical limit";
    return `CRITICAL: evacuate the sector and dispatch emergency response — ${hazards}.` + anomalyNote + seqNote;
  }

  if (level === "HIGH") {
    return "HIGH: stop work in this area, send an inspection team with protective gear, and prepare evacuation." + anomalyNote + seqNote;
  }

  if (level === "MEDIUM") {
    return "MEDIUM: alert the shift supervisor, inspect the reported hazards, and prepare an evacuation route." + anomalyNote + seqNote;
  }

  // LOW — anomalyNote is already baked into the implausible-reading line
  if (fallState === FALL_STATES.FALL_CONFIRMED) {
    return "Fall confirmed and the worker is still down — keep the rescue team dispatched; re-check when posture recovers." + seqNote;
  }
  if (fallState === FALL_STATES.POSSIBLE_FALL) {
    return "Possible fall: contact the worker by radio and verify their status." + seqNote;
  }
  if (anomalyDetected) {
    return "Risk is low, but the sensor reading looks implausible: check the device and keep monitoring." + seqNote;
  }
  return "Normal operation: continue routine monitoring." + seqNote;
}

// ─── Risk Factors (explainability) ───────────────────────────
//
// Per-factor contribution to the assessment — the "why" behind the
// number, as a list of { source, name, points, detail }. Ships on every
// result as `risk_factors` and reaches the API as `ai.aiRiskFactors`
// (aiIntegration.js appends the ML opinion). Every result carries at
// least one factor, so the frontend can always render an explanation.

function buildRiskFactors({ sensorData, scores, baseScore, riskScore, multiplier, dangerCount, anomaly, stable, windowResult }) {
  const factors = [];
  const add = (source, name, points, detail) =>
    factors.push({ source, name, points: Math.round(points), detail });

  if (scores.temperature.score > 0) add("rules", "temperature_c", scores.temperature.score, `${scores.temperature.label} (${sensorData.temperature_c}°C)`);
  if (scores.gas.score > 0) add("rules", "gas_raw", scores.gas.score, `${scores.gas.label} (${sensorData.gas_raw})`);
  if (scores.water.score > 0) add("rules", "water_level_cm", scores.water.score, `${scores.water.label} (${sensorData.water_level_cm}cm)`);
  if (scores.sos.score > 0) add("rules", "sos", scores.sos.score, scores.sos.label);
  if (scores.fall.score > 0) add("rules", "fall", scores.fall.score, scores.fall.label || "Fall signature");
  if (multiplier > 1.0) {
    // Contribution of the multiplier: final vs pre-multiplier score,
    // floored at 0 (when the score is already capped the multiplier's
    // contribution is genuinely 0 — the detail still names it).
    add("rules", "combined_danger", Math.max(0, riskScore - Math.min(baseScore, 100)),
      `Combined danger multiplier ×${multiplier} (${dangerCount} simultaneous hazards)`);
  }
  if (anomaly.anomalyDetected) {
    add("anomaly", "anomaly", anomaly.anomalyScore, anomaly.anomalyReasons.join("; "));
  }
  for (const w of windowResult.trendWarnings) add("trend", w.sensor, 0, w.message);
  if (stable.holding) {
    add("stability", "hysteresis", 0, `Level held at ${stable.level} during de-escalation window`);
  }
  if (factors.length === 0) add("rules", "baseline", 0, "All sensors within normal range");

  return factors;
}

// ─── Main Risk Calculation ───────────────────────────────────

/**
 * Calculate risk from sensor data.
 *
 * @param {Object} sensorData
 * @param {number} sensorData.temperature_c
 * @param {number} sensorData.gas_raw
 * @param {number} sensorData.water_level_cm
 * @param {number} sensorData.acceleration_x_ms2
 * @param {number} sensorData.acceleration_y_ms2
 * @param {number} sensorData.acceleration_z_ms2
 * @param {boolean} sensorData.sos
 *
 * @returns {{ risk_score: number, risk_level: string, reason: string }}
 */
function calculateRisk(sensorData) {
  const fallInfo = { state: FALL_STATES.NORMAL, score: 0 };

  // Score each sensor independently
  const scores = {
    temperature: scoreTemperature(sensorData.temperature_c || 0),
    gas: scoreGas(sensorData.gas_raw || 0),
    water: scoreWater(sensorData.water_level_cm || 0),
    sos: scoreSOS(sensorData.sos),
    fall: { score: 0, level: "safe", label: null },
  };

  // Run fall detection on accelerometer data
  if (
    sensorData.acceleration_x_ms2 !== undefined &&
    sensorData.acceleration_y_ms2 !== undefined &&
    sensorData.acceleration_z_ms2 !== undefined
  ) {
    const fallResult = detectFall(
      sensorData.acceleration_x_ms2,
      sensorData.acceleration_y_ms2,
      sensorData.acceleration_z_ms2
    );
    fallInfo.state = fallResult.fallState;
    fallInfo.score = fallResult.fallScore;

    scores.fall = {
      score: fallResult.fallScore,
      level: fallResult.fallDetected ? "critical" : fallResult.fallScore > 30 ? "high" : "safe",
      label: fallResult.fallDetected ? "Fall confirmed" : fallResult.fallState === FALL_STATES.POSSIBLE_FALL ? "Possible fall — worker may need help" : null,
      details: fallResult,
    };
  } else {
    fallInfo.state = FALL_STATES.NORMAL;
  }

  // Rule-based anomaly detection on the raw reading
  const anomaly = detectAnomaly(sensorData);

  // Sequence-based checks (rolling window): frozen sensors join the
  // anomaly verdict; trend warnings are computed for the reason/factors.
  const windowResult = rollingWindow.feedReading(sensorData.device_id, sensorData);
  if (windowResult.stuckSensors.length > 0) {
    anomaly.anomalyDetected = true;
    anomaly.anomalyScore = Math.min(100, anomaly.anomalyScore + 30 * windowResult.stuckSensors.length);
    anomaly.anomalyReasons.push(...windowResult.stuckReasons);
  }

  // Base score: sum of individual scores
  let baseScore =
    scores.temperature.score +
    scores.gas.score +
    scores.water.score +
    scores.sos.score +
    scores.fall.score;

  // Combined danger multiplier
  const dangerCount = countDangerSignals(scores);
  let multiplier = 1.0;
  if (dangerCount === 2) multiplier = 1.3;
  if (dangerCount === 3) multiplier = 1.6;
  if (dangerCount >= 4) multiplier = 2.0;

  let riskScore = Math.round(Math.min(baseScore * multiplier, 100));

  // Determine risk level
  let riskLevel;
  if (riskScore >= 80) {
    riskLevel = "CRITICAL";
  } else if (riskScore >= 55) {
    riskLevel = "HIGH";
  } else if (riskScore >= 30) {
    riskLevel = "MEDIUM";
  } else {
    riskLevel = "LOW";
  }

  // If any individual sensor is CRITICAL, risk can't be below HIGH
  const anyCritical =
    scores.temperature.level === "critical" ||
    scores.gas.level === "critical" ||
    scores.water.level === "critical" ||
    scores.sos.level === "critical" ||
    scores.fall.level === "critical";

  // If any individual sensor is HIGH, risk can't be below MEDIUM
  const anyHigh =
    scores.temperature.level === "high" ||
    scores.gas.level === "high" ||
    scores.water.level === "high" ||
    scores.fall.level === "high";

  if (anyHigh && riskLevel === "LOW") riskLevel = "MEDIUM";
  if (anyCritical && riskLevel === "LOW") riskLevel = "MEDIUM";
  if (anyCritical && riskLevel === "MEDIUM") riskLevel = "HIGH";

  // Collect reasons (raw, for THIS reading)
  const reasons = [];
  if (scores.temperature.label) reasons.push(scores.temperature.label);
  if (scores.gas.label) reasons.push(scores.gas.label);
  if (scores.water.label) reasons.push(scores.water.label);
  if (scores.sos.label) reasons.push(scores.sos.label);
  if (scores.fall.label) reasons.push(scores.fall.label);
  if (dangerCount >= 2) reasons.push(`Combined danger (${dangerCount} simultaneous hazards)`);
  if (anomaly.anomalyDetected) reasons.push(`Anomaly: ${anomaly.anomalyReasons.join(", ")}`);
  // Pre-threshold trend warnings (deriveAlerts-safe wording — see rollingWindow.js)
  for (const w of windowResult.trendWarnings) reasons.push(w.message);

  const rawReason = reasons.length > 0 ? reasons.join("; ") : "No major risk detected";

  // Alert stability: escalate instantly, but a de-escalation only lands
  // after HYSTERESIS_HOLD_READINGS consecutive readings below the held
  // level (see applyHysteresis above).
  const stable = applyHysteresis(sensorData.device_id, riskScore, riskLevel, rawReason);

  return {
    risk_score: stable.score,
    risk_level: stable.level,
    reason: stable.reason,
    anomaly_detected: anomaly.anomalyDetected,
    anomaly_score: anomaly.anomalyScore,
    fall_state: fallInfo.state,
    fall_score: fallInfo.score,
    // Sequence intelligence (Day 2) — always present, may be empty
    stuck_sensors: windowResult.stuckSensors,
    trend_warnings: windowResult.trendWarnings,
    risk_factors: buildRiskFactors({
      sensorData, scores, baseScore, riskScore, multiplier, dangerCount,
      anomaly, stable, windowResult,
    }),
    // Actionable next step derived from the FINAL assessment — present on
    // every result, including fallback/offline paths.
    recommendation: buildRecommendation({
      level: stable.level,
      fallState: fallInfo.state,
      anomalyDetected: anomaly.anomalyDetected,
      sos: sensorData.sos === true,
      dangerCount,
      stuckSensors: windowResult.stuckSensors,
      trendWarnings: windowResult.trendWarnings,
    }),
  };
}

/**
 * Reset session state: fall detection AND alert-stability (hysteresis).
 * Tests call this between cases; the simulator calls it on scenario
 * switches. The backend intentionally never resets mid-session — that is
 * what keeps the hold window meaningful across readings.
 */
function resetState() {
  resetFallState();
  hysteresisState.clear();
  rollingWindow.reset();
}

module.exports = {
  calculateRisk,
  resetState,
  THRESHOLDS,
  FALL_STATES,
  detectAnomaly,
  ANOMALY_ENVELOPE,
  HYSTERESIS_HOLD_READINGS,
  buildRecommendation,
};
