"""
AI Prediction Server

Flask server that exposes ML predictions over HTTP.
The Node.js backend calls these endpoints to get AI-powered risk and anomaly analysis.

Endpoints:
    POST /predict/risk      — Predict risk level from sensor data
    POST /predict/anomaly   — Check if sensor reading is anomalous
    POST /predict/all       — Get both risk and anomaly analysis
    GET  /health            — Health check

Usage:
    python server.py                    # Start on port 5001
    python server.py --port 5002        # Custom port
    python server.py --load-models      # Load saved models at startup
"""

import argparse
import os
import sys

# Windows consoles default to cp1252 — force UTF-8 so startup output never crashes
if sys.stdout.encoding and sys.stdout.encoding.lower().replace("-", "") != "utf8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from flask import Flask, request, jsonify

from anomaly_detector import AnomalyDetector, detector
from risk_predictor import RiskPredictor, predictor

app = Flask(__name__)

# ─── Validation ───────────────────────────────────────────────

REQUIRED_FIELDS = [
    "temperature_c",
    "gas_raw",
    "water_level_cm",
    "acceleration_x_ms2",
    "acceleration_y_ms2",
    "acceleration_z_ms2",
]


def validate_reading(data):
    """Validate that a sensor reading has all required fields."""
    errors = []

    for field in REQUIRED_FIELDS:
        if field not in data:
            errors.append(f"Missing field: {field}")
        elif not isinstance(data[field], (int, float)):
            errors.append(f"{field} must be a number")

    if "sos" in data and not isinstance(data["sos"], bool):
        errors.append("sos must be a boolean")

    return errors


# ─── Routes ───────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "models_loaded": {
            "anomaly_detector": detector.is_trained,
            "risk_predictor": predictor.is_trained,
        },
    })


@app.route("/predict/risk", methods=["POST"])
def predict_risk():
    """Predict risk level from sensor data."""
    data = request.get_json()

    if not data:
        return jsonify({
            "error": "Request body must be JSON"
        }), 400

    errors = validate_reading(data)

    if errors:
        return jsonify({
            "errors": errors
        }), 400

    result = predictor.predict(data)

    return jsonify(result)


@app.route("/predict/anomaly", methods=["POST"])
def predict_anomaly():
    """Check if a sensor reading is anomalous."""
    data = request.get_json()

    if not data:
        return jsonify({
            "error": "Request body must be JSON"
        }), 400

    errors = validate_reading(data)

    if errors:
        return jsonify({
            "errors": errors
        }), 400

    result = detector.predict(data)

    return jsonify(result)


@app.route("/predict/all", methods=["POST"])
def predict_all():
    """Get both risk prediction and anomaly detection in one call."""
    data = request.get_json()

    if not data:
        return jsonify({
            "error": "Request body must be JSON"
        }), 400

    errors = validate_reading(data)

    if errors:
        return jsonify({
            "errors": errors
        }), 400

    # Get AI predictions
    risk_result = predictor.predict(data)
    anomaly_result = detector.predict(data)

    # ─── Combined analysis ────────────────────────────────────

    # Start with the ML risk score
    combined_risk_score = risk_result.get("risk_score", 15)

    # If anomaly detected, increase risk score
    if anomaly_result["is_anomaly"]:
        combined_risk_score = min(
            100,
            combined_risk_score + 20
        )

    # Determine combined risk level
    combined_level = "LOW"

    if combined_risk_score >= 80:
        combined_level = "CRITICAL"

    elif combined_risk_score >= 55:
        combined_level = "HIGH"

    elif combined_risk_score >= 30:
        combined_level = "MEDIUM"

    # ─── Rule-based safety layer ──────────────────────────────

    # The AI never downgrades a higher rule-based risk level.
    rule_based_level = data.get(
        "_rule_based_risk_level",
        "LOW"
    )

    rule_based_score = data.get(
        "_rule_based_risk_score",
        0
    )

    RISK_RANK = {
        "LOW": 0,
        "MEDIUM": 1,
        "HIGH": 2,
        "CRITICAL": 3
    }

    # Use whichever score is higher
    final_score = max(
        combined_risk_score,
        rule_based_score
    )

    # Use whichever risk level is higher
    if RISK_RANK.get(
        rule_based_level,
        0
    ) > RISK_RANK.get(
        combined_level,
        0
    ):
        final_level = rule_based_level
    else:
        final_level = combined_level

    # ─── Final response ───────────────────────────────────────

    return jsonify({
        "risk": risk_result,

        "anomaly": anomaly_result,

        "combined": {
            "risk_score": final_score,

            "risk_level": final_level,

            "anomaly_detected": bool(
                anomaly_result["is_anomaly"]
            ),

            "message": (
                f"AI analysis complete. "
                f"Risk: {final_level}, "
                f"Anomaly: "
                f"{'Yes' if anomaly_result['is_anomaly'] else 'No'}"
            ),
        },
    })


# ─── Main ─────────────────────────────────────────────────────

def main():

    parser = argparse.ArgumentParser(
        description="RockFall AI Prediction Server"
    )

    # Render provides PORT automatically.
    # Locally, if PORT is not defined, it falls back to 5001.
    parser.add_argument(
        "--port",
        type=int,
        default=int(
            os.environ.get("PORT", 5001)
        ),
        help="Port to listen on",
    )

    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host to bind to"
    )

    parser.add_argument(
        "--load-models",
        action="store_true",
        help="Load saved models at startup"
    )

    args = parser.parse_args()

    # ─── Load saved ML models ─────────────────────────────────

    if args.load_models:
        print("Loading saved models...")

        detector.load()
        predictor.load()

    # ─── Start server ─────────────────────────────────────────

    print(
        f"\n🤖 RockFall AI Server starting on "
        f"http://{args.host}:{args.port}"
    )

    print(
        "   POST /predict/risk      — Risk prediction"
    )

    print(
        "   POST /predict/anomaly   — Anomaly detection"
    )

    print(
        "   POST /predict/all       — Combined analysis"
    )

    print(
        "   GET  /health            — Health check\n"
    )

    app.run(
        host=args.host,
        port=args.port,
        debug=False
    )


if __name__ == "__main__":
    main()