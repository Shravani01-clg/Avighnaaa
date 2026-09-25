/**
 * RockFall — End-to-End Demo (Person 3)
 *
 * One command that tells the whole AI story through the real backend:
 *
 *   1. Normal reading        → LOW + routine-monitoring advice
 *   2. Gas ramp              → trend warning BEFORE the threshold + escalation
 *   3. Frozen sensor         → stuck detection over a rolling window + device alert
 *   4. Crisis (T+G+W+SOS)    → CRITICAL + full explainability (aiRiskFactors)
 *   5. Worker fall           → FALL_CONFIRMED + rescue recommendation that
 *                              keeps advising while the worker is still down
 *
 * The demo always spawns ITS OWN backend on port 5099, so it runs the code
 * currently on disk (no dependency on whatever server happens to be running)
 * and never touches your normal backend on 5002.
 *
 * Usage:
 *   node simulator/demo.js             # AI server on :5001 if available (ml_fusion),
 *   node simulator/demo.js --no-ai     #   otherwise graceful rules_fallback
 *   node simulator/demo.js --help      # force AI offline → fail-safe demonstration
 *
 * Exit code 0 = all demo verdicts passed.
 *
 * The DEVICE_API_KEY is read from .env silently and never printed.
 */

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const BACKEND_PORT = 5099;
const AI_PORT = 5001;
const AI_URL = `http://127.0.0.1:${AI_PORT}`;
const DEAD_AI_URL = "http://127.0.0.1:59999"; // nothing listens here → instant fallback

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
RockFall E2E demo

  node simulator/demo.js           Run the full story (uses AI server on :5001 if up)
  node simulator/demo.js --no-ai   Force the AI server offline → fail-safe demo
  node simulator/demo.js --help    Show this help

Spawns its own backend on port ${BACKEND_PORT} from the code on disk; your normal
backend (port 5002) is left alone. Requires .env with DEVICE_API_KEY.`);
  process.exit(0);
}
const noAi = args.includes("--no-ai");

// ─── Utilities ───────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnvKey(key) {
  try {
    const text = fs.readFileSync(path.join(REPO, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        if (m[1] === key) return m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(400, () => done(false));
  });
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tcpProbe(port)) return true;
    await sleep(300);
  }
  return false;
}

function probeAi() {
  return new Promise((resolve) => {
    const req = http.get(`${AI_URL}/health`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(res.statusCode === 200));
    });
    req.setTimeout(4000, () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

// ─── Verdict tracking ────────────────────────────────────────

const verdicts = [];
function check(name, ok, info) {
  verdicts.push({ name, ok: !!ok });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${info ? ` — ${info}` : ""}`);
}
function header(title) {
  console.log(`\n${"═".repeat(66)}\n  ${title}\n${"═".repeat(66)}`);
}

// ─── HTTP against our spawned backend ────────────────────────

let deviceApiKey = null;

function postReading(reading) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(reading);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: BACKEND_PORT,
        path: "/api/sensor-data",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "x-device-key": deviceApiKey,
        },
        timeout: 15000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch (_) { resolve({ status: res.statusCode, body: null, raw: d }); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.write(body);
    req.end();
  });
}

function showReading(label, resp) {
  const b = resp.body || {};
  const r = b.risk || {};
  const ai = b.ai || {};
  const ml = ai.mlRiskPrediction ? ` | ml: ${ai.mlRiskPrediction} (${Math.round((ai.mlConfidence || 0) * 100)}%)` : "";
  console.log(
    `    ${label.padEnd(9)} → ${String(r.risk_level).padEnd(8)} score=${String(r.risk_score).padEnd(4)}` +
    `anomaly=${String(r.anomaly_detected).padEnd(6)} fall=${String(r.fall_state).padEnd(15)}` +
    `ai=${ai.source || "?"}${ml}`
  );
  if (b.alertsCreated && b.alertsCreated.length) {
    console.log(`    ${" ".repeat(9)}  alerts: ${b.alertsCreated.join(", ")}`);
  }
}

function showAdvice(resp, { factors = false, stuck = false, trend = false } = {}) {
  const ai = (resp.body && resp.body.ai) || {};
  if (ai.recommendation) console.log(`    advice: ${ai.recommendation}`);
  if (stuck && ai.stuckSensors && ai.stuckSensors.length) {
    console.log(`    stuck sensors: ${ai.stuckSensors.join(", ")}`);
  }
  if (trend && ai.trendWarnings && ai.trendWarnings.length) {
    for (const w of ai.trendWarnings) console.log(`    trend: ${w.message} (rate ${w.rate_per_min}/min, eta ${w.eta_minutes} min)`);
  }
  if (factors && ai.aiRiskFactors && ai.aiRiskFactors.length) {
    console.log(`    explainability (${ai.aiRiskFactors.length} factors):`);
    for (const f of ai.aiRiskFactors) {
      console.log(`      • [${f.source}] ${f.name}${f.points ? ` +${f.points}` : ""} — ${f.detail}`);
    }
  }
}

