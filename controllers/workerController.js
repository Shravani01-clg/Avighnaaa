const store = require("../config/dataStore");

const getWorkers = async (req, res) => {
  try {
    const data = await store.select("workers", { orderBy: "created_at" });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getWorkers
};