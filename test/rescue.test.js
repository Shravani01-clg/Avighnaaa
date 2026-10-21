/**
 * Rescue Layer Tests (TEST 5–8 + role checks)
 *
 * Run: node test/rescue.test.js --live
 *
 * Exercises the incident workflow through the real controllers with
 * mocked req/res. It writes incidents to the live database, so it refuses
 * to run without the explicit --live opt-in.
 */

const assert = require("assert");
const { requireLiveDbWrite } = require("./live-guard");

// This suite writes to the live database — never run it by accident.
requireLiveDbWrite("rescue.test.js");

const store = require("../config/dataStore");
const { ACTION_EVENTS } = require("../config/rescueConfig");
const { cleanupTestIncidents } = require("./cleanup");
const {
  createIncidentFromAlert,
  assignIncident,
  acceptIncident,
  enRouteIncident,
  arriveIncident,
  startRescue,
  personSafe,
  resolveIncident,
  escalateIncident,
  cancelIncident,
  getTimeline,
  getStats,
  escalationTick,
} = require("../controllers/incidentController");

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function makeReq({ role, email, team_id, body }) {
  return {
    user: { id: "test-user-id", email },
    role,
    profile: { role, team_id: team_id || null, email },
    body: body || {},
    params: {},
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(handler, req, res) {
  await handler(req, res);
  return res;
}

let passed = 0;
function ok(label) { passed += 1; console.log(`  ✅ ${label}`); }

(async () => {
  console.log("── Incident creation & dedup ──");

  const risk = {
    risk_score: 95,
    risk_level: "CRITICAL",
    reason: "Extreme gas level; Combined danger",
    fall_state: "NORMAL",
    sos: true,
    details: {},
    ai: null,
  };

  // Unique per run: incident creation is blocked by INCIDENT_COOLDOWN_MINUTES
  // after a terminal incident on the same device, so a fixed device id made
  // every second run of this test fail.
  const RUN = Date.now().toString(36).toUpperCase();
  const DEV_A = `TEST-DEV-1-${RUN}`;
  const DEV_B = `TEST-DEV-2-${RUN}`;
  // The escalation incident is left in the ESCALATED state on purpose, so it
  // needs its own per-run device id too — a fixed id made the next run
  // update the previous run's incident instead of creating a new one, and
  // the "overdue incident escalates" assertion then failed.
  const DEV_C = `TEST-DEV-3-${RUN}`;

  const first = await createIncidentFromAlert({
    device_id: DEV_A,
    alertType: "COMBINED_DANGER",
    severity: "CRITICAL",
    alertId: null,
    risk,
  });
  assert(first && first.incident_id, "incident should be created");
  assert.strictEqual(first.status, "AWAITING_RESPONSE");
  ok(`created ${first.incident_id} (TEST 2)`);

  const second = await createIncidentFromAlert({
    device_id: DEV_A,
    alertType: "GAS_DANGER",
    severity: "HIGH",
    alertId: null,
    risk: { ...risk, risk_score: 88 },
  });
  assert.strictEqual(second.incident_id, first.incident_id, "dedup: same incident updated");
  assert.strictEqual(second.risk_score, 88);
  ok("dedup: repeated critical reading updates (no 2nd incident)");

  const lowRisk = await createIncidentFromAlert({
    device_id: DEV_B,
    alertType: "ANOMALY",
    severity: "MEDIUM",
    alertId: null,
    risk: { ...risk, risk_level: "MEDIUM", risk_score: 30 },
  });
  assert.strictEqual(lowRisk, null, "MEDIUM must not create an incident");
  ok("TEST 1: below-threshold reading creates no incident");

  const INC = first.incident_id;

  console.log("── Role enforcement (TEST 4) ──");
  let res = await call(
    acceptIncident,
    Object.assign(makeReq({ role: "user", email: "u@x.com" }), { params: { id: INC } }),
    mockRes()
  );
  assert.strictEqual(res.statusCode, 403, "normal user must be rejected");
  ok("TEST 4: user role → 403 on accept");

  console.log("── Invalid transitions (TEST 7 rules) ──");
  res = await call(
    resolveIncident,
    Object.assign(makeReq({ role: "rescue_team", email: "a@x.com" }), { params: { id: INC } }),
    mockRes()
  );
  // AWAITING_RESPONSE → RESOLVE is not in the transition map, so rejected
  assert.strictEqual(res.statusCode, 409, `AWAITING_RESPONSE must not resolve directly, got ${res.statusCode} ${JSON.stringify(res.body)}`);
  ok("AWAITING_RESPONSE → RESOLVE rejected (409)");

  console.log("── Assignment (TEST 5) ──");
  res = await call(
    assignIncident,
    Object.assign(
      makeReq({ role: "rescue_team", email: "a@x.com", body: { team_id: "RT-01" } }),
      { params: { id: INC } }
    ),
    mockRes()
  );
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.status, "ASSIGNED");
  assert.strictEqual(res.body.data.assigned_team_id, "RT-01");
  ok("TEST 5: rescue team assigned RT-01 → ASSIGNED");

  const teams = await store.select("rescue_teams", { filters: { team_id: "RT-01" }, limit: 1 });
  assert.strictEqual(teams[0].status, "BUSY", "assigned team should be BUSY");
  ok("team RT-01 marked BUSY");

  res = await call(
    acceptIncident,
    Object.assign(
      makeReq({ role: "rescue_team", email: "r@x.com", team_id: "RT-02" }),
      { params: { id: INC } }
    ),
    mockRes()
  );
  assert.strictEqual(res.statusCode, 403, "wrong team must be rejected");
  ok("wrong team (RT-02) → 403");

  console.log("── Mission workflow (TEST 6–7) ──");
  const teamReq = () =>
    Object.assign(
      makeReq({ role: "rescue_team", email: "rescue@x.com", team_id: "RT-01" }),
      { params: { id: INC } }
    );

  const steps = [
    [acceptIncident, "ACCEPTED", "TEST 6: accept"],
    [enRouteIncident, "EN_ROUTE", "en route"],
    [arriveIncident, "ON_SCENE", "arrived"],
    [startRescue, "RESCUE_IN_PROGRESS", "rescue started"],
    [personSafe, "PERSON_SAFE", "person safe"],
  ];

  // The pre-departure equipment check now gates EN ROUTE. Prove the gate
  // fires, then complete the checklist properly and continue.
  {
    const { eq } = require("../controllers/equipmentHelpers");
    const gate = await call(enRouteIncident, teamReq(), mockRes());
    assert.strictEqual(gate.statusCode, 409, "EN ROUTE must be blocked before the equipment check");
    assert.strictEqual(gate.body.code, "EQUIPMENT_CHECK_REQUIRED");
    ok("EN ROUTE blocked until the equipment check is complete (409)");

    let rows = await eq("select", "equipment_checklists", {
      filters: { incident_id: INC },
      limit: 1,
    });
    if (!rows || rows.length === 0) {
      const { HAZARD_EQUIPMENT } = require("../config/rescueConfig");
      rows = await eq("insert", "equipment_checklists", {
        incident_id: INC,
        team_id: "RT-01",
        required_items: HAZARD_EQUIPMENT[incident.hazard_type] || HAZARD_EQUIPMENT.HIGH_RISK,
        checked_items: [],
        status: "PENDING",
      });
    }
    const checklist = Array.isArray(rows) ? rows[0] : rows;
    await eq("update", "equipment_checklists", { id: checklist.id }, {
      checked_items: checklist.required_items,
      status: "COMPLETE",
      updated_at: new Date().toISOString(),
    });
    ok("equipment checklist completed for the mission");
  }
  for (const [handler, expected, label] of steps) {
    res = await call(handler, teamReq(), mockRes());
    assert.strictEqual(res.statusCode, 200, `${label}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.data.status, expected);
    ok(`${label} → ${expected}`);
  }

  // team cannot resolve before PERSON_SAFE — already covered by map; now allowed:
  res = await call(resolveIncident, teamReq(), mockRes());
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.status, "RESOLVED");
  ok("TEST 7: resolve from PERSON_SAFE → RESOLVED");

  const rt01 = await store.select("rescue_teams", { filters: { team_id: "RT-01" }, limit: 1 });
  assert.strictEqual(rt01[0].status, "AVAILABLE");
  ok("team RT-01 back to AVAILABLE after resolve");

  console.log("── Timeline (TEST 6–7) ──");
  res = await call(
    getTimeline,
    Object.assign(makeReq({ role: "rescue_team", email: "a@x.com" }), { params: { id: INC } }),
    mockRes()
  );
  const types = res.body.data.map((e) => e.event_type);
  const expected = [
    "INCIDENT_DETECTED",
    "INCIDENT_CREATED",
    "DETECTION_UPDATED", // from the dedup update above
    "TEAM_ASSIGNED",
    "MISSION_ACCEPTED",
    "TEAM_EN_ROUTE",
    "TEAM_ARRIVED",
    "RESCUE_STARTED",
    "PERSON_SAFE",
    "INCIDENT_RESOLVED",
  ];
  assert.deepStrictEqual(types, expected, `timeline mismatch: ${types}`);
  ok("timeline has full sequence in order");

  console.log("── Escalation (TEST 8) ──");
  const esc = await createIncidentFromAlert({
    device_id: DEV_C,
    alertType: "SOS",
    severity: "CRITICAL",
    alertId: null,
    risk,
  });
  // Backdate so it looks overdue.
  //
  // The escalation clock follows the DETECTION event in the incident
  // timeline, not `incidents.updated_at` — that column is bumped by every
  // new sensor reading for an open incident, so a device that keeps
  // transmitting could never be escalated. The timeline anchor is what has
  // to be moved back to make the incident genuinely overdue.
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await store.update(
    "incidents",
    { id: esc.id },
    {
      detected_at: tenMinutesAgo,
      created_at: tenMinutesAgo,
      updated_at: tenMinutesAgo,
    }
  );
  await store.update(
    "incident_events",
    { incident_id: esc.incident_id, event_type: ACTION_EVENTS.DETECT },
    { timestamp: tenMinutesAgo }
  );
  await store.update(
    "incident_events",
    { incident_id: esc.incident_id, event_type: ACTION_EVENTS.CREATE },
    { timestamp: tenMinutesAgo }
  );
  await escalationTick();
  const escAfter = await store.select("incidents", { filters: { incident_id: esc.incident_id }, limit: 1 });
  assert.strictEqual(escAfter[0].status, "ESCALATED", "unacknowledged incident must escalate");
  ok("TEST 8: overdue incident → ESCALATED");

  res = await call(
    getTimeline,
    Object.assign(makeReq({ role: "rescue_team", email: "a@x.com" }), { params: { id: esc.incident_id } }),
    mockRes()
  );
  assert(res.body.data.some((e) => e.event_type === "INCIDENT_ESCALATED"));
  ok("escalation event recorded in timeline");

  console.log("── Stats (TEST analytics) ──");
  res = await call(getStats, makeReq({ role: "rescue_team", email: "a@x.com" }), mockRes());
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.sufficient_data, true);
  assert(res.body.data.total_incidents >= 2);
  assert(res.body.data.resolved_incidents >= 1);
  assert(res.body.data.escalated_incidents >= 1);
  ok("stats computed from real incidents only");

  // Remove the incidents this run created so the live database is left as
  // it was found. Only the incident ids created above are touched.
  await cleanupTestIncidents([first.incident_id, esc.incident_id]);

  console.log(`\n🎉 ${passed} assertions passed`);
  process.exit(0);
})().catch((err) => {
  console.error("\n❌ TEST FAILED:", err.message);
  process.exit(1);
});
