"""
Dataset Generator

Generates labeled sensor data for training ML models.
Uses the same physics as the Node.js simulator but produces CSV/JSON datasets.

Scenarios generate readings; labels are produced by rule_label() — a
Python mirror of the deployed riskEngine.js (see its docstring), so
training labels always match deployment behavior:
  - normal / elevated-but-safe: LOW
  - hazard buildups: MEDIUM → HIGH → CRITICAL as thresholds are crossed
  - fall / SOS / combined danger: HIGH or CRITICAL (multiplier + floors)
"""

import numpy as np
import pandas as pd
import json
import os

# ─── Rule Engine Port (label consistency) ────────────────────

def rule_label(row):
    """
    Python port of the deployed risk-module/riskEngine.js scoring, used to
    label training data. Phase 3 requirement: ML training labels must match
    deployment behavior, otherwise the model 'learns' a different definition
    of risk than the one the rules enforce.

    Mirrors riskEngine.js exactly:
      per-sensor scores   temp 35/30/10, gas 35/30/10, water 30/25/10,
                          SOS 40 (all thresholds 38/45/55, 400/600/800,
                          15/25/40),
      danger multiplier   2 signals → ×1.3, 3 → ×1.6, ≥4 → ×2.0,
      score → level       ≥80 CRITICAL, ≥55 HIGH, ≥30 MEDIUM, else LOW,
      hazard floors       any HIGH ⇒ ≥MEDIUM, any CRITICAL ⇒ ≥HIGH
                          (including the MEDIUM→HIGH critical floor).

    Fall detection is a stateless impact/free-fall heuristic standing in
    for the JS session state machine — rows in coherent fall sequences get
    their terminal-state label. Documented as a port limitation; fall rows
    are never LOW either way, so the anomaly 'normal' pool is unaffected.
    """
    temp = row["temperature_c"]
    gas = row["gas_raw"]
    water = row["water_level_cm"]
    ax, ay, az = row["acceleration_x_ms2"], row["acceleration_y_ms2"], row["acceleration_z_ms2"]
    sos = bool(row.get("sos", False))

    # Per-sensor score + level (mirrors scoreTemperature/scoreGas/scoreWater/scoreSOS)
    if temp >= 55: t_s, t_l = 35, "critical"
    elif temp >= 45: t_s, t_l = 30, "high"
    elif temp >= 38: t_s, t_l = 10, "elevated"
    else: t_s, t_l = 0, "safe"

    if gas >= 800: g_s, g_l = 35, "critical"
    elif gas >= 600: g_s, g_l = 30, "high"
    elif gas >= 400: g_s, g_l = 10, "elevated"
    else: g_s, g_l = 0, "safe"

    if water >= 40: w_s, w_l = 30, "critical"
    elif water >= 25: w_s, w_l = 25, "high"
    elif water >= 15: w_s, w_l = 10, "elevated"
    else: w_s, w_l = 0, "safe"

    s_s, s_l = (40, "critical") if sos else (0, "safe")

    # Stateless fall heuristic (see docstring): impact-range magnitude →
    # critical (matches a confirmed fall), free-fall/tilted → high
    # (mirrors JS "fallScore > 30 ⇒ high"), otherwise safe.
    total_a = (ax ** 2 + ay ** 2 + az ** 2) ** 0.5
    if total_a > 25:
        f_s, f_l = 50, "critical"
    elif total_a < 2.0 or (4 < az < 7 and total_a > 6):
        f_s, f_l = 40, "high"
    else:
        f_s, f_l = 0, "safe"

    # Combined danger multiplier (mirrors countDangerSignals + calculateRisk)
    danger = 0
    if t_l in ("high", "critical"): danger += 1
    if g_l in ("high", "critical"): danger += 1
    if w_l in ("high", "critical"): danger += 1
    if s_l == "critical": danger += 1
    if f_l in ("high", "critical"): danger += 1
    multiplier = 2.0 if danger >= 4 else 1.6 if danger == 3 else 1.3 if danger == 2 else 1.0

    # JS: Math.round(Math.min(base * multiplier, 100)) — half-up rounding
    score = int(min((t_s + g_s + w_s + s_s + f_s) * multiplier, 100) + 0.5)

    if score >= 80: level = "CRITICAL"
    elif score >= 55: level = "HIGH"
    elif score >= 30: level = "MEDIUM"
    else: level = "LOW"

    # Hazard floors (mirrors riskEngine.js: anyHigh && LOW→MEDIUM,
    # anyCritical && LOW→MEDIUM→HIGH, anyCritical && MEDIUM→HIGH)
    any_high = t_l == "high" or g_l == "high" or w_l == "high" or f_l == "high"
    any_critical = (
        t_l == "critical" or g_l == "critical" or w_l == "critical"
        or s_l == "critical" or f_l == "critical"
    )
    if any_high and level == "LOW": level = "MEDIUM"
    if any_critical and level == "LOW": level = "MEDIUM"
    if any_critical and level == "MEDIUM": level = "HIGH"
    return level

