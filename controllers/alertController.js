const store = require("../config/dataStore");

// POST /api/alerts
const createAlert = async (req, res) => {
  try {
    const { device_id, alert_type, severity, message } = req.body;

    if (!device_id || !alert_type || !severity || !message) {
      return res.status(400).json({
        success: false,
        message: "device_id, alert_type, severity and message are required"
      });
    }

    const data = await store.insert("alerts", { device_id, alert_type, severity, message, is_resolved: false });
    res.status(201).json({ success: true, message: "Alert created successfully", data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/alerts
const getAlerts = async (req, res) => {
  try {
    const data = await store.select("alerts", { orderBy: "created_at", limit: 50 });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/alerts/:deviceId
const getAlertsByDevice = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const data = await store.select("alerts", { filters: { device_id: deviceId }, orderBy: "created_at", limit: 50 });
    res.json({ success: true, device_id: deviceId, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// PATCH /api/alerts/:alertId/resolve
const resolveAlert = async (req, res) => {
  try {
    const { alertId } = req.params;
    const data = await store.update("alerts", { id: Number(alertId), is_resolved: false }, { is_resolved: true, resolved_at: new Date().toISOString() });
    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: "Alert not found or already resolved" });
    }
    res.json({ success: true, message: "Alert resolved successfully", data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};


module.exports = {
  createAlert,
  getAlerts,
  getAlertsByDevice,
  resolveAlert
};