const express = require("express");

const {
  receiveSensorData,
  getSensorData
} = require("../controllers/sensorController");

const deviceAuth = require("../middleware/deviceAuth");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// POST sensor data — ESP32 protected by device API key
router.post("/sensor-data", deviceAuth, receiveSensorData);

// GET sensor data — dashboard protected by Supabase JWT
router.get("/sensor-data/:deviceId", authMiddleware, getSensorData);

module.exports = router;