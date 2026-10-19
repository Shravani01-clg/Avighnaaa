const express = require("express");

const {
  listEquipment,
  getEquipment,
  updateEquipment,
  getRecommendations,
  getChecklist,
  saveChecklist,
  returnEquipment,
  getUsageHistory,
} = require("../controllers/equipmentController");

const authMiddleware = require("../middleware/authMiddleware");
const { requireRole } = require("../middleware/roleMiddleware");

const router = express.Router();

// Rescue equipment belongs ONLY to the RESCUE_TEAM role.
router.use(authMiddleware, requireRole("rescue_team"));

// ── Inventory ──────────────────────────────────────────────────
// NOTE: static paths are declared before /:id so "usage", "return" and
// "recommendations" are not swallowed by the parameterised route.
router.get("/rescue-equipment/usage", getUsageHistory);
router.post("/rescue-equipment/return", returnEquipment);
router.get("/rescue-equipment/recommendations/:incidentId", getRecommendations);
router.get("/rescue-equipment/checklist/:incidentId", getChecklist);
router.post("/rescue-equipment/checklist/:incidentId", saveChecklist);

router.get("/rescue-equipment", listEquipment);
router.get("/rescue-equipment/:id", getEquipment);
router.patch("/rescue-equipment/:id", updateEquipment);

module.exports = router;