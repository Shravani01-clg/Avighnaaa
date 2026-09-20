/**
 * Risk Engine — backend adapter
 *
 * Phase 3: The canonical engine lives in `risk-module/` (Person 3's deliverable).
 * This file is a thin re-export so Person 1's backend code keeps working with
 * the exact same import path, while both sides can never diverge again.
 *
 * The only addition here is the `alerts` array that the backend uses to create
 * alert records — it is derived from the same scoring the module exposes.
 */

const {
  calculateRisk: engineCalculateRisk,
  THRESHOLDS,
  FALL_STATES,
  detectAnomaly,
} = require("../risk-module/riskEngine");

/**
 * Calculate risk + derive backend alert types.
 *
 * @param {Object} sensorData
 * @returns {{ risk_score, risk_level, reason, anomaly_detected, anomaly_score, fall_state, fall_score, details, alerts }}
 */
function calculateRisk(sensorData) {
  const result = engineCalculateRisk(sensorData);

  // Derive alert types from the same scores the engine used
  const alerts = [];
  const reason = result.reason || "";
  const fallState = result.fall_state;

  if (reason.includes("temperature")) alerts.push("TEMP_DANGER");
  if (reason.includes("gas level")) alerts.push("GAS_DANGER");
  if (reason.includes("water level")) alerts.push("FLOOD_DANGER");
  if ((sensorData && sensorData.sos === true) || reason.includes("SOS")) alerts.push("SOS");

  if (fallState === FALL_STATES.FALL_CONFIRMED) {
    alerts.push("FALL_DETECTED");
  } else if (fallState === FALL_STATES.POSSIBLE_FALL) {
    alerts.push("POSSIBLE_FALL");
  }

  if (reason.includes("Combined danger")) alerts.push("COMBINED_DANGER");

  return {
    ...result,
    details: {
      scores: {
        anomaly: result.anomaly_score,
        fall: result.fall_score,
      },
      fallState,
      anomalyDetected: result.anomaly_detected,
    },
    alerts,
  };
}

module.exports = {
  calculateRisk,
  THRESHOLDS,
  FALL_STATES,
  detectAnomaly,
};
