/**
 * Rescue Equipment Controller
 *
 * Equipment management for the RESCUE_TEAM role. Backed by the existing
 * Supabase/dataStore architecture (no second database).
 *
 * Everything here is real data:
 *  - inventory comes from rescue_equipment
 *  - checklists come from equipment_checklists
 *  - usage comes from equipment_usage
 *  - history comes from equipment_events
 *
 * Equipment is only marked IN_USE when the workflow explicitly checks it
 * out — nothing is fabricated automatically.
 */

const { eq, normaliseJson, storage } = require("./equipmentHelpers");
// incidents live in the original Avighnaa schema and always exist, so they
// are read straight from the shared store.
const store = require("../config/dataStore");
const {
  HAZARD_EQUIPMENT,
  EQUIPMENT_ITEM_TYPES,
  EQUIPMENT_TYPES,
  EQUIPMENT_STATUSES,
  EQUIPMENT_CONDITIONS,
  READY_EQUIPMENT_STATUSES,
  HAZARD_LABELS,
  ACTION_EVENTS,
} = require("../config/rescueConfig");

const nowIso = () => new Date().toISOString();

// ─── helpers ───────────────────────────────────────────────────

async function logEquipmentEvent(equipment_id, event_type, notes, performed_by) {
  try {
    await eq("insert", "equipment_events", {
      equipment_id,
      event_type,
      notes: notes || null,
      performed_by: performed_by || "system",
      created_at: nowIso(),
    });
  } catch (err) {
    console.error("Equipment event logging failed:", err.message);
  }
}

async function findIncidentByText(incidentId) {
  const rows = await store.select("incidents", {
    filters: { incident_id: incidentId },
    limit: 1,
  });
  return rows && rows.length ? rows[0] : null;
}

// ─── Inventory ─────────────────────────────────────────────────

/**
 * GET /api/rescue-equipment
 * Query: status, type, team, q (search)
 */
