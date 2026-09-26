const store = require("../config/dataStore");
const { calculateRisk } = require("./riskEngine");
const { getAIAnalysis } = require("./aiIntegration");

// ─── Alert Type → Severity Map ──────────────────────────────

const ALERT_SEVERITY = {
  GAS_DANGER: "HIGH",
  FLOOD_DANGER: "HIGH",
  TEMP_DANGER: "HIGH",
  FALL_DETECTED: "CRITICAL",
  POSSIBLE_FALL: "HIGH",
  SOS: "CRITICAL",
  COMBINED_DANGER: "CRITICAL",
  ANOMALY: "MEDIUM",
  HIGH_RISK: "HIGH",
  SENSOR_STUCK: "MEDIUM",
};

const ALERT_MESSAGES = {
  SENSOR_STUCK: "Sensor frozen — device check required",
  GAS_DANGER: "Dangerous gas levels detected",
  FLOOD_DANGER: "Flooding / high water level detected",
  TEMP_DANGER: "Abnormal temperature detected",
  FALL_DETECTED: "Worker fall detected — immediate assistance required",
  POSSIBLE_FALL: "Possible fall detected — worker may need help",
  SOS: "Emergency SOS activated by worker",
  COMBINED_DANGER: "Multiple simultaneous hazards detected — CRITICAL situation",
  ANOMALY: "AI detected an anomalous sensor pattern",
  HIGH_RISK: "High risk level detected",
};

/**
 * Create an alert if no unresolved alert of the same type exists for this device.
 * Deduplication prevents alert spam for ongoing events.
 */
async function createAlertIfNew(device_id, alertType, extraMessage) {
  try {
    const existing = await store.select("alerts", {
      filters: { device_id, alert_type: alertType, is_resolved: false },
      limit: 1,
    });

    if (existing.length > 0) return; // already have an open alert

    const severity = ALERT_SEVERITY[alertType] || "MEDIUM";
    const baseMessage = ALERT_MESSAGES[alertType] || `${alertType} alert`;
    const message = extraMessage ? `${baseMessage}: ${extraMessage}` : baseMessage;

    await store.insert("alerts", { device_id, alert_type: alertType, severity, message, is_resolved: false });
  } catch (err) {
    console.error(`Alert creation failed for ${alertType}:`, err.message);
  }
}

// POST /api/sensor-data
const receiveSensorData = async (req, res) => {
  try {
    const {
      device_id,
      temperature_c,
      gas_raw,
      water_level_cm,
      acceleration_x_ms2,
      acceleration_y_ms2,
      acceleration_z_ms2,
      sos,
      timestamp
    } = req.body;

    // Input validation
    if (!device_id || typeof device_id !== "string") {
      return res.status(400).json({
        success: false,
        message: "Valid device_id is required"
      });
    }

    const numericFields = {
      temperature_c,
      gas_raw,
      water_level_cm,
      acceleration_x_ms2,
      acceleration_y_ms2,
      acceleration_z_ms2
    };

    for (const [field, value] of Object.entries(numericFields)) {
      if (
        value === undefined ||
        value === null ||
        typeof value !== "number" ||
        !Number.isFinite(value)
      ) {
        return res.status(400).json({
          success: false,
          message: `${field} must be a valid number`
        });
      }
    }

    if (gas_raw < 0) {
      return res.status(400).json({
        success: false,
        message: "gas_raw cannot be negative"
      });
    }

    if (water_level_cm < 0) {
      return res.status(400).json({
        success: false,
        message: "water_level_cm cannot be negative"
      });
    }

    if (sos !== undefined && typeof sos !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "sos must be true or false"
      });
    }

    if (timestamp !== undefined) {
      const parsedTimestamp = new Date(timestamp);
      if (Number.isNaN(parsedTimestamp.getTime())) {
        return res.status(400).json({
          success: false,
          message: "timestamp must be a valid ISO 8601 date"
        });
      }
    }

    // ── Calculate risk (enhanced engine with fall detection) ──
    const ruleBasedRisk = calculateRisk(req.body);

    // ── Get AI analysis (falls back gracefully if AI server is down) ──
    const aiResult = await getAIAnalysis(req.body, ruleBasedRisk);

    // Final risk: AI never downgrades, only upgrades
    // Phase 3 contract: risk_level, risk_score, anomaly_detected, reason are ALWAYS present
    const risk = {
      risk_score: aiResult.finalRiskScore || ruleBasedRisk.risk_score,
      risk_level: aiResult.finalRiskLevel || ruleBasedRisk.risk_level,
      anomaly_detected:
        ruleBasedRisk.anomaly_detected ||
        (aiResult.aiAnalysis ? aiResult.aiAnalysis.anomalyDetected === true : false),
      fall_state: ruleBasedRisk.fall_state || "NORMAL",
      reason: ruleBasedRisk.reason,
      details: ruleBasedRisk.details,
      alerts: [...ruleBasedRisk.alerts, ...(aiResult.aiAlerts || [])],
      ai: aiResult.aiAnalysis || null,
    };

    // ── Store sensor reading ──
    const data = await store.insert("sensor_readings", {
      device_id,
      temperature_c,
      gas_raw,
      water_level_cm,
      acceleration_x_ms2,
      acceleration_y_ms2,
      acceleration_z_ms2,
      sos: sos ?? false,
      recorded_at: timestamp || new Date().toISOString()
    });
    const record = Array.isArray(data) ? data[0] : data;

    // ── Store risk prediction ──
    const riskData = await store.insert("risk_predictions", {
  device_id,
  risk_score: risk.risk_score,
  risk_level: risk.risk_level,
  reason: risk.reason,
  anomaly_detected: risk.anomaly_detected,
  fall_state: risk.fall_state,
  ai: risk.ai
});
    // store.insert returns an array of inserted rows — unwrap for the API contract
    const riskRecord = Array.isArray(riskData) ? riskData[0] : riskData;

    // ── Create alerts based on enhanced risk engine output ──
    // The risk engine returns an array of alert types that should be created.
    // Each alert is deduplicated — only one unresolved alert per type per device.
    for (const alertType of risk.alerts) {
      await createAlertIfNew(device_id, alertType, risk.reason);
    }

    res.status(201).json({
      success: true,
      message: "Sensor data, risk prediction and alerts processed successfully",
      data: record,
      risk: {
        ...riskRecord,
        // Phase 3 output contract — predictable fields for the frontend
        anomaly_detected: risk.anomaly_detected,
        fall_state: risk.fall_state,
      },
      riskDetails: risk.details,
      alertsCreated: risk.alerts,
      ai: risk.ai,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message
    });
  }
};


// GET /api/sensor-data/:deviceId
const getSensorData = async (req, res) => {
  try {
    const { deviceId } = req.params;

    const data = await store.select("sensor_readings", {
      filters: { device_id: deviceId },
      orderBy: "recorded_at",
      limit: 50,
    });

    res.json({
      success: true,
      device_id: deviceId,
      count: data.length,
      data
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message
    });
  }
};


module.exports = {
  receiveSensorData,
  getSensorData
};