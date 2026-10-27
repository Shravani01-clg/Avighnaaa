/**
 * Release rescue teams that are marked BUSY but have no active incident.
 *
 * Why this exists: assigning a team flips rescue_teams.status to BUSY, and
 * only a RESOLVED / CANCELLED transition flips it back to AVAILABLE. Test
 * cleanup deletes its incident rows directly (bypassing the state machine),
 * which can leave a team stuck BUSY and break the next run's pre-conditions.
 * This helper repairs exactly that — it NEVER touches a team that still has
 * an active incident, and it reports every change it makes.
 *
 * Run:      node test/release-teams.js
 * Or use:   const { releaseIdleTeams } = require("./release-teams");
 */

require("dotenv").config();

const ACTIVE_STATUSES = [
  "AWAITING_RESPONSE", "ASSIGNED", "ACCEPTED", "EN_ROUTE",
  "ON_SCENE", "RESCUE_IN_PROGRESS", "PERSON_SAFE", "ESCALATED",
];

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}

/**
 * Flip BUSY → AVAILABLE for every team with no active incident.
 * Returns the list of released team ids (empty when nothing needed it).
 */
async function releaseIdleTeams() {
  const sb = getServiceClient();
  if (!sb) return [];

  const { data: teams, error: teamErr } = await sb
    .from("rescue_teams")
    .select("team_id, status");
  if (teamErr || !teams) return [];

  const busy = teams.filter((t) => String(t.status || "").toUpperCase() === "BUSY");
  if (busy.length === 0) return [];

  const { data: active, error: incErr } = await sb
    .from("incidents")
    .select("assigned_team_id")
    .in("status", ACTIVE_STATUSES)
    .not("assigned_team_id", "is", null);
  if (incErr) return [];

  const busyWithWork = new Set((active || []).map((i) => i.assigned_team_id));
  const released = [];

  for (const t of busy) {
    if (busyWithWork.has(t.team_id)) continue; // genuinely on a mission
    const { error } = await sb
      .from("rescue_teams")
      .update({ status: "AVAILABLE", updated_at: new Date().toISOString() })
      .eq("team_id", t.team_id);
    if (!error) released.push(t.team_id);
  }

  return released;
}

module.exports = { releaseIdleTeams, ACTIVE_STATUSES };

if (require.main === module) {
  releaseIdleTeams()
    .then((released) => {
      console.log(
        released.length
          ? `🔧 Released idle team(s): ${released.join(", ")} → AVAILABLE`
          : "✓ No idle BUSY teams — nothing to release"
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(`❌ release-teams failed: ${err.message}`);
      process.exit(1);
    });
}
