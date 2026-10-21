require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

async function main() {
  // The password is read from .env — it is never stored in this repository.
  const password = process.env.RESCUE_TEAM_PASSWORD;
  if (!password) {
    console.error(
      "\n❌ RESCUE_TEAM_PASSWORD is not set — add it to .env (gitignored) and run again.\n"
    );
    process.exit(1);
  }

  const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  const target = (listed.data?.users || []).find(
    (u) =>
      String(u.email || "").toLowerCase() ===
      String(
        process.env.RESCUE_TEAM_EMAIL || "rescue.team@avighnaa.com"
      ).toLowerCase()
  );

  if (!target) {
    console.error("\n❌ Rescue team account not found.\n");
    process.exit(1);
  }

  const { data, error } = await supabase.auth.admin.updateUserById(
    target.id,
    { password }
  );

  if (error) {
    console.error("❌ Failed:", error.message);
    process.exit(1);
  }

  console.log("✅ Rescue password updated successfully!");
  console.log("Email:", data.user.email);
}

main();