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
};

const ALERT_MESSAGES = {
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

/**
 * Create an alert if no unresolved alert of the same type
 * exists for this device.
 *
 * Deduplication prevents alert spam for ongoing events.
 */
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

    if (existing.length > 0) return;

    const severity =
      ALERT_SEVERITY[alertType] || "MEDIUM";

    const baseMessage =
      ALERT_MESSAGES[alertType] ||
      `${alertType} alert`;

    const message = extraMessage
      ? `${baseMessage}: ${extraMessage}`
      : baseMessage;

    await store.insert("alerts", {
      device_id,
      alert_type: alertType,
      severity,
      message,
      is_resolved: false,
    });
  } catch (err) {
    console.error(
      `Alert creation failed for ${alertType}:`,
      err.message
    );
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
      battery_level_percent,
      sos,
      timestamp,
    } = req.body;

    // ── Input validation ────────────────────────────────────

    if (
      !device_id ||
      typeof device_id !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Valid device_id is required",
      });
    }

    // ── MPU6050 validation ──────────────────────────────────
    //
    // MPU6050 is currently the only physical sensor.
    // Therefore X, Y and Z acceleration are required.
    //

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

    // ── Optional sensor validation ──────────────────────────
    //
    // These sensors are NOT currently connected.
    // If values are supplied later, validate them.
    //

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

    // ── Battery validation ──────────────────────────────────

    if (
      battery_level_percent !== undefined &&
      battery_level_percent !== null
    ) {
      if (
        typeof battery_level_percent !== "number" ||
        !Number.isFinite(
          battery_level_percent
        )
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

    // ── SOS validation ──────────────────────────────────────

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

    // ── Timestamp validation ────────────────────────────────

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

    // ── Calculate risk ──────────────────────────────────────

    const ruleBasedRisk =
      calculateRisk(req.body);

    // ── Get AI analysis ─────────────────────────────────────

    const aiResult =
      await getAIAnalysis(
        req.body,
        ruleBasedRisk
      );

    // Final risk: AI never downgrades, only upgrades
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
            ? aiResult.aiAnalysis
                .anomalyDetected === true
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

    // ── Store sensor reading ────────────────────────────────
    //
    // Only MPU6050 values are currently real.
    // Other sensor values are stored as NULL.
    //

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

          recorded_at:
            timestamp ||
            new Date().toISOString(),
        }
      );

    const record =
      Array.isArray(data)
        ? data[0]
        : data;

    // ── Store risk prediction ──────────────────────────────

    const riskData =
      await store.insert(
        "risk_predictions",
        {
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
        }
      );

    const riskRecord =
      Array.isArray(riskData)
        ? riskData[0]
        : riskData;

    // ── Create alerts ───────────────────────────────────────

    for (
      const alertType
      of risk.alerts
    ) {
      await createAlertIfNew(
        device_id,
        alertType,
        risk.reason
      );
    }

    // ── API response ────────────────────────────────────────

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

// GET /api/sensor-data/:deviceId
const getSensorData =
  async (req, res) => {

    try {

      const {
        deviceId
      } = req.params;

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

module.exports = {
  receiveSensorData,
  getSensorData,
};