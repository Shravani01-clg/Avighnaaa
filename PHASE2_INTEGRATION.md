# Phase 2 Integration — Person 3 → Person 1

## Input Format (Sensor Data)

The simulator sends this JSON to `POST /api/sensor-data`:

```json
{
  "device_id": "SIM-DEVICE-001",
  "temperature_c": 28.5,
  "gas_raw": 200,
  "water_level_cm": 5.2,
  "acceleration_x_ms2": 0.05,
  "acceleration_y_ms2": -0.02,
  "acceleration_z_ms2": 9.81,
  "sos": false,
  "timestamp": "2026-09-06T07:45:00.000Z"
}
```

| Field | Type | Unit | Description |
|-------|------|------|-------------|
| `device_id` | string | — | Unique device identifier |
| `temperature_c` | number | °C | Temperature reading |
| `gas_raw` | number | — | Gas sensor raw ADC value |
| `water_level_cm` | number | cm | Water level |
| `acceleration_x_ms2` | number | m/s² | X-axis acceleration |
| `acceleration_y_ms2` | number | m/s² | Y-axis acceleration |
| `acceleration_z_ms2` | number | m/s² | Z-axis acceleration |
| `sos` | boolean | — | SOS button pressed |
| `timestamp` | string | ISO 8601 | Reading timestamp |

---

## Output Format (Risk Assessment)

The risk module returns this:

```json
{
  "risk_score": 91,
  "risk_level": "CRITICAL",
  "reason": "High temperature; High gas level; High water level; Combined danger (3 simultaneous hazards)"
}
```

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `risk_score` | number | 0-100 | Risk intensity |
| `risk_level` | string | LOW / MEDIUM / HIGH / CRITICAL | Risk classification |
| `reason` | string | — | Human-readable explanation |

### Risk Level Thresholds

| Level | Score Range | Action |
|-------|-------------|--------|
| LOW | 0-29 | Normal monitoring |
| MEDIUM | 30-54 | Enhanced monitoring, prepare alerts |
| HIGH | 55-79 | Send alerts, notify supervisors |
| CRITICAL | 80-100 | Emergency alerts, evacuate area |

---

## Alert Types Generated

When risk is calculated, these alerts can be triggered:

| Alert Type | Severity | Trigger Condition |
|------------|----------|-------------------|
| `TEMP_DANGER` | HIGH | temperature_c ≥ 45°C |
| `GAS_DANGER` | HIGH | gas_raw ≥ 600 |
| `FLOOD_DANGER` | HIGH | water_level_cm ≥ 25cm |
| `FALL_DETECTED` | CRITICAL | Fall algorithm confirms fall |
| `SOS` | CRITICAL | sos = true |
| `COMBINED_DANGER` | CRITICAL | 2+ simultaneous hazards |

---

## How to Use in Backend

### Option 1: Direct Integration (Recommended)

In `controllers/sensorController.js`:

```javascript
const { analyzeRisk } = require("../risk-module");

// When sensor data arrives:
const risk = analyzeRisk(req.body);
// risk.risk_score, risk.risk_level, risk.reason
```

### Option 2: HTTP Call to AI Server (Optional)

If using the Python AI server:

```bash
# Start AI server
cd ai-module && python server.py

# Call from backend
POST http://localhost:5001/predict/all
Body: { ...sensorData }
```

---

## Test Results

| Scenario | Expected Risk | Actual Risk | Status |
|----------|---------------|-------------|--------|
| Normal | LOW (0) | LOW (0) | ✅ |
| High Temperature | MEDIUM (30) | MEDIUM (30) | ✅ |
| High Gas | MEDIUM (30) | MEDIUM (30) | ✅ |
| Flood | LOW (25) | LOW (25) | ✅ |
| SOS | HIGH (40) | HIGH (40) | ✅ |
| Combined (3 hazards) | CRITICAL (100) | CRITICAL (100) | ✅ |

---

## Simulator Commands

```bash
# Normal mode (continuous)
node simulator/index.js

# Specific scenario
node simulator/index.js --scenario gas
node simulator/index.js --scenario flood
node simulator/index.js --scenario overheat
node simulator/index.js --scenario fall
node simulator/index.js --scenario sos
node simulator/index.js --scenario combined

# Loop through all scenarios
node simulator/index.js --loop

# Single reading
node simulator/index.js --once
```

---

## Files to Integrate

| File | Purpose | Location |
|------|---------|----------|
| `risk-module/index.js` | Main entry point | `require("../risk-module")` |
| `risk-module/riskEngine.js` | Risk calculation | Used by index.js |
| `risk-module/fallDetection.js` | Fall detection | Used by riskEngine.js |

---

## Summary

**Person 1 needs to:**

1. ✅ Keep existing API endpoints as-is
2. ✅ Add `const { analyzeRisk } = require("../risk-module");` in sensorController
3. ✅ Call `analyzeRisk(req.body)` when sensor data arrives
4. ✅ Store `risk_score`, `risk_level`, `reason` in risk_predictions table
5. ✅ Create alerts based on risk level

**No changes needed to:**
- API endpoints
- Database schema (already has risk_predictions table)
- Device authentication
- Worker management

The risk module is a drop-in addition that enhances the existing backend.
