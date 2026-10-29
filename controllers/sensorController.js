const store = require("../config/dataStore");
const { calculateRisk } = require("./riskEngine");
const { getAIAnalysis } = require("./aiIntegration");
const { createIncidentFromAlert } = require("./incidentController");

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
  FALL_DETECTED:
    "Worker fall detected — immediate assistance required",
  POSSIBLE_FALL:
    "Possible fall detected — worker may need help",
  SOS: "Emergency SOS activated by worker",
  COMBINED_DANGER:
    "Multiple simultaneous hazards detected — CRITICAL situation",
  ANOMALY:
    "AI detected an anomalous sensor pattern",
  HIGH_RISK:
    "High risk level detected",
};

// =====================================================
//                  CREATE ALERT IF NEW
// =====================================================

async function createAlertIfNew(
  device_id,
  alertType,
  extraMessage
) {
  try {
    const existing = await store.select("alerts", {
      filters: {
        device_id,
        alert_type: alertType,
        is_resolved: false,
      },
      limit: 1,
    });

    if (existing.length > 0) {
      return existing[0].id;
    }

    const severity =
      ALERT_SEVERITY[alertType] || "MEDIUM";

    const baseMessage =
      ALERT_MESSAGES[alertType] ||
      `${alertType} alert`;

    const message = extraMessage
      ? `${baseMessage}: ${extraMessage}`
      : baseMessage;

    const created = await store.insert("alerts", {
      device_id,
      alert_type: alertType,
      severity,
      message,
      is_resolved: false,
    });

    return Array.isArray(created) && created[0]
      ? created[0].id
      : null;

  } catch (err) {

    console.error(
      `Alert creation failed for ${alertType}:`,
      err.message
    );
  }
}

