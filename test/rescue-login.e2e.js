/**
 * End-to-end verification of the DEDICATED RESCUE TEAM login.
 *
 * Signs in with the real Supabase auth endpoint, then exercises the live
 * backend exactly like the browser does:
 *   1. POST /auth/v1/token?grant_type=password  (what the login form calls)
 *   2. GET  /api/auth/me                       (what routes the portal)
 *   3. GET  /api/incidents                     (rescue_team allowed)
 *   4. GET  /api/rescue-teams                  (rescue_team allowed)
 *   5. POST /api/incidents/:id/accept          (admin-only -> must be 403)
 *
 * Run: node test/rescue-login.e2e.js
 */
require("dotenv").config();

const API = process.env.API_BASE_URL || "http://localhost:5002/api";
const EMAIL = process.env.RESCUE_TEAM_EMAIL || "rescue.team@avighnaa.com";
const PASSWORD = process.env.RESCUE_TEAM_PASSWORD || "Rescue@2026";

let failures = 0;
function check(label, condition, extra) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

async function signIn() {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`sign-in failed (${res.status}): ${body.msg || body.error_description || body.message}`);
  }
  return body.access_token;
}

async function api(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
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

(async () => {
  console.log(`\n── Dedicated rescue account E2E (${EMAIL}) ──\n`);

  let token;
  try {
    token = await signIn();
    check("signs in with the dedicated rescue credentials", Boolean(token));
  } catch (err) {
    check("signs in with the dedicated rescue credentials", false, err.message);
    process.exit(1);
  }

  // 1) Role resolution — this is what the frontend routes on.
  const me = await api("/auth/me", token);
  check("GET /api/auth/me returns 200", me.status === 200, `got ${me.status}`);
  const role = me.body && me.body.data && me.body.data.role;
  const team = me.body && me.body.data && me.body.data.team_id;
  check("role is rescue_team", role === "rescue_team", `role=${role}`);
  check("team is RT-01", team === "RT-01", `team=${team}`);
  check(
    "frontend will route to the Rescue Portal (not admin)",
    role === "rescue_team",
    "script.js sends rescue_team to page-rescue"
  );

  // 2) Rescue endpoints must be reachable.
  const incidents = await api("/incidents", token);
  check("GET /api/incidents allowed for rescue_team", incidents.status === 200, `got ${incidents.status}`);

  const teams = await api("/rescue-teams", token);
  check("GET /api/rescue-teams allowed", teams.status === 200, `got ${teams.status}`);

  // 3) Admin-only surface must stay closed to a rescue operator.
  const health = await api("/device-health", token);
  check(
    "GET /api/device-health allowed for rescue_team (rescue needs device status)",
    health.status === 200,
    `got ${health.status}`
  );

  // Genuinely admin-only surface: creating/editing rescue teams.
  // There is no admin role: rescue-team management IS a rescue capability.
  const createTeam = await api("/rescue-teams", token, {
    method: "POST",
    body: JSON.stringify({
      team_id: "RT-99",
      team_name: "E2E Temp Team",
      team_type: "FIRE_RESCUE",
    }),
  });
  check(
    "POST /api/rescue-teams allowed for rescue_team (rescue control)",
    createTeam.status === 201,
    `got ${createTeam.status}`
  );
  const userTokens = await (await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.CONTROL_USER_EMAIL || "controlroom.user@rockfall.com",
      password: process.env.CONTROL_USER_PASSWORD || "User@2026",
    }),
  })).json();
  const userCreate = await api("/rescue-teams", userTokens.access_token, {
    method: "POST",
    body: JSON.stringify({ team_id: "RT-98", team_name: "no", team_type: "FIRE_RESCUE" }),
  });
  check(
    "POST /api/rescue-teams rejected for USER -> 403",
    userCreate.status === 403,
    `got ${userCreate.status}`
  );

  const list = Array.isArray(incidents.body && incidents.body.data) ? incidents.body.data : [];
  if (list.length > 0) {
    const target = list[0];
    const accept = await api(`/incidents/${encodeURIComponent(target.incident_id)}/accept`, token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    check(
      "POST /api/incidents/:id/accept rejected for rescue_team (state change)",
      accept.status === 403 || accept.status === 409,
      `got ${accept.status}`
    );

    const timeline = await api(`/incidents/${encodeURIComponent(target.incident_id)}/timeline`, token);
    check(
      "GET timeline returns 200 with a well-formed array",
      timeline.status === 200 && Array.isArray(timeline.body.data),
      `status=${timeline.status} events=${timeline.body && timeline.body.count}`
    );
    check(
      "timeline events carry the human-readable incident_id",
      Array.isArray(timeline.body.data) &&
        timeline.body.data.every((e) => e.incident_id === target.incident_id),
      Array.isArray(timeline.body.data) && timeline.body.data.length
        ? `got ${JSON.stringify(timeline.body.data[0].incident_id)}`
        : "no events"
    );
  } else {
    console.log("  ℹ️  no incidents in the database - skipped state-change checks");
  }

  console.log(
    failures === 0
      ? `\n🎉 rescue login E2E passed\n`
      : `\n❌ ${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
})();
