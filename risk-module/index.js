/**
 * AI/Risk Module — Entry Point
 *
 * Standalone module that accepts sensor data and returns risk assessment.
 * No backend dependencies. Can be used by any system.
 *
 * INPUT FORMAT (common sensor data):
 * {
 *   "device_id": "string",
 *   "temperature_c": number,
 *   "gas_raw": number,
 *   "water_level_cm": number,
 *   "acceleration_x_ms2": number,
 *   "acceleration_y_ms2": number,
 *   "acceleration_z_ms2": number,
 *   "sos": boolean
 * }
 *
 * OUTPUT FORMAT (Phase 3 contract — always present):
 * {
 *   "risk_score": number (0-100),
 *   "risk_level": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
 *   "anomaly_detected": boolean,
 *   "fall_state": "NORMAL" | "SUDDEN_MOVEMENT" | "POSSIBLE_FALL" | "FALL_CONFIRMED",
 *   "reason": "string"
 * }
 */

const { calculateRisk, resetState, THRESHOLDS, detectAnomaly } = require("./riskEngine");

/**
 * Analyze sensor data and return risk assessment.
 *
 * @param {Object} sensorData - Sensor reading in common format
 * @returns {{ risk_score: number, risk_level: string, reason: string }}
 */
function analyzeRisk(sensorData) {
  // Validate input — contract fields are ALWAYS present, even on bad input
  if (!sensorData || typeof sensorData !== "object") {
    return {
      risk_score: 0,
      risk_level: "LOW",
      anomaly_detected: false,
      anomaly_score: 0,
      fall_state: "NORMAL",
      fall_score: 0,
      reason: "Invalid input: sensor data required",
    };
  }

  return calculateRisk(sensorData);
}

/**
 * Reset fall detection state (call when starting a new session/device).
 */
function reset() {
  resetState();
}

module.exports = {
  analyzeRisk,
  reset,
  THRESHOLDS,
  // Re-export for advanced usage
  calculateRisk,
  detectAnomaly,
};
