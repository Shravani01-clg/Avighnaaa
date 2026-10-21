/**
 * Rolling Window — stuck-sensor & trend detection (Person 3)
 *
 * WHY THIS EXISTS
 * A stateless single-reading API cannot tell "sensor frozen at 28.0" apart
 * from "genuinely 28.0" — that distinction requires a SEQUENCE of readings.
 * (Documented as a model limitation on Day 1; solved here on Day 2.)
 *
 * Keeps a per-device ring buffer of the last STUCK_WINDOW readings and
 * provides two sequence-based checks:
 *
 *   1. STUCK SENSOR: a watched channel (temperature / gas / water) that
 *      reports the EXACT same value STUCK_WINDOW times in a row is frozen.
 *      Real sensors always jitter — the simulator (generator.js) adds
 *      noise and rounds, so identical runs of 10 do not occur naturally.
 *
 *   2. TREND WARNING: least-squares slope over the window gives a rate of
 *      change per minute; if the next rule threshold would be crossed
 *      within TREND_ETA_HORIZON_MIN minutes, we warn BEFORE the hazard
 *      instead of after it.
 *
 * Runs inside the rule engine → works even when the Python AI server is
 * offline. State is keyed per device; reset() clears everything (tests,
 * simulator scenario switches).
 *
 * Watched channels are the three hazard sensors only. Accelerometer
 * freeze is covered by the rule envelope + ML fault detection + the fall
 * state machine; watching it here would risk false positives on the
 * (near-zero) drift values a healthy sensor can legitimately repeat.
 */

const STUCK_WINDOW = 10;          // identical readings required to confirm "stuck"
const TREND_MIN_POINTS = 5;       // readings required before computing a slope
const TREND_MIN_SPAN_MS = 5000;   // ...over at least this much time (5 s)
const TREND_ETA_HORIZON_MIN = 5;  // warn if threshold reachable within 5 min

// Minimum sustained rate (units per minute) before a slope is taken seriously
const TREND_RATE_MIN = {
  temperature_c: 2,      // ≥ 2 °C/min
  gas_raw: 40,           // ≥ 40 raw/min
  water_level_cm: 1.5,   // ≥ 1.5 cm/min
};

// Rule thresholds per channel (mirrors THRESHOLDS in riskEngine.js)
const TREND_TARGETS = {
  temperature_c: [38, 45, 55],
  gas_raw: [400, 600, 800],
  water_level_cm: [15, 25, 40],
};

// Short, deriveAlerts-safe labels: reason strings are scanned for
// "temperature", "gas level", "water level" to derive hazard alerts —
// sequence messages must never match those accidentally.
const LABELS = { temperature_c: "temp", gas_raw: "gas", water_level_cm: "water" };

const WATCHED = ["temperature_c", "gas_raw", "water_level_cm"];

const windows = new Map(); // device_id → [{ t, temperature_c, gas_raw, water_level_cm }]

function parseTime(ts) {
  if (typeof ts === "number" && isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const p = Date.parse(ts);
    if (!isNaN(p)) return p;
  }
  return Date.now();
}

/** Least-squares slope over the window, in units per minute. NaN if any value missing. */
function slopePerMinute(buf, field) {
  const n = buf.length;
  const t0 = buf[0].t;
  let sumT = 0, sumV = 0, sumTV = 0, sumTT = 0;
  for (const r of buf) {
    const v = r[field];
    if (typeof v !== "number" || !isFinite(v)) return NaN;
    const dt = r.t - t0;
    sumT += dt;
    sumV += v;
    sumTV += dt * v;
    sumTT += dt * dt;
  }
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return NaN;
  return ((n * sumTV - sumT * sumV) / denom) * 60000; // per-ms → per-minute
}

function computeTrend(buf) {
  if (buf.length < TREND_MIN_POINTS) return [];
  const span = buf[buf.length - 1].t - buf[0].t;
  if (span < TREND_MIN_SPAN_MS) return [];

  const warnings = [];
  const current = buf[buf.length - 1];

  for (const field of WATCHED) {
    const rate = slopePerMinute(buf, field);
    if (!isFinite(rate) || rate < TREND_RATE_MIN[field]) continue;

    const value = current[field];
    if (typeof value !== "number" || !isFinite(value)) continue;

    const target = TREND_TARGETS[field].find((t) => t > value);
    if (target === undefined) continue; // already past every threshold — level logic owns it

    const eta = (target - value) / rate; // minutes
    if (!(eta > 0) || eta > TREND_ETA_HORIZON_MIN) continue;

    const rate1 = Math.round(rate * 10) / 10;
    const eta1 = Math.round(eta * 10) / 10;
    warnings.push({
      sensor: field,
      rate_per_min: rate1,
      target,
      eta_minutes: eta1,
      message: `${LABELS[field]} rising +${rate1}/min — reaches ${target} in ~${eta1} min`,
    });
  }
  return warnings;
}

/**
 * Feed one reading through the window.
 *
 * @returns {{ stuckSensors: string[], stuckReasons: string[], trendWarnings: Object[] }}
 */
function feedReading(deviceId, reading) {
  const key = deviceId || "__default__";
  if (!windows.has(key)) windows.set(key, []);
  const buf = windows.get(key);

  buf.push({
    t: parseTime(reading.timestamp || reading.recorded_at),
    temperature_c: reading.temperature_c,
    gas_raw: reading.gas_raw,
    water_level_cm: reading.water_level_cm,
  });
  while (buf.length > STUCK_WINDOW) buf.shift();

  const stuckSensors = [];
  const stuckReasons = [];
  if (buf.length === STUCK_WINDOW) {
    for (const field of WATCHED) {
      const first = buf[0][field];
      if (first === undefined || first === null) continue;
      if (buf.every((r) => r[field] === first)) {
        stuckSensors.push(field);
        stuckReasons.push(`Stuck sensor: ${LABELS[field]} constant for ${STUCK_WINDOW} readings`);
      }
    }
  }

  return {
    stuckSensors,
    stuckReasons,
    trendWarnings: computeTrend(buf),
  };
}

/** Clear all per-device windows (tests / scenario switches). */
function reset() {
  windows.clear();
}

module.exports = {
  feedReading,
  reset,
  STUCK_WINDOW,
  TREND_MIN_POINTS,
  TREND_MIN_SPAN_MS,
  TREND_ETA_HORIZON_MIN,
  TREND_RATE_MIN,
  LABELS,
};
