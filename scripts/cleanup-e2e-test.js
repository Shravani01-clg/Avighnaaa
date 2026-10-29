/**
 * One-off cleanup for a live E2E verification run (test SOS reading posted
 * through the real /api/sensor-data endpoint). Removes ONLY the rows that
 * verification created: incident AV-1026, its timeline + notifications, the
 * synthetic sensor reading + risk row, and restores team RT-02 (which the
 * test assignment had moved to BUSY). Run: node scripts/cleanup-e2e-test.js
 */
const fs = require("fs");
const path = require("path");

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}

const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

const INCIDENT = "AV-1026";
const READING_ID = "d2c542f7-a96d-4cb7-a04e-e898be0cc6c5";
const TEST_FROM = "2026-10-29T20:15:00.000Z";

async function rest(path_, opts = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path_}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path_} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const log = [];

  // 1. Team RT-02: snapshot first, restore later.
  const rt02 = await rest("rescue_teams?team_id=eq.RT-02&select=*");
  log.push(`RT-02 before: status=${rt02[0]?.status}`);

  // 2. Notifications created by the test (only if migration 008 added the
  //    table — otherwise the feed is in-memory and dies with the request).
  try {
    const notifs = await rest(`notifications?or=(incident_id.eq.${INCIDENT},title.ilike.*${INCIDENT}*,message.ilike.*${INCIDENT}*)&select=id`);
    if (notifs?.length) {
      await rest(`notifications?id=in.(${notifs.map((n) => n.id).join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    }
    log.push(`notifications deleted: ${notifs?.length || 0}`);
  } catch (err) {
    log.push("notifications skipped (table not created yet — feed is in-memory)");
  }

  // 3. Timeline events.
  const evs = await rest(`incident_events?incident_id=eq.${INCIDENT}&select=id`);
  if (evs?.length) {
    await rest(`incident_events?id=in.(${evs.map((e) => e.id).join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  log.push(`incident_events deleted: ${evs?.length || 0}`);

  // 4. The incident row itself.
  const incs = await rest(`incidents?incident_id=eq.${INCIDENT}&select=id`);
  if (incs?.length) {
    await rest(`incidents?id=in.(${incs.map((i) => i.id).join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  log.push(`incidents deleted: ${incs?.length || 0}`);

  // 5. The synthetic sensor reading + its risk prediction.
  const reading = await rest(`sensor_readings?id=eq.${READING_ID}&select=id`);
  if (reading?.length) {
    await rest(`sensor_readings?id=eq.${READING_ID}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  log.push(`sensor_readings deleted: ${reading?.length || 0}`);

  const risks = await rest(`risk_predictions?device_id=eq.RF-001&created_at=gte.${TEST_FROM}&select=id,risk_score,reason`);
  if (risks?.length) {
    await rest(`risk_predictions?id=in.(${risks.map((r) => r.id).join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  log.push(`risk_predictions deleted: ${risks?.length || 0} (${(risks || []).map((r) => r.reason).join("; ")})`);

  // 6. Alerts: only delete ones the test created (created after TEST_FROM).
  const alerts = await rest(`alerts?device_id=eq.RF-001&created_at=gte.${TEST_FROM}&select=id,alert_type,created_at`);
  if (alerts?.length) {
    await rest(`alerts?id=in.(${alerts.map((a) => a.id).join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  log.push(`alerts deleted: ${alerts?.length || 0} (${(alerts || []).map((a) => a.alert_type).join("; ")})`);

  // 7. Restore RT-02 to its pre-test state.
  const rt02Row = rt02[0];
  if (rt02Row) {
    const patch = { status: "AVAILABLE", updated_at: new Date().toISOString() };
    if ("active_incident_id" in rt02Row) patch.active_incident_id = null;
    if ("current_incident_id" in rt02Row) patch.current_incident_id = null;
    if ("mission_count" in rt02Row && typeof rt02Row.mission_count === "number" && rt02Row.mission_count > 0) {
      patch.mission_count = rt02Row.mission_count - 1;
    }
    await rest("rescue_teams?team_id=eq.RT-02", { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=minimal" } });
    log.push("RT-02 restored to AVAILABLE");
  }

  console.log(log.join("\n"));
})().catch((err) => {
  console.error("CLEANUP FAILED:", err.message);
  process.exit(1);
});
