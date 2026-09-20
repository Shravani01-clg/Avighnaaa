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

const { detectFall, resetState, FALL_STATES } = require("./fallDetection");

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

  // Collect reasons
  const reasons = [];
  if (scores.temperature.label) reasons.push(scores.temperature.label);
  if (scores.gas.label) reasons.push(scores.gas.label);
  if (scores.water.label) reasons.push(scores.water.label);
  if (scores.sos.label) reasons.push(scores.sos.label);
  if (scores.fall.label) reasons.push(scores.fall.label);
  if (dangerCount >= 2) reasons.push(`Combined danger (${dangerCount} simultaneous hazards)`);
  if (anomaly.anomalyDetected) reasons.push(`Anomaly: ${anomaly.anomalyReasons.join(", ")}`);

  return {
    risk_score: riskScore,
    risk_level: riskLevel,
    reason: reasons.length > 0 ? reasons.join("; ") : "No major risk detected",
    anomaly_detected: anomaly.anomalyDetected,
    anomaly_score: anomaly.anomalyScore,
    fall_state: fallInfo.state,
    fall_score: fallInfo.score,
  };
}

module.exports = { calculateRisk, resetState, THRESHOLDS, FALL_STATES, detectAnomaly, ANOMALY_ENVELOPE };
