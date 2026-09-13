require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

// Lazy client creation: building the client eagerly with missing env vars
// throws at require-time and crashes the whole server. With lazy creation,
// config/dataStore.js's checkSupabase() catches the failure and falls back
// to in-memory storage — the documented no-credentials mode.
let _client = null;

function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    );
  }
  return _client;
}

// Proxy so callers can keep using `supabase.from(...)` unchanged.
// The real client is only constructed on first actual use.
module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = getClient();
      const value = client[prop];
      return typeof value === "function" ? value.bind(client) : value;
    },
  }
);
