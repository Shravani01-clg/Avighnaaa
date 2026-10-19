/**
 * Incident Controller
 *
 * Operational incident layer ON TOP of the existing alert system.
 * - Alerts stay exactly as they are (detection signals).
 * - An incident is an operational case created from a serious alert.
 *
 * Incident creation is invoked by sensorController AFTER the existing
 * alert logic runs — detection flow is not modified.
 */

const store = require("../config/dataStore");

// ─── incident_events key compatibility ────────────────────────
//
// incident_events.incident_id should be TEXT holding the human-readable
// id ('AV-1024') — that is what migration 001 declares. Some live
// databases drifted to UUID holding incidents.id instead, which made
// every timeline insert fail with:
//     invalid input syntax for type uuid: "AV-1024"
//
// Rather than crash, detect the real column type once (read-only, via
// PostgREST's OpenAPI description) and adapt. Running
// migrations/004_fix_incident_events_schema.sql permanently resolves it
// and this shim then becomes a no-op.

let eventKeyMode = null; // null = not probed yet, 'text' | 'uuid'
let eventKeyModePromise = null;

async function resolveEventKeyMode() {
  if (eventKeyMode) return eventKeyMode;
  if (eventKeyModePromise) return eventKeyModePromise;

  eventKeyModePromise = (async () => {
    const url = process.env.SUPABASE_URL;
    const key =
      process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      eventKeyMode = "text";
      return eventKeyMode;
    }
    try {
      const res = await fetch(`${url}/rest/v1/`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`openapi ${res.status}`);
      const spec = await res.json();
      const col =
        spec.definitions &&
        spec.definitions.incident_events &&
        spec.definitions.incident_events.properties &&
        spec.definitions.incident_events.properties.incident_id;
      eventKeyMode = col && col.format === "uuid" ? "uuid" : "text";
    } catch (err) {
      // Can't tell — assume the declared schema (text).
      eventKeyMode = "text";
    }

    if (eventKeyMode === "uuid") {
      console.warn(
        "\n⚠️  incident_events.incident_id is UUID, not TEXT.\n" +
          "   Adapting automatically, but run migrations/004_fix_incident_events_schema.sql\n" +
          "   in the Supabase SQL Editor to fix the schema permanently.\n"
      );
    }
    return eventKeyMode;
  })();

  return eventKeyModePromise;
}

/**
 * Build incidents.id (uuid) -> incidents.incident_id (text) so events
 * stored against the uuid key can be rendered with the readable id.
 */
function uuidToIncidentIdMap(incidents) {
  const map = {};
  for (const inc of incidents || []) {
    if (inc.id) map[inc.id] = inc.incident_id;
  }
  return map;
}

/**
 * Convert a text incident_id ('AV-1024') into whatever key the
 * incident_events table actually expects. No-op in the correct schema.
 */
async function toEventKey(incident_id) {
  if (!incident_id) return incident_id;
  if ((await resolveEventKeyMode()) !== "uuid") return incident_id;

  // Already a uuid? Use as-is.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(incident_id)) {
    return incident_id;
  }

  const rows = await store.select("incidents", {
    filters: { incident_id },
    limit: 1,
  });
  return rows && rows.length > 0 ? rows[0].id : incident_id;
}

/**
 * Normalise rows read back from incident_events so callers always see
 * the human-readable incident_id, whatever the column type is.
 */
async function normaliseEventRows(rows, incidentsById) {
  if (!rows || rows.length === 0) return [];
  if ((await resolveEventKeyMode()) !== "uuid") return rows;
  return rows.map((ev) => ({
    ...ev,
    incident_id: (incidentsById && incidentsById[ev.incident_id]) || ev.incident_id,
  }));
}

const {
  INCIDENT_MIN_SEVERITY,
  INCIDENT_COOLDOWN_MINUTES,
  RESPONSE_TIMEOUT_MINUTES,
  severityAtLeast,
  HAZARD_MAP,
  HAZARD_TO_TEAM,
  HAZARD_LABELS,
  TERMINAL_STATUSES,
  STATUS_TRANSITIONS,
  ACTION_EVENTS,
  STATUS_LABELS,
} = require("../config/rescueConfig");

