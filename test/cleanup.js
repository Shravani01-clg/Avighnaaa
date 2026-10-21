/**
 * Deterministic cleanup for records a test created.
 *
 * The suites write REAL rows to the live Supabase database (an incident, its
 * timeline, an equipment checklist, an equipment usage row and the equipment
 * events for it). Leaving them behind pollutes exactly the data the rescue
 * team works from — and a stale open incident also keeps a rescue team BUSY,
 * which breaks the next test run.
 *
 * This helper removes ONLY the rows a test created:
 *   - it is given the exact incident ids the test created;
 *   - it never scans for "old" rows, never touches incidents it was not
 *     given, and never modifies existing user, worker, rescue-team or
 *     incident records.
 *
 * Deletion order matters:
 *   equipment_usage.incident_id is ON DELETE SET NULL, so the usage rows
 *   have to be removed first or they would survive as orphans.
 *
 * Cleanup failures are reported but never fail the test run.
 */

const TEST_DEVICE_PREFIXES = ["E2E-DEV-", "TEST-DEV-", "ESCALATION-PROOF-"];

/** Device ids that belong to a test/verification run. */
function isTestDevice(deviceId) {
  const id = String(deviceId || "");
  return TEST_DEVICE_PREFIXES.some((p) => id.startsWith(p));
}

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
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
 * Remove the incident (and its dependent rows) for each id given.
 *
 * @param {string[]} incidentIds exact incident ids created by the test
 * @param {{log?: boolean}} [options]
 * @returns {Promise<{removed: object, errors: string[], skipped: boolean}>}
 */
async function cleanupTestIncidents(incidentIds, options = {}) {
  const log = options.log !== false;
  const ids = [...new Set((incidentIds || []).filter(Boolean))];
  const removed = { equipment_usage: 0, equipment_events: 0, equipment_checklists: 0, incident_events: 0, incidents: 0 };
  const errors = [];

  if (ids.length === 0) return { removed, errors, skipped: false };

  const sb = getServiceClient();
  if (!sb) {
    const msg = "no Supabase service key — test records were NOT cleaned up";
    if (log) console.log(`\n⚠️  ${msg}`);
    return { removed, errors: [msg], skipped: true };
  }

  for (const id of ids) {
    try {
      // 1. equipment usage rows would survive the incident (ON DELETE SET NULL)
      const usage = await sb
        .from("equipment_usage")
        .delete()
        .eq("incident_id", id)
        .select("id");
      removed.equipment_usage += (usage.data || []).length;

      // 2. equipment events carry the incident id in their notes
      for (const eventType of ["CHECKED_OUT", "RETURNED"]) {
        const { data: candidates } = await sb
          .from("equipment_events")
          .select("id,notes")
          .eq("event_type", eventType);
        const exact = (candidates || []).filter((row) =>
          new RegExp(`\\b${id}\\b`).test(String(row.notes || ""))
        );
        for (const row of exact) {
          const del = await sb.from("equipment_events").delete().eq("id", row.id);
          removed.equipment_events += (del.data || []).length;
        }
      }

      // 3. checklist + timeline rows (both cascade with the incident)
      const cl = await sb
        .from("equipment_checklists")
        .delete()
        .eq("incident_id", id)
        .select("id");
      removed.equipment_checklists += (cl.data || []).length;

      const ev = await sb
        .from("incident_events")
        .delete()
        .eq("incident_id", id)
        .select("id");
      removed.incident_events += (ev.data || []).length;

      // 4. the incident itself
      const inc = await sb
        .from("incidents")
        .delete()
        .eq("incident_id", id)
        .select("incident_id");
      removed.incidents += (inc.data || []).length;
    } catch (err) {
      errors.push(`${id}: ${err.message}`);
    }
  }

  if (log) {
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    console.log(
      `\n🧹 Test cleanup: removed ${total} row(s) for ${ids.join(", ")} ` +
        `(incidents ${removed.incidents}, timeline ${removed.incident_events}, ` +
        `checklists ${removed.equipment_checklists}, usage ${removed.equipment_usage}, ` +
        `equipment events ${removed.equipment_events})`
    );
    errors.forEach((e) => console.log(`   ⚠️  cleanup error — ${e}`));
  }

  return { removed, errors, skipped: false };
}

module.exports = { cleanupTestIncidents, isTestDevice, TEST_DEVICE_PREFIXES };
