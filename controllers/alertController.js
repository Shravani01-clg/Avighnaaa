const supabase = require("../config/supabase");

// POST /api/alerts
const createAlert = async (req, res) => {
  try {
    const {
      device_id,
      alert_type,
      severity,
      message
    } = req.body;

    if (!device_id || !alert_type || !severity || !message) {
      return res.status(400).json({
        success: false,
        message: "device_id, alert_type, severity and message are required"
      });
    }

    const { data, error } = await supabase
      .from("alerts")
      .insert([
        {
          device_id,
          alert_type,
          severity,
          message,
          is_resolved: false
        }
      ])
      .select();

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to create alert",
        error: error.message
      });
    }

    res.status(201).json({
      success: true,
      message: "Alert created successfully",
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


// GET /api/alerts
const getAlerts = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch alerts",
        error: error.message
      });
    }

    res.json({
      success: true,
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


// GET /api/alerts/:deviceId
const getAlertsByDevice = async (req, res) => {
  try {
    const { deviceId } = req.params;

    const { data, error } = await supabase
      .from("alerts")
      .select("*")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch device alerts",
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


// PATCH /api/alerts/:alertId/resolve
const resolveAlert = async (req, res) => {
  try {
    const { alertId } = req.params;

    const { data, error } = await supabase
      .from("alerts")
      .update({
        is_resolved: true,
        resolved_at: new Date().toISOString()
      })
      .eq("id", alertId)
      .eq("is_resolved", false)
      .select();

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to resolve alert",
        error: error.message
      });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Alert not found or already resolved"
      });
    }

    res.json({
      success: true,
      message: "Alert resolved successfully",
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
  createAlert,
  getAlerts,
  getAlertsByDevice,
  resolveAlert
};