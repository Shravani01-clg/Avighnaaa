/**
 * AI Integration Layer
 *
 * Connects the Node.js backend to the Python AI server.
 * Falls back gracefully if the AI server is unavailable.
 *
 * The AI never overrides the rule-based engine — it only provides
 * a second opinion. If AI says higher risk, we use AI's level.
 * If rule-based says higher, we keep rule-based.
 */

const http = require("http");

const AI_SERVER_URL = process.env.AI_SERVER_URL || "http://localhost:5001";

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

// ─── AI alert cooldown ───────────────────────────────────────
// The backend already creates at most one unresolved alert per type, but
// the per-reading `alerts` array is echoed back in EVERY response — while
// an anomaly persists, ANOMALY would be re-emitted every 3 seconds and
// the frontend would re-toast it constantly. A per-device cooldown makes
// each AI alert fire once, then stay quiet for ALERT_COOLDOWN_MS.
// Rule-engine emergencies (SOS, FALL_DETECTED, *_DANGER) never travel
// through this path — they come from the rule engine and are governed by
// the alert-until-resolved logic in sensorController.
const ALERT_COOLDOWN_MS = 30_000;
const lastAlertEmit = new Map(); // `${device_id}::${type}` → timestamp of last emission

/**
 * Should this AI alert be emitted right now?
 * First emission for (device, type) always passes; repeats within
 * ALERT_COOLDOWN_MS are suppressed. Injectable `now` for tests.
 */
