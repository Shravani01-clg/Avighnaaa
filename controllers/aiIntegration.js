
const http = require("http");

const AI_SERVER_URL =
  process.env.AI_SERVER_URL || "http://localhost:5001";

const RISK_RANK = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * Send a request to the Python AI server.
 * GET is used for /health.
 * POST is used for AI prediction endpoints.
 */
function callAI(path, body = {}, method = "POST") {
  return new Promise((resolve, reject) => {
    let url;

    try {
      url = new URL(`${AI_SERVER_URL}${path}`);
    } catch (error) {
      reject(new Error(`Invalid AI server URL: ${error.message}`));
      return;
    }

    if (url.protocol !== "http:") {
      reject(new Error("AI server URL must use HTTP."));
      return;
    }

    const data = method === "GET" ? "" : JSON.stringify(body);

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method,
      headers: data
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          }
        : {},
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      let responseBody = "";

      res.setEncoding("utf8");

      res.on("data", (chunk) => {
        responseBody += chunk;
      });

      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(
            new Error(
              `AI server returned HTTP ${res.statusCode}: ${responseBody}`
            )
          );
          return;
        }

        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(
            new Error(
              `Invalid JSON from AI server: ${error.message}`
            )
          );
        }
      });
    });

    req.on("error", (error) => {
      reject(new Error(`AI server connection failed: ${error.message}`));
    });

    req.on("timeout", () => {
      req.destroy(new Error("AI server request timed out."));
    });

    if (data) {
      req.write(data);
    }

    req.end();
  });
}

/**
 * Analyze incoming sensor data using the Python AI models.
 * This function uses the actual data passed by the backend.
 */
async function getAIAnalysis(sensorData, ruleBasedRisk) {
  try {
    const aiInput = {
      ...sensorData,
      _rule_based_risk_level: ruleBasedRisk.risk_level,
      _rule_based_risk_score: ruleBasedRisk.risk_score,
    };

    const result = await callAI("/predict/all", aiInput);

    if (!result || result.error) {
      throw new Error(
        result?.error || "The AI server returned an empty response."
      );
    }

    const { risk, anomaly, combined } = result;

    if (!risk || !anomaly || !combined) {
      throw new Error(
        "The AI response is missing risk, anomaly, or combined results."
      );
    }

    const mlRiskLevel = String(
      risk.risk_level ?? risk.risk ?? "LOW"
    ).toUpperCase();

    const ruleRiskLevel = String(
      ruleBasedRisk.risk_level ?? "LOW"
    ).toUpperCase();

    const mlRiskScore = Number(
      risk.risk_score ?? risk.score ?? 0
    );

    const ruleRiskScore = Number(
      ruleBasedRisk.risk_score ?? 0
    );

    // Keep whichever risk level is more severe.
    const finalRiskLevel =
      (RISK_RANK[mlRiskLevel] ?? 0) >
      (RISK_RANK[ruleRiskLevel] ?? 0)
        ? mlRiskLevel
        : ruleRiskLevel;

    const finalRiskScore = Math.max(
      Number.isFinite(mlRiskScore) ? mlRiskScore : 0,
      Number.isFinite(ruleRiskScore) ? ruleRiskScore : 0
    );

    const anomalyDetected = Boolean(
      anomaly.anomaly_detected ??
      anomaly.is_anomaly ??
      anomaly.anomaly ??
      false
    );

    const aiAlerts = [];

    if (anomalyDetected) {
      aiAlerts.push({
        type: "ANOMALY",
        severity: finalRiskLevel,
        message:
          anomaly.message ||
          "The AI anomaly detector identified unusual sensor behavior.",
      });
    }

    if ((RISK_RANK[finalRiskLevel] ?? 0) >= RISK_RANK.HIGH) {
      aiAlerts.push({
        type: "HIGH_RISK",
        severity: finalRiskLevel,
        message: `AI risk assessment indicates ${finalRiskLevel} risk.`,
      });
    }

    return {
      available: true,
      finalRiskLevel,
      finalRiskScore,

      aiAnalysis: {
        mlRiskPrediction: mlRiskLevel,
        mlConfidence: risk.confidence ?? null,
        mlProbabilities: risk.probabilities ?? null,
        anomalyDetected,
        anomalyScore:
          anomaly.anomaly_score ?? anomaly.score ?? null,
        combinedScore:
          combined.combined_score ?? combined.score ?? null,
      },

      aiAlerts,
    };
  } catch (error) {
    console.error("AI analysis failed:", error.message);

    return {
      available: false,
      reason: error.message,
      finalRiskLevel: ruleBasedRisk.risk_level,
      finalRiskScore: ruleBasedRisk.risk_score,
      aiAlerts: [],
    };
  }
}

/**
 * Check whether the Python AI server is running.
 * IMPORTANT: The /health endpoint uses GET, not POST.
 */
async function checkAIServer() {
  try {
    const result = await callAI("/health", {}, "GET");
    return result.status === "ok";
  } catch (error) {
    console.error("AI health check failed:", error.message);
    return false;
  }
}

module.exports = {
  getAIAnalysis,
  checkAIServer,
  AI_SERVER_URL,
};