// ─── Helpers ───────────────────────────────────────────────────

function formatLocation(loc) {
  if (!loc) return "Location not configured";
  const parts = [loc.building, loc.floor && `Floor ${loc.floor}`, loc.room && `Room ${loc.room}`, loc.zone];
  const joined = parts.filter(Boolean).join(" / ");
  return joined || "Location not configured";
}

async function getDeviceLocation(deviceId) {
  try {
    const rows = await store.select("device_locations", {
      filters: { device_id: deviceId },
      limit: 1,
    });
    return rows && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}

async function logEvent(incident_id, event_type, performed_by, notes) {
  try {
    await store.insert("incident_events", {
      incident_id: await toEventKey(incident_id),
      event_type,
      performed_by: performed_by || "system",
      timestamp: new Date().toISOString(),
      notes: notes || null,
    });
  } catch (err) {
    console.error("Incident event logging failed:", err.message);
  }
}

async function nextIncidentId() {
  // AV-1024 style: sequential, based on stored count.
  const rows = await store.select("incidents", { limit: 10000 });
  const used = new Set(rows.map((r) => r.incident_id));
  let n = 1024;
  let id = `AV-${n}`;
  while (used.has(id)) {
    n += 1;
    id = `AV-${n}`;
  }
  return id;
}

function buildAiSummary({ hazardType, risk, personDetected, location }) {
  // Built ONLY from data the backend actually has.
  const lines = [];
  const label = HAZARD_LABELS[hazardType] || hazardType;
  lines.push(`${label} emergency detected.`);

  const parts = [];
  if (risk.reason) parts.push(risk.reason);
  if (risk.details && risk.details.fallState && risk.details.fallState !== "NORMAL") {
    parts.push(`Fall state: ${risk.details.fallState}`);
  }
  if (risk.ai) {
    const ml = risk.ai.mlRiskPrediction;
    const conf = risk.ai.mlConfidence;
    if (ml) {
      parts.push(`AI model predicts ${ml} risk${conf != null ? ` (${Math.round(conf * 100)}% confidence)` : ""}`);
    }
    if (risk.ai.anomalyDetected) parts.push("AI anomaly detector flagged unusual sensor behaviour");
  }
  if (parts.length) lines.push(parts.join(". ") + ".");

  if (personDetected) {
    lines.push("Person presence indicated by SOS / fall signal on this device.");
  }

  lines.push(`Location: ${location}`);
  lines.push(`Risk score: ${risk.risk_score} (${risk.risk_level}).`);

  return lines.join(" ");
}

// ─── INCIDENT CREATION (called from sensorController) ──────────

/**
 * Create or update an incident from an existing alert.
 *
 * DEDUPLICATION LOGIC:
 *  1. Only alerts at/above INCIDENT_MIN_SEVERITY are considered.
 *  2. If ANY open (non-terminal) incident exists for the same
 *     device_id → UPDATE it (risk score, severity upgrade, summary,
 *     updated_at) instead of creating a new one. One open operational
 *     case per device — a flood case plus a gas trigger on the same
 *     ESP32 never becomes two parallel missions.
 *  3. If the most recent TERMINAL incident for that device is
 *     younger than INCIDENT_COOLDOWN_MINUTES → do nothing.
 *  4. Otherwise → create a new incident + timeline events.
 */
async function createIncidentFromAlert({
  device_id,
  alertType,
  severity,
  alertId,
  risk,
}) {
  try {
    if (!severityAtLeast(severity, INCIDENT_MIN_SEVERITY)) return null;

    const hazardType = HAZARD_MAP[alertType];
    if (!hazardType) return null;

    // ── Dedup lookup ───────────────────────────────────────
    const existing = await store.select("incidents", {
      filters: { device_id },
      orderBy: "created_at",
      limit: 50,
    });

    const open = (existing || []).find(
      (inc) => !TERMINAL_STATUSES.includes(inc.status)
    );

    const location = await getDeviceLocation(device_id);
    const locationText = formatLocation(location);
    const personDetected =
      risk.sos === true ||
      (risk.fall_state && risk.fall_state !== "NORMAL");

    // ── 2) Update open incident ────────────────────────────
    if (open) {
      const updated = await store.update(
        "incidents",
        { id: open.id },
        {
          hazard_type: hazardType,
          recommended_team_type: HAZARD_TO_TEAM[hazardType] || open.recommended_team_type,
          risk_score: risk.risk_score,
          severity: severityAtLeast(severity, open.severity) ? severity : open.severity,
          alert_id: alertId != null ? String(alertId) : open.alert_id,
          ai_summary: buildAiSummary({
            hazardType,
            risk,
            personDetected: personDetected || open.person_detected,
            location: locationText,
          }),
          person_detected: Boolean(personDetected) || Boolean(open.person_detected),
          updated_at: new Date().toISOString(),
        }
      );
      await logEvent(
        open.incident_id,
        ACTION_EVENTS.DETECTION_UPDATE,
        "system",
        `New reading from ${device_id}: risk ${risk.risk_score} (${risk.risk_level})`
      );
      return updated && updated[0] ? updated[0] : open;
    }

    // ── 3) Cooldown after a recent terminal incident ───────
    const lastTerminal = (existing || [])
      .filter((inc) => TERMINAL_STATUSES.includes(inc.status))
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0];

    if (lastTerminal) {
      const ageMs = Date.now() - new Date(lastTerminal.updated_at || lastTerminal.created_at).getTime();
      if (ageMs < INCIDENT_COOLDOWN_MINUTES * 60 * 1000) return null;
    }

    // ── 4) Create new incident ─────────────────────────────
    const incidentId = await nextIncidentId();

    const data = await store.insert("incidents", {
      incident_id: incidentId,
      alert_id: alertId != null ? String(alertId) : null,
      device_id,
      hazard_type: hazardType,
      severity,
      risk_score: risk.risk_score,
      person_detected: Boolean(personDetected),
      location: locationText,
      ai_summary: buildAiSummary({
        hazardType,
        risk,
        personDetected,
        location: locationText,
      }),
      recommended_team_type: HAZARD_TO_TEAM[hazardType] || "SECURITY",
      assigned_team_id: null,
      status: "AWAITING_RESPONSE",
      detected_at: new Date().toISOString(),
      resolved_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const incident = Array.isArray(data) ? data[0] : data;

    await logEvent(incidentId, ACTION_EVENTS.DETECT, "system", `Alert ${alertType} from ${device_id}`);
    await logEvent(
      incidentId,
      ACTION_EVENTS.CREATE,
      "system",
      `Severity ${severity}, risk score ${risk.risk_score}`
    );

    console.log(
      `🚨 Incident ${incidentId} created (${severity}) for ${device_id} — ${hazardType}`
    );
    return incident;
  } catch (err) {
    // Incident creation must NEVER break existing sensor/alert flow.
    console.error("Incident creation failed:", err.message);
    return null;
  }
}

// ─── GET /api/incidents ────────────────────────────────────────

const listIncidents = async (req, res) => {
  try {
    const { status, severity, hazard_type, team, from, to } = req.query;

    let data = await store.select("incidents", {
      orderBy: "created_at",
      limit: 500,
    });

    if (status) data = data.filter((i) => i.status === status);
    if (severity) data = data.filter((i) => i.severity === severity);
    if (hazard_type) data = data.filter((i) => i.hazard_type === hazard_type);
    if (team) data = data.filter((i) => i.assigned_team_id === team);
    if (from) data = data.filter((i) => new Date(i.created_at) >= new Date(from));
    if (to) data = data.filter((i) => new Date(i.created_at) <= new Date(to));

    // Least privilege: a plain control-room USER only sees emergencies that
    // are still open. Closed incidents/history stay behind rescue_team.
    if (req.role === "user") {
      data = data.filter((i) => !TERMINAL_STATUSES.includes(i.status));
    }

    const enriched = await enrichIncidents(data, await loadTeamsById());

    res.json({ success: true, count: enriched.length, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── GET /api/incidents/:id ────────────────────────────────────

const getIncident = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await store.select("incidents", {
      filters: { incident_id: id },
      limit: 1,
    });

    if (!rows || rows.length === 0) {
      // allow lookup by internal id too
      const byId = await store.select("incidents", { filters: { id }, limit: 1 });
      if (!byId || byId.length === 0) {
        return res.status(404).json({ success: false, message: "Incident not found" });
      }
      const [one] = await enrichIncidents(byId, await loadTeamsById());
      return res.json({ success: true, data: one });
    }

    const [one] = await enrichIncidents(rows, await loadTeamsById());
    res.json({ success: true, data: one });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── GET /api/incidents/:id/timeline ───────────────────────────

const getTimeline = async (req, res) => {
  try {
    const { id } = req.params;
    const events = await store.select("incident_events", {
      filters: { incident_id: await toEventKey(id) },
      orderBy: "timestamp",
      limit: 200,
    });

    // Map the stored key back to the human-readable incident_id.
    // We filtered on the resolved key of THIS incident, so every returned
    // row belongs to `id` by construction.
    const normalised =
      (await resolveEventKeyMode()) === "uuid"
        ? (events || []).map((ev) => ({ ...ev, incident_id: id }))
        : events || [];

    // oldest first for display
    const data = [...(normalised || [])].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── Workflow action engine ────────────────────────────────────

async function findIncident(id) {
  let rows = await store.select("incidents", { filters: { incident_id: id }, limit: 1 });
  if (!rows || rows.length === 0) {
    rows = await store.select("incidents", { filters: { id }, limit: 1 });
  }
  return rows && rows.length > 0 ? rows[0] : null;
}

async function performAction(req, res, action) {
  try {
    const { id } = req.params;
    const notes = (req.body && req.body.notes) || null;

    const incident = await findIncident(id);
    if (!incident) {
      return res.status(404).json({ success: false, message: "Incident not found" });
    }

    const role = req.role;
    const allowedRoles = require("../config/rescueConfig").ACTION_ROLES[action] || [];
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied: ${action} requires role ${allowedRoles.join(" or ")}`,
        your_role: role,
      });
    }

    const transitions = STATUS_TRANSITIONS[incident.status] || {};
    const nextStatus = transitions[action];

    // ── Pre-departure equipment gate ──────────────────────────
    // A team may not mark EN_ROUTE until every required equipment item for
    // this hazard has been checked. The API refuses rather than letting the
    // UI claim a check that never happened.
    if (action === "EN_ROUTE") {
      try {
        // Use the availability-aware helper: it transparently falls back to
        // memory when migration 006 has not been run yet, matching
        // equipmentController exactly. Reading the table directly here would
        // 500 and block every departure.
        const { eq, normaliseJson } = require("./equipmentHelpers");
        let checklists = await eq("select", "equipment_checklists", {
          filters: { incident_id: incident.incident_id },
          limit: 1,
        });

        if (!checklists || checklists.length === 0) {
          // No checklist yet — build one from the hazard recommendations so
          // the team is never blocked by a missing record.
          const { HAZARD_EQUIPMENT } = require("../config/rescueConfig");
          const required = HAZARD_EQUIPMENT[incident.hazard_type] || HAZARD_EQUIPMENT.HIGH_RISK;
          const created = await eq("insert", "equipment_checklists", {
            incident_id: incident.incident_id,
            team_id: incident.assigned_team_id || null,
            required_items: required,
            checked_items: [],
            status: "PENDING",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          checklists = Array.isArray(created) ? created : [created];
        }

        const checklist = checklists[0];
        const required = normaliseJson(checklist.required_items, []);
        const checked = normaliseJson(checklist.checked_items, []);
        const outstanding = required.filter((item) => !checked.includes(item));

        if (outstanding.length > 0) {
          return res.status(409).json({
            success: false,
            message:
              `Pre-departure equipment check incomplete — ${outstanding.length} item(s) outstanding. ` +
              "Complete the checklist before marking EN ROUTE.",
            code: "EQUIPMENT_CHECK_REQUIRED",
            outstanding_items: outstanding,
            required_items: required,
          });
        }
      } catch (err) {
        // Never let the gate silently pass because storage hiccuped.
        console.error("Equipment gate failed closed:", err.message);
        return res.status(500).json({
          success: false,
          message: "Could not verify the equipment check. Try again.",
          error: err.message,
        });
      }
    }

    if (!nextStatus) {
      return res.status(409).json({
        success: false,
        message: `Invalid transition: cannot perform ${action} while incident is ${incident.status}`,
        current_status: incident.status,
        allowed_actions: Object.keys(transitions),
      });
    }

    // rescue_team may only act on incidents assigned to their own team.
    // EXCEPTION: ASSIGN / REASSIGN are the rescue team claiming a mission.
    // Under the two-role architecture there is no admin, so the rescue team
    // itself dispatches itself — blocking these would leave every incident
    // permanently unassignable.
    if (role === "rescue_team") {
      const teamId = req.profile && req.profile.team_id;
      const claimActions = ["ASSIGN", "REASSIGN"];
      if (action !== undefined && !["CANCEL", ...claimActions].includes(action)) {
        if (!incident.assigned_team_id) {
          return res.status(409).json({
            success: false,
            message: "Incident has no assigned team yet",
          });
        }
        if (teamId && incident.assigned_team_id !== teamId) {
          return res.status(403).json({
            success: false,
            message: "Incident is assigned to a different team",
            your_team: teamId,
            assigned_team: incident.assigned_team_id,
          });
        }
      }
      // RESOLVE for rescue_team only from PERSON_SAFE (enforced by transition map)
    }

    const updates = {
      status: nextStatus,
      updated_at: new Date().toISOString(),
    };

    if (action === "ASSIGN" || action === "REASSIGN") {
      const teamId = req.body && req.body.team_id;
      if (!teamId) {
        return res.status(400).json({ success: false, message: "team_id is required" });
      }
      const teams = await store.select("rescue_teams", { filters: { team_id: teamId }, limit: 1 });
      if (!teams || teams.length === 0) {
        return res.status(404).json({ success: false, message: "Rescue team not found" });
      }
      updates.assigned_team_id = teamId;
      // mark team busy when it receives a mission
      await store.update("rescue_teams", { team_id: teamId }, { status: "BUSY", updated_at: new Date().toISOString() });
    }

    if (nextStatus === "RESOLVED") {
      updates.resolved_at = new Date().toISOString();
      if (incident.assigned_team_id) {
        await store.update(
          "rescue_teams",
          { team_id: incident.assigned_team_id },
          { status: "AVAILABLE", updated_at: new Date().toISOString() }
        );
      }
    }

    if (nextStatus === "CANCELLED") {
      updates.resolved_at = new Date().toISOString();
      if (incident.assigned_team_id) {
        await store.update(
          "rescue_teams",
          { team_id: incident.assigned_team_id },
          { status: "AVAILABLE", updated_at: new Date().toISOString() }
        );
      }
    }

    const data = await store.update("incidents", { id: incident.id }, updates);
    const updated = data && data.length > 0 ? data[0] : { ...incident, ...updates };

    const performedBy =
      (req.user && req.user.email) || role;
    await logEvent(
      incident.incident_id,
      ACTION_EVENTS[action],
      performedBy,
      notes ||
        (action === "ASSIGN" || action === "REASSIGN"
          ? `Team ${req.body.team_id} ${action === "REASSIGN" ? "reassigned" : "assigned"}`
          : `Status → ${STATUS_LABELS[nextStatus] || nextStatus}`)
    );

    res.json({
      success: true,
      message: `${action} completed — status is now ${nextStatus}`,
      data: updated,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
}

const assignIncident = async (req, res) => {
  // Assigning an incident that already has a team is a REASSIGNMENT, not an
  // initial assignment. Without this, a second assignment attempt would look
  // for an ASSIGN transition from ASSIGNED and fail with 409.
  const incident = await findIncident(req.params.id);
  if (!incident) {
    return res.status(404).json({ success: false, message: "Incident not found" });
  }
  const action = incident.assigned_team_id ? "REASSIGN" : "ASSIGN";
  return performAction(req, res, action);
};
const acceptIncident = (req, res) => performAction(req, res, "ACCEPT");
const enRouteIncident = (req, res) => performAction(req, res, "EN_ROUTE");
const arriveIncident = (req, res) => performAction(req, res, "ARRIVE");
const startRescue = (req, res) => performAction(req, res, "START_RESCUE");
const personSafe = (req, res) => performAction(req, res, "PERSON_SAFE");
const resolveIncident = (req, res) => performAction(req, res, "RESOLVE");
const escalateIncident = (req, res) => performAction(req, res, "ESCALATE");
const cancelIncident = (req, res) => performAction(req, res, "CANCEL");

// ─── GET /api/incidents/stats ──────────────────────────────────

const getStats = async (req, res) => {
  try {
    const all = await store.select("incidents", { orderBy: "created_at", limit: 1000 });

    if (!all || all.length === 0) {
      return res.json({
        success: true,
        sufficient_data: false,
        message: "No data available yet.",
        data: null,
      });
    }

    const activeStatuses = [
      "AWAITING_RESPONSE", "ASSIGNED", "ACCEPTED", "EN_ROUTE",
      "ON_SCENE", "RESCUE_IN_PROGRESS", "PERSON_SAFE", "ESCALATED",
    ];

    const resolved = all.filter((i) => i.status === "RESOLVED");
    const escalated = all.filter((i) => i.status === "ESCALATED");

    // Times computed from real event timestamps where available.
    const rawEvents = await store.select("incident_events", { orderBy: "timestamp", limit: 5000 });

    // Map uuid keys back to incident_id text so the lookup below matches.
    const incidentsByUuid = {};
    for (const inc of all || []) incidentsByUuid[inc.id] = inc.incident_id;
    const events = await normaliseEventRows(rawEvents, incidentsByUuid);

    const byIncident = {};
    for (const ev of events || []) {
      (byIncident[ev.incident_id] = byIncident[ev.incident_id] || []).push(ev);
    }

    const ackTimes = [];
    const resTimes = [];
    for (const inc of all) {
      const evs = byIncident[inc.incident_id] || [];
      const detected = evs.find((e) => e.event_type === ACTION_EVENTS.DETECT);
      const accepted = evs.find((e) => e.event_type === ACTION_EVENTS.ACCEPT);
      const resolvedEv = evs.find((e) => e.event_type === ACTION_EVENTS.RESOLVE);

      if (detected && accepted) {
        ackTimes.push((new Date(accepted.timestamp) - new Date(detected.timestamp)) / 1000);
      }
      if (detected && resolvedEv) {
        resTimes.push((new Date(resolvedEv.timestamp) - new Date(detected.timestamp)) / 1000);
      }
    }


    const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

    const countBy = (keyFn) => {
      const out = {};
      for (const i of all) {
        const k = keyFn(i) || "Unknown";
        out[k] = (out[k] || 0) + 1;
      }
      return out;
    };

    res.json({
      success: true,
      sufficient_data: true,
      data: {
        total_incidents: all.length,
        critical_incidents: all.filter((i) => i.severity === "CRITICAL").length,
        high_incidents: all.filter((i) => i.severity === "HIGH").length,
        active_incidents: all.filter((i) => activeStatuses.includes(i.status)).length,
        resolved_incidents: resolved.length,
        escalated_incidents: escalated.length,
        avg_ack_seconds: avg(ackTimes),
        avg_resolution_seconds: avg(resTimes),
        by_hazard: countBy((i) => i.hazard_type),
        by_location: countBy((i) => i.location),
        by_team: countBy((i) => i.assigned_team_id),
        by_status: countBy((i) => i.status),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── ESCALATION SCHEDULER ──────────────────────────────────────

/**
 * Escalates incidents that were never acknowledged within
 * RESPONSE_TIMEOUT_MINUTES. SIMULATED escalation: records an event
 * and flags the incident — it does NOT contact any external service.
 */
async function escalationTick() {
  try {
    const all = await store.select("incidents", {
      filters: { status: ["AWAITING_RESPONSE", "ASSIGNED", "ACCEPTED"] },
      orderBy: "created_at",
      limit: 200,
    });

    const now = Date.now();
    for (const inc of all || []) {
      // Timer starts from last status change (assignment) or creation.
      const base = new Date(inc.updated_at || inc.created_at).getTime();
      const ageMin = (now - base) / 60000;
      if (ageMin < RESPONSE_TIMEOUT_MINUTES) continue;

      await store.update(
        "incidents",
        { id: inc.id },
        { status: "ESCALATED", updated_at: new Date().toISOString() }
      );
      await logEvent(
        inc.incident_id,
        ACTION_EVENTS.ESCALATE,
        "system",
        `No acknowledgement within ${RESPONSE_TIMEOUT_MINUTES} min — escalated to control room (simulated)`
      );
      console.log(`⚠️ Incident ${inc.incident_id} escalated (response timeout)`);
    }
  } catch (err) {
    console.error("Escalation check failed:", err.message);
  }
}

function startEscalationScheduler() {
  setInterval(escalationTick, require("../config/rescueConfig").ESCALATION_CHECK_MS);
  console.log(
    `⏱  Escalation scheduler running (timeout: ${RESPONSE_TIMEOUT_MINUTES} min)`
  );
}

// ─── Rescue request (main dashboard → rescue portal) ───────────

/**
 * Which incidents have had a rescue request raised against them.
 *
 * Derived from incident_events so it works whether or not
 * migrations/005_rescue_requested.sql has been applied yet.
 */
async function getRequestedSet() {
  try {
    const events = await store.select("incident_events", {
      filters: { event_type: ACTION_EVENTS.REQUEST },
      limit: 5000,
    });
    const set = new Set();
    for (const ev of events || []) {
      // event rows may be keyed by text incident_id or by incidents.id
      set.add(ev.incident_id);
      if (ev.incident_ref) set.add(ev.incident_ref);
    }
    return set;
  } catch {
    return new Set();
  }
}

/**
 * Attach `rescue_requested` (+ request time + team name) to incident rows.
 * Never throws — enrichment must not break the list endpoint.
 */
async function enrichIncidents(incidents, teamsById) {
  if (!incidents || incidents.length === 0) return incidents || [];

  let requested = new Set();
  try {
    requested = await getRequestedSet();
  } catch {
    /* ignore */
  }

  // Map incidents.id (uuid) -> incident_id so uuid-keyed events resolve.
  const byUuid = {};
  for (const inc of incidents) {
    if (inc.id) byUuid[inc.id] = inc.incident_id;
  }

  return incidents.map((inc) => {
    const isRequested =
      inc.rescue_requested === true ||
      requested.has(inc.incident_id) ||
      (inc.id && requested.has(inc.id));

    const team = inc.assigned_team_id
      ? teamsById && teamsById[inc.assigned_team_id]
      : null;

    return {
      ...inc,
      rescue_requested: isRequested,
      rescue_requested_at: inc.rescue_requested_at || null,
      assigned_team_name: team ? team.team_name : null,
      hazard_label: HAZARD_LABELS[inc.hazard_type] || inc.hazard_type,
      status_label: STATUS_LABELS[inc.status] || inc.status,
    };
  });
}

async function loadTeamsById() {
  try {
    const teams = await store.select("rescue_teams", { limit: 200 });
    const map = {};
    for (const t of teams || []) map[t.team_id] = t;
    return map;
  } catch {
    return {};
  }
}

/**
 * POST /api/incidents/:id/request-rescue
 *
 * The main dashboard's [REQUEST RESCUE TEAM] button.
 * - Activates an EXISTING incident; never creates a duplicate.
 * - Idempotent: pressing it twice records one request.
 * - Any authenticated user or rescue-team member may call it.
 */
const requestRescue = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await store.select("incidents", {
      filters: { incident_id: id },
      limit: 1,
    });

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Incident not found",
      });
    }

    const incident = rows[0];

    if (TERMINAL_STATUSES.includes(incident.status)) {
      return res.status(409).json({
        success: false,
        message: `Incident ${id} is already ${incident.status} and cannot take a new rescue request`,
        status: incident.status,
      });
    }

    const [enriched] = await enrichIncidents([incident], await loadTeamsById());
    const alreadyRequested = enriched.rescue_requested;

    const requestedAt = new Date().toISOString();
    const updates = { updated_at: requestedAt };

    // Best effort: these columns exist only after migration 005. If they are
    // missing the timeline event below is still the source of truth, so a
    // failure here must not break the request.
    try {
      if (!alreadyRequested) {
        updates.rescue_requested = true;
        updates.rescue_requested_at = requestedAt;
        await store.update("incidents", { id: incident.id }, updates);
      } else {
        await store.update(
          "incidents",
          { id: incident.id },
          { updated_at: requestedAt }
        );
      }
    } catch (err) {
      console.warn(
        `⚠️  Could not set rescue_requested on ${id} (${err.message}). ` +
          "Run migrations/005_rescue_requested.sql — the timeline event is still recorded."
      );
    }

    if (!alreadyRequested) {
      await logEvent(
        incident.incident_id,
        ACTION_EVENTS.REQUEST,
        (req.user && req.user.email) || "system",
        `Rescue response requested from the control room by ${(req.user && req.user.email) || "unknown"}`
      );
    }

    const fresh = await store.select("incidents", {
      filters: { incident_id: id },
      limit: 1,
    });
    const [final] = await enrichIncidents(
      fresh && fresh.length ? fresh : [incident],
      await loadTeamsById()
    );

    res.json({
      success: true,
      message: alreadyRequested
        ? `Rescue was already requested for ${id}`
        : `🚨 Rescue team requested for ${id}`,
      already_requested: alreadyRequested,
      data: final,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

/**
 * GET /api/incidents/history
 *
 * Closed incidents with real response / resolution times measured from
 * the incident_events timeline. Rescue team only.
 */
const getHistory = async (req, res) => {
  try {
    const { team, hazard_type, from, to, limit } = req.query;

    let all = await store.select("incidents", {
      orderBy: "created_at",
      limit: 1000,
    });

    const events = await store.select("incident_events", {
      orderBy: "timestamp",
      limit: 5000,
    });

    const byIncident = {};
    for (const ev of await normaliseEventRows(events, uuidToIncidentIdMap(all))) {
      (byIncident[ev.incident_id] = byIncident[ev.incident_id] || []).push(ev);
    }

    let data = all.filter((i) =>
      ["RESOLVED", "CANCELLED", "ESCALATED"].includes(i.status)
    );

    if (team) data = data.filter((i) => i.assigned_team_id === team);
    if (hazard_type) data = data.filter((i) => i.hazard_type === hazard_type);
    if (from) data = data.filter((i) => new Date(i.created_at) >= new Date(from));
    if (to) data = data.filter((i) => new Date(i.created_at) <= new Date(to));

    const seconds = (a, b) =>
      a && b ? Math.round((new Date(b) - new Date(a)) / 1000) : null;

    const rows = data
      .map((inc) => {
        const evs = (byIncident[inc.incident_id] || []).slice().sort(
          (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );
        const detected = evs.find((e) => e.event_type === ACTION_EVENTS.DETECT);
        const accepted = evs.find((e) => e.event_type === ACTION_EVENTS.ACCEPT);
        const resolved = evs.find((e) => e.event_type === ACTION_EVENTS.RESOLVE);

        return {
          incident_id: inc.incident_id,
          created_at: inc.created_at,
          resolved_at: inc.resolved_at || (resolved && resolved.timestamp) || null,
          hazard_type: inc.hazard_type,
          hazard_label: HAZARD_LABELS[inc.hazard_type] || inc.hazard_type,
          severity: inc.severity,
          status: inc.status,
          status_label: STATUS_LABELS[inc.status] || inc.status,
          location: inc.location,
          assigned_team_id: inc.assigned_team_id,
          person_detected: inc.person_detected,
          // Time from detection to the team accepting the mission.
          response_seconds: seconds(detected && detected.timestamp, accepted && accepted.timestamp),
          // Time from detection to the incident being resolved.
          resolution_seconds: seconds(detected && detected.timestamp, inc.resolved_at || (resolved && resolved.timestamp)),
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const capped = limit ? rows.slice(0, Number(limit)) : rows;

    res.json({ success: true, count: capped.length, data: capped });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

module.exports = {
  createIncidentFromAlert,
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
  startEscalationScheduler,
  escalationTick,
  formatLocation,
  getDeviceLocation,
  enrichIncidents,
  loadTeamsById,
};