function shouldEmitAlert(type, deviceId, now = Date.now()) {
  const key = `${deviceId || "__default__"}::${type}`;
  const last = lastAlertEmit.get(key);
  if (last !== undefined && now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertEmit.set(key, now);
  return true;
}

/** Clear cooldown state (tests / session reset). */
function resetAlertCooldown() {
  lastAlertEmit.clear();
}

/**
 * Call the Python AI server
 */
function callAI(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${AI_SERVER_URL}${path}`);
    const data = JSON.stringify(body);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 3000, // 3 second timeout
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("Invalid JSON from AI server"));
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("AI server timeout"));
    });

    req.write(data);
    req.end();
  });
}

/**
 * Alerts that must fire regardless of AI-server reachability.
 *
 * The stuck-sensor verdict comes from the rule engine's rolling window,
 * so it is available even in rules_fallback mode — its alert therefore
 * fires on EVERY path (ANOMALY / AI_RISK_UPGRADE stay ML-only: their
 * verdict only exists when the models answer). Shared by all three paths
 * so the cooldown applies uniformly.
 */
function stuckSensorAlerts(ruleBasedRisk, sensorData) {
  if (
    (ruleBasedRisk.stuck_sensors || []).length > 0 &&
    shouldEmitAlert("SENSOR_STUCK", sensorData.device_id)
  ) {
    return ["SENSOR_STUCK"];
  }
  return [];
}

/**
 * Get AI analysis for a sensor reading.
 * Combines rule-based risk with ML predictions.
 *
 * @param {Object} sensorData - Raw sensor reading
 * @param {Object} ruleBasedRisk - Result from the rule-based risk engine
 * @returns {{ risk_level, risk_score, ai_analysis, alerts_to_add }}
 */
async function getAIAnalysis(sensorData, ruleBasedRisk) {
  try {
    // Call the AI server for combined analysis
    const aiInput = {
      ...sensorData,
      _rule_based_risk_level: ruleBasedRisk.risk_level,
      _rule_based_risk_score: ruleBasedRisk.risk_score,
    };

    const result = await callAI("/predict/all", aiInput);

    if (!result || result.error) {
      const reason = result?.error || "No response";
      return {
        available: false,
        reason,
        finalRiskLevel: ruleBasedRisk.risk_level,
        finalRiskScore: ruleBasedRisk.risk_score,
        aiAlerts: stuckSensorAlerts(ruleBasedRisk, sensorData),
        // The block below keeps the SAME shape as the success path so the
        // backend/frontend always receive advice + mode, even on errors.
        aiAnalysis: {
          source: "rules_fallback",
          aiAvailable: false,
          reason,
          recommendation: ruleBasedRisk.recommendation || null,
          stuckSensors: ruleBasedRisk.stuck_sensors || [],
          trendWarnings: ruleBasedRisk.trend_warnings || [],
          aiRiskFactors: ruleBasedRisk.risk_factors || [],
        },
      };
    }

    const { risk, anomaly, combined } = result;

    // Determine final risk level (AI never downgrades)
    let finalRiskLevel = ruleBasedRisk.risk_level;
    let finalRiskScore = ruleBasedRisk.risk_score;

    if (RISK_RANK[combined.risk_level] > RISK_RANK[ruleBasedRisk.risk_level]) {
      finalRiskLevel = combined.risk_level;
      finalRiskScore = combined.risk_score;
    }

    // Additional alerts from AI (each gated by the per-device cooldown)
    const aiAlerts = [];

    // Anomaly detected → add ANOMALY alert
    if (anomaly.is_anomaly && shouldEmitAlert("ANOMALY", sensorData.device_id)) {
      aiAlerts.push("ANOMALY");
    }

    // ML predicts higher risk → add AI_RISK_UPGRADE alert
    if (
      RISK_RANK[risk.predicted_risk_level] > RISK_RANK[ruleBasedRisk.risk_level] &&
      shouldEmitAlert("AI_RISK_UPGRADE", sensorData.device_id)
    ) {
      aiAlerts.push("AI_RISK_UPGRADE");
    }

    // Frozen sensor (rule-side verdict) → device-health alert; fires even
    // when the AI server is down (shared helper, cooldown applies).
    aiAlerts.push(...stuckSensorAlerts(ruleBasedRisk, sensorData));

    // Explainability: rule-engine factors + the ML model's opinion (Day 2)
    const mlRaised = RISK_RANK[risk.predicted_risk_level] > RISK_RANK[ruleBasedRisk.risk_level];
    const aiRiskFactors = [
      ...(ruleBasedRisk.risk_factors || []),
      {
        source: "ml",
        name: "risk_predictor",
        points: 0,
        detail:
          `predicts ${risk.predicted_risk_level} ` +
          `(${Math.round((risk.confidence || 0) * 100)}% confidence) — ` +
          (mlRaised ? "raised the final level" : "agrees or stays below the rules (MAX fusion never downgrades)"),
      },
    ];

    return {
      available: true,
      finalRiskLevel,
      finalRiskScore,
      aiAnalysis: {
        source: "ml_fusion",
        aiAvailable: true,
        // Advice comes from the rule engine (works offline); fusion only
        // ever RAISES the level, so the recommendation stays honest.
        recommendation: ruleBasedRisk.recommendation || null,
        stuckSensors: ruleBasedRisk.stuck_sensors || [],
        trendWarnings: ruleBasedRisk.trend_warnings || [],
        aiRiskFactors,
        mlRiskPrediction: risk.predicted_risk_level,
        mlConfidence: risk.confidence,
        mlProbabilities: risk.probabilities,
        anomalyDetected: anomaly.is_anomaly,
        anomalyScore: anomaly.anomaly_score,
        combinedScore: combined.risk_score,
      },
      aiAlerts,
    };
  } catch (err) {
    // AI server unavailable — fall back to rule-based only.
    // Same aiAnalysis shape as the success path (mode flagged offline) so
    // the rescue recommendation still reaches the client.
    return {
      available: false,
      reason: err.message,
      finalRiskLevel: ruleBasedRisk.risk_level,
      finalRiskScore: ruleBasedRisk.risk_score,
      aiAlerts: stuckSensorAlerts(ruleBasedRisk, sensorData),
      aiAnalysis: {
        source: "rules_fallback",
        aiAvailable: false,
        reason: err.message,
        recommendation: ruleBasedRisk.recommendation || null,
        stuckSensors: ruleBasedRisk.stuck_sensors || [],
        trendWarnings: ruleBasedRisk.trend_warnings || [],
        aiRiskFactors: ruleBasedRisk.risk_factors || [],
      },
    };
  }
}

/**
 * Check if the AI server is running
 */
async function checkAIServer() {
  try {
    const result = await callAI("/health", {});
    return result.status === "ok";
  } catch {
    return false;
  }
}

module.exports = {
  getAIAnalysis,
  checkAIServer,
  AI_SERVER_URL,
  // Alert cooldown (exposed for validate.js §5 + future use)
  shouldEmitAlert,
  resetAlertCooldown,
  ALERT_COOLDOWN_MS,
};
