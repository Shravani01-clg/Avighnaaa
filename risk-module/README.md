# AI/Risk Module — Phase 1 Deliverable

Standalone risk assessment module for the RockFall (Avighnaaa) project.

## What It Does

Takes sensor data → Returns risk assessment.

```
Sensor Data (JSON)
      ↓
  Risk Module
      ↓
{ risk_score, risk_level, reason }
```

## Input Format (Common Sensor Data)

```json
{
  "device_id": "DEVICE-001",
  "temperature_c": 25.0,
  "gas_raw": 200,
  "water_level_cm": 5.0,
  "acceleration_x_ms2": 0.1,
  "acceleration_y_ms2": -0.05,
  "acceleration_z_ms2": 9.8,
  "sos": false
}
```

## Output Format (Phase 3 contract — fields always present)

```json
{
  "risk_score": 0,
  "risk_level": "LOW",
  "anomaly_detected": false,
  "anomaly_score": 0,
  "fall_state": "NORMAL",
  "fall_score": 0,
  "reason": "No major risk detected",
  "recommendation": "Normal operation: continue routine monitoring.",
  "stuck_sensors": [],
  "trend_warnings": [],
  "risk_factors": [
    { "source": "rules", "name": "baseline", "points": 0, "detail": "All sensors within normal range" }
  ]
}
```

- `anomaly_detected` — rule-based anomaly check (implausible readings / sensor faults / frozen sensors)
- `fall_state` — `NORMAL` → `SUDDEN_MOVEMENT` → `POSSIBLE_FALL` → `FALL_CONFIRMED`
- `recommendation` — what to do next (present even on invalid input)
- `stuck_sensors` / `trend_warnings` — sequence intelligence from the
  rolling window (Day 2): frozen channels and pre-threshold rising trends
- `risk_factors` — explainable per-factor contributions (≥ 1 always)

See `AI_DOCUMENTATION.md` in the repo root for the full spec.

### Risk Levels

| Level | Score Range | Description |
|-------|-------------|-------------|
| LOW | 0-29 | Normal conditions |
| MEDIUM | 30-54 | Elevated concern, monitor closely |
| HIGH | 55-79 | Immediate action required |
| CRITICAL | 80-100 | Emergency, evacuate area |

## How to Use

### In Node.js

```javascript
const { analyzeRisk } = require("./risk-module");

const result = analyzeRisk({
  device_id: "DEVICE-001",
  temperature_c: 50,
  gas_raw: 700,
  water_level_cm: 5,
  acceleration_x_ms2: 0.1,
  acceleration_y_ms2: -0.05,
  acceleration_z_ms2: 9.8,
  sos: false,
});

console.log(result);
// { risk_score: 65, risk_level: "HIGH", reason: "High temperature; High gas level" }
```

### Command Line

```bash
# Run tests
node risk-module/test.js

# Check output format
node -e "const { analyzeRisk } = require('./risk-module'); console.log(JSON.stringify(analyzeRisk({device_id:'test',temperature_c:50,gas_raw:700,water_level_cm:5,acceleration_x_ms2:0,acceleration_y_ms2:0,acceleration_z_ms2:9.8,sos:false}), null, 2))"
```

## Features

- **4-level risk assessment**: LOW → MEDIUM → HIGH → CRITICAL
- **Fall detection**: Accelerometer-based free-fall + impact algorithm
- **Combined danger multiplier**: Multiple hazards compound risk exponentially
- **Safety floor**: Any CRITICAL sensor forces risk to at least HIGH
- **Zero dependencies**: Pure Node.js, no external packages
- **Standalone**: No backend, database, or network required

## Risk Factors

| Factor | Scoring |
|--------|---------|
| Temperature | ≥55°C: +35, ≥45°C: +30, ≥38°C: +10 |
| Gas Level | ≥800: +35, ≥600: +30, ≥400: +10 |
| Water Level | ≥40cm: +30, ≥25cm: +25, ≥15cm: +10 |
| SOS Button | Pressed: +40 |
| Fall Detection | Detected: up to +100 |
| Combined Danger | 2 hazards: 1.3x, 3: 1.6x, 4+: 2.0x multiplier |

Alert stability: escalation is immediate; de-escalation waits for 3
consecutive readings below the held level (per device) so levels never
flap on threshold noise.

## Files

| File | Purpose |
|------|---------|
| `index.js` | Main entry point — `analyzeRisk(sensorData)` |
| `riskEngine.js` | Risk calculation + rule-based anomaly detection + hysteresis + recommendation + risk factors |
| `fallDetection.js` | Accelerometer fall detection with 4-state progression |
| `rollingWindow.js` | Day 2: per-device rolling window — stuck-sensor + trend detection |
| `test.js` | Legacy test script |
| `validate.js` | Validation gate (run this — 27 checks) |
| `README.md` | This file |

## Testing

```bash
node risk-module/validate.js   # gate — scenarios, contract, fall states, anomaly FP, alert stability, sequence intelligence (27 checks)
node risk-module/test.js       # legacy suite
```

Expected output:
```
═══════════════════════════════════════════════════
  🧪  Risk Module — Test Suite
═══════════════════════════════════════════════════

  ✅ Normal (safe)
     Score: 0 | Level: LOW
     Reason: No major risk detected

  ✅ High temperature
     Score: 55 | Level: HIGH
     Reason: High temperature

  ...

───────────────────────────────────────────────────
  Results: 7 passed, 0 failed
───────────────────────────────────────────────────
```
