/**
 * Guard for the suites that WRITE to the live Supabase database.
 *
 * The rescue suites exercise the real backend against the real cloud
 * database, so running them creates real rows (an incident, its timeline, an
 * equipment checklist, an equipment usage record) and provisions the demo
 * auth accounts. That is fine while actively developing — but it is NOT
 * something to do casually against a live database.
 *
 * Therefore these suites refuse to run unless the operator explicitly opts
 * in:
 *
 *   node test/rescue.e2e.js --live        (or: ALLOW_LIVE_DB_WRITES=1)
 *
 * The default `npm test` therefore only runs the read-only, static
 * DOM-contract check. The write-capable suites are reachable through
 * `npm run test:live`.
 */
function requireLiveDbWrite(suiteName) {
  const allowed =
    process.argv.includes("--live") ||
    process.env.ALLOW_LIVE_DB_WRITES === "1";

  if (allowed) return true;

  console.log(
    `\n⛔ ${suiteName} SKIPPED — it WRITES to the live Supabase database.\n` +
      `   Re-run it deliberately with:  node test/${suiteName} --live\n` +
      `   (or set ALLOW_LIVE_DB_WRITES=1)\n`
  );
  process.exit(2);
}

module.exports = { requireLiveDbWrite };
