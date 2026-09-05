const express = require("express");

const {
  createRiskPrediction,
  getRiskPredictions,
  getRiskByDevice
} = require("../controllers/riskController");

const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// POST a new risk prediction — protected
router.post("/risk", authMiddleware, createRiskPrediction);

// GET all risk predictions — protected
router.get("/risk", authMiddleware, getRiskPredictions);

// GET risk predictions for one device — protected
router.get("/risk/:deviceId", authMiddleware, getRiskByDevice);

module.exports = router;