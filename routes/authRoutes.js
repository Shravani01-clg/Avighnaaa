const express = require("express");

const { getMe } = require("../controllers/authController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

// GET /api/auth/me — identity + role, verified backend-side
router.get("/auth/me", authMiddleware, getMe);

module.exports = router;
