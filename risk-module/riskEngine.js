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

const { detectFall, resetState } = require("./fallDetection");

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

    scores.fall = {
      score: fallResult.fallScore,
      level: fallResult.fallDetected ? "critical" : fallResult.fallScore > 30 ? "high" : "safe",
      label: fallResult.fallDetected ? "Fall detected" : null,
    };
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

  return {
    risk_score: riskScore,
    risk_level: riskLevel,
    reason: reasons.length > 0 ? reasons.join("; ") : "No major risk detected",
  };
}

module.exports = { calculateRisk, resetState, THRESHOLDS };
