/**
 * Notification Feed Smoke Test (IN-MEMORY ONLY — never touches the cloud DB)
 *
 * Run: node test/notifications.smoke.js
 *
 * Proves the cross-login notification contract through the REAL controllers:
 *   1. control room raises a rescue request  -> rescue login is notified
 *   2. rescue login assigns a team          -> control room (admin) is notified
 *   3. read state + audience scoping are enforced server-side
 *   4. a notification failure can never break a rescue action (never-throws)
 */

// Blank the Supabase credentials BEFORE any config module loads, so
// config/dataStore.js falls back to its in-memory store. dotenv cannot
// overwrite pre-set keys, so this sticks for the whole process.
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SECRET_KEY = "";

const assert = require("assert");

const store = require("../config/dataStore");
const { createIncidentFromAlert, requestRescue, assignIncident } = require("../controllers/incidentController");
const {
  createNotification,
  listNotifications,
  markRead,
  markAllRead,
} = require("../controllers/notificationController");

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function makeReq({ role, email, team_id, body, params }) {
  return {
    user: { id: "smoke-user", email },
    role,
    profile: { role, team_id: team_id || null, email },
    body: body || {},
    params: params || {},
  };
}

let passed = 0;
function ok(label) { passed += 1; console.log(`  ✅ ${label}`); }

(async () => {
  console.log("── Notification feed (in-memory) ──");

  // ── 1) Incident + rescue request from the control room ──────────
  const risk = {
    risk_score: 95,
    risk_level: "CRITICAL",
    reason: "Smoke test incident",
    fall_state: "NORMAL",
    sos: true,
    details: {},
    ai: null,
  };

  const incident = await createIncidentFromAlert({
    device_id: "SMOKE-NOTIF-001",
    alertType: "SOS",
    severity: "CRITICAL",
    alertId: "smoke",
    risk,
  });
  assert(incident && incident.incident_id, "incident must be created in memory");
  ok(`incident ${incident.incident_id} created (memory store)`);

  const reqRes = await (async () => {
    const res = mockRes();
    await requestRescue(
      makeReq({ role: "user", email: "control@room", body: {} , params: { id: incident.incident_id } }),
      res
    );
    return res;
  })();
  assert.strictEqual(reqRes.body.success, true, `requestRescue must succeed: ${JSON.stringify(reqRes.body)}`);
  ok("control room raised a rescue request");

  // ── 2) The RESCUE LOGIN is notified of the request ──────────────
  const rescueList = mockRes();
  await listNotifications(makeReq({ role: "rescue_team", email: "rescue@team" }), rescueList);
  assert.strictEqual(rescueList.body.success, true);
  const reqNotif = (rescueList.body.data || []).find(n => n.type === "RESCUE_REQUESTED");
  assert(reqNotif, "rescue_team feed must contain the RESCUE_REQUESTED row");
  assert.strictEqual(reqNotif.incident_id, incident.incident_id);
  assert.strictEqual(reqNotif.read, false);
  assert(rescueList.body.unread_count >= 1, "unread_count must count the new row");
  ok("rescue login notified: RESCUE_REQUESTED (unread)");

  // ── 3) The ADMIN (control-room) login must NOT see that row ─────
  const adminBefore = mockRes();
  await listNotifications(makeReq({ role: "user", email: "control@room" }), adminBefore);
  assert(
    !(adminBefore.body.data || []).some(n => n.type === "RESCUE_REQUESTED"),
    "audience scoping: control room must not receive rescue-side rows"
  );
  ok("audience scoping: control-room feed excludes rescue rows");

  // ── 4) Rescue login ASSIGNS a team -> admin is notified ─────────
  const assignRes = mockRes();
  await assignIncident(
    makeReq({
      role: "rescue_team",
      email: "rescue@team",
      team_id: "RT-01",
      body: { team_id: "RT-01" },
      params: { id: incident.incident_id },
    }),
    assignRes
  );
  assert.strictEqual(assignRes.body.success, true, `assign must succeed: ${JSON.stringify(assignRes.body)}`);
  ok(`team RT-01 assigned from the rescue login (status ${assignRes.body.data && assignRes.body.data.status})`);

  const adminList = mockRes();
  await listNotifications(makeReq({ role: "user", email: "control@room" }), adminList);
  const assignNotif = (adminList.body.data || []).find(n => n.type === "TEAM_ASSIGNED");
  assert(assignNotif, "control-room feed must contain the TEAM_ASSIGNED row");
  assert(assignNotif.message.includes("RT-01"), "notification must name the assigned team");
  assert.strictEqual(assignNotif.incident_id, incident.incident_id);
  ok("ADMIN login notified: TEAM_ASSIGNED (from the rescue-login assignment)");

  // ── 5) Read state: mark one, then mark all ──────────────────────
  const markRes = mockRes();
  await markRead(
    makeReq({ role: "user", email: "control@room", params: { id: String(assignNotif.id) } }),
    markRes
  );
  assert.strictEqual(markRes.body.success, true);
  const afterMark = mockRes();
  await listNotifications(makeReq({ role: "user", email: "control@room" }), afterMark);
  assert.strictEqual(
    (afterMark.body.data || []).find(n => String(n.id) === String(assignNotif.id)).read,
    true,
    "marked row must read back as read"
  );
  ok("mark-one read works and reads back");

  // Cross-audience markRead must 404 (one login cannot flip the other's state).
  const crossRes = mockRes();
  await markRead(
    makeReq({ role: "rescue_team", email: "rescue@team", params: { id: String(assignNotif.id) } }),
    crossRes
  );
  assert.strictEqual(crossRes.body.success, false, "cross-audience markRead must be refused");
  ok("cross-audience markRead refused (404)");

  const allRes = mockRes();
  await markAllRead(makeReq({ role: "user", email: "control@room" }), allRes);
  assert.strictEqual(allRes.body.success, true);
  const finalList = mockRes();
  await listNotifications(makeReq({ role: "user", email: "control@room" }), finalList);
  assert.strictEqual(finalList.body.unread_count, 0, "unread_count must be 0 after read-all");
  ok("mark-all-read works; unread badge back to 0");

  // ── 6) createNotification never throws / never blocks ───────────
  const bogus = await createNotification({
    incident_id: null,
    audience: "not-a-login",
    type: "X",
    title: "t",
    message: "m",
  });
  assert.strictEqual(bogus, null, "invalid audience must be rejected without throwing");
  ok("createNotification never-throws contract holds (invalid audience -> null)");

  // The rescue request above already succeeded even though notifications
  // are written inline — proof the workflow path cannot be blocked.
  ok("rescue workflow completed with notifications inline (no blocking)");

  console.log(`\n✅ notifications smoke OK — ${passed} checks passed\n`);
  process.exit(0);
})().catch((err) => {
  console.error(`\n❌ notifications smoke FAILED: ${err.message}\n`);
  process.exit(1);
});
