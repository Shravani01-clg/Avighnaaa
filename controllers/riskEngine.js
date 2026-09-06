/**
 * Enhanced Risk Engine
 *
 * Calculates risk score (0–100) and level (LOW / MEDIUM / HIGH / CRITICAL)
 * from sensor readings. Includes:
 *   - Individual sensor thresholds (temperature, gas, water)
 *   - Fall detection score (from accelerometer)
 *   - SOS emergency flag
 *   - Combined danger multiplier (multiple dangers = exponential risk)
 *
 * IMPORTANT: This engine supports but does NOT replace hard safety thresholds.
 * The alert logic still triggers on individual sensor limits.
 */

const { detectFall } = require("./fallDetection");

// ─── Thresholds ──────────────────────────────────────────────

const THRESHOLDS = {
  temperature: {
    elevated: 38,      // °C — mild concern
    high: 45,          // °C — dangerous
    critical: 55,      // °C — extreme
  },
  gasRaw: {
    elevated: 400,     // raw ADC — mild concern
    high: 600,         // — dangerous
    critical: 800,     // — extreme
  },
  waterLevelCm: {
    elevated: 15,      // cm — rising
    high: 25,          // — dangerous
    critical: 40,      // — extreme flood
  },
};

// ─── Individual Sensor Scoring ───────────────────────────────

function scoreTemperature(temp) {
  if (temp >= THRESHOLDS.temperature.critical) return { score: 35, level: "critical", label: "Extreme temperature" };
  if (temp >= THRESHOLDS.temperature.high) return { score: 25, level: "high", label: "High temperature" };
  if (temp >= THRESHOLDS.temperature.elevated) return { score: 10, level: "elevated", label: "Elevated temperature" };
  return { score: 0, level: "safe", label: null };
}

function scoreGas(gas) {
  if (gas >= THRESHOLDS.gasRaw.critical) return { score: 35, level: "critical", label: "Extreme gas level" };
  if (gas >= THRESHOLDS.gasRaw.high) return { score: 25, level: "high", label: "High gas level" };
  if (gas >= THRESHOLDS.gasRaw.elevated) return { score: 10, level: "elevated", label: "Elevated gas level" };
  return { score: 0, level: "safe", label: null };
}

function scoreWater(water) {
  if (water >= THRESHOLDS.waterLevelCm.critical) return { score: 30, level: "critical", label: "Extreme water level" };
  if (water >= THRESHOLDS.waterLevelCm.high) return { score: 20, level: "high", label: "High water level" };
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
 * @returns {{ risk_score: number, risk_level: string, reason: string, details: Object, alerts: string[] }}
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
      details: fallResult,
    };
  }

  // ── Base score: sum of individual scores ──
  let baseScore =
    scores.temperature.score +
    scores.gas.score +
    scores.water.score +
    scores.sos.score +
    scores.fall.score;

  // ── Combined danger multiplier ──
  // Multiple simultaneous dangers compound the risk
  const dangerCount = countDangerSignals(scores);
  let multiplier = 1.0;
  if (dangerCount === 2) multiplier = 1.3;   // 30% boost
  if (dangerCount === 3) multiplier = 1.6;   // 60% boost
  if (dangerCount >= 4) multiplier = 2.0;    // doubled

  let riskScore = Math.round(Math.min(baseScore * multiplier, 100));

  // ── Determine risk level ──
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

  // ── If any individual sensor is CRITICAL, risk can't be below HIGH ──
  const anyCritical =
    scores.temperature.level === "critical" ||
    scores.gas.level === "critical" ||
    scores.water.level === "critical" ||
    scores.sos.level === "critical" ||
    scores.fall.level === "critical";

  if (anyCritical && riskLevel === "LOW") riskLevel = "MEDIUM";
  if (anyCritical && riskLevel === "MEDIUM") riskLevel = "HIGH";

  // ── Collect reasons ──
  const reasons = [];
  const alerts = [];  // specific alert types to create

  if (scores.temperature.label) {
    reasons.push(scores.temperature.label);
    if (scores.temperature.level === "high" || scores.temperature.level === "critical") {
      alerts.push("TEMP_DANGER");
    }
  }
  if (scores.gas.label) {
    reasons.push(scores.gas.label);
    if (scores.gas.level === "high" || scores.gas.level === "critical") {
      alerts.push("GAS_DANGER");
    }
  }
  if (scores.water.label) {
    reasons.push(scores.water.label);
    if (scores.water.level === "high" || scores.water.level === "critical") {
      alerts.push("FLOOD_DANGER");
    }
  }
  if (scores.sos.label) {
    reasons.push(scores.sos.label);
    alerts.push("SOS");
  }
  if (scores.fall.label) {
    reasons.push(scores.fall.label);
    alerts.push("FALL_DETECTED");
  }

  // Combined danger alert
  if (dangerCount >= 2) {
    reasons.push(`Combined danger (${dangerCount} simultaneous hazards)`);
    alerts.push("COMBINED_DANGER");
  }

  return {
    risk_score: riskScore,
    risk_level: riskLevel,
    reason: reasons.length > 0 ? reasons.join("; ") : "No major risk detected",
    details: {
      scores: {
        temperature: scores.temperature.score,
        gas: scores.gas.score,
        water: scores.water.score,
        sos: scores.sos.score,
        fall: scores.fall.score,
      },
      dangerCount,
      multiplier,
      baseScore,
      fallResult: scores.fall.details || null,
    },
    alerts, // list of alert types to create
  };
}

module.exports = {
  calculateRisk,
  THRESHOLDS,
};