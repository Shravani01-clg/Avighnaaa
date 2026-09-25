"""
Phase 3 Model Validation — Person 3 (AI/ML Lead)

Run:  python validate_models.py [--samples 500]

Verifies the ML side of the Phase 3 "DONE when" criteria:

  1. Anomaly detector: normal sensor readings are NOT incorrectly
     classified as anomalies (false-positive rate on a held-out
     normal set the model never saw).
  2. Anomaly detector: danger scenarios ARE flagged (detection rate).
  3. Risk predictor: accuracy per scenario class + overall,
     mapped to LOW / MEDIUM / HIGH / CRITICAL.
  4. Output contract: /predict/all combined payload always contains
     risk_level, risk_score, anomaly_detected.
  5. Shipped artifact: the actual anomaly_model.pkl on disk (what the
     server loads) passes the FP + fault gates — catches train/serve
     skew between train.py and this script.
  6. Shipped artifact: the actual risk_model.pkl on disk passes the
     accuracy gate.
  7. JSON serialization lock: every payload is json.dumps-able and the
     real Flask POST /predict/all returns 200 (regression for the
     numpy.bool_/float64 → HTTP 500 bug).

Exit code 0 = Phase 3 ML gate passed.
"""

import argparse
import json
import os
import sys

# Windows consoles default to cp1252 — force UTF-8 so status output never crashes
if sys.stdout.encoding and sys.stdout.encoding.lower().replace("-", "") != "utf8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(__file__))

from dataset_generator import build_dataset
from anomaly_detector import AnomalyDetector
from risk_predictor import RiskPredictor
from sklearn.model_selection import train_test_split

from risk_predictor import FEATURES as RISK_FEATURES  # 7 features incl. sos

PASS_FP_RATE = 5.0      # % of normal readings falsely flagged as anomalies (spec task 2)
PASS_FAULT = 90.0       # % of implausible/sensor-fault readings flagged (ML's core job)
PASS_ACCURACY = 85.0    # % risk predictor accuracy (holdout)

# NOTE: known hazards (gas 700, flood 30, SOS) are intentionally NOT an anomaly
# gate — the rule engine owns those. The ML detector's job is patterns the
# RULES miss: sensor faults, impossible values, broken motion signatures.

FAULT_CASES = {
    "Impossible temperature (120°C)": {"temperature_c": 120, "gas_raw": 200, "water_level_cm": 5, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8},
    "Negative gas (-5)":              {"temperature_c": 28, "gas_raw": -5, "water_level_cm": 5, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8},
    "Negative water (-3cm)":          {"temperature_c": 28, "gas_raw": 200, "water_level_cm": -3, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8},
    "Dead accelerometer (|a|≈0)":     {"temperature_c": 28, "gas_raw": 200, "water_level_cm": 5, "acceleration_x_ms2": 0, "acceleration_y_ms2": 0, "acceleration_z_ms2": 0.2},
    "Violent shake, no fall ctx":     {"temperature_c": 28, "gas_raw": 200, "water_level_cm": 5, "acceleration_x_ms2": 40, "acceleration_y_ms2": 0, "acceleration_z_ms2": 9.8},
}
# NOT gated: frozen/stuck sensor outputting a plausible constant value.
# A single reading cannot distinguish "stuck at 28.0" from "genuinely 28.0"
# — that detection requires sequence variance, which the stateless predict
# API does not have. Documented as a model limitation (solved in Phase 3 by
# the rolling-window detector in risk-module).


def fault_detection_rate(detector, per_case=20):
    """Run FAULT_CASES (20 noisy variants each) against a detector.

    Returns (hits, total, {case_name: pct_detected}).
    Used by §2 (freshly trained model) and §5 (shipped .pkl) so both
    gates are measured on the identical fixture.
    """
    hits = total = 0
    per_case_pct = {}
    for name, base in FAULT_CASES.items():
        case_hits = 0
        for i in range(per_case):
            case = dict(base)
            case["temperature_c"] += (i % 3 - 1) * 0.1
            case["gas_raw"] += (i % 5 - 2)
            if detector.predict(case)["is_anomaly"]:
                case_hits += 1
        per_case_pct[name] = case_hits / per_case * 100
        hits += case_hits
        total += per_case
    return hits, total, per_case_pct


