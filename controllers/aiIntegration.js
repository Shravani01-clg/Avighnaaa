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
      return { available: false, reason: result?.error || "No response" };
    }

    const { risk, anomaly, combined } = result;

    // Determine final risk level (AI never downgrades)
    let finalRiskLevel = ruleBasedRisk.risk_level;
    let finalRiskScore = ruleBasedRisk.risk_score;

    if (RISK_RANK[combined.risk_level] > RISK_RANK[ruleBasedRisk.risk_level]) {
      finalRiskLevel = combined.risk_level;
      finalRiskScore = combined.risk_score;
    }

    // Additional alerts from AI
    const aiAlerts = [];

    // Anomaly detected → add ANOMALY alert
    if (anomaly.is_anomaly) {
      aiAlerts.push("ANOMALY");
    }

    // ML predicts higher risk → add AI_RISK_UPGRADE alert
    if (RISK_RANK[risk.predicted_risk_level] > RISK_RANK[ruleBasedRisk.risk_level]) {
      aiAlerts.push("AI_RISK_UPGRADE");
    }

    return {
      available: true,
      finalRiskLevel,
      finalRiskScore,
      aiAnalysis: {
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
    // AI server unavailable — fall back to rule-based only
    return {
      available: false,
      reason: err.message,
      finalRiskLevel: ruleBasedRisk.risk_level,
      finalRiskScore: ruleBasedRisk.risk_score,
      aiAlerts: [],
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
};
