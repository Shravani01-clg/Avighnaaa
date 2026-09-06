const store = require("../config/dataStore");

// GET all devices
const getDevices = async (req, res) => {
  try {
    const data = await store.select("devices", { orderBy: "created_at" });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET one device
const getDeviceById = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const data = await store.select("devices", { filters: { device_id: deviceId }, limit: 1 });
    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: "Device not found" });
    }
    res.json({ success: true, data: data[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};


module.exports = {
  getDevices,
  getDeviceById
};