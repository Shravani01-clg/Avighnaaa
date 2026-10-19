/**
 * Helpers for the rescue equipment subsystem.
 *
 * Two jobs:
 *  1. normaliseJson — Supabase returns jsonb parsed, the in-memory fallback
 *     and some driver paths return a JSON string.
 *  2. Table availability — the equipment tables are created by
 *     migrations/006_two_roles_and_equipment.sql. Until that file is run in
 *     the Supabase SQL Editor the tables do not exist, so equipment calls
 *     fall back to memory. The fallback is ALWAYS reported in the API
 *     response as storage:"memory" so demo data is never passed off as
 *     persisted database rows.
 */

const store = require("../config/dataStore");

const MEMORY_TABLES = {
  rescue_equipment: [],
  equipment_checklists: [],
  equipment_usage: [],
  equipment_events: [],
};

// Starter inventory used ONLY when the equipment tables do not exist yet
// (i.e. migrations/006 has not been run). It is returned with
// storage:"memory" so it is never mistaken for persisted data.
(function seedMemoryInventory() {
  const d = (offset) => {
    const t = new Date();
    t.setDate(t.getDate() + offset);
    return t.toISOString().slice(0, 10);
  };
  const items = [
    ["FE-01", "Fire Extinguisher", "PROTECTION", 4, "AVAILABLE", "GOOD", "Station Bay 1", -30, 60],
    ["GM-01", "Gas Mask", "PROTECTION", 3, "AVAILABLE", "GOOD", "Station Bay 1", -25, 35],
    ["GM-02", "Gas Mask (spare)", "PROTECTION", 1, "MAINTENANCE", "FAIR", "Workshop", -90, 5],
    ["FA-01", "First Aid Kit", "MEDICAL", 3, "AVAILABLE", "GOOD", "Clinic", -20, 70],
    ["FA-02", "Stretcher", "MEDICAL", 1, "AVAILABLE", "GOOD", "Clinic", -45, 45],
    ["RR-01", "Rescue Rope (30m)", "RESCUE", 2, "AVAILABLE", "GOOD", "Equipment Bay", -15, 75],
    ["ER-01", "Emergency Radio", "COMMS", 4, "AVAILABLE", "GOOD", "Control Room", -10, 80],
    ["FL-01", "Flashlight (high lumen)", "LIGHTING", 6, "AVAILABLE", "GOOD", "Equipment Bay", -60, 30],
    ["HS-01", "Safety Helmet", "PROTECTION", 6, "AVAILABLE", "GOOD", "Equipment Bay", -50, 40],
    ["LS-01", "Life Jacket", "WATER", 3, "IN_USE", "GOOD", "Pump House", -35, 55],
    ["WT-01", "Water Rescue Paddle", "WATER", 2, "AVAILABLE", "GOOD", "Pump House", -28, 62],
    ["MS-01", "Multi-gas Monitor", "COMMS", 1, "DAMAGED", "POOR", "Workshop", -120, -10],
  ];
  MEMORY_TABLES.rescue_equipment = items.map((r, i) => ({
    id: `mem-eq-${i + 1}`,
    equipment_id: r[0],
    equipment_name: r[1],
    equipment_type: r[2],
    quantity: r[3],
    status: r[4],
    condition: r[5],
    location: r[6],
    last_inspection_date: d(r[7]),
    next_inspection_date: d(r[8]),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
})();

let warned = false;

function looksLikeMissingTable(err) {
  const code = err && (err.code || "");
  const msg = String((err && err.message) || "");
  return (
    code === "PGRST205" || // PostgREST: table not in schema cache
    code === "42P01" || // Postgres: relation does not exist
    /does not exist|not found in the schema cache/i.test(msg)
  );
}

async function tableExists(table) {
  try {
    await store.select(table, { limit: 1 });
    return true;
  } catch (err) {
    if (looksLikeMissingTable(err)) {
      if (!warned) {
        warned = true;
        console.warn(
          `\n⚠️  Equipment tables are not in the database yet.\n` +
            `   Running migrations/006_two_roles_and_equipment.sql in the Supabase SQL Editor\n` +
            `   creates them. Until then equipment data is held in MEMORY and is lost on\n` +
            `   restart (API responses report storage:"memory").\n`
        );
      }
      return false;
    }
    throw err;
  }
}

let storageMode = null;

/** "supabase" once the tables exist, otherwise "memory". */
async function storage() {
  if (!storageMode) {
    storageMode = (await tableExists("rescue_equipment")) ? "supabase" : "memory";
  }
  return storageMode;
}

// ── Memory-backed CRUD with the same shape as dataStore ────────

let seq = 1;

const memory = {
  async insert(table, record) {
    const rows = MEMORY_TABLES[table] || (MEMORY_TABLES[table] = []);
    const entry = { id: `mem-${seq++}`, ...record };
    rows.push(entry);
    return [entry];
  },
  async select(table, { filters = {}, orderBy = null, limit = 50 } = {}) {
    let rows = [...(MEMORY_TABLES[table] || [])];
    for (const [key, value] of Object.entries(filters)) {
      rows = rows.filter((r) => r[key] === value);
    }
    if (orderBy) rows.sort((a, b) => (a[orderBy] < b[orderBy] ? -1 : 1));
    return rows.slice(0, limit);
  },
  async update(table, match, updates) {
    const rows = MEMORY_TABLES[table] || [];
    const hit = rows.find((r) => Object.entries(match).every(([k, v]) => r[k] === v));
    if (!hit) return [];
    Object.assign(hit, updates);
    return [hit];
  },
};

/**
 * Use the real Supabase tables when they exist, otherwise memory.
 * Errors that are NOT "table missing" are re-thrown so genuine faults stay
 * visible instead of being swallowed into memory.
 */
async function eq(method, table, ...args) {
  const useMemory = (await storage()) === "memory";
  const target = useMemory ? memory[method].bind(memory, table) : store[method].bind(store, table);
  try {
    return await target(...args);
  } catch (err) {
    if (useMemory || !looksLikeMissingTable(err)) throw err;
    storageMode = "memory";
    console.warn(
      `⚠️  ${table} appeared missing mid-request — falling back to memory for this call.`
    );
    return memory[method](table, ...args);
  }
}

function normaliseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

module.exports = { normaliseJson, eq, storage, MEMORY_TABLES };