const supabase = require("../config/supabase");
const { calculateRisk } = require("./riskEngine");

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

    // Gas and water levels cannot be negative
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

    // SOS must be boolean
    if (sos !== undefined && typeof sos !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "sos must be true or false"
      });
    }

    // Timestamp validation
    if (timestamp !== undefined) {
      const parsedTimestamp = new Date(timestamp);

      if (Number.isNaN(parsedTimestamp.getTime())) {
        return res.status(400).json({
          success: false,
          message: "timestamp must be a valid ISO 8601 date"
        });
      }
    }

    // Calculate risk
    const risk = calculateRisk(req.body);

    // Store sensor reading
    const { data, error } = await supabase
      .from("sensor_readings")
      .insert([
        {
          device_id,
          temperature_c,
          gas_raw,
          water_level_cm,
          acceleration_x_ms2,
          acceleration_y_ms2,
          acceleration_z_ms2,
          sos: sos ?? false,
          recorded_at: timestamp || new Date().toISOString()
        }
      ])
      .select();

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to store sensor data",
        error: error.message
      });
    }

    // Store calculated risk prediction
    const { data: riskData, error: riskError } = await supabase
      .from("risk_predictions")
      .insert([
        {
          device_id,
          risk_score: risk.risk_score,
          risk_level: risk.risk_level,
          reason: risk.reason
        }
      ])
      .select();

    if (riskError) {
      return res.status(500).json({
        success: false,
        message: "Sensor data stored, but risk prediction failed",
        error: riskError.message
      });
    }

    // Create HIGH_RISK alert only if there is no unresolved HIGH_RISK alert
    if (risk.risk_level === "HIGH") {
      const {
        data: existingHighRiskAlerts,
        error: highRiskCheckError
      } = await supabase
        .from("alerts")
        .select("id")
        .eq("device_id", device_id)
        .eq("alert_type", "HIGH_RISK")
        .eq("is_resolved", false)
        .limit(1);

      if (highRiskCheckError) {
        return res.status(500).json({
          success: false,
          message: "Risk stored, but HIGH_RISK alert check failed",
          error: highRiskCheckError.message
        });
      }

      if (existingHighRiskAlerts.length === 0) {
        const { error: alertError } = await supabase
          .from("alerts")
          .insert([
            {
              device_id,
              alert_type: "HIGH_RISK",
              severity: "HIGH",
              message: `High risk detected: ${risk.reason}`,
              is_resolved: false
            }
          ]);

        if (alertError) {
          return res.status(500).json({
            success: false,
            message: "Sensor data and risk stored, but alert creation failed",
            error: alertError.message
          });
        }
      }
    }

    // Create SOS alert only if there is no unresolved SOS alert
    if (sos === true) {
      const {
        data: existingSosAlerts,
        error: sosCheckError
      } = await supabase
        .from("alerts")
        .select("id")
        .eq("device_id", device_id)
        .eq("alert_type", "SOS")
        .eq("is_resolved", false)
        .limit(1);

      if (sosCheckError) {
        return res.status(500).json({
          success: false,
          message: "Sensor data and risk stored, but SOS alert check failed",
          error: sosCheckError.message
        });
      }

      if (existingSosAlerts.length === 0) {
        const { error: sosAlertError } = await supabase
          .from("alerts")
          .insert([
            {
              device_id,
              alert_type: "SOS",
              severity: "CRITICAL",
              message: "Emergency SOS activated by worker",
              is_resolved: false
            }
          ]);

        if (sosAlertError) {
          return res.status(500).json({
            success: false,
            message: "Sensor data stored, but SOS alert creation failed",
            error: sosAlertError.message
          });
        }
      }
    }

    res.status(201).json({
      success: true,
      message: "Sensor data, risk prediction and alerts processed successfully",
      data,
      risk: riskData
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};


// GET /api/sensor-data/:deviceId
const getSensorData = async (req, res) => {
  try {
    const { deviceId } = req.params;

    const { data, error } = await supabase
      .from("sensor_readings")
      .select("*")
      .eq("device_id", deviceId)
      .order("recorded_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch sensor data",
        error: error.message
      });
    }

    res.json({
      success: true,
      device_id: deviceId,
      count: data.length,
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};


module.exports = {
  receiveSensorData,
  getSensorData
};