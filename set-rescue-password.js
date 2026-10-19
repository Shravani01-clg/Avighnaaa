require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

async function main() {
  const { data, error } = await supabase.auth.admin.updateUserById(
    "ef560517-ae38-48d2-8598-9c2fd90d337e",
    {
      password: "Rescue@12345"
    }
  );

  if (error) {
    console.error("❌ Failed:", error.message);
    process.exit(1);
  }

  console.log("✅ Rescue password updated successfully!");
  console.log("Email:", data.user.email);
}

main();