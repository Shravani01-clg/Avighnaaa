/**
 * The demo accounts used by the provisioning script and the test suites.
 *
 * IMPORTANT: the PASSWORDS are deliberately not stored in the repository.
 * They live in `.env` (which is gitignored), so pushing this code can never
 * publish a working credential. The addresses and the role/team mapping
 * are public information — the secrets are not.
 *
 * Required in `.env`:
 *   RESCUE_TEAM_EMAIL=rescue.team@avighnaa.com
 *   RESCUE_TEAM_PASSWORD=<the password that works>
 *   CONTROL_USER_EMAIL=admin@gmail.com
 *   CONTROL_USER_PASSWORD=<the password that works>
 */

/** Reads a required environment variable, or stops with a clear message. */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `\n❌ ${name} is not set.\n` +
        `   Account passwords are intentionally not stored in this repository.\n` +
        `   Add ${name}=<value> to .env (gitignored) and try again.\n`
    );
    process.exit(2);
  }
  return value;
}

function buildAccounts() {
  return [
    {
      label: "Rescue team",
      email: process.env.RESCUE_TEAM_EMAIL || "rescue.team@avighnaa.com",
      password: requireEnv("RESCUE_TEAM_PASSWORD"),
      passwordEnv: "RESCUE_TEAM_PASSWORD",
      role: "rescue_team",
      team: process.env.RESCUE_TEAM_ID || "RT-01",
    },
    {
      label: "Control-room user",
      email: process.env.CONTROL_USER_EMAIL || "admin@gmail.com",
      password: requireEnv("CONTROL_USER_PASSWORD"),
      passwordEnv: "CONTROL_USER_PASSWORD",
      role: "user",
      team: null,
    },
  ];
}

module.exports = { requireEnv, buildAccounts };
