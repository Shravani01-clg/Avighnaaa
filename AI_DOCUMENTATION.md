# AI Documentation — Person 3 (AI/ML Lead)

Phase 3 deliverable. Explains the model purpose, input features, output,
risk categories, detection logic, and model limitations for the Avighnaaa
(RockFall) mine-safety AI.

---

## 1. Model Purpose

Two cooperating decision layers turn raw MPU6050 + environmental sensor
readings into a single, actionable risk assessment:

| Layer | Where | Purpose |
|---|---|---|
| **Rule engine** | `risk-module/riskEngine.js` | The safety backbone. Deterministic threshold scoring, explainable `reason` strings, instant alerts. Always runs; never disabled. |
| **ML models** | `ai-module/` (Python) | The second opinion. Catches unusual *patterns* the thresholds miss and predicts risk level from learned scenario shapes. |

**Fusion rule:** the AI never *downgrades* a risk level — final level is the
MAX of rule-based and ML assessments (`controllers/aiIntegration.js`,
`ai-module/server.py /predict/all`). If the ML server is down, the system
degrades gracefully to rules-only with zero behavior change to alert types.

**Why both:** rules guarantee known hazards (gas ≥ 600 etc.) always fire the
right alert, even with zero training data. ML covers what thresholds can't
express — slow drift, weird combinations, silent sensor faults.

---

## 2. Input Features

Every reading is one JSON object (ESP32 → `POST /api/sensor-data` → AI):

| Feature | Unit | Role | Used by |
|---|---|---|---|
| `temperature_c` | °C | Fire/overheat hazard | rules + both models |
| `gas_raw` | ADC counts | Gas (MQ-type sensor) hazard | rules + both models |
| `water_level_cm` | cm | Flood hazard | rules + both models |
| `acceleration_x_ms2` | m/s² | MPU6050 X axis | fall detection + models |
| `acceleration_y_ms2` | m/s² | MPU6050 Y axis | fall detection + models |
| `acceleration_z_ms2` | m/s² | MPU6050 Z axis (≈9.8 upright) | fall detection + models |
| `sos` | boolean | Worker-triggered emergency | rules + risk model |

Derived internally: total acceleration |a| = √(x²+y²+z²), Z-axis delta from
the learned upright baseline, per-axis spikes, anomaly envelope distance.

---

## 3. Output

**The contract — these fields are ALWAYS present** (validated by
`risk-module/validate.js`, even for invalid/empty input):

```json
{
  "risk_level": "HIGH",
  "risk_score": 79,
  "anomaly_detected": true,
  "fall_state": "FALL_CONFIRMED",
  "reason": "High temperature; Anomaly: Implausible temperature (120°C)"
}
```

| Field | Type | Notes |
|---|---|---|
| `risk_level` | `"LOW" \| "MEDIUM" \| "HIGH" \| "CRITICAL"` | Final fused level |
| `risk_score` | number 0–100 | Fused intensity score |
| `anomaly_detected` | boolean | True if rules **or** ML flag the reading |
| `fall_state` | `NORMAL \| SUDDEN_MOVEMENT \| POSSIBLE_FALL \| FALL_CONFIRMED` | Spec progression |
| `reason` | string | Human-readable explanation (always non-empty) |

Supplementary fields: `anomaly_score`, `fall_score`, and (from the backend)
`ai` block with ML detail, plus `alertsCreated` list.

---

## 4. Risk Categories

| Level | Score | Meaning | Action |
|---|---|---|---|
| **LOW** | 0–29 | Normal conditions | Routine monitoring |
| **MEDIUM** | 30–54 | Elevated concern | Enhanced monitoring; **floor for any HIGH-level hazard** |
| **HIGH** | 55–79 | Dangerous | Send alerts, notify supervisors; **floor for any CRITICAL sensor or confirmed-fall context** |
| **CRITICAL** | 80–100 | Emergency | Evacuate / immediate response |

Floors (Phase 3): a single HIGH hazard can no longer score out as LOW
(rising water 25 pts → MEDIUM minimum), and any CRITICAL sensor forces at
least HIGH regardless of the arithmetic sum.

---

## 5. Detection Logic

### 5.1 Rule engine (`risk-module/riskEngine.js`)

Per-sensor additive scoring, then fusion:

| Factor | Points | Trigger |
|---|---|---|
| Elevated temp | +10 | ≥ 38 °C |
| High temp | +25 | ≥ 45 °C (CRITICAL at ≥ 55 °C → +35) |
| Elevated gas | +10 | ≥ 400 |
| High gas | +25 | ≥ 600 (CRITICAL at ≥ 800 → +35) |
| Rising water | +10 | ≥ 15 cm |
| High water | +20 | ≥ 25 cm (CRITICAL at ≥ 40 cm → +30) |
| SOS | +40 | button pressed (always CRITICAL sensor) |
| Fall | up to +100 | see 5.3 |
| **Combined multiplier** | ×1.3 / ×1.6 / ×2.0 | 2 / 3 / 4+ simultaneous hazards |

Alerts derived from the same scores: `TEMP_DANGER`, `GAS_DANGER`,
`FLOOD_DANGER`, `SOS`, `FALL_DETECTED`, `POSSIBLE_FALL`, `COMBINED_DANGER`,
`ANOMALY`.

### 5.2 Anomaly detection (dual, both sides of the stack)

- **Rule-based** (`detectAnomaly` in riskEngine): flags *implausible*
  readings — impossible temperatures, negative gas/water, motion signatures
  matching no known pattern, missing fields. Hazard-level values are NOT
  anomalies (they're known danger states the thresholds handle).
- **ML hybrid** (`ai-module/anomaly_detector.py`):
  1. Hardware feasibility priors (physical sensor limits — nothing statistical can learn that a negative gas reading is impossible),
  2. Robust per-feature bounds (median ± 8·IQR on normal data) for single-axis sensor faults,
  3. Isolation Forest for unusual *combinations* of plausible values.

Trained ONLY on readings the rule engine scores LOW — ML's definition of
"normal" is exactly deployment's definition of "normal".

### 5.3 Fall detection (`risk-module/fallDetection.js`, MPU6050)

Physics: free-fall (|a| ≈ 0) → impact (|a| spike) → orientation change
(Z drops below the upright baseline).

| State | Meaning | Trigger |
|---|---|---|
| `NORMAL` | Normal movement | default |
| `SUDDEN_MOVEMENT` | jerk/spike, watching | any nonzero fall score < 40 |
| `POSSIBLE_FALL` | signature forming | score ≥ 40 (e.g. free-fall alone) |
| `FALL_CONFIRMED` | emergency | score ≥ 70 — needs impact **and** (free-fall window or orientation) |

State persists while the worker remains lying down (cooldown period), and
clears to NORMAL after sustained upright readings. A single orientation
change can never confirm a fall (worker may have bent down).

### 5.4 ML risk model (`ai-module/risk_predictor.py`)

Gradient Boosting classifier trained on ~3.5k labeled readings generated by
`dataset_generator.py`, labeled by a Python port of the rule engine so
training labels match deployment behavior. Maps predictions onto the same
LOW/MEDIUM/HIGH/CRITICAL scale with confidence and class probabilities.

---

## 6. Model Limitations

1. **Fall detection needs the impact reading.** A fall where the impact is
   missed by the sampling window falls back to POSSIBLE_FALL (free-fall or
   lying-down alone cannot confirm). Tuned to favor missed falls over false
   emergencies.
2. **Stateless single-reading anomaly API cannot catch stuck sensors.** A
   frozen sensor outputting a plausible constant (28.000 °C forever) looks
   identical to a real reading in isolation. Catching it requires sequence
   variance tracking (future work: rolling window in the backend).
3. **Simulator-trained ML.** Models learn the simulator's physics (same
   family as the dataset generator). Real mine data will differ; retrain
   with `python train.py` once real labeled data exists.
4. **Per-device fall session state.** Fall state is per-process; a
   multi-instance backend needs sticky routing or shared state per device.
5. **AI server is optional by design.** With it down, ML anomaly
   detection and risk upgrades are unavailable — rules still protect all
   known hazards. The `ANOMALY` alert type only fires when ML is reachable.
6. **Anomaly FP budget.** ML false-positive rate on normal data measured at
   ≤ 0.5% (limit 5% in `validate_models.py`; bounds are mixture-aware to
   include legitimate lying/crouch postures). Anomalies boost risk by up to
   +20 points, so persistent FP noise could elevate scores — monitor in
   production.

---

## 7. How to Run Everything

```bash
# Rules + validation (no dependencies)
node risk-module/validate.js          # Phase 3 gate — 15 checks
node risk-module/test.js              # legacy suite — 7 tests

# ML training + validation
cd ai-module
python train.py                       # regenerate data + models
python validate_models.py             # Phase 3 ML gate — 4 checks

# Servers
python ai-module/server.py --load-models   # AI server :5001
PORT=5002 DEVICE_API_KEY=... node server.js  # backend :5002

# Simulator (Person 2)
cd simulator && API_URL=http://localhost:5002 DEVICE_API_KEY=... node index.js --scenario fall
```
