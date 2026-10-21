/**
 * Provision the Avighnaa demo accounts for all three roles.
 *
 * Idempotent — safe to run more than once. Uses the service-role key, so it
 * needs NO SQL editor, NO password-reset email and NO dashboard clicking.
 *
 * Run:  node scripts/create-accounts.js
 *
 * Why app_metadata: middleware/roleMiddleware.js resolves the role from
 * user.app_metadata.role (part of the verified JWT) before it looks at the
 * profiles table. So the role is enforced server-side as soon as this script
 * finishes — no SQL and no profile row required.
 *
 * The existing control-room admin (controlroom@rockfall.com) is NOT touched.
 */
require("dotenv").config();

const { buildAccounts } = require("./accounts");

// Passwords come from .env only — they are never stored in this repository.
const ACCOUNTS = buildAccounts();

// An EXISTING account keeps its password unless the operator asks for a
// reset: rewriting it would silently override the password the operator set
// in the Supabase dashboard and invalidate every live session.
const RESET_PASSWORD = process.argv.includes("--reset-password");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "\n❌ SUPABASE_URL / SUPABASE_SECRET_KEY missing from .env — add them and run again.\n"
  );
  process.exit(1);
}

const adminHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
});

async function listUsers() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error(`admin list failed (${res.status}): ${await res.text()}`);
  return (await res.json()).users || [];
}

async function createUser(acc) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      email: acc.email,
      password: acc.password,
      email_confirm: true,
      app_metadata: acc.team ? { role: acc.role, team_id: acc.team } : { role: acc.role },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${acc.email}: ${body.msg || body.message || res.statusText}`);
  }
  return body;
}

async function updateUser(id, acc) {
  // Password is only sent when the operator explicitly asked for a reset.
  const payload = {
    email_confirm: true,
    app_metadata: acc.team ? { role: acc.role, team_id: acc.team } : { role: acc.role },
  };
  if (RESET_PASSWORD) {
    payload.password = acc.password;
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${acc.email}: ${body.msg || body.message || res.statusText}`);
  }
  return body;
}

async function syncProfile(user, acc) {
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb
    .from("profiles")
    .upsert(
      {
        id: user.id, // real uuid from auth.users — never a placeholder
        email: user.email,
        role: acc.role,
        team_id: acc.role === "rescue_team" ? acc.team : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
  return !error;
}

(async () => {
  const existing = await listUsers();

  for (const acc of ACCOUNTS) {
    const target = acc.email.trim().toLowerCase();
    const found = existing.find(
      (u) => String(u.email || "").trim().toLowerCase() === target
    );

    const user = found
      ? await updateUser(found.id, acc)
      : await createUser(acc);

    const profileOk = await syncProfile(user, acc);

    console.log(`\n   ${acc.label}`);
    console.log(`   ${found ? "✅ auth user updated" : "✅ auth user created"}`);
    if (found && RESET_PASSWORD) {
      console.log(
        `   ⚠️  the password of this EXISTING account was RESET to the value below ` +
          `(and every live session for it was invalidated)`
      );
    } else if (found) {
      console.log(
        `   ℹ️  the existing password was KEPT (re-run with --reset-password to change it)`
      );
    }
    console.log(`   email         ${user.email}`);
    console.log(`   role          ${acc.role}${acc.team ? `  (team ${acc.team})` : ""}`);
    console.log(`   profile row   ${profileOk ? "synced" : "skipped (JWT metadata still applies)"}`);
  }

  console.log(
    `\n   Passwords are read from .env and are never stored in this repository.\n` +
      (RESET_PASSWORD
        ? `   (--reset-password was used: existing accounts had their password reset)\n`
        : `   Add --reset-password if you really want to overwrite an existing password.\n`)
  );
})().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
