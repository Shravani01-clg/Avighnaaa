/**
 * AVIGHNAA RESCUE SYSTEM — FULL E2E (TWO-ROLE ARCHITECTURE)
 *
 * Run:  node test/rescue.e2e.js
 *
 * AVIGHNAA has exactly TWO roles: user and rescue_team. There is no admin.
 * This test proves:
 *   - a USER cannot reach any rescue-team API (backend-enforced)
 *   - the RESCUE_TEAM owns assignment, escalation and resolution
 *   - the equipment checklist genuinely gates the EN ROUTE step
 *   - equipment usage is recorded only when explicitly checked out
 *   - both interfaces read the same incident row
 */
require("dotenv").config();

const { requireLiveDbWrite } = require("./live-guard");

// This suite writes to the live database — never run it by accident.
requireLiveDbWrite("rescue.e2e.js");

const { createIncidentFromAlert } = require("../controllers/incidentController");
const { cleanupTestIncidents, isTestDevice } = require("./cleanup");

const API = process.env.API_BASE_URL || "http://localhost:5002/api";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY;

const { buildAccounts } = require("../scripts/accounts");

const ACCOUNTS = buildAccounts();

let passed = 0;
let failed = 0;
const failures = [];

// Incidents this run created — removed again by the cleanup at the end so
// the suite leaves the live database exactly as it found it.
const createdIncidents = [];

function check(label, ok, extra) {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    failures.push(label + (extra ? ` — ${extra}` : ""));
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
  return ok;
}

const adminHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
});

/**
 * Make sure the demo accounts exist and carry the right role.
 *
 * IMPORTANT: the password of an EXISTING account is never written. Sending it
 * would silently overwrite the password the operator chose in the Supabase
 * dashboard and invalidate every live session for that user. Only the
 * server-controlled app_metadata (role / team) is corrected.
 *
 * When the configured password does not match the account, the suite says so
 * and points at the environment variable to fix — it does not "repair" it.
 */
async function ensureAccounts() {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: adminHeaders(),
  });
  const existing = (await list.json()).users || [];
  const passwordMismatches = [];

  for (const acc of ACCOUNTS) {
    const found = existing.find(
      (u) => String(u.email || "").toLowerCase() === acc.email.toLowerCase()
    );
    const meta = acc.team ? { role: acc.role, team_id: acc.team } : { role: acc.role };

    if (found) {
      // Role / team metadata only — the password is NOT part of this update.
      const metaOk =
        found.app_metadata &&
        found.app_metadata.role === meta.role &&
        (meta.team_id === undefined ||
          found.app_metadata.team_id === meta.team_id);

      if (!metaOk) {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${found.id}`, {
          method: "PUT",
          headers: adminHeaders(),
          body: JSON.stringify({ app_metadata: meta }),
        });
        console.log(`   ↻ fixed app_metadata for ${acc.email} (role=${meta.role})`);
      }

      // Report — do not overwrite — a password that no longer matches.
      let credentialsOk = false;
      try {
        const probe = await fetch(
          `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
          {
            method: "POST",
            headers: { apikey: ANON, "Content-Type": "application/json" },
            body: JSON.stringify({ email: acc.email, password: acc.password }),
          }
        );
        credentialsOk = probe.ok;
      } catch {
        credentialsOk = false;
      }

      if (!credentialsOk) {
        passwordMismatches.push(acc.email);
        console.log(
          `   ⚠️  ${acc.email} exists but the configured password does not match. ` +
            `The suite will NOT overwrite your password — set ` +
            `${acc.passwordEnv} in .env to the password that works.`
        );
      }
      continue;
    }

    // Account does not exist yet → create it with the configured password.
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        email: acc.email,
        password: acc.password,
        email_confirm: true,
        app_metadata: meta,
      }),
    });
    console.log(`   + created ${acc.email} (role=${meta.role})`);
  }

  return passwordMismatches;
}

async function signIn(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `sign-in ${email} failed: ${body.msg || res.statusText}. ` +
        `If you changed this password in the Supabase dashboard, put it in .env ` +
        `(RESCUE_TEAM_PASSWORD / CONTROL_USER_PASSWORD) — the suite will not ` +
        `overwrite your password.`
    );
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
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * The rescue account belongs to RT-01. Assignment correctly refuses a team
 * that is BUSY, and earlier runs can leave RT-01 holding open incidents, so
 * release it first. Uses the real cancel endpoint — no test-only back door.
 *
 * ONLY incidents that belong to a test run are released. An incident created
 * by a real device (or by a person) is never cancelled by the test suite —
 * if one is holding the team, the suite reports that instead of destroying
 * live operational data.
 */
