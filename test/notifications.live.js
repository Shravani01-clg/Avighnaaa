/**
 * CROSS-LOGIN NOTIFICATIONS — LIVE E2E
 *
 * Run:  node test/notifications.live.js --live
 *
 * Proves, against the REAL backend + REAL Supabase accounts, that the
 * communication loop between the two logins works over HTTP:
 *
 *   control room (user) raises a rescue request
 *        -> the RESCUE LOGIN's feed receives RESCUE_REQUESTED
 *   rescue login assigns a team to the incident
 *        -> the ADMIN / CONTROL-ROOM LOGIN's feed receives TEAM_ASSIGNED
 *   read state + audience scoping are enforced over the wire
 *
 * Writes one incident (device E2E-DEV-NOTIF-*) to the live database and
 * removes it again at the end, exactly like rescue.e2e.js.
 */

require("dotenv").config();

const { requireLiveDbWrite } = require("./live-guard");

// This suite writes to the live database — never run it by accident.
requireLiveDbWrite("notifications.live.js");

const { createIncidentFromAlert } = require("../controllers/incidentController");
const { cleanupTestIncidents } = require("./cleanup");
const { releaseIdleTeams } = require("./release-teams");
const { buildAccounts } = require("../scripts/accounts");

const API = process.env.API_BASE_URL || "http://localhost:5002/api";
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const ACCOUNTS = buildAccounts();
const rescueAcc = ACCOUNTS.find((a) => a.role === "rescue_team");
const controlAcc = ACCOUNTS.find((a) => a.role === "user");

let passed = 0;
let failed = 0;

function check(label, ok, extra) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
  return ok;
}

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`sign-in ${email} failed: ${body.msg || res.statusText}`);
  }
  return body.access_token;
}

