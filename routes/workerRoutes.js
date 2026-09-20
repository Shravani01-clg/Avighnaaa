const express = require("express");

const {
  getWorkers
} = require("../controllers/workerController");

const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// GET all workers — protected
router.get("/workers", authMiddleware, getWorkers);

module.exports = router;