// =====================================================
//                  POST /api/sensor-data
// =====================================================

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
      battery_level_percent,
      sos,

      // NEW: PIR motion status
      motion_detected,

      timestamp,
    } = req.body;

    // ===================================================
    // INPUT VALIDATION
    // ===================================================

    if (
      !device_id ||
      typeof device_id !== "string"
    ) {

      return res.status(400).json({
        success: false,
        message: "Valid device_id is required",
      });
    }

    // ===================================================
    // MPU6050 VALIDATION
    // ===================================================

    const mpuFields = {
      acceleration_x_ms2,
      acceleration_y_ms2,
      acceleration_z_ms2,
    };

    for (
      const [field, value]
      of Object.entries(mpuFields)
    ) {

      if (
        value === undefined ||
        value === null ||
        typeof value !== "number" ||
        !Number.isFinite(value)
      ) {

        return res.status(400).json({
          success: false,
          message:
            `${field} must be a valid number`,
        });
      }
    }

    // ===================================================
    // OPTIONAL SENSOR VALIDATION
    // ===================================================

    if (
      temperature_c !== undefined &&
      temperature_c !== null
    ) {

      if (
        typeof temperature_c !== "number" ||
        !Number.isFinite(temperature_c)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "temperature_c must be a valid number or null",
        });
      }
    }

    // ===================================================
    // GAS VALIDATION
    // ===================================================

    if (
      gas_raw !== undefined &&
      gas_raw !== null
    ) {

      if (
        typeof gas_raw !== "number" ||
        !Number.isFinite(gas_raw)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "gas_raw must be a valid number or null",
        });
      }

      if (gas_raw < 0) {

        return res.status(400).json({
          success: false,
          message:
            "gas_raw cannot be negative",
        });
      }
    }

    // ===================================================
    // WATER VALIDATION
    // ===================================================

    if (
      water_level_cm !== undefined &&
      water_level_cm !== null
    ) {

      if (
        typeof water_level_cm !== "number" ||
        !Number.isFinite(water_level_cm)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "water_level_cm must be a valid number or null",
        });
      }

      if (water_level_cm < 0) {

        return res.status(400).json({
          success: false,
          message:
            "water_level_cm cannot be negative",
        });
      }
    }

    // ===================================================
    // BATTERY VALIDATION
    // ===================================================

    if (
      battery_level_percent !== undefined &&
      battery_level_percent !== null
    ) {

      if (
        typeof battery_level_percent !== "number" ||
        !Number.isFinite(battery_level_percent)
      ) {

        return res.status(400).json({
          success: false,
          message:
            "battery_level_percent must be a valid number or null",
        });
      }

      if (
        battery_level_percent < 0 ||
        battery_level_percent > 100
      ) {

        return res.status(400).json({
          success: false,
          message:
            "battery_level_percent must be between 0 and 100",
        });
      }
    }

    // ===================================================
    // SOS VALIDATION
    // ===================================================

    if (
      sos !== undefined &&
      typeof sos !== "boolean"
    ) {

      return res.status(400).json({
        success: false,
        message:
          "sos must be true or false",
      });
    }

    // ===================================================
    // PIR MOTION VALIDATION
    // ===================================================

    if (
      motion_detected !== undefined &&
      typeof motion_detected !== "boolean"
    ) {

      return res.status(400).json({
        success: false,
        message:
          "motion_detected must be true or false",
      });
    }

    // ===================================================
    // TIMESTAMP VALIDATION
    // ===================================================

    if (timestamp !== undefined) {

      const parsedTimestamp =
        new Date(timestamp);

      if (
        Number.isNaN(
          parsedTimestamp.getTime()
        )
      ) {

        return res.status(400).json({
          success: false,
          message:
            "timestamp must be a valid ISO 8601 date",
        });
      }
    }

    // ===================================================
    // CALCULATE RULE-BASED RISK
    // ===================================================

    const ruleBasedRisk =
      calculateRisk(req.body);

    // ===================================================
    // GET AI ANALYSIS
    // ===================================================

    const aiResult =
      await getAIAnalysis(
        req.body,
        ruleBasedRisk
      );

    // Final risk:
    // AI never downgrades, only upgrades

    const risk = {

      risk_score:
        aiResult.finalRiskScore ||
        ruleBasedRisk.risk_score,

      risk_level:
        aiResult.finalRiskLevel ||
        ruleBasedRisk.risk_level,

      anomaly_detected:
        ruleBasedRisk.anomaly_detected ||
        (
          aiResult.aiAnalysis
            ? aiResult.aiAnalysis.anomalyDetected === true
            : false
        ),

      fall_state:
        ruleBasedRisk.fall_state ||
        "NORMAL",

      reason:
        ruleBasedRisk.reason,

      details:
        ruleBasedRisk.details,

      alerts: [
        ...ruleBasedRisk.alerts,
        ...(aiResult.aiAlerts || []),
      ],

      ai:
        aiResult.aiAnalysis || null,
    };

    // ===================================================
    // STORE SENSOR READING
    // ===================================================

    const data =
      await store.insert(
        "sensor_readings",
        {

          device_id,

          temperature_c:
            temperature_c ?? null,

          gas_raw:
            gas_raw ?? null,

          water_level_cm:
            water_level_cm ?? null,

          acceleration_x_ms2,

          acceleration_y_ms2,

          acceleration_z_ms2,

          battery_level_percent:
            battery_level_percent ?? null,

          sos:
            sos ?? false,

          // NEW:
          // PIR motion status
          motion_detected:
            motion_detected ?? false,

          recorded_at:
            timestamp ||
            new Date().toISOString(),
        }
      );

    const record =
      Array.isArray(data)
        ? data[0]
        : data;

    // ===================================================
    // STORE RISK PREDICTION
    // ===================================================

    const riskRow = {

      device_id,

      risk_score:
        risk.risk_score,

      risk_level:
        risk.risk_level,

      reason:
        risk.reason,

      anomaly_detected:
        risk.anomaly_detected,

      fall_state:
        risk.fall_state,
    };

    let riskData;

    try {

      riskData =
        await store.insert(
          "risk_predictions",
          {
            ...riskRow,
            ai: risk.ai || null
          }
        );

    } catch (err) {

      const isMissingAiColumn =
        err &&
        err.code === "42703" &&
        typeof err.message === "string" &&
        /\bdoes not exist\b/i.test(
          err.message
        ) &&
        /\bai\b/.test(
          err.message
        );

      if (!isMissingAiColumn) {

        console.error(
          "Risk prediction insert failed:",
          err.message
        );

        throw err;
      }

      console.warn(
        "risk_predictions.ai column missing — storing without AI payload"
      );

      riskData =
        await store.insert(
          "risk_predictions",
          riskRow
        );
    }

    const riskRecord =
      Array.isArray(riskData)
        ? riskData[0]
        : riskData;

    // ===================================================
    // CREATE ALERTS
    // ===================================================

    const createdAlertIds = {};

    for (
      const alertType
      of risk.alerts
    ) {

      const typeId =
        typeof alertType === "string"
          ? alertType
          : alertType &&
            alertType.type;

      if (!typeId) {
        continue;
      }

      const alertId =
        await createAlertIfNew(
          device_id,
          typeId,
          risk.reason
        );

      createdAlertIds[typeId] =
        alertId;
    }

    // ===================================================
    // RESCUE LAYER
    // ===================================================

    const HAZARD_PRIORITY = {

      COMBINED_DANGER: 100,

      SOS: 90,

      GAS_DANGER: 80,

      TEMP_DANGER: 70,

      FALL_DETECTED: 65,

      FLOOD_DANGER: 60,

      POSSIBLE_FALL: 50,

      HIGH_RISK: 20,

      ANOMALY: 10,
    };

    let bestEntry = null;

    let bestPriority = -1;

    for (
      const alertEntry
      of risk.alerts
    ) {

      const typeId =
        typeof alertEntry === "string"
          ? alertEntry
          : alertEntry &&
            alertEntry.type;

      if (!typeId) {
        continue;
      }

      const severity =
        (
          typeof alertEntry === "object" &&
          alertEntry.severity
        ) ||
        ALERT_SEVERITY[typeId] ||
        "MEDIUM";

      const priority =
        HAZARD_PRIORITY[typeId] ||
        0;

      if (
        priority >
        bestPriority
      ) {

        bestPriority =
          priority;

        bestEntry = {
          typeId,
          severity,
        };
      }
    }

    if (bestEntry) {

      await createIncidentFromAlert({
        device_id,

        alertType:
          bestEntry.typeId,

        severity:
          bestEntry.severity,

        alertId:
          createdAlertIds[
            bestEntry.typeId
          ] || null,

        risk: {
          ...risk,
          sos:
            req.body.sos === true,
        },
      });
    }

    // ===================================================
    // API RESPONSE
    // ===================================================

    res.status(201).json({

      success: true,

      message:
        "MPU6050 sensor data, risk prediction and alerts processed successfully",

      data: record,

      risk: {

        ...riskRecord,

        anomaly_detected:
          risk.anomaly_detected,

        fall_state:
          risk.fall_state,
      },

      riskDetails:
        risk.details,

      alertsCreated:
        risk.alerts,

      ai:
        risk.ai,
    });

  } catch (err) {

    console.error(
      "❌ Sensor data processing error:",
      err
    );

    res.status(500).json({

      success: false,

      message:
        "Server error",

      error:
        err.message,
    });
  }
};

// =====================================================
//             GET /api/sensor-data/:deviceId
// =====================================================

const getSensorData =
  async (req, res) => {

    try {

      const { deviceId } =
        req.params;

      const data =
        await store.select(
          "sensor_readings",
          {

            filters: {
              device_id:
                deviceId,
            },

            orderBy:
              "recorded_at",

            limit: 50,
          }
        );

      res.json({

        success: true,

        device_id:
          deviceId,

        count:
          data.length,

        data,
      });

    } catch (err) {

      res.status(500).json({

        success: false,

        message:
          "Server error",

        error:
          err.message,
      });
    }
  };

// =====================================================
//                    EXPORTS
// =====================================================

module.exports = {
  receiveSensorData,
  getSensorData,
};