/**
 * Phase 3 Validation Suite — Person 3 (AI/ML Lead)
 *
 * Run:  node risk-module/validate.js
 *
 * Verifies the Phase 3 "DONE when" criteria:
 *   1. AI reliably analyzes sensor data (risk scenarios)
 *   2. Detects anomalies (rule-based) without false-flagging normal readings
 *   3. Detects falls with the full state progression
 *   4. Generates risk predictions mapped to LOW / MEDIUM / HIGH / CRITICAL
 *   5. Always provides the consistent output contract for Person 1's backend
 *
 * Exit code 0 = Phase 3 gate passed.
 */

const { analyzeRisk, reset, detectAnomaly } = require("./index");
const { FALL_STATES } = require("./fallDetection");

// ─── Helpers ─────────────────────────────────────────────────

const BASE = {
  device_id: "VALIDATE-001",
  temperature_c: 28,
  gas_raw: 200,
  water_level_cm: 5,
  acceleration_x_ms2: 0.05,
  acceleration_y_ms2: -0.02,
  acceleration_z_ms2: 9.8,
  sos: false,
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  reset();
  try {
    const result = fn();
    if (result === true || (result && result.ok)) {
      passed++;
      console.log(`  ✅ ${name}`);
      if (result.info) console.log(`     ${result.info}`);
    } else {
      failed++;
      failures.push(name);
      console.log(`  ❌ ${name}`);
      if (result.info) console.log(`     ${result.info}`);
    }
  } catch (err) {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name} — threw: ${err.message}`);
  }
  console.log("");
}

// ─── 1. Risk prediction scenarios (spec task 5) ─────────────

console.log("═══════════════════════════════════════════════════");
console.log("  1️⃣  Risk prediction — spec scenarios");
console.log("═══════════════════════════════════════════════════\n");

check("Normal scenario → LOW", () => {
  const r = analyzeRisk(BASE);
  return {
    ok: r.risk_level === "LOW",
    info: `score=${r.risk_score} level=${r.risk_level}`,
  };
});

check("Dangerous gas → MEDIUM or higher + GAS_DANGER alert", () => {
  reset();
  const r = analyzeRisk({ ...BASE, gas_raw: 700 });
  const alerts = deriveAlerts(r);
  return {
    ok: ["MEDIUM", "HIGH", "CRITICAL"].includes(r.risk_level) && alerts.includes("GAS_DANGER"),
    info: `score=${r.risk_score} level=${r.risk_level}`,
  };
});

check("Rising water → MEDIUM or higher", () => {
  const r = analyzeRisk({ ...BASE, water_level_cm: 30 });
  return {
    ok: ["MEDIUM", "HIGH", "CRITICAL"].includes(r.risk_level),
    info: `score=${r.risk_score} level=${r.risk_level}`,
  };
});

check("SOS → HIGH or higher", () => {
  const r = analyzeRisk({ ...BASE, sos: true });
  return {
    ok: ["HIGH", "CRITICAL"].includes(r.risk_level),
    info: `score=${r.risk_score} level=${r.risk_level}`,
  };
});

check("Combined hazards → CRITICAL", () => {
  const r = analyzeRisk({
    ...BASE,
    temperature_c: 48,
    gas_raw: 650,
    water_level_cm: 28,
  });
  return {
    ok: r.risk_level === "CRITICAL",
    info: `score=${r.risk_score} level=${r.risk_level}`,
  };
});

// ─── 2. Output contract (spec task 6) ───────────────────────

console.log("═══════════════════════════════════════════════════");
console.log("  2️⃣  Output contract — always returns predictable fields");
console.log("═══════════════════════════════════════════════════\n");

const contractCases = [
  BASE,
  { ...BASE, gas_raw: 900, temperature_c: 60 },
  { ...BASE, sos: true },
  null, // invalid input must still honor the contract
];

check("Contract fields present on every response (incl. invalid input)", () => {
  for (const data of contractCases) {
    reset();
    const r = analyzeRisk(data);
    const hasAll =
      typeof r.risk_score === "number" &&
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(r.risk_level) &&
      typeof r.anomaly_detected === "boolean" &&
      typeof r.fall_state === "string" &&
      typeof r.reason === "string" && r.reason.length > 0;
    if (!hasAll) return { ok: false, info: `Failed for input: ${JSON.stringify(data)}` };
  }
  return { ok: true, info: "risk_score, risk_level, anomaly_detected, fall_state, reason present in all cases" };
});

check("Invalid input → safe defaults (LOW, no anomaly)", () => {
  const r = analyzeRisk(null);
  return {
    ok: r.risk_level === "LOW" && r.anomaly_detected === false,
    info: `level=${r.risk_level} anomaly=${r.anomaly_detected}`,
  };
});

check("risk_score within 0–100", () => {
  for (const data of [
    { ...BASE, gas_raw: 1200, temperature_c: 90, water_level_cm: 80, sos: true },
    { ...BASE, temperature_c: -50 },
  ]) {
    reset();
    const r = analyzeRisk(data);
    if (r.risk_score < 0 || r.risk_score > 100) return { ok: false, info: `score=${r.risk_score}` };
  }
  return { ok: true };
});

// ─── 3. Fall detection progression (spec task 3) ────────────

console.log("═══════════════════════════════════════════════════");
console.log("  3️⃣  Fall detection — MPU6050 state progression");
console.log("═══════════════════════════════════════════════════\n");

check("Normal movement → fall_state NORMAL", () => {
  const r = analyzeRisk(BASE);
  return { ok: r.fall_state === FALL_STATES.NORMAL, info: `fall_state=${r.fall_state}` };
});

check("Sudden jerk → SUDDEN_MOVEMENT (no false fall)", () => {
  // A hard jerk/spike (e.g. equipment bump) — |a| ≈ 24.4, below fall threshold
  const r = analyzeRisk({ ...BASE, acceleration_x_ms2: 8, acceleration_y_ms2: 6, acceleration_z_ms2: 22 });
  return {
    ok: r.fall_state === FALL_STATES.SUDDEN_MOVEMENT && r.risk_level !== "CRITICAL",
    info: `fall_state=${r.fall_state} score=${r.risk_score} level=${r.risk_level}`,
  };
});

check("Fall sequence (standing → free-fall → impact → lying) → FALL_CONFIRMED", () => {
  // One continuous session, like the real device streaming readings
  const seq = [
    { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 },   // standing
    { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 0.4 },   // free-fall
    { acceleration_x_ms2: 25, acceleration_y_ms2: 20, acceleration_z_ms2: 35 },  // impact
    { acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 },   // lying
  ];
  reset();
  let result = null;
  for (const accel of seq) {
    result = analyzeRisk({ ...BASE, ...accel });
  }
  return {
    ok: result.fall_state === FALL_STATES.FALL_CONFIRMED,
    info: `fall_state=${result.fall_state} fall_score=${result.fall_score}`,
  };
});

check("Full session: confirmed fall stays CONFIRMED while lying, clears after recovery", () => {
  reset();
  const standing = { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 };
  const freefall = { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 0.4 };
  const impact = { acceleration_x_ms2: 25, acceleration_y_ms2: 20, acceleration_z_ms2: 35 };
  const lying = { acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 };
  const feed = (a) => analyzeRisk({ ...BASE, ...a });

  // Phase 1: normal movement
  let r = feed(standing);
  if (r.fall_state !== FALL_STATES.NORMAL) return { ok: false, info: `standing → ${r.fall_state}` };

  // Phase 2: fall happens
  feed(freefall);
  r = feed(impact);
  if (r.fall_state !== FALL_STATES.FALL_CONFIRMED) return { ok: false, info: `impact → ${r.fall_state}` };

  // Phase 3: worker still on the ground through the cooldown window
  for (let i = 0; i < 10; i++) r = feed(lying);
  if (r.fall_state !== FALL_STATES.FALL_CONFIRMED) return { ok: false, info: `lying during cooldown → ${r.fall_state}` };

  // Phase 4: worker stands back up — state clears
  for (let i = 0; i < 12; i++) r = feed(standing);
  if (r.fall_state !== FALL_STATES.NORMAL) return { ok: false, info: `recovered → ${r.fall_state}` };

  return { ok: true, info: "NORMAL → FALL_CONFIRMED → (sustained) → NORMAL — full progression verified" };
});

// ─── 4. Anomaly detection — false-positive check (spec task 2) ──

console.log("═══════════════════════════════════════════════════");
console.log("  4️⃣  Anomaly detection — normal readings must NOT be flagged");
console.log("═══════════════════════════════════════════════════\n");

check("Rule-based anomaly: normal envelope → no anomalies (0% FP)", () => {
  let flagged = 0;
  const n = 300;
  for (let i = 0; i < n; i++) {
    const reading = {
      temperature_c: 28 + (Math.random() - 0.5) * 8,   // 24–32 °C
      gas_raw: 200 + (Math.random() - 0.5) * 100,      // 150–250
      water_level_cm: 5 + (Math.random() - 0.5) * 4,   // 3–7 cm
      acceleration_x_ms2: (Math.random() - 0.5) * 0.6,
      acceleration_y_ms2: (Math.random() - 0.5) * 0.6,
      acceleration_z_ms2: 9.8 + (Math.random() - 0.5) * 0.6,
    };
    if (detectAnomaly(reading).anomalyDetected) flagged++;
  }
  const fpRate = (flagged / n) * 100;
  return {
    ok: fpRate <= 1,
    info: `False-positive rate: ${fpRate.toFixed(2)}% (${flagged}/${n})`,
  };
});

check("Rule-based anomaly: sensor faults ARE flagged (>90% TP)", () => {
  let flagged = 0;
  const faults = [
    { temperature_c: 120 },                          // impossible temp
    { temperature_c: -40 },                          // impossible temp
    { gas_raw: -5 },                                 // negative gas
    { water_level_cm: -3 },                          // negative water
    { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 0.2 },   // |a| ≈ 0 — free-hang fault
    { acceleration_x_ms2: 40, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 },  // violent shake, no fall
  ];
  for (const fault of faults) {
    if (detectAnomaly(fault).anomalyDetected) flagged++;
  }
  const tpRate = (flagged / faults.length) * 100;
  return {
    ok: tpRate >= 90,
    info: `True-positive rate: ${tpRate.toFixed(0)}% (${flagged}/${faults.length})`,
  };
});

check("Hazard readings are NOT anomalies (hot/gas/wet = known danger)", () => {
  const hazards = [
    { temperature_c: 50, gas_raw: 200, water_level_cm: 5, acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 },
    { temperature_c: 28, gas_raw: 700, water_level_cm: 5, acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 },
    { temperature_c: 28, gas_raw: 200, water_level_cm: 35, acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 },
  ];
  for (const h of hazards) {
    const a = detectAnomaly(h);
    if (a.anomalyDetected) return { ok: false, info: `Hazard flagged as anomaly: ${a.anomalyReasons.join(", ")}` };
  }
  return { ok: true, info: "Hazards scored as danger, not anomaly" };
});

// ─── Summary ─────────────────────────────────────────────────

console.log("───────────────────────────────────────────────────");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("───────────────────────────────────────────────────\n");

if (failed > 0) {
  console.log("  Failed checks:");
  for (const f of failures) console.log(`   - ${f}`);
  console.log("");
  process.exit(1);
} else {
  console.log("  🎉 Phase 3 gate: all checks passed.\n");
}

// ─── Utilities ───────────────────────────────────────────────

/**
 * Mirror of the backend alert derivation (controllers/riskEngine.js)
 */
function deriveAlerts(result) {
  const alerts = [];
  const reason = result.reason || "";
  if (reason.includes("temperature")) alerts.push("TEMP_DANGER");
  if (reason.includes("gas level")) alerts.push("GAS_DANGER");
  if (reason.includes("water level")) alerts.push("FLOOD_DANGER");
  if (reason.includes("SOS")) alerts.push("SOS");
  if (result.fall_state === "FALL_CONFIRMED") alerts.push("FALL_DETECTED");
  else if (result.fall_state === "POSSIBLE_FALL") alerts.push("POSSIBLE_FALL");
  if (reason.includes("Combined danger")) alerts.push("COMBINED_DANGER");
  return alerts;
}
