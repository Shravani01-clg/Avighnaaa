const store = require("../config/dataStore");

// POST /api/risk
const createRiskPrediction = async (req, res) => {
  try {
    const { device_id, risk_score, risk_level, reason } = req.body;
    if (!device_id || risk_score === undefined || !risk_level || !reason) {
      return res.status(400).json({ success: false, message: "device_id, risk_score, risk_level and reason are required" });
    }
    const data = await store.insert("risk_predictions", { device_id, risk_score, risk_level, reason });
    res.status(201).json({ success: true, message: "Risk prediction created successfully", data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/risk
const getRiskPredictions = async (req, res) => {
  try {
    const data = await store.select("risk_predictions", { orderBy: "created_at", limit: 50 });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/risk/:deviceId
const getRiskByDevice = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const data = await store.select("risk_predictions", { filters: { device_id: deviceId }, orderBy: "created_at", limit: 50 });
    res.json({ success: true, device_id: deviceId, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};


module.exports = {
  createRiskPrediction,
  getRiskPredictions,
  getRiskByDevice
};