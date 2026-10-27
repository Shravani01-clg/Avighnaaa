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
 *     response as storage:"memory", and memory mode starts EMPTY — no demo
 *     inventory is ever fabricated to fill the pages.
 */

const store = require("../config/dataStore");

const MEMORY_TABLES = {
  rescue_equipment: [],
  equipment_checklists: [],
  equipment_usage: [],
  equipment_events: [],
};

// NOTE: nothing is ever pre-seeded here. Until migration 006 is run the
// memory tables stay EMPTY — the API reports storage:"memory" and the
// equipment pages show "no records yet" rather than fabricated demo items.
// Inventory rows only ever come from the database (or rows the rescue
// team itself enters during a memory-mode session).

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
            `   creates them. Until then the equipment API runs from MEMORY with NO seeded\n` +
            `   inventory (responses report storage:"memory") — enter real items in the UI or\n` +
            `   run the migration.\n`
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