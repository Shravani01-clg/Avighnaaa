/**
 * Rescue Configuration — SINGLE source of truth for rescue thresholds.
 *
 * No other rescue file may hard-code thresholds, timeouts, hazard maps
 * or status transitions. Change them here (or via env overrides).
 */

// ─── Incident creation ─────────────────────────────────────────
// An incident is created only when a generated ALERT has a severity
// at or above this level. (LOW/MEDIUM readings never create incidents.)
const INCIDENT_MIN_SEVERITY =
  (process.env.INCIDENT_MIN_SEVERITY || "HIGH").toUpperCase();

// Dedup: if a TERMINAL incident for the same device+hazard is younger
// than this, no new incident is created (prevents resolve→recreate flapping).
const INCIDENT_COOLDOWN_MINUTES = Number(
  process.env.INCIDENT_COOLDOWN_MINUTES || 10
);

// Escalation: unacknowledged incidents older than this become ESCALATED.
const RESPONSE_TIMEOUT_MINUTES = Number(
  process.env.RESPONSE_TIMEOUT_MINUTES || 5
);

// How often the escalation scheduler runs.
const ESCALATION_CHECK_MS = Number(
  process.env.ESCALATION_CHECK_MS || 30000
);

// Device considered offline if no reading for this many seconds.
const DEVICE_OFFLINE_SECONDS = Number(
  process.env.DEVICE_OFFLINE_SECONDS || 60
);

// ─── Severity ranking ──────────────────────────────────────────
const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function severityAtLeast(severity, minimum) {
  return (
    (SEVERITY_RANK[String(severity || "").toUpperCase()] ?? -1) >=
    (SEVERITY_RANK[minimum] ?? 99)
  );
}

// ─── Alert type → hazard type ──────────────────────────────────
// Maps the EXISTING alert types (from controllers/sensorController.js)
// to incident hazard types. Detection logic is untouched.
const HAZARD_MAP = {
  GAS_DANGER: "GAS_LEAK",
  TEMP_DANGER: "FIRE_HEAT",
  FLOOD_DANGER: "FLOOD",
  FALL_DETECTED: "FALL",
  POSSIBLE_FALL: "FALL",
  SOS: "SOS",
  COMBINED_DANGER: "COMBINED",
  ANOMALY: "ANOMALY",
  HIGH_RISK: "HIGH_RISK",
};

// ─── Hazard → recommended team type ────────────────────────────
// Matches rescue_teams.team_type values.
const HAZARD_TO_TEAM = {
  GAS_LEAK: "FIRE_RESCUE",
  FIRE_HEAT: "FIRE_RESCUE",
  COMBINED: "FIRE_RESCUE",
  FLOOD: "WATER_RESCUE",
  FALL: "MEDICAL",
  SOS: "MEDICAL",
  ANOMALY: "SECURITY",
  HIGH_RISK: "SECURITY",
};

const HAZARD_LABELS = {
  GAS_LEAK: "Possible Fire / Gas",
  FIRE_HEAT: "High Temperature / Fire Risk",
  FLOOD: "Flooding / Water Hazard",
  FALL: "Fall / Impact Detected",
  SOS: "SOS Emergency",
  COMBINED: "Multiple Combined Hazards",
  ANOMALY: "Sensor Anomaly",
  HIGH_RISK: "High Risk Detected",
};

// ─── Mission workflow ──────────────────────────────────────────
const INCIDENT_STATUSES = [
  "AWAITING_RESPONSE",
  "ASSIGNED",
  "ACCEPTED",
  "EN_ROUTE",
  "ON_SCENE",
  "RESCUE_IN_PROGRESS",
  "PERSON_SAFE",
  "RESOLVED",
  "ESCALATED",
  "CANCELLED",
];

const TERMINAL_STATUSES = ["RESOLVED", "CANCELLED"];

// Allowed transitions: from → { action → to }
// Nothing outside this map is accepted by the API, so
// AWAITING_RESPONSE can never jump straight to RESOLVED.
const STATUS_TRANSITIONS = {
  AWAITING_RESPONSE: { ASSIGN: "ASSIGNED", CANCEL: "CANCELLED", ESCALATE: "ESCALATED" },
  ASSIGNED: { ACCEPT: "ACCEPTED", REASSIGN: "ASSIGNED", CANCEL: "CANCELLED", ESCALATE: "ESCALATED" },
  ACCEPTED: { EN_ROUTE: "EN_ROUTE", CANCEL: "CANCELLED", ESCALATE: "ESCALATED" },
  EN_ROUTE: { ARRIVE: "ON_SCENE", ESCALATE: "ESCALATED" },
  ON_SCENE: { START_RESCUE: "RESCUE_IN_PROGRESS", ESCALATE: "ESCALATED" },
  RESCUE_IN_PROGRESS: { PERSON_SAFE: "PERSON_SAFE", ESCALATE: "ESCALATED" },
  PERSON_SAFE: { RESOLVE: "RESOLVED" },
  ESCALATED: { ASSIGN: "ASSIGNED", ACCEPT: "ACCEPTED", CANCEL: "CANCELLED", RESOLVE: "RESOLVED" },
  RESOLVED: {},
  CANCELLED: {},
};

// Event type recorded for each action (timeline).
const ACTION_EVENTS = {
  REQUEST: "RESCUE_REQUESTED",
  CREATE: "INCIDENT_CREATED",
  DETECT: "INCIDENT_DETECTED",
  DETECTION_UPDATE: "DETECTION_UPDATED",
  ASSIGN: "TEAM_ASSIGNED",
  REASSIGN: "TEAM_REASSIGNED",
  ACCEPT: "MISSION_ACCEPTED",
  EN_ROUTE: "TEAM_EN_ROUTE",
  ARRIVE: "TEAM_ARRIVED",
  START_RESCUE: "RESCUE_STARTED",
  PERSON_SAFE: "PERSON_SAFE",
  RESOLVE: "INCIDENT_RESOLVED",
  ESCALATE: "INCIDENT_ESCALATED",
  CANCEL: "INCIDENT_CANCELLED",
};

