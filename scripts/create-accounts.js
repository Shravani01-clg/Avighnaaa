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

const ACCOUNTS = [
  {
    label: "Rescue team",
    email: process.env.RESCUE_TEAM_EMAIL || "rescue.team@avighnaa.com",
    password: process.env.RESCUE_TEAM_PASSWORD || "Rescue@2026",
    role: "rescue_team",
    team: process.env.RESCUE_TEAM_ID || "RT-01",
  },
  {
    label: "Control-room user",
    email: process.env.CONTROL_USER_EMAIL || "controlroom.user@rockfall.com",
    password: process.env.CONTROL_USER_PASSWORD || "User@2026",
    role: "user",
    team: null,
  },
];

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
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify({
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
    console.log(`   ✅ auth user ${found ? "updated" : "created"}`);
    console.log(`   email         ${user.email}`);
    console.log(`   password      ${acc.password}`);
    console.log(`   role          ${acc.role}${acc.team ? `  (team ${acc.team})` : ""}`);
    console.log(`   profile row   ${profileOk ? "synced" : "skipped (JWT metadata still applies)"}`);
  }

  console.log(
    "\n   The existing admin account (controlroom@rockfall.com) was not modified.\n"
  );
})().catch((err) => {
  console.error(`\n❌ ${err.message}\n`);
  process.exit(1);
});