const listEquipment = async (req, res) => {
  try {
    const { status, type, team, q } = req.query;
    let rows = await eq("select", "rescue_equipment", { orderBy: "equipment_id", limit: 500 });

    if (status) rows = rows.filter((r) => r.status === status);
    if (type) rows = rows.filter((r) => r.equipment_type === type);
    if (team) rows = rows.filter((r) => r.assigned_team_id === team);
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter(
        (r) =>
          String(r.equipment_name || "").toLowerCase().includes(needle) ||
          String(r.equipment_id || "").toLowerCase().includes(needle)
      );
    }

    // Readiness rollup for the equipment dashboard.
    const summary = {
      total: rows.length,
      available: rows.filter((r) => r.status === "AVAILABLE").length,
      in_use: rows.filter((r) => r.status === "IN_USE").length,
      maintenance: rows.filter((r) => r.status === "MAINTENANCE").length,
      damaged: rows.filter((r) => r.status === "DAMAGED").length,
      unavailable: rows.filter((r) => r.status === "UNAVAILABLE").length,
      total_units: rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0),
    };
    summary.ready_percent =
      summary.total === 0
        ? 0
        : Math.round(
            (rows.filter((r) => READY_EQUIPMENT_STATUSES.includes(r.status)).length /
              summary.total) * 100
          );

    // Maintenance attention list — never presented as "ready".
    const needsAttention = rows
      .filter((r) => ["MAINTENANCE", "DAMAGED", "UNAVAILABLE"].includes(r.status))
      .sort((a, b) => String(a.next_inspection_date || "").localeCompare(String(b.next_inspection_date || "")));

    res.json({
      success: true,
      count: rows.length,
      summary,
      needs_attention: needsAttention,
      storage: await storage(),
      data: rows,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/** GET /api/rescue-equipment/:id — one item plus its history. */
const getEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    let rows = await eq("select", "rescue_equipment", { filters: { equipment_id: id }, limit: 1 });

    // Also allow lookup by the internal uuid.
    if (!rows || rows.length === 0) {
      rows = await eq("select", "rescue_equipment", { filters: { id }, limit: 1 });
    }
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Equipment not found" });
    }

    const item = rows[0];
    const events = await eq("select", "equipment_events", {
      filters: { equipment_id: item.equipment_id },
      orderBy: "created_at",
      limit: 100,
    });
    const usage = await eq("select", "equipment_usage", {
      filters: { equipment_id: item.equipment_id },
      orderBy: "checked_out_at",
      limit: 50,
    });

    res.json({
      success: true,
      data: item,
      history: (events || []).slice().sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      ),
      usage: usage || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/** PATCH /api/rescue-equipment/:id — status / condition / inspection dates. */
const updateEquipment = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};

    const rows = await eq("select", "rescue_equipment", { filters: { equipment_id: id }, limit: 1 });
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: "Equipment not found" });
    }
    const item = rows[0];

    const updates = { updated_at: nowIso() };

    if (body.status !== undefined) {
      if (!EQUIPMENT_STATUSES.includes(body.status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Allowed: ${EQUIPMENT_STATUSES.join(", ")}`,
        });
      }
      updates.status = body.status;
    }
    if (body.condition !== undefined) {
      if (!EQUIPMENT_CONDITIONS.includes(body.condition)) {
        return res.status(400).json({
          success: false,
          message: `Invalid condition. Allowed: ${EQUIPMENT_CONDITIONS.join(", ")}`,
        });
      }
      updates.condition = body.condition;
    }
    if (body.quantity !== undefined) updates.quantity = Number(body.quantity);
    if (body.assigned_team_id !== undefined) updates.assigned_team_id = body.assigned_team_id;
    if (body.location !== undefined) updates.location = body.location;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.last_inspection_date !== undefined) updates.last_inspection_date = body.last_inspection_date;
    if (body.next_inspection_date !== undefined) updates.next_inspection_date = body.next_inspection_date;

    const data = await eq("update", "rescue_equipment", { id: item.id }, updates);
    const updated = data && data.length ? data[0] : { ...item, ...updates };

    await logEquipmentEvent(
      item.equipment_id,
      "STATUS_CHANGED",
      `status → ${updates.status || item.status}, condition → ${updates.condition || item.condition}`,
      req.user && req.user.email
    );
    if (body.last_inspection_date !== undefined || body.next_inspection_date !== undefined) {
      await logEquipmentEvent(item.equipment_id, "INSPECTED", "Inspection dates updated", req.user && req.user.email);
    }

    res.json({ success: true, message: `${item.equipment_id} updated`, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── Hazard-based recommendations ──────────────────────────────

/**
 * GET /api/rescue-equipment/recommendations/:incidentId
 * General prototype recommendations from the incident hazard + the
 * inventory that can satisfy each one.
 */
const getRecommendations = async (req, res) => {
  try {
    const incident = await findIncidentByText(req.params.incidentId);
    if (!incident) {
      return res.status(404).json({ success: false, message: "Incident not found" });
    }

    const hazard = incident.hazard_type;
    const items = HAZARD_EQUIPMENT[hazard] || HAZARD_EQUIPMENT.HIGH_RISK;
    const types = EQUIPMENT_ITEM_TYPES[hazard] || EQUIPMENT_ITEM_TYPES.HIGH_RISK;

    const inventory = await eq("select", "rescue_equipment", { limit: 500 });
    const matching = (inventory || []).filter((e) => types.includes(e.equipment_type));

    res.json({
      success: true,
      incident_id: incident.incident_id,
      storage: await storage(),
      hazard_type: hazard,
      hazard_label: HAZARD_LABELS[hazard] || hazard,
      recommended_team: incident.recommended_team_type || null,
      checklist_items: items,
      suggested_equipment: matching,
      disclaimer:
        "General prototype recommendations derived from the incident hazard type. " +
        "Not certified professional emergency-response instructions.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── Pre-departure checklist ───────────────────────────────────

/**
 * GET /api/rescue-equipment/checklist/:incidentId
 * Returns the checklist, creating it from the hazard recommendations the
 * first time it is requested.
 */
const getChecklist = async (req, res) => {
  try {
    const incident = await findIncidentByText(req.params.incidentId);
    if (!incident) {
      return res.status(404).json({ success: false, message: "Incident not found" });
    }

    let rows = await eq("select", "equipment_checklists", {
      filters: { incident_id: incident.incident_id },
      limit: 1,
    });

    if (!rows || rows.length === 0) {
      const required = HAZARD_EQUIPMENT[incident.hazard_type] || HAZARD_EQUIPMENT.HIGH_RISK;
      const created = await eq("insert", "equipment_checklists", {
        incident_id: incident.incident_id,
        team_id: incident.assigned_team_id || null,
        required_items: required,
        checked_items: [],
        status: "PENDING",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      rows = Array.isArray(created) ? created : [created];
    }

    const checklist = rows[0];
    const required = normaliseJson(checklist.required_items, []);
    const checked = normaliseJson(checklist.checked_items, []);
    const outstanding = required.filter((item) => !checked.includes(item));

    res.json({
      success: true,
      storage: await storage(),
      data: {
        ...checklist,
        required_items: required,
        checked_items: checked,
        outstanding_items: outstanding,
        can_go_en_route: outstanding.length === 0,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * POST /api/rescue-equipment/checklist/:incidentId
 * body: { checked_items: [...], mark_complete: true, equipment_used: [...] }
 *
 * The checklist can only be marked COMPLETE when EVERY required item is
 * checked — the API refuses otherwise rather than lying to the team.
 */
const saveChecklist = async (req, res) => {
  try {
    const incident = await findIncidentByText(req.params.incidentId);
    if (!incident) {
      return res.status(404).json({ success: false, message: "Incident not found" });
    }

    const rows = await eq("select", "equipment_checklists", {
      filters: { incident_id: incident.incident_id },
      limit: 1,
    });
    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No checklist for this incident yet — GET the checklist first.",
      });
    }
    const checklist = rows[0];

    const required = normaliseJson(checklist.required_items, []);
    const body = req.body || {};
    const incoming = normaliseJson(body.checked_items, null);
    const checked = incoming || normaliseJson(checklist.checked_items, []);

    // Only accept items that are actually on the required list.
    const validChecked = required.filter((item) => checked.includes(item));
    const rejected = checked.filter((item) => !required.includes(item));

    const outstanding = required.filter((item) => !validChecked.includes(item));
    const complete = outstanding.length === 0;

    if (body.mark_complete && !complete) {
      return res.status(400).json({
        success: false,
        message: `Equipment check cannot be completed — ${outstanding.length} required item(s) still unchecked.`,
        outstanding_items: outstanding,
      });
    }

    const updates = {
      checked_items: validChecked,
      status: complete ? "COMPLETE" : "IN_PROGRESS",
      team_id: checklist.team_id || incident.assigned_team_id || null,
      updated_at: nowIso(),
    };
    if (complete) {
      updates.completed_by = (req.user && req.user.email) || "rescue_team";
      updates.completed_at = nowIso();
    }

    const data = await eq("update", "equipment_checklists", { id: checklist.id }, updates);
    const saved = data && data.length ? data[0] : { ...checklist, ...updates };

    // Record real check-outs. Nothing is marked IN_USE implicitly.
    const used = normaliseJson(body.equipment_used, []);
    for (const entry of used) {
      const equipmentId = entry.equipment_id || entry;
      const qty = Number(entry.quantity_used) || 1;
      if (!equipmentId) continue;

      const item = await eq("select", "rescue_equipment", {
        filters: { equipment_id: equipmentId },
        limit: 1,
      });
      if (!item || item.length === 0) continue;

      await eq("insert", "equipment_usage", {
        incident_id: incident.incident_id,
        equipment_id: equipmentId,
        team_id: incident.assigned_team_id || null,
        quantity_used: qty,
        checked_out_at: nowIso(),
        condition_after_use: null,
        created_at: nowIso(),
      });
      await eq("update", "rescue_equipment",
        { id: item[0].id },
        { status: "IN_USE", updated_at: nowIso() }
      );
      await logEquipmentEvent(
        equipmentId,
        "CHECKED_OUT",
        `Checked out for ${incident.incident_id} (x${qty})`,
        req.user && req.user.email
      );
    }

    res.json({
      success: true,
      message: complete
        ? `✅ Equipment check complete for ${incident.incident_id}`
        : `Checklist saved — ${outstanding.length} item(s) outstanding`,
      data: {
        ...saved,
        required_items: required,
        checked_items: validChecked,
        outstanding_items: outstanding,
        can_go_en_route: complete,
      },
      rejected_items: rejected,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/**
 * POST /api/rescue-equipment/return
 * body: { incident_id, equipment_id, condition_after_use, notes }
 */
const returnEquipment = async (req, res) => {
  try {
    const body = req.body || {};
    const { incident_id: incidentId, equipment_id: equipmentId } = body;

    if (!equipmentId) {
      return res.status(400).json({ success: false, message: "equipment_id is required" });
    }
    const condition = body.condition_after_use || "GOOD";
    if (!EQUIPMENT_CONDITIONS.includes(condition)) {
      return res.status(400).json({
        success: false,
        message: `Invalid condition. Allowed: ${EQUIPMENT_CONDITIONS.join(", ")}`,
      });
    }

    const item = await eq("select", "rescue_equipment", { filters: { equipment_id: equipmentId }, limit: 1 });
    if (!item || item.length === 0) {
      return res.status(404).json({ success: false, message: "Equipment not found" });
    }

    // Close the most recent open usage row for this incident/equipment.
    if (incidentId) {
      const usages = await eq("select", "equipment_usage", {
        filters: { incident_id: incidentId, equipment_id: equipmentId },
        orderBy: "checked_out_at",
        limit: 50,
      });
      const open = (usages || []).find((u) => !u.returned_at);
      if (open) {
        await eq("update", "equipment_usage",
          { id: open.id },
          { returned_at: nowIso(), condition_after_use: condition, notes: body.notes || null }
        );
      }
    }

    // POOR condition after use means the item is NOT ready any more.
    const nextStatus = condition === "POOR" ? "DAMAGED" : "AVAILABLE";
    const updated = await eq("update", "rescue_equipment",
      { id: item[0].id },
      { status: nextStatus, condition, updated_at: nowIso() }
    );

    await logEquipmentEvent(
      equipmentId,
      "RETURNED",
      `Returned${incidentId ? ` from ${incidentId}` : ""} — condition ${condition}, status ${nextStatus}`,
      req.user && req.user.email
    );

    res.json({
      success: true,
      message: `${equipmentId} returned (${nextStatus})`,
      data: updated && updated.length ? updated[0] : { ...item[0], status: nextStatus, condition },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

/** GET /api/rescue-equipment/usage — usage + readiness history. */
const getUsageHistory = async (req, res) => {
  try {
    const { incident_id: incidentId } = req.query;
    let usage = await eq("select", "equipment_usage", { orderBy: "checked_out_at", limit: 500 });
    if (incidentId) usage = usage.filter((u) => u.incident_id === incidentId);

    const events = await eq("select", "equipment_events", { orderBy: "created_at", limit: 500 });

    res.json({
      success: true,
      count: (usage || []).length,
      data: usage || [],
      events: (events || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  listEquipment,
  getEquipment,
  updateEquipment,
  getRecommendations,
  getChecklist,
  saveChecklist,
  returnEquipment,
  getUsageHistory,
  EQUIPMENT_TYPES,
  ACTION_EVENTS,
};