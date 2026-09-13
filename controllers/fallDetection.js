/**
 * Fall Detection — backend adapter
 *
 * Phase 3: The canonical fall-detection algorithm lives in `risk-module/`
 * (Person 3's deliverable). This shim keeps Person 1's import paths working
 * while guaranteeing both sides run the exact same detection logic.
 */

const {
  detectFall,
  resetState,
  THRESHOLDS,
  FALL_STATES,
} = require("../risk-module/fallDetection");

module.exports = {
  detectFall,
  resetState,
  THRESHOLDS,
  FALL_STATES,
};
