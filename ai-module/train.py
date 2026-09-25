"""
Train All Models

Run this script to:
1. Generate training data from simulator scenarios
2. Train the anomaly detector (on rule-engine LOW data — same pool the
   validation gate uses, so what ships is what was validated)
3. Train the risk predictor (on all labeled data)
4. Save both models to disk

Usage:
    python train.py
    python train.py --samples 1000
"""

import sys
import os
import argparse

# Windows consoles default to cp1252 — force UTF-8 so status output never crashes
if sys.stdout.encoding and sys.stdout.encoding.lower().replace("-", "") != "utf8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from dataset_generator import build_dataset
from anomaly_detector import AnomalyDetector
from risk_predictor import RiskPredictor


def main():
    parser = argparse.ArgumentParser(description="Train RockFall AI models")
    parser.add_argument("--samples", type=int, default=500, help="Normal samples per scenario")
    args = parser.parse_args()

    print("=" * 60)
    print("  🤖 RockFall AI Model Training")
    print("=" * 60)

    # ── Step 1: Generate dataset ──
    print("\n📊 Step 1: Generating training dataset...")
    df = build_dataset(args.samples)
    print(f"   Total samples: {len(df)}")
    print(f"   Risk distribution:")
    for level, count in df["risk_level"].value_counts().items():
        print(f"     {level}: {count} ({count/len(df)*100:.1f}%)")

    # Save raw dataset
    dataset_path = os.path.join(os.path.dirname(__file__), "training_data.csv")
    df.to_csv(dataset_path, index=False)
    print(f"   Saved to: {dataset_path}")

    # ── Step 2: Train anomaly detector (deployment semantics) ──
    print("\n🔍 Step 2: Training anomaly detector...")
    # "Normal" = everything the rule engine scores LOW — the SAME pool the
    # validation gate (validate_models.py) trains and tests on.
    #
    # Training on the narrow `scenario == "normal"` rows instead made the
    # deployed model flag legitimate elevated readings (gas 400–599,
    # water 15–25 cm, temp 38–45 °C — all LOW per the rules) as
    # "implausible": measured 50.5% false-positive rate on LOW rows
    # against a 5% gate limit. That train/serve skew is caught by
    # validate_models.py §5, which gates the shipped .pkl directly.
    normal_df = df[df["risk_level"] == "LOW"].copy()
    print(f"   Training on {len(normal_df)} rule-engine LOW samples...")

    anomaly_detector = AnomalyDetector()
    anomaly_detector.train(normal_df)
    anomaly_detector.save()

    # Test anomaly detection on rule-danger rows — flagging these is a
    # bonus: the rule engine owns known hazards, the ML detector's core
    # job is sensor faults (validate_models.py §2 gates that separately).
    danger_samples = df[df["risk_level"] != "LOW"].head(10)
    print(f"\n   Testing on {len(danger_samples)} rule-danger rows:")
    for _, row in danger_samples.iterrows():
        result = anomaly_detector.predict(row.to_dict())
        status = "🚨 ANOMALY" if result["is_anomaly"] else "✅ normal"
        print(f"     {row['scenario']:12s} → {status} (score: {result['anomaly_score']:.3f})")

    # ── Step 3: Train risk predictor (all labeled data) ──
    print("\n🎯 Step 3: Training risk predictor...")
    risk_predictor = RiskPredictor()
    risk_predictor.train(df)
    risk_predictor.save()

    # ── Step 4: Integration test ──
    print("\n🧪 Step 4: Integration test...")

    test_cases = [
        {"name": "Normal", "data": {"temperature_c": 28, "gas_raw": 200, "water_level_cm": 5, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8, "sos": False}},
        {"name": "Gas danger", "data": {"temperature_c": 30, "gas_raw": 750, "water_level_cm": 5, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8, "sos": False}},
        {"name": "Fall", "data": {"temperature_c": 28, "gas_raw": 200, "water_level_cm": 5, "acceleration_x_ms2": 6, "acceleration_y_ms2": 1.5, "acceleration_z_ms2": 4, "sos": False}},
        {"name": "SOS", "data": {"temperature_c": 28, "gas_raw": 200, "water_level_cm": 5, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8, "sos": True}},
        {"name": "Combined", "data": {"temperature_c": 50, "gas_raw": 700, "water_level_cm": 35, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8, "sos": True}},
    ]

    for tc in test_cases:
        risk_result = risk_predictor.predict(tc["data"])
        anomaly_result = anomaly_detector.predict(tc["data"])

        print(f"\n   [{tc['name']}]")
        print(f"     Risk: {risk_result['predicted_risk_level']} (confidence: {risk_result['confidence']:.1%})")
        print(f"     Anomaly: {'Yes' if anomaly_result['is_anomaly'] else 'No'} (score: {anomaly_result['anomaly_score']:.3f})")

    print("\n" + "=" * 60)
    print("  ✅ Training complete! Models saved.")
    print("=" * 60)
    print(f"\n  Models saved in: {os.path.dirname(__file__)}")
    print(f"  - anomaly_model.pkl (Isolation Forest)")
    print(f"  - risk_model.pkl (Gradient Boosting)")
    print(f"  - training_data.csv (labeled dataset)")


if __name__ == "__main__":
    main()
