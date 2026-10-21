const express = require("express");

const {
  listIncidents,
  getIncident,
  getTimeline,
  requestRescue,
  getHistory,
  assignIncident,
  acceptIncident,
  enRouteIncident,
  arriveIncident,
  startRescue,
  personSafe,
  resolveIncident,
  escalateIncident,
  cancelIncident,
  getStats,
} = require("../controllers/incidentController");

const authMiddleware = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

const router = express.Router();

// All incident routes require a valid Supabase JWT
router.use(authMiddleware);

// ── Read endpoints ─────────────────────────────────────────────
// user      → active emergencies only (enforced in listIncidents) so the
//             main dashboard can show the emergency + request rescue.
// rescue_team → everything, including closed incidents/history.
router.get("/incidents", requireRole("user", "rescue_team"), listIncidents);
router.get("/incidents/stats", requireRole("rescue_team"), getStats);
router.get("/incidents/history", requireRole("rescue_team"), getHistory);
router.get("/incidents/:id/timeline", requireRole("user", "rescue_team"), getTimeline);
router.get("/incidents/:id", requireRole("user", "rescue_team"), getIncident);

// ── Rescue request (main dashboard → rescue portal) ────────────
// Any authenticated user or the rescue team. Idempotent, and it
// activates an EXISTING incident rather than creating a duplicate.
router.post("/incidents/:id/request-rescue", requireRole("user", "rescue_team"), requestRescue);

// ── Rescue Control — belongs to the RESCUE TEAM ────────────────
// There is no admin role: assignment, escalation and cancellation are
// operational rescue decisions made from the Rescue Control console.
router.post("/incidents/:id/assign", requireRole("rescue_team"), assignIncident);

// Mission workflow — rescue team (role + assigned-team checked in controller)
router.post("/incidents/:id/accept", requireRole("rescue_team"), acceptIncident);
router.post("/incidents/:id/en-route", requireRole("rescue_team"), enRouteIncident);
router.post("/incidents/:id/arrive", requireRole("rescue_team"), arriveIncident);
router.post("/incidents/:id/start-rescue", requireRole("rescue_team"), startRescue);
router.post("/incidents/:id/person-safe", requireRole("rescue_team"), personSafe);

// Resolve / escalate / cancel — rescue team (transition map still enforced)
router.post("/incidents/:id/resolve", requireRole("rescue_team"), resolveIncident);
router.post("/incidents/:id/escalate", requireRole("rescue_team"), escalateIncident);
router.post("/incidents/:id/cancel", requireRole("rescue_team"), cancelIncident);

module.exports = router;
