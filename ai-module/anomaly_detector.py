"""
Anomaly Detector

Uses Isolation Forest to detect unusual sensor patterns that don't match
normal operating conditions. This catches:
- Gradual sensor drift
- Unusual combinations of values
- Patterns the rule-based engine might miss

The detector is trained ONLY on normal data, so anything that deviates
significantly from normal is flagged.
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


class AnomalyDetector:
    def __init__(self):
        self.model = None
        self.scaler = StandardScaler()
        self.is_trained = False
        self.threshold = -0.5  # Isolation Forest decision boundary (lower = more anomalous)

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
            contamination=0.05,  # expect ~5% anomalies in training data
            max_samples="auto",
            random_state=42,
            n_jobs=-1,
        )
        self.model.fit(X_scaled)
        self.is_trained = True

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

        # Get anomaly score (lower = more anomalous)
        score = self.model.decision_function(X_scaled)[0]
        prediction = self.model.predict(X_scaled)[0]

        # Normalize score to 0-1 range (0 = normal, 1 = very anomalous)
        # Isolation Forest scores: typically between -0.5 and 0.5
        normalized_score = max(0, min(1, 0.5 - score))

        return {
            "is_anomaly": prediction == -1,
            "anomaly_score": round(normalized_score, 4),
            "raw_score": round(score, 4),
            "confidence": round(min(normalized_score * 2, 1.0), 4),
            "message": "Anomalous pattern detected" if prediction == -1 else "Normal pattern",
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
        joblib.dump({"model": self.model, "scaler": self.scaler, "threshold": self.threshold}, path)
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
        self.is_trained = True
        print(f"Anomaly detector loaded from {path}")
        return True


# ─── Singleton instance ───────────────────────────────────────

detector = AnomalyDetector()
