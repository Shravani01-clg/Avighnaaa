/**
 * Risk Module — Independent Test Script
 *
 * Run: node risk-module/test.js
 *
 * Tests the module with various scenarios to verify it works correctly.
 * No backend or database required.
 */

const { analyzeRisk, reset } = require("./index");

// ─── Test Data ───────────────────────────────────────────────

const tests = [
  {
    name: "Normal (safe)",
    data: {
      device_id: "TEST-001",
      temperature_c: 25,
      gas_raw: 200,
      water_level_cm: 5,
      acceleration_x_ms2: 0.1,
      acceleration_y_ms2: -0.05,
      acceleration_z_ms2: 9.8,
      sos: false,
    },
    expected: { risk_level: "LOW" },
  },
  {
    name: "High temperature",
    data: {
      device_id: "TEST-002",
      temperature_c: 50,
      gas_raw: 200,
      water_level_cm: 5,
      acceleration_x_ms2: 0.1,
      acceleration_y_ms2: -0.05,
      acceleration_z_ms2: 9.8,
      sos: false,
    },
    expected: { risk_level: "MEDIUM" },
  },
  {
    name: "High gas",
    data: {
      device_id: "TEST-003",
      temperature_c: 25,
      gas_raw: 700,
      water_level_cm: 5,
      acceleration_x_ms2: 0.1,
      acceleration_y_ms2: -0.05,
      acceleration_z_ms2: 9.8,
      sos: false,
    },
    expected: { risk_level: "MEDIUM" },
  },
  {
    name: "Flood",
    data: {
      device_id: "TEST-004",
      temperature_c: 25,
      gas_raw: 200,
      water_level_cm: 30,
      acceleration_x_ms2: 0.1,
      acceleration_y_ms2: -0.05,
      acceleration_z_ms2: 9.8,
      sos: false,
    },
    expected: { risk_level: "LOW" },
  },
  {
    name: "SOS activated",
    data: {
      device_id: "TEST-005",
      temperature_c: 25,
      gas_raw: 200,
      water_level_cm: 5,
      acceleration_x_ms2: 0.1,
      acceleration_y_ms2: -0.05,
      acceleration_z_ms2: 9.8,
      sos: true,
    },
    expected: { risk_level: "HIGH" },
  },
  {
    name: "Combined danger (gas + temp + flood)",
    data: {
      device_id: "TEST-006",
      temperature_c: 48,
      gas_raw: 650,
      water_level_cm: 28,
      acceleration_x_ms2: 0.1,
      acceleration_y_ms2: -0.05,
      acceleration_z_ms2: 9.8,
      sos: false,
    },
    expected: { risk_level: "CRITICAL" },
  },
  {
    name: "Invalid input",
    data: null,
    expected: { risk_level: "LOW" },
  },
];

// ─── Run Tests ───────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════");
console.log("  🧪  Risk Module — Test Suite");
console.log("═══════════════════════════════════════════════════\n");

let passed = 0;
let failed = 0;

for (const test of tests) {
  reset(); // Reset fall detection state for each test
  const result = analyzeRisk(test.data);
  const ok = result.risk_level === test.expected.risk_level;

  if (ok) {
    console.log(`  ✅ ${test.name}`);
    console.log(`     Score: ${result.risk_score} | Level: ${result.risk_level}`);
    console.log(`     Reason: ${result.reason}`);
    passed++;
  } else {
    console.log(`  ❌ ${test.name}`);
    console.log(`     Expected: ${test.expected.risk_level} | Got: ${result.risk_level}`);
    console.log(`     Score: ${result.risk_score} | Reason: ${result.reason}`);
    failed++;
  }
  console.log("");
}

console.log("───────────────────────────────────────────────────");
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log("───────────────────────────────────────────────────\n");

// ─── Output Format Demo ─────────────────────────────────────

console.log("📋 Output format example:\n");
const example = analyzeRisk({
  device_id: "DEMO-001",
  temperature_c: 42,
  gas_raw: 550,
  water_level_cm: 8,
  acceleration_x_ms2: 0.05,
  acceleration_y_ms2: -0.02,
  acceleration_z_ms2: 9.81,
  sos: false,
});
console.log(JSON.stringify(example, null, 2));
console.log("");

process.exit(failed > 0 ? 1 : 0);
