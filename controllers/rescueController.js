/**
 * Rescue Controller
 *
 * Rescue team management, device locations, device health and the
 * (optional) device alert command. All reads/writes go through the
 * existing dataStore abstraction.
 */

const store = require("../config/dataStore");
const { DEVICE_OFFLINE_SECONDS } = require("../config/rescueConfig");

// ─── Rescue teams ──────────────────────────────────────────────

// GET /api/rescue-teams
const getTeams = async (req, res) => {
  try {
    const data = await store.select("rescue_teams", { orderBy: "created_at", limit: 100 });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/rescue-teams/:teamId
const getTeamById = async (req, res) => {
  try {
    const { teamId } = req.params;
    const data = await store.select("rescue_teams", { filters: { team_id: teamId }, limit: 1 });
    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: "Rescue team not found" });
    }
    res.json({ success: true, data: data[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// POST /api/rescue-teams (rescue_team)
const createTeam = async (req, res) => {
  try {
    const { team_id, team_name, team_type, status, current_location } = req.body;
    if (!team_id || !team_name || !team_type) {
      return res.status(400).json({ success: false, message: "team_id, team_name and team_type are required" });
    }
    const existing = await store.select("rescue_teams", { filters: { team_id }, limit: 1 });
    if (existing && existing.length > 0) {
      return res.status(409).json({ success: false, message: "team_id already exists" });
    }
    const data = await store.insert("rescue_teams", {
      team_id,
      team_name,
      team_type,
      status: status || "AVAILABLE",
      current_location: current_location || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    res.status(201).json({ success: true, message: "Rescue team created", data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// PATCH /api/rescue-teams/:teamId (rescue_team)
const updateTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    const allowed = {};
    for (const key of ["team_name", "team_type", "status", "current_location"]) {
      if (req.body[key] !== undefined) allowed[key] = req.body[key];
    }
    allowed.updated_at = new Date().toISOString();
    const data = await store.update("rescue_teams", { team_id: teamId }, allowed);
    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: "Rescue team not found" });
    }
    res.json({ success: true, message: "Rescue team updated", data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── Device locations ──────────────────────────────────────────

// GET /api/device-locations
const getLocations = async (req, res) => {
  try {
    const data = await store.select("device_locations", { limit: 200 });
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/device-locations/:deviceId
const getLocation = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const data = await store.select("device_locations", { filters: { device_id: deviceId }, limit: 1 });
    if (!data || data.length === 0) {
      return res.status(404).json({ success: false, message: "No configured location for this device" });
    }
    res.json({ success: true, data: data[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// PUT /api/device-locations/:deviceId (rescue_team)
const upsertLocation = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { building, floor, room, zone, latitude, longitude } = req.body;
    const updates = {
      building: building ?? null,
      floor: floor != null ? String(floor) : null,
      room: room != null ? String(room) : null,
      zone: zone ?? null,
      latitude: typeof latitude === "number" ? latitude : null,
      longitude: typeof longitude === "number" ? longitude : null,
      updated_at: new Date().toISOString(),
    };
    const existing = await store.select("device_locations", { filters: { device_id: deviceId }, limit: 1 });
    if (existing && existing.length > 0) {
      const data = await store.update("device_locations", { device_id: deviceId }, updates);
      return res.json({ success: true, message: "Device location updated", data });
    }
    const data = await store.insert("device_locations", {
      device_id: deviceId,
      ...updates,
      created_at: new Date().toISOString(),
    });
    res.status(201).json({ success: true, message: "Device location created", data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── Device health ─────────────────────────────────────────────

// GET /api/device-health
// Online/offline + last seen + battery ONLY if the device actually sends it.
const getDeviceHealth = async (req, res) => {
  try {
    const devices = await store.select("devices", { orderBy: "created_at", limit: 100 });

    const health = [];
    for (const device of devices) {
      const deviceId = device.device_id;
      const readings = await store.select("sensor_readings", {
        filters: { device_id: deviceId },
        orderBy: "recorded_at",
        limit: 1,
      });
      const latest = readings && readings.length > 0 ? readings[0] : null;
      const lastSeen = latest ? new Date(latest.recorded_at) : null;
      const secondsAgo = lastSeen ? (Date.now() - lastSeen.getTime()) / 1000 : null;
      const online = secondsAgo !== null && secondsAgo <= DEVICE_OFFLINE_SECONDS;

      const entry = {
        device_id: deviceId,
        name: device.name || deviceId,
        status: online ? "ONLINE" : "OFFLINE",
        last_seen: lastSeen ? lastSeen.toISOString() : null,
        last_seen_seconds_ago: secondsAgo !== null ? Math.round(secondsAgo) : null,
        location: device.location || null,
      };

      // Battery only if the hardware actually reported it.
      if (latest && latest.battery_level_percent !== null && latest.battery_level_percent !== undefined) {
        entry.battery_level_percent = latest.battery_level_percent;
      }

      health.push(entry);
    }

    res.json({ success: true, count: health.length, data: health });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── Latest sensor snapshot (for incident detail view) ─────────

// GET /api/devices/:deviceId/latest-reading
const getLatestReading = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const readings = await store.select("sensor_readings", {
      filters: { device_id: deviceId },
      orderBy: "recorded_at",
      limit: 1,
    });
    if (!readings || readings.length === 0) {
      return res.status(404).json({ success: false, message: "No readings for this device" });
    }
    res.json({
      success: true,
      data: readings[0],
      source: "latest_received",
      note: "Latest value received from the device (polling interval applies)",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// ─── Device alert command (two-way buzzer) ─────────────────────
//
// IMPORTANT: The current ESP32 firmware only POSTs sensor data;
// it does NOT poll the backend for commands. The command is queued
// in `device_commands`. This endpoint is a DEMO / SIMULATED action
// until firmware polling support is added.

// POST /api/devices/:deviceId/command (rescue_team)
const sendDeviceCommand = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { command } = req.body;
    const cmd = command || "ACTIVATE_BUZZER";

    const data = await store.insert("device_commands", {
      device_id: deviceId,
      command: cmd,
      status: "QUEUED",
      issued_by: (req.user && req.user.email) || "unknown",
      created_at: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: `Command queued for ${deviceId}`,
      data,
      simulation: true,
      note:
        "DEMO / SIMULATED: the current ESP32 firmware does not poll commands. " +
        "The command is queued; a firmware update would be required for the buzzer to react.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// GET /api/devices/:deviceId/commands — device-side polling endpoint
// (deviceAuth protected; ready for future firmware use)
const getDeviceCommands = async (req, res) => {
  try {
    const { deviceId } = req.params;
    const commands = await store.select("device_commands", {
      filters: { device_id: deviceId, status: "QUEUED" },
      orderBy: "created_at",
      limit: 10,
    });
    res.json({ success: true, count: commands.length, data: commands });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

// POST /api/devices/:deviceId/commands/:commandId/ack — device confirms
const ackDeviceCommand = async (req, res) => {
  try {
    const { commandId } = req.params;
    const data = await store.update(
      "device_commands",
      { id: commandId },
      { status: "COMPLETED", updated_at: new Date().toISOString() }
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getTeams,
  getTeamById,
  createTeam,
  updateTeam,
  getLocations,
  getLocation,
  upsertLocation,
  getDeviceHealth,
  getLatestReading,
  sendDeviceCommand,
  getDeviceCommands,
  ackDeviceCommand,
};
