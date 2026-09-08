/**
 * Sensor Simulator — Main Runner
 *
 * Acts as an ESP32 device, generating sensor data and POSTing it to the backend.
 *
 * Usage:
 *   node simulator/index.js                    # Normal mode (random events)
 *   node simulator/index.js --scenario gas     # Run a specific scenario
 *   node simulator/index.js --loop             # Loop through all scenarios
 *   node simulator/index.js --once             # Send one reading and exit
 *
 * Available scenarios:
 *   gas, flood, overheat, fall, sos, combined
 */

const http = require("http");
const config = require("./config");
const generator = require("./generator");
const scenarios = require("./scenarios");
const { analyzeRisk, reset: resetRisk } = require("../risk-module");

// ─── CLI Arguments ───────────────────────────────────────────

const args = process.argv.slice(2);
const scenarioFlag = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : null;
const loopMode = args.includes("--loop");
const onceMode = args.includes("--once");

// ─── HTTP Helper ─────────────────────────────────────────────

function postSensorData(reading) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${config.apiUrl}/api/sensor-data`);
    const body = JSON.stringify(reading);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-device-key": config.deviceApiKey,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Display ─────────────────────────────────────────────────

function printReading(reading, label) {
  const ts = new Date(reading.timestamp).toLocaleTimeString();
  const risk = `T:${reading.temperature_c}°C G:${reading.gas_raw} W:${reading.water_level_cm}cm`;
  const accel = `Ax:${reading.acceleration_x_ms2} Ay:${reading.acceleration_y_ms2} Az:${reading.acceleration_z_ms2}`;
  const sos = reading.sos ? " ⚠️ SOS" : "";
  console.log(`[${ts}] ${label ? `[${label}] ` : ""}${risk} ${accel}${sos}`);
}

function printResult(result, index, localRisk) {
  const status = result.status === 201 ? "✅" : "❌";
  const backendRisk = result.body?.risk?.[0];
  const riskInfo = localRisk
    ? ` → Risk: ${localRisk.risk_level} (${localRisk.risk_score}) ${localRisk.reason}`
    : backendRisk
    ? ` → Risk: ${backendRisk.risk_level} (${backendRisk.risk_score})`
    : "";
  console.log(`  ${status} #${index} [${result.status}]${riskInfo}`);
}

// ─── Scenarios Map ───────────────────────────────────────────

const scenarioMap = {
  gas: scenarios.gasLeak,
  flood: scenarios.flood,
  overheat: scenarios.overheat,
  fall: scenarios.workerFall,
  sos: scenarios.sosEmergency,
  combined: scenarios.combinedDanger,
};

const scenarioNames = Object.keys(scenarioMap);

// ─── Main Loop ───────────────────────────────────────────────

let readingIndex = 0;
let currentScenario = null;
let scenarioQueue = [];
let failCount = 0;

async function sendNext() {
  readingIndex++;
  let reading;
  let label = "normal";

  // Determine what to send
  if (currentScenario) {
    const result = currentScenario.next();
    if (result.done) {
      console.log("\n📋 Scenario complete.\n");
      currentScenario = null;

      // If looping, move to next scenario
      if (loopMode && scenarioQueue.length > 0) {
        const nextName = scenarioQueue.shift();
        console.log(`\n🔄 Starting scenario: ${nextName}\n`);
        currentScenario = scenarioMap[nextName]();
        generator.resetState();
        label = nextName;
        reading = currentScenario.next().value;
      } else if (loopMode) {
        // Restart the loop
        scenarioQueue = [...scenarioNames];
        const nextName = scenarioQueue.shift();
        console.log(`\n🔄 Restarting scenario loop: ${nextName}\n`);
        currentScenario = scenarioMap[nextName]();
        generator.resetState();
        label = nextName;
        reading = currentScenario.next().value;
      } else {
        // Single scenario mode — just go normal
        reading = generator.generateNormal();
        label = "normal (scenario done)";
      }
    } else {
      reading = result.value;
      label = currentScenario === scenarioMap.gas ? "gas" :
              currentScenario === scenarioMap.flood ? "flood" :
              currentScenario === scenarioMap.overheat ? "overheat" :
              currentScenario === scenarioMap.fall ? "fall" :
              currentScenario === scenarioMap.sos ? "sos" :
              currentScenario === scenarioMap.combined ? "combined" : "scenario";
    }
  } else {
    // Normal mode — try random event
    const randomEvent = generator.maybeRandomEvent();
    if (randomEvent) {
      reading = randomEvent.reading;
      label = `random-${randomEvent.dangerType}`;
    } else {
      reading = generator.generateNormal();
      label = "normal";
    }
  }

  printReading(reading, label);

  // Run risk analysis locally using the risk-module
  const localRisk = analyzeRisk(reading);
  const riskEmoji = localRisk.risk_level === "CRITICAL" ? "🔴" :
                    localRisk.risk_level === "HIGH" ? "🟠" :
                    localRisk.risk_level === "MEDIUM" ? "🟡" : "🟢";
  console.log(`  ${riskEmoji} Risk: ${localRisk.risk_level} (${localRisk.risk_score}/100) — ${localRisk.reason}`);

  try {
    const result = await postSensorData(reading);
    failCount = 0;
  } catch (err) {
    failCount++;
    console.log(`  ⚠️  Backend not available (${err.message}) — risk calculated locally`);
    if (failCount >= 5) {
      console.log("\n⚠️  Backend offline. Continuing with local risk analysis only.\n");
      failCount = 0;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  🪨  RockFall Sensor Simulator");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Device ID:    ${config.deviceId}`);
  console.log(`  API URL:      ${config.apiUrl}/api/sensor-data`);
  console.log(`  Interval:     ${config.intervalMs}ms`);
  console.log(`  Mode:         ${onceMode ? "single reading" : scenarioFlag ? `scenario: ${scenarioFlag}` : loopMode ? "loop all scenarios" : "normal (continuous)"}`);
  console.log("═══════════════════════════════════════════════════\n");

  // Handle --once mode
  if (onceMode) {
    const reading = generator.generateNormal();
    printReading(reading, "single");
    const localRisk = analyzeRisk(reading);
    const riskEmoji = localRisk.risk_level === "CRITICAL" ? "🔴" :
                      localRisk.risk_level === "HIGH" ? "🟠" :
                      localRisk.risk_level === "MEDIUM" ? "🟡" : "🟢";
    console.log(`  ${riskEmoji} Risk: ${localRisk.risk_level} (${localRisk.risk_score}/100) — ${localRisk.reason}`);
    try {
      await postSensorData(reading);
    } catch (err) {
      console.log(`  ⚠️  Backend not available — risk calculated locally`);
    }
    return;
  }

  // Handle scenario flag
  if (scenarioFlag) {
    if (!scenarioMap[scenarioFlag]) {
      console.error(`❌ Unknown scenario: ${scenarioFlag}`);
      console.error(`   Available: ${scenarioNames.join(", ")}`);
      process.exit(1);
    }
    console.log(`📋 Starting scenario: ${scenarioFlag}\n`);
    currentScenario = scenarioMap[scenarioFlag]();
    generator.resetState();
    resetRisk();
  }

  // Handle loop mode
  if (loopMode && !scenarioFlag) {
    scenarioQueue = [...scenarioNames];
    const first = scenarioQueue.shift();
    console.log(`🔄 Loop mode — starting with: ${first}\n`);
    currentScenario = scenarioMap[first]();
    generator.resetState();
  }

  // Continuous loop
  while (true) {
    await sendNext();
    await sleep(config.intervalMs);
  }
}

// ─── Start ───────────────────────────────────────────────────

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
