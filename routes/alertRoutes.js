const express = require("express");

const {
  createAlert,
  getAlerts,
  getAlertsByDevice,
  resolveAlert
} = require("../controllers/alertController");

const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// POST a new alert — protected
router.post("/alerts", authMiddleware, createAlert);

// GET all alerts — protected
router.get("/alerts", authMiddleware, getAlerts);

// GET alerts for one device — protected
router.get("/alerts/:deviceId", authMiddleware, getAlertsByDevice);

// PATCH resolve an alert — protected
router.patch("/alerts/:alertId/resolve", authMiddleware, resolveAlert);

module.exports = router;