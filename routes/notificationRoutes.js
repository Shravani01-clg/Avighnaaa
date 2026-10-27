const express = require("express");

const {
  listNotifications,
  markAllRead,
  markRead,
} = require("../controllers/notificationController");

const authMiddleware = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

const router = express.Router();

// ── Notifications (both logins; scoped server-side) ───────────
// GET returns only the rows addressed to the caller's audience:
//   user        → control-room/admin feed (team assigned, ...)
//   rescue_team → rescue feed (rescue requested, ...)
router.get("/notifications", authMiddleware, requireRole("user", "rescue_team"), listNotifications);

// read-all before :id/read so the literal path always wins.
router.post("/notifications/read-all", authMiddleware, requireRole("user", "rescue_team"), markAllRead);
router.post("/notifications/:id/read", authMiddleware, requireRole("user", "rescue_team"), markRead);

module.exports = router;