// ─── Backend child process ───────────────────────────────────

let backend = null;
const backendLog = [];

function spawnBackend(aiUrl) {
  backend = spawn(process.execPath, ["server.js"], {
    cwd: REPO,
    env: { ...process.env, PORT: String(BACKEND_PORT), AI_SERVER_URL: aiUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim()) {
        backendLog.push(line);
        if (backendLog.length > 60) backendLog.shift();
      }
    }
  };
  backend.stdout.on("data", capture);
  backend.stderr.on("data", capture);
  backend.on("error", (err) => {
    console.error(`Failed to start backend: ${err.message}`);
    process.exit(1);
  });
}

function killBackend() {
  if (backend && backend.exitCode === null) {
    try { backend.kill(); } catch (_) { /* ignore */ }
  }
}

process.on("exit", killBackend);
process.on("SIGINT", () => { killBackend(); process.exit(130); });
process.on("SIGTERM", () => { killBackend(); process.exit(143); });

// ─── Reading sequences ───────────────────────────────────────

const STANDING = { acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 };

function normalReadings() {
  return [
    { temperature_c: 28.3, gas_raw: 214, water_level_cm: 5.1, ...STANDING },
    { temperature_c: 28.7, gas_raw: 196, water_level_cm: 5.4, ...STANDING },
  ];
}

function rampReadings() {
  const now = Date.now();
  return [200, 300, 400, 500, 600, 700].map((gas_raw, i) => ({
    temperature_c: 28 + i * 0.4,
    gas_raw,
    water_level_cm: 5 + i * 0.2,
    ...STANDING,
    // Backdated 10 s apart → trend math sees a real 50 s window
    timestamp: new Date(now - (5 - i) * 10_000).toISOString(),
  }));
}

function stuckReadings() {
  const frozen = { temperature_c: 29.0, gas_raw: 215, water_level_cm: 5.0, ...STANDING };
  return Array.from({ length: 10 }, () => ({ ...frozen }));
}

function crisisReading() {
  return { temperature_c: 50, gas_raw: 700, water_level_cm: 30, ...STANDING, sos: true };
}

function fallReadings() {
  return [
    { temperature_c: 28, gas_raw: 200, water_level_cm: 5, acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 9.8 }, // standing
    { temperature_c: 28, gas_raw: 200, water_level_cm: 5, acceleration_x_ms2: 0, acceleration_y_ms2: 0, acceleration_z_ms2: 0.4 }, // free-fall
    { temperature_c: 28, gas_raw: 200, water_level_cm: 5, acceleration_x_ms2: 25, acceleration_y_ms2: 20, acceleration_z_ms2: 35 }, // impact
    { temperature_c: 28, gas_raw: 200, water_level_cm: 5, acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 },  // lying
    { temperature_c: 28, gas_raw: 200, water_level_cm: 5, acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 },
    { temperature_c: 28, gas_raw: 200, water_level_cm: 5, acceleration_x_ms2: 6, acceleration_y_ms2: 1.5, acceleration_z_ms2: 4 },
  ];
}

async function sendSequence(deviceId, readings, labelFn) {
  const responses = [];
  for (let i = 0; i < readings.length; i++) {
    const resp = await postReading({ device_id: deviceId, ...readings[i] });
    responses.push(resp);
    if (labelFn) showReading(labelFn(i, readings.length), resp);
    if (resp.status !== 201 || !resp.body || resp.body.success !== true) {
      console.log(`      ⚠️  unexpected response: HTTP ${resp.status} ${JSON.stringify(resp.body || resp.raw || {}).slice(0, 200)}`);
    }
    await sleep(120);
  }
  // If the backend rejected EVERY reading of a phase, dump its log and stop.
  if (responses.length > 0 && responses.every((r) => r.status !== 201)) {
    console.error("\nThe backend rejected every reading — aborting. Last backend output:");
    for (const line of backendLog.slice(-20)) console.error("  " + line);
    killBackend();
    process.exit(1);
  }
  return responses;
}

/** Safe accessor: the parsed body, or {} when a request failed. */
const body = (resp) => (resp && resp.body) || {};

// ─── Main ────────────────────────────────────────────────────

