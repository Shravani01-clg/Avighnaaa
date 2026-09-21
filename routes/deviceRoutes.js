const express = require("express");

const {
  getDevices,
  getDeviceById
} = require("../controllers/deviceController");

const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// GET all devices — protected
router.get("/devices", authMiddleware, getDevices);

// GET one device — protected
router.get("/devices/:deviceId", authMiddleware, getDeviceById);

module.exports = router;