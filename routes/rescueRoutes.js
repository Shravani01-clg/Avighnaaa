const express = require("express");

const {
  getTeams,
  getTeamById,
  createTeam,
  updateTeam,
  getLocations,
  getLocation,
  upsertLocation,
  getDeviceHealth,
  getLatestReading,
  sendDeviceCommand,
  getDeviceCommands,
  ackDeviceCommand,
} = require("../controllers/rescueController");

const authMiddleware = require("../middleware/authMiddleware");
const deviceAuth = require("../middleware/deviceAuth");
const { requireRole } = require("../middleware/roleMiddleware");

const router = express.Router();

// ── Rescue teams ───────────────────────────────────────────────
router.get("/rescue-teams", authMiddleware, getTeams);
router.get("/rescue-teams/:teamId", authMiddleware, getTeamById);
router.post("/rescue-teams", authMiddleware, requireRole("rescue_team"), createTeam);
router.patch("/rescue-teams/:teamId", authMiddleware, requireRole("rescue_team"), updateTeam);

// ── Device locations (configured installation location) ────────
router.get("/device-locations", authMiddleware, getLocations);
router.get("/device-locations/:deviceId", authMiddleware, getLocation);
router.put("/device-locations/:deviceId", authMiddleware, requireRole("rescue_team"), upsertLocation);

// ── Device health + latest reading ─────────────────────────────
router.get("/device-health", authMiddleware, requireRole("rescue_team"), getDeviceHealth);
router.get("/devices/:deviceId/latest-reading", authMiddleware, requireRole("rescue_team"), getLatestReading);

// ── Two-way device command (DEMO / SIMULATED — see controller) ─
router.post(
  "/devices/:deviceId/command",
  authMiddleware,
  requireRole("rescue_team"),
  sendDeviceCommand
);

// Device-side polling endpoints (ready for future firmware use)
router.get("/devices/:deviceId/commands", deviceAuth, getDeviceCommands);
router.post("/devices/:deviceId/commands/:commandId/ack", deviceAuth, ackDeviceCommand);

module.exports = router;