# ─── Normal Data Generator ───────────────────────────────────

def generate_normal(count=500):
    """Generate normal (safe) sensor readings with realistic noise."""
    data = []
    temp = 28.0
    gas = 200.0
    water = 5.0
    ax, ay, az = 0.0, 0.0, 9.8

    for _ in range(count):
        # Slow drift
        temp += np.random.normal(0, 0.5)
        gas += np.random.normal(0, 8)
        water += np.random.normal(0, 0.3)
        ax += np.random.normal(0, 0.05)
        ay += np.random.normal(0, 0.05)
        az += np.random.normal(0, 0.05)

        # Drift back to baseline
        temp += (28 - temp) * 0.05
        gas += (200 - gas) * 0.05
        water += (5 - water) * 0.03
        ax *= 0.95
        ay *= 0.95
        az += (9.8 - az) * 0.1

        # Clamp
        temp = np.clip(temp, 20, 36)
        gas = np.clip(gas, 80, 350)
        water = np.clip(water, 0, 12)
        ax = np.clip(ax, -1, 1)
        ay = np.clip(ay, -1, 1)
        az = np.clip(az, 9.0, 10.5)

        data.append({
            "temperature_c": round(temp, 1),
            "gas_raw": round(gas),
            "water_level_cm": round(water, 1),
            "acceleration_x_ms2": round(ax, 2),
            "acceleration_y_ms2": round(ay, 2),
            "acceleration_z_ms2": round(az, 2),
            "sos": False,
            "risk_level": "LOW",
            "scenario": "normal",
        })

    return data


def generate_danger_buildup(scenario_name, target_field, base_value, danger_value, count=80):
    """Gradually build up danger in one sensor field."""
    data = []
    temp, gas, water = 28.0, 200.0, 5.0
    ax, ay, az = 0.0, 0.0, 9.8

    for i in range(count):
        progress = i / count

        # Apply danger buildup to target field
        if target_field == "temperature_c":
            temp = base_value + (danger_value - base_value) * progress + np.random.normal(0, 1)
        elif target_field == "gas_raw":
            gas = base_value + (danger_value - base_value) * progress + np.random.normal(0, 10)
        elif target_field == "water_level_cm":
            water = base_value + (danger_value - base_value) * progress + np.random.normal(0, 0.5)

        # Keep others normal
        temp = temp if target_field == "temperature_c" else np.clip(temp + np.random.normal(0, 0.3), 22, 34)
        gas = gas if target_field == "gas_raw" else np.clip(gas + np.random.normal(0, 5), 100, 350)
        water = water if target_field == "water_level_cm" else np.clip(water + np.random.normal(0, 0.2), 0, 12)

        # Normal accel
        ax = np.clip(np.random.normal(0, 0.2), -0.5, 0.5)
        ay = np.clip(np.random.normal(0, 0.2), -0.5, 0.5)
        az = np.clip(9.8 + np.random.normal(0, 0.2), 9.3, 10.3)

        # Label
        if progress < 0.4:
            risk = "LOW"
        elif progress < 0.7:
            risk = "MEDIUM"
        else:
            risk = "HIGH"

        data.append({
            "temperature_c": round(temp, 1),
            "gas_raw": round(gas),
            "water_level_cm": round(water, 1),
            "acceleration_x_ms2": round(ax, 2),
            "acceleration_y_ms2": round(ay, 2),
            "acceleration_z_ms2": round(az, 2),
            "sos": False,
            "risk_level": risk,
            "scenario": scenario_name,
        })

    return data


