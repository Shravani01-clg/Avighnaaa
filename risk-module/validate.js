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
 *   6. Alert stability: instant escalation, delayed de-escalation (no level
 *      flapping), per-device isolation, AI-alert cooldown, and a rescue
 *      recommendation on every response
 *   7. Sequence intelligence (Day 2): stuck-sensor detection over a
 *      rolling window, pre-threshold trend warnings, explainable
 *      risk_factors, and recommendation coverage for both
 *
 * Exit code 0 = Phase 3 gate passed.
 */

const { analyzeRisk, reset, detectAnomaly } = require("./index");
const { FALL_STATES } = require("./fallDetection");
const { STUCK_WINDOW } = require("./rollingWindow");
const { shouldEmitAlert, resetAlertCooldown } = require("../controllers/aiIntegration");

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
      typeof r.reason === "string" && r.reason.length > 0 &&
      typeof r.recommendation === "string" && r.recommendation.length > 0 &&
      Array.isArray(r.stuck_sensors) &&
      Array.isArray(r.trend_warnings) &&
      Array.isArray(r.risk_factors) && r.risk_factors.length > 0;
    if (!hasAll) return { ok: false, info: `Failed for input: ${JSON.stringify(data)}` };
  }
  return { ok: true, info: "risk_score, risk_level, anomaly_detected, fall_state, reason, recommendation, stuck_sensors, trend_warnings, risk_factors present in all cases" };
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

// ─── 5. Alert stability — hysteresis, cooldown, recommendation ──

console.log("═══════════════════════════════════════════════════");
console.log("  5️⃣  Alert stability — no flapping, cooldown, advice");
console.log("═══════════════════════════════════════════════════\n");

check("Escalation is immediate (danger never waits)", () => {
  analyzeRisk(BASE); // establish a LOW baseline
  const r = analyzeRisk({ ...BASE, gas_raw: 700 });
  return {
    ok: ["MEDIUM", "HIGH", "CRITICAL"].includes(r.risk_level),
    info: `baseline LOW → gas 700 → ${r.risk_level} (${r.risk_score})`,
  };
});

check("De-escalation held for 3 stable readings (no level flapping)", () => {
  const danger = analyzeRisk({ ...BASE, gas_raw: 700 }); // establish MEDIUM
  const r1 = analyzeRisk(BASE);                          // hold 1/3
  const r2 = analyzeRisk(BASE);                          // hold 2/3
  const r3 = analyzeRisk(BASE);                          // hold 3/3 → stand down
  const ok =
    danger.risk_level === "MEDIUM" &&
    r1.risk_level === "MEDIUM" && r1.risk_score === danger.risk_score &&
    r2.risk_level === "MEDIUM" &&
    r3.risk_level === "LOW";
  return {
    ok,
    info:
      `${danger.risk_level}(${danger.risk_score}) → ` +
      `${r1.risk_level}(${r1.risk_score}, hold 1) → ` +
      `${r2.risk_level}(hold 2) → ${r3.risk_level}(stand down)`,
  };
});

check("Hysteresis state is isolated per device", () => {
  analyzeRisk({ ...BASE, device_id: "STAB-A", gas_raw: 700 }); // A in danger
  const b = analyzeRisk({ ...BASE, device_id: "STAB-B" });      // B normal → LOW
  const a = analyzeRisk({ ...BASE, device_id: "STAB-A" });      // A still holding
  return {
    ok: b.risk_level === "LOW" && a.risk_level === "MEDIUM",
    info: `B=${b.risk_level} (clean, unaffected) | A=${a.risk_level} (still held)`,
  };
});

check("AI alert cooldown — fires once per device, window respected", () => {
  resetAlertCooldown();
  const first = shouldEmitAlert("ANOMALY", "COOL-1", 1_000_000);
  const within = shouldEmitAlert("ANOMALY", "COOL-1", 1_010_000); // 10s later → suppressed
  const after = shouldEmitAlert("ANOMALY", "COOL-1", 1_040_000);  // 40s later → allowed
  const otherDevice = shouldEmitAlert("ANOMALY", "COOL-2", 1_010_000); // other device → allowed
  const ok = first === true && within === false && after === true && otherDevice === true;
  return {
    ok,
    info: `first=${first} within10s=${within} after40s=${after} otherDevice=${otherDevice}`,
  };
});

check("Rescue recommendation present & level-appropriate", () => {
  const low = analyzeRisk(BASE);
  const crit = analyzeRisk({ ...BASE, temperature_c: 48, gas_raw: 650, water_level_cm: 28, sos: true });
  const ok =
    typeof low.recommendation === "string" && low.recommendation.length > 0 &&
    typeof crit.recommendation === "string" && /evacuat|rescue/i.test(crit.recommendation);
  return {
    ok,
    info: `LOW→"${low.recommendation}" | CRITICAL→"${crit.recommendation.slice(0, 72)}…"`,
  };
});

// ─── 6. Sequence intelligence — stuck sensor & trends (Day 2) ──

console.log("═══════════════════════════════════════════════════");
console.log("  6️⃣  Sequence intelligence — stuck sensor & trends");
console.log("═══════════════════════════════════════════════════\n");

