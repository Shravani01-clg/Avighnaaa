"""
Ablation Study — Person 3 (AI/ML Lead)

Run:  python ablation.py [--samples 500]

Compares three risk-classification configurations on a freshly built
labeled dataset:

  A. Rules only   — the rule engine's Python port (mirror of
                    risk-module/riskEngine.js) = rule_label()
  B. ML only      — the shipped Gradient Boosting risk predictor (.pkl)
  C. Fusion       — MAX(rules, ML): the level only ever moves UP, exactly
                    what controllers/aiIntegration.js deploys (the AI may
                    raise a level, it can never lower one)

Metrics per configuration:
  accuracy        — % of rows whose reported level matches the label
  miss rate       — danger rows (label >= MEDIUM) reported as LOW
                    (safety metric: a missed danger)
  false escalation — LOW rows reported as >= MEDIUM
                    (annoyance metric: a false alarm)

HONESTY NOTE (keep this in the report/viva):
  Labels in this dataset are produced by rule_label() — a Python port of
  the deployed rule engine. Configuration A therefore scores 100% by
  construction: the rules ARE the labeling function. That number is
  printed with an asterisk, not hidden. What the table actually shows:
    * how closely ML approximates the contract it was trained on (B),
    * what fusion buys: miss rate 0 by design — MAX(rules, ML) can never
      report lower than the rules, so it cannot miss a danger the rules
      see (verified empirically below),
    * at what cost: fusion inherits ML's false escalations, which is the
      price of "never downgrade".

Exit code 0 = all three configurations evaluated without error.
"""

import argparse
import os
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower().replace("-", "") != "utf8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, os.path.dirname(__file__))

from dataset_generator import build_dataset
from risk_predictor import RiskPredictor

RISK_RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


def level_metrics(y_true, y_pred):
    """Return (accuracy%, miss-rate%, false-escalation%)."""
    n = len(y_true)
    assert n > 0, "empty evaluation set"
    acc = sum(1 for t, p in zip(y_true, y_pred) if t == p) / n * 100

    danger_idx = [i for i, t in enumerate(y_true) if t != "LOW"]
    miss = (
        sum(1 for i in danger_idx if y_pred[i] == "LOW") / len(danger_idx) * 100
        if danger_idx else 0.0
    )

    low_idx = [i for i, t in enumerate(y_true) if t == "LOW"]
    esc = (
        sum(1 for i in low_idx if y_pred[i] != "LOW") / len(low_idx) * 100
        if low_idx else 0.0
    )
    return acc, miss, esc


def main():
    parser = argparse.ArgumentParser(description="Rules vs ML vs Fusion ablation")
    parser.add_argument("--samples", type=int, default=500,
                        help="Readings per scenario in the fresh dataset")
    args = parser.parse_args()

    print("=" * 76)
    print("  🧪 Ablation — Rules only vs ML only vs Fusion (MAX)")
    print("=" * 76)

    # ── Evaluation set ──────────────────────────────────────
    print("\n📊 Building a fresh labeled dataset (independent of train.py's draw)...")
    df = build_dataset(args.samples)
    y_true = df["risk_level"].tolist()
    print(f"   Samples: {len(df)}")
    for level in ["LOW", "MEDIUM", "HIGH", "CRITICAL"]:
        count = sum(1 for t in y_true if t == level)
        print(f"     {level:8s}: {count:5d} ({count / len(df) * 100:.1f}%)")

    # ── Configuration B: ML only (shipped .pkl) ─────────────
    predictor = RiskPredictor()
    if not predictor.load():
        print("\n❌ risk_model.pkl not found — run: python train.py first.")
        sys.exit(1)

    print("\n⚙️  Running the shipped risk predictor over all rows...")
    y_ml = [
        predictor.predict(row)["predicted_risk_level"]
        for row in df.to_dict("records")
    ]

    # ── Configuration A: Rules only ─────────────────────────
    # build_dataset() labeled every row with rule_label(), so the labels
    # themselves are the rules' output — Config A == labels by construction.
    y_rules = list(y_true)

    # ── Configuration C: Fusion = MAX(rules, ML) ────────────
    # Mirrors controllers/aiIntegration.js: final = the HIGHER of the two.
    y_fusion = [
        r if RISK_RANK[r] >= RISK_RANK[m] else m
        for r, m in zip(y_rules, y_ml)
    ]

    # ── Table ───────────────────────────────────────────────
    configs = [
        ("A. Rules only", y_rules),
        ("B. ML only (shipped .pkl)", y_ml),
        ("C. Fusion MAX(rules, ML)", y_fusion),
    ]

    print("\n" + "-" * 76)
    print(f"  {'Configuration':28s} {'Accuracy':>10s} {'Miss rate':>12s} {'False escal.':>14s}")
    print("-" * 76)
    rows = {}
    for name, y_pred in configs:
        acc, miss, esc = level_metrics(y_true, y_pred)
        rows[name] = (acc, miss, esc)
        star = " *" if name.startswith("A.") else ""
        fusion_mark = " ✓" if name.startswith("C.") and miss == 0 else ""
        print(f"  {name:28s} {acc:9.1f}%{star} {miss:>10.1f}%{fusion_mark} {esc:>13.1f}%")
    print("-" * 76)
    print("  * by construction: labels come from the rule engine (see honesty note)")
    print("  ✓ fusion miss rate = 0 by design: MAX(rules, ML) can never downgrade")
    print(f"\n  Fusion miss rate measured: {rows['C. Fusion MAX(rules, ML)'][1]:.1f}% "
          f"({'verified — 0 misses' if rows['C. Fusion MAX(rules, ML)'][1] == 0 else 'UNEXPECTED — investigate!'})")

    fusion_esc = rows["C. Fusion MAX(rules, ML)"][2]
    ml_esc = rows["B. ML only (shipped .pkl)"][2]
    print(f"  Fusion false-escalation rate: {fusion_esc:.1f}% "
          f"(ML-only contributes {ml_esc:.1f}% — that is the measured price of "
          f"'never downgrade')")

    print("\n  Reading of the table:")
    print("   • A is the deployment contract (ground truth by definition).")
    print("   • B measures how well ML learned the contract it was trained on.")
    print("   • C is what actually ships: B's coverage can only ADD risk levels,")
    print("     never remove them — so a danger the rules see can never be lost,")
    print("     even if the ML side disagrees. When the AI server is down, the")
    print("     backend degrades to exactly configuration A.")

    print("\n" + "=" * 76)
    print("  ✅ Ablation complete")
    print("=" * 76 + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