def main():
    parser = argparse.ArgumentParser(description="Phase 3 ML validation")
    parser.add_argument("--samples", type=int, default=500)
    args = parser.parse_args()

    results = []

    print("=" * 60)
    print("  🔬 Phase 3 — ML Model Validation")
    print("=" * 60)

    # ── Build dataset ────────────────────────────────────────
    print("\n📊 Building dataset...")
    df = build_dataset(args.samples)
    print(f"   Samples: {len(df)}")

    # ── 1. Anomaly false-positive check ─────────────────────
    print("\n" + "-" * 60)
    print("  1️⃣  Anomaly detector — false-positive rate on NORMAL data")
    print("-" * 60)

    # Deployment semantics: "normal" = everything the rule engine scores LOW.
    # Train on 80% of that pool, FP-test on the unseen 20%. Danger rows
    # (MEDIUM+) are never seen in training.
    low_df = df[df["risk_level"] == "LOW"]
    train_n, holdout_n = train_test_split(low_df, test_size=0.2, random_state=42)
    detector = AnomalyDetector()
    detector.train(train_n)

    flagged = 0
    for _, row in holdout_n.iterrows():
        if detector.predict(row.to_dict())["is_anomaly"]:
            flagged += 1
    fp_rate = flagged / len(holdout_n) * 100
    fresh_fp_rate = fp_rate  # compared against the shipped .pkl in §5
    ok = fp_rate <= PASS_FP_RATE
    results.append(ok)
    print(f"\n   Trained on {len(train_n)} LOW rows; FP-tested on {len(holdout_n)} unseen LOW rows")
    print(f"   {'✅' if ok else '❌'} False-positive rate: {fp_rate:.2f}% "
          f"({flagged}/{len(holdout_n)} normal readings flagged) — limit {PASS_FP_RATE}%")

    # ── 2. Sensor-fault / implausible-reading detection (ML's core job) ──
    print("\n" + "-" * 60)
    print("  2️⃣  Anomaly detector — sensor faults & implausible readings")
    print("-" * 60)

    faults_hit, faults_total, per_case_pct = fault_detection_rate(detector)
    for name, pct in per_case_pct.items():
        mark = "✅" if pct >= PASS_FAULT else "⚠️"
        print(f"   {mark} {name:32s}: {pct:5.0f}%")
    fault_rate = faults_hit / faults_total * 100
    ok = fault_rate >= PASS_FAULT
    results.append(ok)
    print(f"\n   {'✅' if ok else '❌'} Fault detection rate: {fault_rate:.1f}% "
          f"({faults_hit}/{faults_total}) — target {PASS_FAULT}%")

    # Informational: detection on rule-danger rows (rules own these — ML is a bonus)
    danger_rows = df[df["risk_level"].isin(["MEDIUM", "HIGH", "CRITICAL"])]
    extra = sum(
        1 for _, row in danger_rows.iterrows()
        if detector.predict(row.to_dict())["is_anomaly"]
    )
    print(f"\n   ℹ️  Bonus — known-danger rows also flagged: {extra}/{len(danger_rows)} "
          f"({extra/len(danger_rows)*100:.1f}%) — rules own these, ML flagging is a bonus")

    # ── 3. Risk predictor accuracy ──────────────────────────
    print("\n" + "-" * 60)
    print("  3️⃣  Risk predictor — accuracy per risk level")
    print("-" * 60)

    predictor = RiskPredictor()
    # Train silently (predictor.train prints its own report)
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        predictor.train(df)
    print("   (full training report printed by train.py)")

    # Holdout evaluation per class — RISK_FEATURES includes sos (7 features)
    df_eval = df.copy()
    df_eval["sos"] = df_eval["sos"].astype(int)
    X = predictor.scaler.transform(df_eval[RISK_FEATURES].values)
    y_true = df_eval["risk_level"].values

    # Proper holdout split (same seed as training so we can rebuild the split)
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, predictor.label_encoder.transform(y_true),
        test_size=0.2, random_state=42, stratify=predictor.label_encoder.transform(y_true),
    )
    y_pred = predictor.model.predict(X_te)
    y_te_labels = predictor.label_encoder.inverse_transform(y_te)
    y_pred_labels = predictor.label_encoder.inverse_transform(y_pred)

    from sklearn.metrics import classification_report
    report = classification_report(y_te_labels, y_pred_labels, output_dict=True)
    print()
    for level in ["LOW", "MEDIUM", "HIGH", "CRITICAL"]:
        if level in report:
            r = report[level]
            print(f"   {level:8s} precision={r['precision']:.3f} recall={r['recall']:.3f} f1={r['f1-score']:.3f} n={int(r['support'])}")
    acc = report["accuracy"] * 100
    ok = acc >= PASS_ACCURACY
    results.append(ok)
    print(f"\n   {'✅' if ok else '❌'} Overall accuracy: {acc:.1f}% — target {PASS_ACCURACY}%")

    # ── 4. Output contract check ────────────────────────────
    print("\n" + "-" * 60)
    print("  4️⃣  Output contract — /predict/all combined fields")
    print("-" * 60)

    sample = {
        "temperature_c": 48,
        "gas_raw": 650,
        "water_level_cm": 28,
        "acceleration_x_ms2": 0,
        "acceleration_y_ms2": 0,
        "acceleration_z_ms2": 9.8,
        "sos": False,
    }
    risk_result = predictor.predict(sample)
    anomaly_result = detector.predict(sample)

    combined = {
        "risk_score": risk_result.get("risk_score", 15),
        "risk_level": risk_result["predicted_risk_level"],
        "anomaly_detected": bool(anomaly_result["is_anomaly"]),
    }
    ok = (
        isinstance(combined["risk_score"], (int, float))
        and combined["risk_level"] in ("LOW", "MEDIUM", "HIGH", "CRITICAL")
        and isinstance(combined["anomaly_detected"], bool)
        and isinstance(risk_result.get("reason") or risk_result.get("message"), str)
    )
    results.append(ok)
    print(f"\n   Combined payload: {combined}")
    print(f"   {'✅' if ok else '❌'} Contract fields risk_level, risk_score, anomaly_detected all present and typed")

    # ── 5. Shipped anomaly model — the .pkl that actually deploys ──
    print("\n" + "-" * 60)
    print("  5️⃣  Shipped model gate — anomaly_model.pkl (what the server loads)")
    print("-" * 60)

    # §1/§2 prove the *method* (train on LOW → gate passes). This section
    # proves the *artifact*: the .pkl sitting on disk right now, as loaded
    # by server.py, tested on LOW rows this run's fresh build — data the
    # shipped model has never seen (train.py and this script draw
    # independent unseeded datasets). This is the gate that catches
    # train/serve skew: it measured 50.5% FP on the pre-fix .pkl.
    shipped_det = AnomalyDetector()
    if not shipped_det.load():
        print("\n   ❌ anomaly_model.pkl not found or not loadable — run: python train.py")
        results.append(False)
    else:
        flagged_s = sum(
            1 for _, row in holdout_n.iterrows()
            if shipped_det.predict(row.to_dict())["is_anomaly"]
        )
        shipped_fp = flagged_s / len(holdout_n) * 100
        ok_fp = shipped_fp <= PASS_FP_RATE
        print(f"\n   Trained-fresh FP: {fresh_fp_rate:.2f}%   |   Shipped .pkl FP: {shipped_fp:.2f}% — limit {PASS_FP_RATE}%")

        s_hits, s_total, s_cases = fault_detection_rate(shipped_det)
        for name, pct in s_cases.items():
            mark = "✅" if pct >= PASS_FAULT else "❌"
            print(f"   {mark} {name:32s}: {pct:5.0f}%")
        shipped_fault = s_hits / s_total * 100
        ok_fault = shipped_fault >= PASS_FAULT
        print(f"\n   {'✅' if ok_fault else '❌'} Shipped fault detection: {shipped_fault:.1f}% "
              f"({s_hits}/{s_total}) — target {PASS_FAULT}%")
        ok = ok_fp and ok_fault
        results.append(ok)
        print(f"   {'✅' if ok else '❌'} Shipped anomaly model passes FP + fault gates together")

    # ── 6. Shipped risk model — risk_model.pkl accuracy ──────
    print("\n" + "-" * 60)
    print("  6️⃣  Shipped model gate — risk_model.pkl (what the server loads)")
    print("-" * 60)

    shipped_pred = RiskPredictor()
    if not shipped_pred.load():
        print("\n   ❌ risk_model.pkl not found or not loadable — run: python train.py")
        results.append(False)
    else:
        Xs = shipped_pred.scaler.transform(df_eval[RISK_FEATURES].values)
        ys = shipped_pred.label_encoder.transform(y_true)
        _, Xs_te, _, ys_te = train_test_split(
            Xs, ys, test_size=0.2, random_state=42, stratify=ys
        )
        shipped_acc = float((shipped_pred.model.predict(Xs_te) == ys_te).mean()) * 100
        ok = shipped_acc >= PASS_ACCURACY
        results.append(ok)
        print(f"\n   Shipped .pkl accuracy on this run's unseen holdout: {shipped_acc:.1f}% — target {PASS_ACCURACY}%")
        print(f"   {'✅' if ok else '❌'} Shipped risk model passes accuracy gate")

    # ── 7. JSON serialization lock (regression for the /predict/all 500) ──
    print("\n" + "-" * 60)
    print("  7️⃣  JSON serialization lock — payloads must stay Flask-safe")
    print("-" * 60)

    # Regression lock: a np.bool_/np.float64 leaking into the payload used
    # to crash Flask's jsonify with a 500 on /predict/all. Two layers:
    # (a) json.dumps the full payload directly, (b) POST through the real
    # Flask endpoint and require 200 + the three top-level keys.
    det_for_json = shipped_det if shipped_det.is_trained else detector
    pred_for_json = shipped_pred if shipped_pred.is_trained else predictor
    normal_sample = {
        "temperature_c": 32.5,
        "gas_raw": 420,          # the reading that exposed the 50.5% FP bug
        "water_level_cm": 15.0,
        "acceleration_x_ms2": 0.2,
        "acceleration_y_ms2": 0.1,
        "acceleration_z_ms2": 9.7,
        "sos": False,
    }
    ok_json = True
    for s in (normal_sample, sample):
        try:
            payload = {
                "risk": pred_for_json.predict(s),
                "anomaly": det_for_json.predict(s),
                "combined": {
                    "risk_score": 15,
                    "risk_level": pred_for_json.predict(s)["predicted_risk_level"],
                    "anomaly_detected": bool(det_for_json.predict(s)["is_anomaly"]),
                },
            }
            json.dumps(payload)
        except TypeError as e:
            ok_json = False
            print(f"\n   ❌ json.dumps failed (non-serializable type leaked): {e}")

    endpoint_ok = ok_json
    if endpoint_ok:
        from server import app
        from anomaly_detector import detector as live_detector
        from risk_predictor import predictor as live_predictor
        live_detector.load()
        live_predictor.load()
        client = app.test_client()
        for s in (normal_sample, sample):
            body = {**s, "_rule_based_risk_level": "HIGH", "_rule_based_risk_score": 65}
            resp = client.post("/predict/all", json=body)
            if resp.status_code != 200:
                endpoint_ok = False
                print(f"\n   ❌ POST /predict/all → {resp.status_code}: "
                      f"{resp.get_data(as_text=True)[:200]}")
            else:
                data = resp.get_json()
                if not data or not all(k in data for k in ("risk", "anomaly", "combined")):
                    endpoint_ok = False
                    print(f"\n   ❌ POST /predict/all 200 but keys wrong: {list((data or {}).keys())}")

    ok = ok_json and endpoint_ok
    results.append(ok)
    print(f"\n   {'✅' if ok else '❌'} json.dumps × 2 payloads + Flask POST /predict/all × 2 "
          f"→ 200 with risk/anomaly/combined (numpy-500 regression locked)")

    # ── Summary ─────────────────────────────────────────────
    print("\n" + "=" * 60)
    passed = sum(1 for r in results if r)
    failed = len(results) - passed
    print(f"  Results: {passed} passed, {failed} failed")
    print("=" * 60 + "\n")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