check("Stuck sensor detected after window of identical readings", () => {
  let last = null;
  for (let i = 0; i < STUCK_WINDOW; i++) {
    last = analyzeRisk({ ...BASE, device_id: "STUCK-1" });
  }
  const ok =
    last.stuck_sensors.includes("temperature_c") &&
    last.stuck_sensors.includes("gas_raw") &&
    last.stuck_sensors.includes("water_level_cm") &&
    last.anomaly_detected === true &&
    last.reason.includes("Stuck sensor");
  return {
    ok,
    info: `stuck=[${last.stuck_sensors.join(", ")}] anomaly=${last.anomaly_detected}`,
  };
});

check("No stuck false-positive on jittered readings", () => {
  let last = null;
  for (let i = 0; i < 14; i++) {
    last = analyzeRisk({
      ...BASE,
      device_id: "STUCK-2",
      temperature_c: 28 + (i % 3) * 0.1,
      gas_raw: 200 + (i % 4) * 7,
      water_level_cm: 5 + (i % 3) * 0.1,
    });
  }
  return {
    ok: last.stuck_sensors.length === 0,
    info: `stuck=[${last.stuck_sensors.join(", ")}] after 14 jittered readings`,
  };
});

check("Trend warning: rising gas → ETA before threshold", () => {
  const t0 = 1_800_000_000_000; // fixed epoch → deterministic slope
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = analyzeRisk({
      ...BASE,
      device_id: "TREND-1",
      timestamp: new Date(t0 + i * 10_000).toISOString(),
      gas_raw: 200 + i * 40, // 200 → 400 in 50 s = +240/min
    });
  }
  const w = last.trend_warnings.find((x) => x.sensor === "gas_raw");
  const ok =
    !!w &&
    w.rate_per_min >= 40 &&
    w.eta_minutes > 0 && w.eta_minutes <= 5 &&
    last.reason.includes("rising");
  return {
    ok,
    info: w ? `${w.message} (in reason: ${last.reason.includes("rising")})` : `no gas trend (warnings: ${last.trend_warnings.length})`,
  };
});

check("No trend warning on oscillating readings", () => {
  const t0 = 1_800_000_000_000;
  let last = null;
  for (let i = 0; i < 6; i++) {
    last = analyzeRisk({
      ...BASE,
      device_id: "TREND-2",
      timestamp: new Date(t0 + i * 10_000).toISOString(),
      gas_raw: 200 + (i % 2) * 10,
      temperature_c: 28 + (i % 2) * 0.2,
      water_level_cm: 5 + (i % 2) * 0.2,
    });
  }
  return {
    ok: last.trend_warnings.length === 0,
    info: `warnings=${last.trend_warnings.length} on oscillating data`,
  };
});

check("risk_factors explain a danger reading (+ baseline for normal)", () => {
  const normal = analyzeRisk({ ...BASE, device_id: "FACT-1" });
  const danger = analyzeRisk({ ...BASE, device_id: "FACT-2", gas_raw: 650 });
  const gasFactor = danger.risk_factors.find((f) => f.name === "gas_raw");
  const ok =
    normal.risk_factors.length >= 1 &&
    normal.risk_factors.every((f) => typeof f.points === "number" && typeof f.detail === "string") &&
    !!gasFactor && gasFactor.points > 0 && gasFactor.detail.length > 0;
  return {
    ok,
    info: `normal→"${normal.risk_factors[0].name}" | danger→gas factor "${gasFactor ? gasFactor.detail : "MISSING"}" (${gasFactor ? gasFactor.points : "-"} pts)`,
  };
});

check("Recommendation covers frozen sensor and pre-threshold trend", () => {
  let last = null;
  for (let i = 0; i < STUCK_WINDOW; i++) {
    last = analyzeRisk({ ...BASE, device_id: "REC-STUCK" });
  }
  const stuckRec = last.recommendation;

  const t0 = 1_800_000_000_000;
  for (let i = 0; i < 6; i++) {
    last = analyzeRisk({
      ...BASE,
      device_id: "REC-TREND",
      timestamp: new Date(t0 + i * 10_000).toISOString(),
      gas_raw: 200 + i * 40,
    });
  }
  const trendRec = last.recommendation;

  const ok = /frozen/.test(stuckRec) && /Pre-emptive/.test(trendRec);
  return {
    ok,
    info: `stuck→"${stuckRec.slice(0, 66)}…" | trend→"${trendRec.slice(0, 66)}…"`,
  };
});

check("Rescue advice persists while worker still down (fall confirmed)", () => {
  // standing → free-fall → impact (CRITICAL, adopted) → lying ×3:
  // the 3rd lying reading expires the hold window and drops the raw level
  // to LOW — advice must still cover the confirmed, downed worker.
  const seq = [
    { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 },
    { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 0.4 },
    { acceleration_x_ms2: 25, acceleration_y_ms2: 20, acceleration_z_ms2: 35 },
    { acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 },
    { acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 },
    { acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 },
  ];
  let last = null;
  for (const s of seq) {
    last = analyzeRisk({ ...BASE, ...s, device_id: "REC-FALL" });
  }
  const ok =
    last.fall_state === FALL_STATES.FALL_CONFIRMED &&
    /still down/i.test(last.recommendation);
  return {
    ok,
    info: `fall=${last.fall_state} level=${last.risk_level} → "${last.recommendation.slice(0, 74)}…"`,
  };
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
