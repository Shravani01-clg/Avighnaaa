"""
Risk Predictor

Supervised ML model that predicts risk level (LOW / MEDIUM / HIGH / CRITICAL)
from sensor readings. Trained on labeled data from the simulator.

This provides a "second opinion" alongside the rule-based risk engine.
The final risk is the MAX of rule-based and ML prediction — the AI never
downgrades a critical alert.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.metrics import classification_report
import joblib
import os

MODEL_DIR = os.path.dirname(__file__)

FEATURES = [
    "temperature_c",
    "gas_raw",
    "water_level_cm",
    "acceleration_x_ms2",
    "acceleration_y_ms2",
    "acceleration_z_ms2",
    "sos",
]

RISK_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


class RiskPredictor:
    def __init__(self):
        self.model = None
        self.label_encoder = LabelEncoder()
        self.scaler = StandardScaler()
        self.is_trained = False

    def train(self, dataset: pd.DataFrame):
        """
        Train the risk prediction model.

        Args:
            dataset: DataFrame with sensor features + 'risk_level' column
        """
        # Prepare features
        df = dataset.copy()
        df["sos"] = df["sos"].astype(int)

        X = df[FEATURES].values
        y = df["risk_level"].values

        # Encode labels
        y_encoded = self.label_encoder.fit_transform(y)

        # Scale features
        X_scaled = self.scaler.fit_transform(X)

        # Split
        X_train, X_test, y_train, y_test = train_test_split(
            X_scaled, y_encoded, test_size=0.2, random_state=42, stratify=y_encoded
        )

        # Train with Gradient Boosting (better than plain RF for this)
        self.model = GradientBoostingClassifier(
            n_estimators=150,
            max_depth=6,
            learning_rate=0.1,
            random_state=42,
        )
        self.model.fit(X_train, y_train)
        self.is_trained = True

        # Evaluate
        y_pred = self.model.predict(X_test)
        y_test_labels = self.label_encoder.inverse_transform(y_test)
        y_pred_labels = self.label_encoder.inverse_transform(y_pred)

        print("\n=== Risk Predictor Performance ===")
        print(classification_report(y_test_labels, y_pred_labels))

        # Cross-validation
        scores = cross_val_score(self.model, X_scaled, y_encoded, cv=5, scoring="accuracy")
        print(f"Cross-validation accuracy: {scores.mean():.3f} ± {scores.std():.3f}")

        # Feature importance
        importance = self.model.feature_importances_
        print("\nFeature importance:")
        for feat, imp in sorted(zip(FEATURES, importance), key=lambda x: -x[1]):
            print(f"  {feat}: {imp:.3f}")

    def predict(self, sensor_reading: dict) -> dict:
        """
        Predict risk level from a single sensor reading.

        Args:
            sensor_reading: dict with sensor values

        Returns:
            dict with predicted_risk_level, confidence, probabilities
        """
        if not self.is_trained:
            return {
                "predicted_risk_level": "LOW",
                "confidence": 0.0,
                "probabilities": {},
                "message": "Model not trained yet — defaulting to LOW",
            }

        X = np.array([[
            sensor_reading.get("temperature_c", 0),
            sensor_reading.get("gas_raw", 0),
            sensor_reading.get("water_level_cm", 0),
            sensor_reading.get("acceleration_x_ms2", 0),
            sensor_reading.get("acceleration_y_ms2", 0),
            sensor_reading.get("acceleration_z_ms2", 0),
            int(sensor_reading.get("sos", False)),
        ]])

        X_scaled = self.scaler.transform(X)

        prediction = self.model.predict(X_scaled)[0]
        probabilities = self.model.predict_proba(X_scaled)[0]

        # Build probability dict
        prob_dict = {}
        for i, class_name in enumerate(self.label_encoder.classes_):
            prob_dict[class_name] = round(float(probabilities[i]), 4)

        # Confidence = max probability
        confidence = round(float(max(probabilities)), 4)

        # Risk score (0-100) based on predicted level
        risk_score_map = {"LOW": 15, "MEDIUM": 45, "HIGH": 70, "CRITICAL": 95}
        risk_score = risk_score_map.get(prediction, 15)

        # Adjust score within level based on probability distribution
        if prediction != "LOW":
            # If there's significant probability of a higher level, boost score
            for level in ["MEDIUM", "HIGH", "CRITICAL"]:
                idx = list(self.label_encoder.classes_).index(level) if level in self.label_encoder.classes_ else -1
                if idx >= 0:
                    risk_score = min(100, risk_score + int(probabilities[idx] * 15))

        return {
            "predicted_risk_level": prediction,
            "risk_score": risk_score,
            "confidence": confidence,
            "probabilities": prob_dict,
            "message": f"ML prediction: {prediction} (confidence: {confidence:.1%})",
        }

    def save(self, path=None):
        """Save the trained model to disk."""
        path = path or os.path.join(MODEL_DIR, "risk_model.pkl")
        joblib.dump({
            "model": self.model,
            "label_encoder": self.label_encoder,
            "scaler": self.scaler,
        }, path)
        print(f"Risk predictor saved to {path}")

    def load(self, path=None):
        """Load a trained model from disk."""
        path = path or os.path.join(MODEL_DIR, "risk_model.pkl")
        if not os.path.exists(path):
            print(f"No saved model found at {path}")
            return False

        data = joblib.load(path)
        self.model = data["model"]
        self.label_encoder = data["label_encoder"]
        self.scaler = data["scaler"]
        self.is_trained = True
        print(f"Risk predictor loaded from {path}")
        return True


# ─── Singleton instance ───────────────────────────────────────

predictor = RiskPredictor()