def generate_fall(count=30):
    """Generate fall event data: standing → free-fall → impact → lying down."""
    data = []

    # Phase 1: Standing (5 readings)
    for _ in range(5):
        data.append({
            "temperature_c": 28 + np.random.normal(0, 0.5),
            "gas_raw": 200 + np.random.normal(0, 10),
            "water_level_cm": 5 + np.random.normal(0, 0.3),
            "acceleration_x_ms2": np.random.normal(0, 0.2),
            "acceleration_y_ms2": np.random.normal(0, 0.2),
            "acceleration_z_ms2": 9.8 + np.random.normal(0, 0.2),
            "sos": False,
            "risk_level": "LOW",
            "scenario": "fall",
        })

    # Phase 2: Free-fall (3 readings)
    for _ in range(3):
        data.append({
            "temperature_c": 28 + np.random.normal(0, 0.5),
            "gas_raw": 200 + np.random.normal(0, 10),
            "water_level_cm": 5 + np.random.normal(0, 0.3),
            "acceleration_x_ms2": np.random.normal(0, 0.5),
            "acceleration_y_ms2": np.random.normal(0, 0.5),
            "acceleration_z_ms2": 0.5 + np.random.normal(0, 0.5),
            "sos": False,
            "risk_level": "HIGH",
            "scenario": "fall",
        })

    # Phase 3: Impact (2 readings)
    for _ in range(2):
        data.append({
            "temperature_c": 28 + np.random.normal(0, 0.5),
            "gas_raw": 200 + np.random.normal(0, 10),
            "water_level_cm": 5 + np.random.normal(0, 0.3),
            "acceleration_x_ms2": 25 + np.random.normal(0, 5),
            "acceleration_y_ms2": 20 + np.random.normal(0, 5),
            "acceleration_z_ms2": 35 + np.random.normal(0, 8),
            "sos": False,
            "risk_level": "CRITICAL",
            "scenario": "fall",
        })

    # Phase 4: Lying down (10 readings)
    for _ in range(10):
        data.append({
            "temperature_c": 28 + np.random.normal(0, 0.5),
            "gas_raw": 200 + np.random.normal(0, 10),
            "water_level_cm": 5 + np.random.normal(0, 0.3),
            "acceleration_x_ms2": 6.0 + np.random.normal(0, 1),
            "acceleration_y_ms2": 1.5 + np.random.normal(0, 0.5),
            "acceleration_z_ms2": 4.0 + np.random.normal(0, 1),
            "sos": False,
            "risk_level": "CRITICAL",
            "scenario": "fall",
        })

    # Phase 5: Recovery (10 readings)
    for _ in range(10):
        data.append({
            "temperature_c": 28 + np.random.normal(0, 0.5),
            "gas_raw": 200 + np.random.normal(0, 10),
            "water_level_cm": 5 + np.random.normal(0, 0.3),
            "acceleration_x_ms2": np.random.normal(0, 0.3),
            "acceleration_y_ms2": np.random.normal(0, 0.3),
            "acceleration_z_ms2": 9.8 + np.random.normal(0, 0.3),
            "sos": False,
            "risk_level": "LOW",
            "scenario": "fall",
        })

    return data