// Who may perform each action.
//
// AVIGHNAA has exactly TWO roles: 'user' and 'rescue_team'.
// There is no admin role — operational rescue decisions belong to the
// rescue team, which is what runs the Rescue Control console.
const ACTION_ROLES = {
  // Any authenticated control-room user (or the rescue team) can request
  // rescue for an incident the risk engine already raised.
  REQUEST: ["user", "rescue_team"],
  // Assignment, reassignment, escalation and cancellation are rescue
  // operational decisions — no admin role exists.
  ASSIGN: ["rescue_team"],
  REASSIGN: ["rescue_team"],
  CANCEL: ["rescue_team"],
  ESCALATE: ["rescue_team"],
  RESOLVE: ["rescue_team"], // only from PERSON_SAFE (checked in controller)
  ACCEPT: ["rescue_team"],
  EN_ROUTE: ["rescue_team"],
  ARRIVE: ["rescue_team"],
  START_RESCUE: ["rescue_team"],
  PERSON_SAFE: ["rescue_team"],
  // Pre-departure equipment gate
  EQUIPMENT_CHECK: ["rescue_team"],
};

// Timer labels shown on mission buttons (frontend mirrors this map).
const STATUS_LABELS = {
  AWAITING_RESPONSE: "Awaiting Response",
  ASSIGNED: "Assigned",
  ACCEPTED: "Accepted",
  EN_ROUTE: "En Route",
  ON_SCENE: "On Scene",
  RESCUE_IN_PROGRESS: "Rescue In Progress",
  PERSON_SAFE: "Person Safe",
  RESOLVED: "Resolved",
  ESCALATED: "Escalated",
  CANCELLED: "Cancelled",
};

// ─── Rescue equipment ──────────────────────────────────────────
// Inventory types used by rescue_equipment.equipment_type.
const EQUIPMENT_TYPES = {
  PROTECTION: "Protective equipment",
  MEDICAL: "Medical equipment",
  RESCUE: "Rescue / lifting equipment",
  COMMS: "Communication equipment",
  LIGHTING: "Lighting equipment",
  WATER: "Water rescue equipment",
};

// Hazard → general equipment recommendations for the pre-departure check.
//
// IMPORTANT: these are GENERAL PROTOTYPE recommendations derived from the
// incident hazard type. They are NOT certified professional emergency
// response instructions and must be presented as such in the UI.
const HAZARD_EQUIPMENT = {
  GAS_LEAK: ["Protective equipment", "Breathing protection", "Fire extinguisher", "Emergency communication device", "Flashlight"],
  FIRE_HEAT: ["Protective equipment", "Breathing protection", "Fire extinguisher", "Emergency communication device", "Flashlight"],
  COMBINED: ["Protective equipment", "Breathing protection", "Fire extinguisher", "First-aid kit", "Emergency communication device", "Flashlight"],
  FLOOD: ["Life-saving equipment", "Rescue rope", "Flashlight", "Emergency communication device"],
  FALL: ["First-aid kit", "Stretcher", "Emergency communication device"],
  SOS: ["First-aid kit", "Protective equipment", "Emergency communication device", "Flashlight"],
  ANOMALY: ["Protective equipment", "Emergency communication device", "Flashlight"],
  HIGH_RISK: ["Protective equipment", "First-aid kit", "Emergency communication device", "Flashlight"],
};

// Which inventory types satisfy each recommendation label.
const EQUIPMENT_ITEM_TYPES = {
  GAS_LEAK: ["PROTECTION", "COMMS", "LIGHTING"],
  FIRE_HEAT: ["PROTECTION", "COMMS", "LIGHTING"],
  COMBINED: ["PROTECTION", "MEDICAL", "COMMS", "LIGHTING"],
  FLOOD: ["WATER", "RESCUE", "COMMS", "LIGHTING"],
  FALL: ["MEDICAL", "COMMS"],
  SOS: ["MEDICAL", "PROTECTION", "COMMS", "LIGHTING"],
  ANOMALY: ["PROTECTION", "COMMS", "LIGHTING"],
  HIGH_RISK: ["PROTECTION", "MEDICAL", "COMMS", "LIGHTING"],
};

const EQUIPMENT_STATUSES = ["AVAILABLE", "IN_USE", "MAINTENANCE", "DAMAGED", "UNAVAILABLE"];
const EQUIPMENT_CONDITIONS = ["NEW", "GOOD", "FAIR", "POOR"];

// Statuses that count as "ready to respond".
const READY_EQUIPMENT_STATUSES = ["AVAILABLE"];

module.exports = {
  INCIDENT_MIN_SEVERITY,
  INCIDENT_COOLDOWN_MINUTES,
  RESPONSE_TIMEOUT_MINUTES,
  ESCALATION_CHECK_MS,
  DEVICE_OFFLINE_SECONDS,
  SEVERITY_RANK,
  severityAtLeast,
  HAZARD_MAP,
  HAZARD_TO_TEAM,
  HAZARD_LABELS,
  INCIDENT_STATUSES,
  TERMINAL_STATUSES,
  STATUS_TRANSITIONS,
  ACTION_EVENTS,
  ACTION_ROLES,
  STATUS_LABELS,
  EQUIPMENT_TYPES,
  HAZARD_EQUIPMENT,
  EQUIPMENT_ITEM_TYPES,
  EQUIPMENT_STATUSES,
  EQUIPMENT_CONDITIONS,
  READY_EQUIPMENT_STATUSES,
};
