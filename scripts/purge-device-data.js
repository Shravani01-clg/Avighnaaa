/**
 * Purge every piece of TELEMETRY a device has produced from the live
 * database: its incidents (with timeline, equipment checklists, usage rows
 * and equipment events), alerts, sensor readings and risk predictions.
 *
 * This exists to keep the system free of simulated data: the sensor simulator
 * (since removed from this project) wrote real rows against a device id —
 * RF-001 by default — and any such rows would then show up in the dashboard,
 * the rescue console and analytics as if they were genuine emergencies.
 * Works for any device id.
 *
 * What is NEVER touched (registry/configuration, not simulated data):
 *   devices, device_locations, workers, rescue_teams, rescue_equipment,
 *   profiles/accounts.
 *
 * Incident-row deletion reuses the test suites' cleanup helper, which
 * respects the ON DELETE SET NULL order (equipment_usage first).
 * The notifications feed is not touched: that table only exists in
 * memory until migration 008 runs, and a server restart clears it.
 *
 * Usage:
 *   node scripts/purge-device-data.js                  # RF-001
 *   node scripts/purge-device-data.js --device RF-002
 *   node scripts/purge-device-data.js --dry-run        # counts only, no writes
 */

require("dotenv").config();

const { cleanupTestIncidents } = require("../test/cleanup");

const DEVICE_TABLES = [
  ["alerts", "id"],
  ["sensor_readings", "id"],
  ["risk_predictions", "id"],
  ["device_commands", "id"],
];

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { createClient } = require("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function parseArgs(argv) {
  const args = { device: "RF-001", dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--device" && argv[i + 1]) args.device = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function countAll(sb, device) {
  const counts = {};
  for (const [table, col] of DEVICE_TABLES) {
    const { count, error } = await sb
      .from(table)
      .select(col, { count: "exact", head: true })
      .eq("device_id", device);
    counts[table] = error ? `ERR ${error.message}` : count;
  }
  const inc = await sb
    .from("incidents")
    .select("incident_id, status")
    .eq("device_id", device);
  counts.incidents = inc.error ? `ERR ${inc.error.message}` : inc.data;
  return counts;
}

async function main() {
  const { device, dryRun } = parseArgs(process.argv);
  const sb = getServiceClient();
  if (!sb) {
    console.error("❌ No SUPABASE_URL / SUPABASE_SECRET_KEY in .env — nothing purged.");
    process.exit(1);
  }

  console.log(`\n── Purge telemetry for device ${device} ${dryRun ? "(DRY RUN)" : ""} ──`);
  const before = await countAll(sb, device);
  console.log("before:", JSON.stringify(before));

  const incidents = Array.isArray(before.incidents) ? before.incidents : [];
  if (incidents.length === 0 && !Object.values(before).some((v) => typeof v === "number" && v > 0)) {
    console.log("✓ nothing to purge for this device.");
    return;
  }

  if (dryRun) {
    console.log("\n(dry run — no rows deleted)");
    return;
  }

  // 1. Incidents + everything hanging off them (exact ids only).
  if (incidents.length > 0) {
    const ids = incidents.map((i) => i.incident_id);
    const { removed, errors } = await cleanupTestIncidents(ids, { log: false });
    const total = Object.values(removed).reduce((a, b) => a + b, 0);
    console.log(
      `🧹 incidents ${ids.join(", ")} — removed ${total} row(s) ` +
        `(incidents ${removed.incidents}, timeline ${removed.incident_events}, ` +
        `checklists ${removed.equipment_checklists}, usage ${removed.equipment_usage}, ` +
        `equipment events ${removed.equipment_events})`
    );
    errors.forEach((e) => console.log(`   ⚠️  ${e}`));
  }

  // 2. Device-scoped telemetry.
  for (const [table, col] of DEVICE_TABLES) {
    const { data, error } = await sb
      .from(table)
      .delete()
      .eq("device_id", device)
      .select(col);
    if (error) console.log(`   ⚠️  ${table}: ${error.message}`);
    else console.log(`   ${table}: removed ${(data || []).length} row(s)`);
  }

  const after = await countAll(sb, device);
  console.log("after: ", JSON.stringify(after));
  console.log("✓ purge complete (registries untouched).");
}

main().catch((err) => {
  console.error(`❌ purge failed: ${err.message}`);
  process.exit(1);
});
