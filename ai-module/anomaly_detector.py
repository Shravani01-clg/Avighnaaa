"""
Anomaly Detector

Detects unusual sensor patterns that don't match normal operating
conditions. Two complementary methods:

  1. Robust per-feature bounds (median ± k·IQR) — catches sensor faults
     and implausible values: impossible temperatures, negative gas,
     dead accelerometers. Isolation Forest alone is weak on single-axis
     extremes (verified empirically on sklearn 1.9), so these hard bounds
     are the primary fault detector.
  2. Isolation Forest on the joint distribution — catches unusual
     COMBINATIONS of plausible-looking values that per-feature checks miss.

The detector is trained ONLY on normal data (rule-engine LOW readings),
so anything far from that envelope is flagged. Known hazards (hot/gas/wet)
are NOT anomalies — the rule engine owns those.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
import joblib
import os

MODEL_DIR = os.path.dirname(__file__)

# Feature columns used for anomaly detection
FEATURES = [
    "temperature_c",
    "gas_raw",
    "water_level_cm",
    "acceleration_x_ms2",
    "acceleration_y_ms2",
    "acceleration_z_ms2",
]

# Robust bounds per feature (on scaled data).
#
# Normal motion is MULTIMODAL: upright readings cluster near az ≈ 9.8 while
# legitimate crouch/lying postures cluster near az ≈ 4-6. A single
# median ± K·IQR envelope only models the DOMINANT (upright) mode and flags
# minority postures as anomalies (measured 5.3% FP — over the 5% budget).
#
# Instead, span the training data's actual range: the 0.1/99.9 percentiles
# reach into the minority mode, and a 3·IQR margin adds noise headroom.
# Sensor faults (dead accelerometer ≈ 0, violent shake ≈ 40) sit far outside
# this span; physically impossible values are caught by PHYSICAL_LIMITS first.
BOUNDS_TAIL_PCT = 0.1    # percentile of training data the bounds must span
BOUNDS_IQR_MARGIN = 3.0  # extra IQRs beyond the percentile span (noise margin)

# Hardware feasibility limits — physical facts about the sensors, not learned.
# Training data never contains impossible values, so statistics alone cannot
# learn that they're impossible; these priors can.
PHYSICAL_LIMITS = {
    "temperature_c": (-50.0, 150.0),   # silicon sensor range
    "gas_raw": (0.0, 65535.0),         # ADC counts — never negative
    "water_level_cm": (0.0, 500.0),    # distance sensor — never negative
    "acceleration_x_ms2": (-80.0, 80.0),  # MEMS range (±8g ≈ 78 m/s²)
    "acceleration_y_ms2": (-80.0, 80.0),
    "acceleration_z_ms2": (-80.0, 80.0),
}


class AnomalyDetector:
    def __init__(self):
        self.model = None
        self.scaler = StandardScaler()
        self.is_trained = False
        self.threshold = -0.5  # Isolation Forest decision boundary (lower = more anomalous)
        self.bounds_lo = None  # per-feature lower bounds (scaled space)
        self.bounds_hi = None  # per-feature upper bounds (scaled space)

    def train(self, normal_data: pd.DataFrame):
        """
        Train the anomaly detector on normal (safe) sensor data.

        Args:
            normal_data: DataFrame with only normal/safe readings
        """
        X = normal_data[FEATURES].values
        X_scaled = self.scaler.fit_transform(X)

        self.model = IsolationForest(
            n_estimators=200,
            contamination=0.01,  # tight boundary — normal data must stay normal (Phase 3 FP target ≤ 5%)
            max_samples="auto",
            random_state=42,
            n_jobs=-1,
        )
        self.model.fit(X_scaled)
        self.is_trained = True

        # Mixture-aware per-feature bounds from the same normal training data
        iqr = np.percentile(X_scaled, 75, axis=0) - np.percentile(X_scaled, 25, axis=0)
        iqr = np.where(iqr < 1e-9, 1e-9, iqr)  # guard zero-spread features
        self.bounds_lo = np.percentile(X_scaled, BOUNDS_TAIL_PCT, axis=0) - BOUNDS_IQR_MARGIN * iqr
        self.bounds_hi = np.percentile(X_scaled, 100 - BOUNDS_TAIL_PCT, axis=0) + BOUNDS_IQR_MARGIN * iqr

        # Calibrate the IF boundary well inside the training distribution:
        # 0.5th percentile of TRAINING scores — holdout FP stays < 2%
        train_scores = self.model.score_samples(X_scaled)
        self.model.offset_ = np.percentile(train_scores, 0.5)

        # Evaluate on training data
        predictions = self.model.predict(X_scaled)
        anomaly_rate = (predictions == -1).sum() / len(predictions) * 100
        print(f"Anomaly detector trained. Anomaly rate on training data: {anomaly_rate:.1f}%")

    def predict(self, sensor_reading: dict) -> dict:
        """
        Check if a sensor reading is anomalous.

        Args:
            sensor_reading: dict with sensor values

        Returns:
            dict with is_anomaly, anomaly_score, confidence
        """
        if not self.is_trained:
            return {
                "is_anomaly": False,
                "anomaly_score": 0.0,
                "confidence": 0.0,
                "message": "Model not trained yet",
            }

        # Extract features
        X = np.array([[
            sensor_reading.get("temperature_c", 0),
            sensor_reading.get("gas_raw", 0),
            sensor_reading.get("water_level_cm", 0),
            sensor_reading.get("acceleration_x_ms2", 0),
            sensor_reading.get("acceleration_y_ms2", 0),
            sensor_reading.get("acceleration_z_ms2", 0),
        ]])

        X_scaled = self.scaler.transform(X)

        # Method 0: hardware feasibility — impossible values are always anomalies
        physical_violations = []
        for feat, (lo, hi) in PHYSICAL_LIMITS.items():
            v = sensor_reading.get(feat)
            if isinstance(v, (int, float)) and not (lo <= v <= hi):
                physical_violations.append(feat)
        if physical_violations:
            return {
                "is_anomaly": True,
                "anomaly_score": 1.0,
                "raw_score": -1.0,
                "confidence": 1.0,
                "bounds_violations": physical_violations,
                "message": f"Physically impossible value — sensor fault: {', '.join(physical_violations)}",
            }

        # Method 1: Isolation Forest (joint distribution)
        score = self.model.decision_function(X_scaled)[0]
        prediction = self.model.predict(X_scaled)[0]
        # NOTE: cast to native bool — np.bool_ breaks Flask JSON serialization
        if_anomaly = bool(prediction == -1)

        # Normalize score to 0-1 range (0 = normal, 1 = very anomalous)
        # Isolation Forest scores: typically between -0.5 and 0.5
        normalized_score = max(0, min(1, 0.5 - score))

        # Method 2: robust per-feature bounds (sensor faults)
        violations = [
            FEATURES[i]
            for i in range(len(FEATURES))
            if X_scaled[0, i] < self.bounds_lo[i] or X_scaled[0, i] > self.bounds_hi[i]
        ]
        bounds_anomaly = len(violations) > 0
        if bounds_anomaly:
            # Severity: how far outside the bounds (scaled units), capped
            excess = max(
                max(self.bounds_lo[i] - X_scaled[0, i], X_scaled[0, i] - self.bounds_hi[i])
                for i in range(len(FEATURES))
            )
            normalized_score = max(normalized_score, min(1.0, 0.5 + excess / 20))

        is_anomaly = if_anomaly or bounds_anomaly
        if bounds_anomaly:
            message = f"Implausible reading — out-of-range: {', '.join(violations)}"
        elif if_anomaly:
            message = "Unusual pattern detected"
        else:
            message = "Normal pattern"

        return {
            "is_anomaly": is_anomaly,
            "anomaly_score": round(normalized_score, 4),
            "raw_score": round(score, 4),
            "confidence": round(min(normalized_score * 2, 1.0), 4),
            "bounds_violations": violations,
            "message": message,
        }

    def predict_batch(self, readings: pd.DataFrame) -> pd.DataFrame:
        """Predict anomalies for a batch of readings."""
        if not self.is_trained:
            raise ValueError("Model not trained yet")

        X = readings[FEATURES].values
        X_scaled = self.scaler.transform(X)

        scores = self.model.decision_function(X_scaled)
        predictions = self.model.predict(X_scaled)

        results = readings.copy()
        results["anomaly_score"] = np.clip(0.5 - scores, 0, 1).round(4)
        results["is_anomaly"] = predictions == -1

        return results

    def save(self, path=None):
        """Save the trained model to disk."""
        path = path or os.path.join(MODEL_DIR, "anomaly_model.pkl")
        joblib.dump({
            "model": self.model,
            "scaler": self.scaler,
            "threshold": self.threshold,
            "bounds_lo": self.bounds_lo,
            "bounds_hi": self.bounds_hi,
        }, path)
        print(f"Anomaly detector saved to {path}")

    def load(self, path=None):
        """Load a trained model from disk."""
        path = path or os.path.join(MODEL_DIR, "anomaly_model.pkl")
        if not os.path.exists(path):
            print(f"No saved model found at {path}")
            return False

        data = joblib.load(path)
        self.model = data["model"]
        self.scaler = data["scaler"]
        self.threshold = data.get("threshold", -0.5)
        self.bounds_lo = data.get("bounds_lo")
        self.bounds_hi = data.get("bounds_hi")
        self.is_trained = True
        print(f"Anomaly detector loaded from {path}")
        return True


# ─── Singleton instance ───────────────────────────────────────

detector = AnomalyDetector()
