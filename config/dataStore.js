/**
 * Data Store
 *
 * Abstraction layer that tries Supabase first.
 * If Supabase isn't configured or fails, falls back to in-memory storage.
 *
 * This lets the entire backend work without any database credentials.
 */

const supabase = require("./supabase");

// ─── In-Memory Storage ───────────────────────────────────────

const memoryStore = {
  sensor_readings: [],
  risk_predictions: [],
  alerts: [],
  devices: [
    { device_id: "SIM-DEVICE-001", name: "Simulated Device 1", location: "Test Mine", created_at: new Date().toISOString() },
  ],
  workers: [
    { id: 1, name: "Test Worker", role: "Miner", created_at: new Date().toISOString() },
  ],
};

let _id = 1;
function nextId() { return _id++; }

// ─── Supabase Health Check (cached) ─────────────────────────

let supabaseAvailable = null; // null = not checked yet

async function checkSupabase() {
  if (supabaseAvailable !== null) return supabaseAvailable;

  try {
    const { error } = await supabase.from("sensor_readings").select("id").limit(1);
    supabaseAvailable = !error;
    if (supabaseAvailable) {
      console.log("✅ Supabase connected — using cloud database");
    } else {
      console.log("⚠️  Supabase not configured — using in-memory storage");
      console.log("   (Data will be lost when server restarts)");
    }
  } catch {
    supabaseAvailable = false;
    console.log("⚠️  Supabase not available — using in-memory storage");
  }

  return supabaseAvailable;
}

// ─── Generic CRUD Operations ─────────────────────────────────

async function insert(table, record) {
  const usesSupabase = await checkSupabase();

  if (usesSupabase) {
    const { data, error } = await supabase.from(table).insert([record]).select();
    if (error) throw error;
    return data;
  }

  // In-memory fallback
  const entry = { id: nextId(), ...record, created_at: new Date().toISOString() };
  memoryStore[table] = memoryStore[table] || [];
  memoryStore[table].push(entry);
  return [entry];
}

async function select(table, { filters = {}, orderBy = null, limit = 50 } = {}) {
  const usesSupabase = await checkSupabase();

  if (usesSupabase) {
    let query = supabase.from(table).select("*");

    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }

    if (orderBy) {
      query = query.order(orderBy, { ascending: false });
    }

    query = query.limit(limit);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  // In-memory fallback
  let rows = memoryStore[table] || [];

  for (const [key, value] of Object.entries(filters)) {
    rows = rows.filter((r) => r[key] === value);
  }

  if (orderBy) {
    rows = [...rows].sort((a, b) => new Date(b[orderBy]) - new Date(a[orderBy]));
  }

  return rows.slice(0, limit);
}

async function update(table, filters, updates) {
  const usesSupabase = await checkSupabase();

  if (usesSupabase) {
    let query = supabase.from(table).update(updates);
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }
    const { data, error } = await query.select();
    if (error) throw error;
    return data;
  }

  // In-memory fallback
  const rows = memoryStore[table] || [];
  let updated = [];
  for (const row of rows) {
    const matches = Object.entries(filters).every(([k, v]) => {
      // Handle type coercion for ID fields (string URL param vs number in store)
      if (row[k] == v) return true; // loose equality catches string/number mismatch
      return row[k] === v;
    });
    if (matches) {
      Object.assign(row, updates);
      updated.push(row);
    }
  }
  return updated;
}

module.exports = {
  insert,
  select,
  update,
  checkSupabase,
  // Direct access for simple reads in other controllers
  get memoryStore() { return memoryStore; },
};
