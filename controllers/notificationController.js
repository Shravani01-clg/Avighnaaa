/**
 * Notification Controller
 *
 * A tiny role-addressed notification feed that connects the two
 * AVIGHNAA logins:
 *
 *   audience "user"        → the control-room / admin dashboard
 *   audience "rescue_team" → the rescue portal
 *
 * Notifications are written by the rescue workflow (see
 * controllers/incidentController.js):
 *   - the rescue login assigns / reassigns a team → control room is told
 *   - the control room raises a rescue request    → rescue portal is told
 *
 * Rules:
 *   - createNotification() NEVER throws. A notification failure must
 *     never break a rescue action or a rescue request.
 *   - Availability-aware storage, exactly like equipmentHelpers: the
 *     notifications table is created by migrations/008. Until that file
 *     is run in the Supabase SQL Editor the feed falls back to MEMORY
 *     (works within one server run; lost on restart) and every list
 *     response reports storage:"memory" so it is never passed off as
 *     persisted database rows. Once migration 008 is run, the backend
 *     picks up the table automatically — no code change, no restart
 *     logic beyond the next probe.
 *   - The frontend polls; there is no socket layer. Delivery is
 *     "eventually consistent" within one poll interval.
 *   - Read state is per-audience, not per-user: a control room runs one
 *     shared console, so one unread badge is the honest model.
 */

const store = require("../config/dataStore");

// Matches roleMiddleware VALID_ROLES — the two AVIGHNAA logins.
const AUDIENCES = ["user", "rescue_team"];

const NOTIFICATION_LIMIT = 50;

// ─── Availability-aware storage (same contract as equipmentHelpers) ──

const MEMORY_ROWS = [];
let storageMode = null; // null = not probed yet
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

/** "supabase" once migration 008 has been run, otherwise "memory". */
async function storage() {
  if (storageMode) return storageMode;
  try {
    await store.select("notifications", { limit: 1 });
    storageMode = "supabase";
  } catch (err) {
    if (!looksLikeMissingTable(err)) throw err;
    storageMode = "memory";
  }
  if (storageMode === "memory" && !warned) {
    warned = true;
    console.warn(
      `\n⚠️  The notifications table is not in the database yet.\n` +
        `   Running migrations/008_notifications.sql in the Supabase SQL Editor\n` +
        `   creates it. Until then the feed works from MEMORY (one server run,\n` +
        `   lost on restart) — API responses report storage:"memory".\n`
    );
  }
  return storageMode;
}

let seq = 1;

const memory = {
  async insert(record) {
    const entry = { id: `mem-notif-${seq++}`, ...record };
    MEMORY_ROWS.push(entry);
    return [entry];
  },
  async select({ filters = {}, limit = 50 } = {}) {
    let rows = [...MEMORY_ROWS];
    for (const [key, value] of Object.entries(filters)) {
      rows = rows.filter((r) => r[key] === value);
    }
    // Newest first — mirrors dataStore's orderBy:"created_at" (desc).
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return rows.slice(0, limit);
  },
  async update(match, updates) {
    const hits = MEMORY_ROWS.filter((r) =>
      Object.entries(match).every(([k, v]) => r[k] === v)
    );
    hits.forEach((row) => Object.assign(row, updates));
    return hits;
  },
};

async function notifInsert(record) {
  if ((await storage()) === "memory") return memory.insert(record);
  try {
    return await store.insert("notifications", record);
  } catch (err) {
    if (!looksLikeMissingTable(err)) throw err;
    storageMode = "memory";
    return memory.insert(record);
  }
}

async function notifSelect({ filters, limit }) {
  if ((await storage()) === "memory") return memory.select({ filters, limit });
  try {
    return await store.select("notifications", {
      filters,
      orderBy: "created_at",
      limit,
    });
  } catch (err) {
    if (!looksLikeMissingTable(err)) throw err;
    storageMode = "memory";
    return memory.select({ filters, limit });
  }
}

async function notifUpdate(filters, updates) {
  if ((await storage()) === "memory") return memory.update(filters, updates);
  try {
    return await store.update("notifications", filters, updates);
  } catch (err) {
    if (!looksLikeMissingTable(err)) throw err;
    storageMode = "memory";
    return memory.update(filters, updates);
  }
}

// ─── Write path ────────────────────────────────────────────────

/**
 * Record one notification. Best-effort by contract: returns the row on
 * success and null on any failure (missing credentials, bad audience,
 * storage hiccup, ...). The rescue workflow calls this inline — it can
 * never be blocked by a notification problem.
 */
async function createNotification({ incident_id, audience, type, title, message }) {
  try {
    if (!AUDIENCES.includes(audience) || !title || !message) return null;
    const rows = await notifInsert({
      incident_id: incident_id || null,
      audience,
      type: type || "GENERAL",
      title,
      message,
      read: false,
      created_at: new Date().toISOString(),
    });
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.warn(`⚠️  Notification write failed (${type || "GENERAL"}): ${err.message}`);
    return null;
  }
}

// ─── GET /api/notifications ────────────────────────────────────
// Newest first, scoped to the caller's login. `unread_count` drives
// the bell badge from the same query — no second round trip.
const listNotifications = async (req, res) => {
  try {
    const rows = await notifSelect({
      filters: { audience: req.role },
      limit: NOTIFICATION_LIMIT,
    });

    const data = rows || [];
    res.json({
      success: true,
      count: data.length,
      unread_count: data.filter((n) => !n.read).length,
      storage: await storage(),
      data,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── POST /api/notifications/read-all ──────────────────────────
const markAllRead = async (req, res) => {
  try {
    const data = await notifUpdate(
      { audience: req.role, read: false },
      { read: true }
    );
    res.json({
      success: true,
      message: "All notifications marked read",
      updated: data ? data.length : 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── POST /api/notifications/:id/read ──────────────────────────
const markRead = async (req, res) => {
  try {
    const { id } = req.params;
    // Scoped to the caller's audience so one login cannot flip the
    // other login's read state.
    const data = await notifUpdate({ id, audience: req.role }, { read: true });
    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  createNotification,
  listNotifications,
  markAllRead,
  markRead,
};