def generate_sos(count=30):
    """Generate SOS emergency data."""
    data = []

    # Normal before SOS
    for _ in range(5):
        data.append({
            "temperature_c": 28 + np.random.normal(0, 0.5),
            "gas_raw": 200 + np.random.normal(0, 10),
            "water_level_cm": 5 + np.random.normal(0, 0.3),
            "acceleration_x_ms2": np.random.normal(0, 0.2),
            "acceleration_y_ms2": np.random.normal(0, 0.2),
            "acceleration_z_ms2": 9.8 + np.random.normal(0, 0.2),
            "sos": True,
            "risk_level": "CRITICAL",
            "scenario": "sos",
        })

    # SOS with rising danger
    for i in range(20):
        progress = i / 20
        data.append({
            "temperature_c": 28 + progress * 10 + np.random.normal(0, 1),
            "gas_raw": 200 + progress * 400 + np.random.normal(0, 20),
            "water_level_cm": 5 + np.random.normal(0, 0.3),
            "acceleration_x_ms2": np.random.normal(0, 0.3),
            "acceleration_y_ms2": np.random.normal(0, 0.3),
            "acceleration_z_ms2": 9.8 + np.random.normal(0, 0.3),
            "sos": True,
            "risk_level": "CRITICAL",
            "scenario": "sos",
        })

    return data


def generate_combined(count=40):
    """Generate combined danger (gas + water + temperature all rising)."""
    data = []

    for i in range(count):
        progress = i / count
        data.append({
            "temperature_c": 28 + progress * 25 + np.random.normal(0, 1),
            "gas_raw": 200 + progress * 600 + np.random.normal(0, 15),
            "water_level_cm": 5 + progress * 35 + np.random.normal(0, 0.5),
            "acceleration_x_ms2": np.random.normal(0, 0.3),
            "acceleration_y_ms2": np.random.normal(0, 0.3),
            "acceleration_z_ms2": 9.8 + np.random.normal(0, 0.3),
            "sos": progress > 0.7,
            "risk_level": "CRITICAL" if progress > 0.6 else "HIGH" if progress > 0.3 else "MEDIUM",
            "scenario": "combined",
        })

    return data


# ─── Main Dataset Builder ────────────────────────────────────

def build_dataset(readings_per_scenario=500):
    """Build a complete labeled dataset from all scenarios."""
    all_data = []

    # Normal data (large pool)
    all_data.extend(generate_normal(readings_per_scenario))

    # Danger buildups
    all_data.extend(generate_danger_buildup("gas_leak", "gas_raw", 200, 800, readings_per_scenario))
    all_data.extend(generate_danger_buildup("flood", "water_level_cm", 5, 45, readings_per_scenario))
    all_data.extend(generate_danger_buildup("overheat", "temperature_c", 28, 55, readings_per_scenario))

    # Special events
    for _ in range(readings_per_scenario // 30):
        all_data.extend(generate_fall())
        all_data.extend(generate_sos())
        all_data.extend(generate_combined())

    df = pd.DataFrame(all_data)

    # Round numeric columns
    for col in ["temperature_c", "gas_raw", "water_level_cm",
                "acceleration_x_ms2", "acceleration_y_ms2", "acceleration_z_ms2"]:
        df[col] = df[col].round(2)

    # Phase 3: relabel with the rule-engine port so training labels match
    # exactly what the deployed rules produce for the same readings.
    df["risk_level"] = df.apply(rule_label, axis=1)

    return df


if __name__ == "__main__":
    print("Generating dataset...")
    df = build_dataset(500)

    # Save as CSV
    output_path = os.path.join(os.path.dirname(__file__), "training_data.csv")
    df.to_csv(output_path, index=False)
    print(f"Saved {len(df)} samples to {output_path}")

    # Print distribution
    print("\nRisk level distribution:")
    print(df["risk_level"].value_counts().to_string())
    print(f"\nScenario distribution:")
    print(df["scenario"].value_counts().to_string())