async function api(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

/** Remove the notifications this run wrote for its test incident. */
async function cleanupNotifications(incidentId) {
  if (!SERVICE_KEY) return;
  try {
    const { createClient } = require("@supabase/supabase-js");
    const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const del = await sb
      .from("notifications")
      .delete()
      .eq("incident_id", incidentId)
      .select("id");
    console.log(`\n🧹 Test cleanup: removed ${(del.data || []).length} notification row(s)`);
  } catch (err) {
    // Table may not exist yet (memory mode) — nothing to remove then.
    console.log(`\n🧹 Test cleanup: notifications not removable (${err.message})`);
  }
}

(async () => {
  console.log("── Cross-login notifications (LIVE) ──");
  console.log(`   API: ${API}`);

  // ── 1) Sign in as BOTH logins ─────────────────────────────────
  const rescueToken = await signIn(rescueAcc.email, rescueAcc.password);
  const controlToken = await signIn(controlAcc.email, controlAcc.password);
  check(`signed in as rescue login (${rescueAcc.email})`, true);
  check(`signed in as admin/control-room login (${controlAcc.email})`, true);

  // ── 2) Create one test incident (cleaned up at the end) ───────
  const deviceId = `E2E-DEV-NOTIF-${Date.now()}`;
  const incident = await createIncidentFromAlert({
    device_id: deviceId,
    alertType: "SOS",
    severity: "CRITICAL",
    alertId: "notif-live",
    risk: {
      risk_score: 95,
      risk_level: "CRITICAL",
      reason: "Notifications live e2e",
      fall_state: "NORMAL",
      sos: true,
      details: {},
      ai: null,
    },
  });
  if (!incident || !incident.incident_id) {
    console.error("\n❌ could not create the test incident — aborting (nothing written)");
    process.exit(1);
  }
  const INC = incident.incident_id;
  console.log(`   test incident: ${INC} (device ${deviceId})`);

  try {
    // ── 3) Control room raises the rescue request ───────────────
    const req1 = await api(`/incidents/${INC}/request-rescue`, controlToken, {
      method: "POST",
      body: "{}",
    });
    check("control room raised a rescue request over HTTP", req1.ok, JSON.stringify(req1.body));

    // ── 4) The RESCUE LOGIN's feed must show it ─────────────────
    const rescueFeed = await api("/notifications", rescueToken);
    const reqNotif = (rescueFeed.body.data || []).find(
      (n) => n.type === "RESCUE_REQUESTED" && n.incident_id === INC
    );
    check(
      "RESCUE LOGIN feed received RESCUE_REQUESTED",
      Boolean(reqNotif),
      `feed: ${JSON.stringify((rescueFeed.body.data || []).slice(0, 3))}`
    );
    check("notification carries the incident id + unread flag", reqNotif && reqNotif.read === false);
    check(
      "list response reports storage mode honestly",
      rescueFeed.body.storage === "supabase" || rescueFeed.body.storage === "memory",
      `storage=${rescueFeed.body.storage}`
    );
    if (rescueFeed.body.storage === "memory") {
      console.log(
        "   ℹ️  feed is in MEMORY mode — run migrations/008_notifications.sql for persistence"
      );
    }

    // ── 5) The ADMIN (control-room) feed must NOT show it ───────
    const adminBefore = await api("/notifications", controlToken);
    const leaked = (adminBefore.body.data || []).some(
      (n) => n.type === "RESCUE_REQUESTED" && n.incident_id === INC
    );
    check("audience scoping: control-room feed excludes rescue rows", !leaked);

    // ── 6) Rescue login ASSIGNS a team ──────────────────────────
    const assign = await api(`/incidents/${INC}/assign`, rescueToken, {
      method: "POST",
      body: JSON.stringify({ team_id: "RT-01" }),
    });
    check("rescue login assigned team RT-01 over HTTP", assign.ok, JSON.stringify(assign.body));

    // ── 7) THE ADMIN LOGIN MUST RECEIVE THE NOTIFICATION ────────
    const adminFeed = await api("/notifications", controlToken);
    const assignNotif = (adminFeed.body.data || []).find(
      (n) => n.type === "TEAM_ASSIGNED" && n.incident_id === INC
    );
    check(
      "ADMIN/CONTROL-ROOM LOGIN received TEAM_ASSIGNED notification",
      Boolean(assignNotif),
      `feed: ${JSON.stringify((adminFeed.body.data || []).slice(0, 3))}`
    );
    check(
      "notification names the assigned team",
      assignNotif && String(assignNotif.message).includes("RT-01"),
      assignNotif && assignNotif.message
    );
    check("admin unread_count counts the new row", (adminFeed.body.unread_count || 0) >= 1);

    // ── 8) Read state over the wire ─────────────────────────────
    if (assignNotif) {
      const mark = await api(
        `/notifications/${encodeURIComponent(assignNotif.id)}/read`,
        controlToken,
        { method: "POST" }
      );
      check("control room marked its notification read", mark.ok, JSON.stringify(mark.body));

      // Cross-audience: the rescue login must NOT be able to flip it.
      const cross = await api(
        `/notifications/${encodeURIComponent(assignNotif.id)}/read`,
        rescueToken,
        { method: "POST" }
      );
      check("cross-audience markRead refused", cross.status === 404, `status=${cross.status}`);
    }

    const all = await api("/notifications/read-all", controlToken, { method: "POST" });
    check("control room mark-all-read works", all.ok, JSON.stringify(all.body));

    const afterAll = await api("/notifications", controlToken);
    check("unread badge back to 0 after read-all", (afterAll.body.unread_count || 0) === 0);

    // ── 9) Role guard: anonymous request is refused ─────────────
    const anon = await api("/notifications", null);
    check("notifications require a signed-in login", anon.status === 401, `status=${anon.status}`);
  } finally {
    await cleanupNotifications(INC);
    await cleanupTestIncidents([INC], { log: true });
    // Deleting the incident directly bypasses the RESOLVED transition that
    // would normally release the assigned team — release it here so the
    // next run doesn't start against a team stuck BUSY.
    try {
      const released = await releaseIdleTeams();
      if (released.length) console.log(`🧹 Released idle team(s): ${released.join(", ")}`);
    } catch { /* non-fatal */ }
  }

  console.log(
    `\n${failed === 0 ? "✅" : "❌"} notifications live e2e: ${passed} passed, ${failed} failed\n`
  );
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`\n❌ notifications live e2e CRASHED: ${err.message}\n`);
  process.exit(1);
});