async function freeTeam(token, teamId) {
  const pending = await api("/incidents", token);
  const mine = (pending.body.data || []).filter(
    (i) => i.assigned_team_id === teamId && !["RESOLVED", "CANCELLED"].includes(i.status)
  );
  for (const inc of mine) {
    if (!isTestDevice(inc.device_id)) {
      console.log(
        `   ⚠️  ${inc.incident_id} (${inc.device_id}) is holding ${teamId} and is NOT a test record — left untouched`
      );
      continue;
    }
    await api(`/incidents/${inc.incident_id}/cancel`, token, {
      method: "POST",
      body: JSON.stringify({ notes: "E2E cleanup — releasing the team" }),
    });
  }
  const teams = await api("/rescue-teams", token);
  const team = (teams.body.data || []).find((t) => t.team_id === teamId);
  return team ? team.status : "UNKNOWN";
}

(async () => {
  console.log("\n════ AVIGHNAA RESCUE — E2E (two roles) ════\n");
  await ensureAccounts();

  const tokens = {};
  for (const acc of ACCOUNTS) tokens[acc.role] = await signIn(acc.email, acc.password);
  console.log("── Authentication ──");
  check("USER and RESCUE_TEAM both sign in", Object.keys(tokens).length === 2);

  // ── 1. Two-role enforcement ──────────────────────────────────
  console.log("\n── A. There is no admin role ──");
  const meRescue = await api("/auth/me", tokens.rescue_team);
  const meUser = await api("/auth/me", tokens.user);
  check("rescue account resolves to rescue_team", meRescue.body.data.role === "rescue_team", meRescue.body.data.role);
  check("control account resolves to user", meUser.body.data.role === "user", meUser.body.data.role);
  check("no account resolves to 'admin'", meRescue.body.data.role !== "admin" && meUser.body.data.role !== "admin");

  console.log("\n── B. USER is denied every rescue-team API ──");
  const denied = [
    ["GET", "/incidents/stats", "/incidents/stats"],
    ["GET", "/incidents/history", "/incidents/history"],
    ["GET", "/rescue-equipment", "/rescue-equipment"],
    ["GET", "/rescue-equipment/usage", "/rescue-equipment/usage"],
    ["GET", "/device-health", "/device-health"],
    ["POST", "/rescue-teams", "/rescue-teams"],
    ["PATCH", "/rescue-teams/RT-01", "/rescue-teams/RT-01"],
  ];
  for (const [method, label, path] of denied) {
    const r = await api(path, tokens.user, {
      method,
      body: method === "POST" || method === "PATCH" ? JSON.stringify({}) : undefined,
    });
    check(`USER ${method} ${label} → 403`, r.status === 403, `got ${r.status}`);
  }

  const userAssign = await api("/incidents/AV-0000/assign", tokens.user, {
    method: "POST",
    body: JSON.stringify({ team_id: "RT-01" }),
  });
  check("USER cannot assign a team → 403", userAssign.status === 403, `got ${userAssign.status}`);

  const userEscalate = await api("/incidents/AV-0000/escalate", tokens.user, {
    method: "POST",
    body: "{}",
  });
  check("USER cannot escalate → 403", userEscalate.status === 403, `got ${userEscalate.status}`);

  const userEqPatch = await api("/rescue-equipment/FE-01", tokens.user, {
    method: "PATCH",
    body: JSON.stringify({ status: "DAMAGED" }),
  });
  check("USER cannot change equipment → 403", userEqPatch.status === 403, `got ${userEqPatch.status}`);

  const anon = await api("/incidents", null);
  check("unauthenticated /incidents → 401", anon.status === 401, `got ${anon.status}`);

  // ── 2. Detection → incident ─────────────────────────────────
  console.log("\n── C. Sensor → risk → AI → alert → incident ──");
  const runId = Date.now().toString(36).toUpperCase();
  const risk = {
    risk_score: 95,
    risk_level: "CRITICAL",
    reason: "Extreme gas level; Combined danger",
    fall_state: "NORMAL",
    sos: true,
    details: {},
    ai: null,
  };

  const incident = await createIncidentFromAlert({
    device_id: `E2E-DEV-${runId}`,
    alertType: "COMBINED_DANGER",
    severity: "CRITICAL",
    alertId: `ALERT-${runId}`,
    risk,
  });
  check("incident auto-created", Boolean(incident && incident.incident_id));
  if (!incident) return finish();
  const INC = incident.incident_id;
  createdIncidents.push(INC);
  console.log(`     incident = ${INC}`);

  const dupe = await createIncidentFromAlert({
    device_id: `E2E-DEV-${runId}`,
    alertType: "GAS_DANGER",
    severity: "CRITICAL",
    alertId: `ALERT-${runId}-B`,
    risk,
  });
  check("no duplicate for the same ongoing emergency", dupe.incident_id === INC);

  // ── 3. User requests rescue ─────────────────────────────────
  console.log("\n── D. USER requests rescue ──");
  const req1 = await api(`/incidents/${INC}/request-rescue`, tokens.user, { method: "POST", body: "{}" });
  check("USER can request rescue → 200", req1.status === 200, `got ${req1.status}`);
  check("incident flagged rescue_requested", req1.body.data.rescue_requested === true);
  const req2 = await api(`/incidents/${INC}/request-rescue`, tokens.user, { method: "POST", body: "{}" });
  check("repeat request is idempotent", req2.body.already_requested === true);

  const portal = await api("/incidents", tokens.rescue_team);
  check("RESCUE_TEAM portal sees the incident", (portal.body.data || []).some((i) => i.incident_id === INC));

  // The portal must show the REQUEST against the same incident, and the
  // recorded ping must carry the dispatch context (location / device / team)
  // so the rescue team knows where to go and who owns the mission.
  const portalRow = (portal.body.data || []).find((i) => i.incident_id === INC);
  check(
    "portal shows rescue_requested on the SAME incident",
    Boolean(portalRow && portalRow.rescue_requested === true)
  );

  const reqTl = await api(`/incidents/${INC}/timeline`, tokens.rescue_team);
  const reqEvents = (reqTl.body.data || []).filter((e) => e.event_type === "RESCUE_REQUESTED");
  const reqEvent = reqEvents[0];
  check("ping is recorded on the incident timeline", Boolean(reqEvent));
  check(
    "ping records who requested it",
    Boolean(
      reqEvent &&
        reqEvent.performed_by === ACCOUNTS.find((a) => a.role === "user").email
    ),
    reqEvent && reqEvent.performed_by
  );
  check(
    "ping carries the dispatch context (location / device / team)",
    Boolean(
      reqEvent &&
        /location:/.test(reqEvent.notes || "") &&
        /device:/.test(reqEvent.notes || "") &&
        /assigned team:/.test(reqEvent.notes || "")
    ),
    reqEvent && reqEvent.notes
  );
  check(
    "a repeat ping does not duplicate the timeline event",
    reqEvents.length === 1,
    `events=${reqEvents.length}`
  );

  // ── 4. Rescue team assigns ──────────────────────────────────
  console.log("\n── E. RESCUE_TEAM assigns a team ──");
  const teamStatus = await freeTeam(tokens.rescue_team, "RT-01");
  check("RT-01 released to AVAILABLE before assigning", teamStatus === "AVAILABLE", `status=${teamStatus}`);

  const assign = await api(`/incidents/${INC}/assign`, tokens.rescue_team, {
    method: "POST",
    body: JSON.stringify({ team_id: "RT-01" }),
  });
  check("RESCUE_TEAM assigns RT-01 → 200", assign.status === 200, `got ${assign.status}`);
  check("status → ASSIGNED", assign.body.data.status === "ASSIGNED");

  // ── 5. Equipment checklist gates EN_ROUTE ───────────────────
  console.log("\n── F. Pre-departure equipment check ──");
  const rec = await api(`/rescue-equipment/recommendations/${INC}`, tokens.rescue_team);
  check("hazard recommendations returned", rec.status === 200 && rec.body.checklist_items.length > 0);
  check("recommendations carry a disclaimer", /not certified/i.test(rec.body.disclaimer || ""));

  const accept = await api(`/incidents/${INC}/accept`, tokens.rescue_team, { method: "POST", body: "{}" });
  check("mission accepted → ACCEPTED", accept.status === 200 && accept.body.data.status === "ACCEPTED");

  const blocked = await api(`/incidents/${INC}/en-route`, tokens.rescue_team, { method: "POST", body: "{}" });
  check(
    "EN ROUTE blocked while checklist incomplete → 409",
    blocked.status === 409 && blocked.body.code === "EQUIPMENT_CHECK_REQUIRED",
    `got ${blocked.status}`
  );

  const cl = await api(`/rescue-equipment/checklist/${INC}`, tokens.rescue_team);
  const required = cl.body.data.required_items || [];
  check("checklist has required items", required.length > 0);

  const partial = await api(`/rescue-equipment/checklist/${INC}`, tokens.rescue_team, {
    method: "POST",
    body: JSON.stringify({ checked_items: required.slice(0, 1), mark_complete: true }),
  });
  check(
    "cannot fake completion with items outstanding → 400",
    partial.status === 400 && /outstanding|still unchecked/i.test(partial.body.message || ""),
    `got ${partial.status}`
  );

  const inventory = await api("/rescue-equipment", tokens.rescue_team);
  check("equipment inventory readable by RESCUE_TEAM", inventory.status === 200 && inventory.body.count > 0, `count=${inventory.body.count}`);
  check("readiness summary computed", inventory.body.summary && typeof inventory.body.summary.ready_percent === "number");
  check("storage mode is reported", ["supabase", "memory"].includes(inventory.body.storage), inventory.body.storage);

  const avail = (inventory.body.data || []).find((e) => e.status === "AVAILABLE");
  const done = await api(`/rescue-equipment/checklist/${INC}`, tokens.rescue_team, {
    method: "POST",
    body: JSON.stringify({
      checked_items: required,
      mark_complete: true,
      equipment_used: avail ? [{ equipment_id: avail.equipment_id, quantity_used: 1 }] : [],
    }),
  });
  check("full checklist completes → ✅", done.status === 200 && done.body.data.can_go_en_route === true, `status=${done.status}`);

  if (avail) {
    const after = await api(`/rescue-equipment/${avail.equipment_id}`, tokens.rescue_team);
    check("checked-out equipment marked IN_USE", after.body.data.status === "IN_USE", after.body.data.status);
    check("usage recorded against the incident", (after.body.usage || []).some((u) => u.incident_id === INC));

    const returned = await api("/rescue-equipment/return", tokens.rescue_team, {
      method: "POST",
      body: JSON.stringify({ incident_id: INC, equipment_id: avail.equipment_id, condition_after_use: "GOOD" }),
    });
    check("equipment can be returned → AVAILABLE", returned.status === 200 && returned.body.data.status === "AVAILABLE", returned.body.data && returned.body.data.status);
  }

  const depart = await api(`/incidents/${INC}/en-route`, tokens.rescue_team, { method: "POST", body: "{}" });
  check("EN ROUTE allowed once the checklist is complete", depart.status === 200 && depart.body.data.status === "EN_ROUTE", `got ${depart.status}`);

  // ── 6. Mission workflow ─────────────────────────────────────
  console.log("\n── G. Mission workflow ──");
  for (const [endpoint, expected] of [
    ["arrive", "ON_SCENE"],
    ["start-rescue", "RESCUE_IN_PROGRESS"],
    ["person-safe", "PERSON_SAFE"],
    ["resolve", "RESOLVED"],
  ]) {
    const r = await api(`/incidents/${INC}/${endpoint}`, tokens.rescue_team, { method: "POST", body: "{}" });
    check(`RESCUE_TEAM ${endpoint} → ${expected}`, r.status === 200 && r.body.data.status === expected, `got ${r.status}`);
  }

  const skip = await api(`/incidents/${INC}/en-route`, tokens.rescue_team, { method: "POST", body: "{}" });
  check("RESOLVED incident rejects further transitions", skip.status >= 400, `got ${skip.status}`);

  // ── 7. Shared state ─────────────────────────────────────────
  console.log("\n── H. Timeline, history, shared state ──");
  const tl = await api(`/incidents/${INC}/timeline`, tokens.rescue_team);
  const evs = (tl.body.data || []).map((e) => e.event_type);
  for (const ev of ["INCIDENT_DETECTED", "RESCUE_REQUESTED", "TEAM_ASSIGNED", "MISSION_ACCEPTED", "TEAM_EN_ROUTE", "INCIDENT_RESOLVED"]) {
    check(`timeline has ${ev}`, evs.includes(ev));
  }

  const hist = await api("/incidents/history", tokens.rescue_team);
  const row = (hist.body.data || []).find((h) => h.incident_id === INC);
  check("history contains the incident", Boolean(row));
  check("history has real response + resolution times", row && typeof row.response_seconds === "number" && typeof row.resolution_seconds === "number");

  const asUser = await api(`/incidents/${INC}`, tokens.user);
  const asRescue = await api(`/incidents/${INC}`, tokens.rescue_team);
  check("USER and RESCUE_TEAM read the same incident state", asUser.body.data.status === asRescue.body.data.status && asUser.body.data.updated_at === asRescue.body.data.updated_at);

  const stats = await api("/incidents/stats", tokens.rescue_team);
  check("analytics include the incident", stats.body.data && stats.body.data.total_incidents >= 1);

  console.log("\n── I. Existing Avighnaa functionality intact ──");
  const health = await fetch(`${API}/health`);
  check("existing sensor API still responds", health.status < 500, `got ${health.status}`);

  finish();

  async function finish() {
    // Remove the rows this run created. Only the incident ids created above
    // are touched — existing user, worker, rescue-team and incident records
    // are never read for deletion and never modified.
    await cleanupTestIncidents(createdIncidents);

    console.log(`\n${"─".repeat(52)}`);
    if (failed === 0) {
      console.log(`🎉 ALL ${passed} E2E CHECKS PASSED\n`);
      process.exit(0);
    }
    console.log(`❌ ${failed} of ${passed + failed} checks FAILED:`);
    for (const f of failures) console.log(`   • ${f}`);
    console.log("");
    process.exit(1);
  }
})().catch((err) => {
  console.error(`\n❌ E2E crashed: ${err.stack}\n`);
  process.exit(1);
});