async function main() {
  deviceApiKey = loadEnvKey("DEVICE_API_KEY");
  if (!deviceApiKey) {
    console.error("DEVICE_API_KEY not found in .env — cannot authenticate demo readings.");
    process.exit(1);
  }

  if (await tcpProbe(BACKEND_PORT)) {
    console.error(`Port ${BACKEND_PORT} is already in use — stop that process first so the demo can run its own backend.`);
    process.exit(1);
  }

  const aiUp = noAi ? false : await probeAi();
  const aiUrl = noAi ? DEAD_AI_URL : AI_URL;

  spawnBackend(aiUrl);
  console.log(`\nStarting demo backend on port ${BACKEND_PORT} (AI: ${noAi ? "forced OFFLINE" : aiUp ? `up → ${AI_URL}` : "not reachable → rules_fallback"}) …`);
  if (!(await waitForPort(BACKEND_PORT))) {
    console.error("Backend did not become ready in 30 s. Last backend output:");
    for (const line of backendLog.slice(-20)) console.error("  " + line);
    process.exit(1);
  }
  console.log("Backend ready.\n");

  // The Supabase `devices` table has a foreign key: readings must belong to
  // a registered device. Register one run-unique device per phase using the
  // project's own data layer (same code path the backend uses).
  require("dotenv").config({ path: path.join(REPO, ".env") });
  const store = require(path.join(REPO, "config", "dataStore"));
  const run = Date.now().toString(36).slice(-4).toUpperCase();
  const id = (name) => `DEMO-${run}-${name}`;
  const all = [];
  try {
    // Discover the real schema by cloning an existing devices row (Person 1's
    // table has NOT NULL / FK columns such as worker_id that we must satisfy).
    // Only identity fields are overridden; the serial id is left to default.
    const sampleRows = await store.select("devices", { limit: 1 });
    if (!sampleRows || sampleRows.length === 0) {
      throw new Error("devices table is empty — cannot register demo devices");
    }
    for (const phase of ["NORMAL", "RAMP", "STUCK", "CRISIS", "FALL"]) {
      const record = { ...sampleRows[0] };
      delete record.id;
      record.device_id = id(phase);
      if ("name" in record) record.name = `RockFall demo ${phase.toLowerCase()} ${run}`;
      if ("created_at" in record) record.created_at = new Date().toISOString();
      await store.insert("devices", record);
    }
    console.log(`Demo devices registered (DEMO-${run}-*).\n`);
  } catch (err) {
    console.error(`Device registration failed: ${err.message}`);
    killBackend();
    process.exit(1);
  }

  // ── Phase 1: normal ────────────────────────────────────────
  header("PHASE 1 · Normal reading → LOW + routine advice");
  const p1 = await sendSequence(id("NORMAL"), normalReadings(), (i, n) => `reading ${i + 1}/${n}`);
  all.push(...p1);
  const b1 = body(p1[p1.length - 1]);
  showAdvice(p1[p1.length - 1], { factors: true });
  check("Normal reading stays LOW with advice present",
    b1.risk && b1.risk.risk_level === "LOW" && !!(b1.ai && b1.ai.recommendation),
    `level=${b1.risk && b1.risk.risk_level}`);

  // ── Phase 2: gas ramp → trend warning ──────────────────────
  header("PHASE 2 · Gas ramp (200→700 in 50 s) → trend warning + escalation");
  const p2 = await sendSequence(id("RAMP"), rampReadings(), (i, n) => `gas ${200 + i * 100}`);
  all.push(...p2);
  const last2 = body(p2[p2.length - 1]);
  showAdvice(p2[p2.length - 1], { trend: true });
  check("Trend warning raised BEFORE the threshold", ((last2.ai || {}).trendWarnings || []).length >= 1,
    ((last2.ai || {}).trendWarnings || []).map((w) => w.message).join("; ") || "none");
  check("Escalated to MEDIUM+ with GAS_DANGER alert",
    ["MEDIUM", "HIGH", "CRITICAL"].includes(last2.risk && last2.risk.risk_level) && (last2.alertsCreated || []).includes("GAS_DANGER"),
    `level=${last2.risk && last2.risk.risk_level}`);

  // ── Phase 3: frozen sensor ─────────────────────────────────
  header("PHASE 3 · Frozen sensor (10 identical readings) → stuck detection");
  const p3 = await sendSequence(id("STUCK"), stuckReadings(), (i, n) => `identical ${i + 1}/${n}`);
  all.push(...p3);
  const last3 = body(p3[p3.length - 1]);
  showAdvice(p3[p3.length - 1], { stuck: true, factors: true });
  check("Stuck sensors detected via rolling window",
    ((last3.ai || {}).stuckSensors || []).length >= 3, ((last3.ai || {}).stuckSensors || []).join(", ") || "none");
  check("Anomaly flagged + SENSOR_STUCK alert raised",
    (last3.risk || {}).anomaly_detected === true && (last3.alertsCreated || []).includes("SENSOR_STUCK"),
    `anomaly=${(last3.risk || {}).anomaly_detected}`);

  // ── Phase 4: crisis → CRITICAL + explainability ────────────
  header("PHASE 4 · Crisis (temp 50 + gas 700 + water 30 + SOS) → CRITICAL + explainability");
  const p4 = await sendSequence(id("CRISIS"), [crisisReading(), crisisReading()], (i, n) => `crisis ${i + 1}/${n}`);
  all.push(...p4);
  const last4 = body(p4[p4.length - 1]);
  showAdvice(p4[p4.length - 1], { factors: true });
  check("CRITICAL with SOS + COMBINED_DANGER alerts",
    (last4.risk || {}).risk_level === "CRITICAL" &&
    (last4.alertsCreated || []).includes("SOS") &&
    (last4.alertsCreated || []).includes("COMBINED_DANGER"),
    `level=${(last4.risk || {}).risk_level}`);
  check("Explainability lists every contributor",
    ((last4.ai || {}).aiRiskFactors || []).length >= 5, `${((last4.ai || {}).aiRiskFactors || []).length} factors`);

  // ── Phase 5: fall → rescue recommendation ──────────────────
  header("PHASE 5 · Worker fall (standing → free-fall → impact → lying) → rescue");
  const p5 = await sendSequence(id("FALL"), fallReadings(), (i, n) => `fall step ${i + 1}/${n}`);
  all.push(...p5);
  const last5 = body(p5[p5.length - 1]);
  showAdvice(p5[p5.length - 1], { factors: true });
  check("Fall confirmed and worker-still-down advice persists",
    (last5.risk || {}).fall_state === "FALL_CONFIRMED" && /still down/i.test((last5.ai || {}).recommendation || ""),
    `fall_state=${(last5.risk || {}).fall_state}`);

  // ── Mode verdict ───────────────────────────────────────────
  header("SYSTEM-MODE VERDICT");
  const sources = [...new Set(all.map((r) => ((r.body || {}).ai || {}).source || "missing"))];
  const adviceOk = all.every((r) => (r.body || {}).ai && typeof r.body.ai.recommendation === "string");
  const httpOk = all.every((r) => r.status === 201);
  if (noAi) {
    check("Fail-safe: all readings processed with AI server unreachable",
      httpOk && sources.length === 1 && sources[0] === "rules_fallback",
      `${all.length}/${all.length} readings, mode=${sources.join("/")}`);
    check("Fail-safe: advice + explainability still present on every response",
      adviceOk && all.every((r) => Array.isArray(((r.body || {}).ai || {}).aiRiskFactors)),
      "recommendation + aiRiskFactors never null");
  } else if (aiUp) {
    check("Full-stack: ML fusion mode active",
      httpOk && sources.includes("ml_fusion"), `mode=${sources.join("/")}`);
    check("Advice + explainability present on every response", adviceOk);
  } else {
    console.log(`  ℹ️  AI server not reachable on :${AI_PORT} — system ran in rules_fallback (graceful degradation).`);
    check("Backend kept serving in rules_fallback mode", httpOk && sources.length === 1 && sources[0] === "rules_fallback",
      `mode=${sources.join("/")}`);
    check("Advice + explainability present on every response", adviceOk);
  }

  // ── Backend log notes (honesty pass) ───────────────────────
  const logNotes = backendLog.filter((l) => /Alert creation failed|error/i.test(l));
  if (logNotes.length) {
    console.log("\n  Backend log notes:");
    for (const l of logNotes.slice(-5)) console.log(`    ${l}`);
  }

  // ── Summary ────────────────────────────────────────────────
  const passed = verdicts.filter((v) => v.ok).length;
  header(`DEMO SUMMARY — ${passed}/${verdicts.length} verdicts passed`);
  for (const v of verdicts) console.log(`  ${v.ok ? "✅" : "❌"} ${v.name}`);
  console.log(`\n  Total readings sent: ${all.length} | mode: ${sources.join("/")}`);
  console.log(`  Reproduce: node simulator/demo.js${noAi ? " --no-ai" : ""}\n`);

  killBackend();
  await sleep(500);
  process.exit(passed === verdicts.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nDemo failed: ${err.message}`);
  killBackend();
  process.exit(1);
});
