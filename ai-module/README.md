# 🤖 RockFall AI/ML Module

Machine learning module for anomaly detection and risk prediction.

## Architecture

```
Sensor Data → [Rule-Based Engine] → Risk Score + Alerts
                    ↓ (second opinion)
              [AI/ML Module]
                    ↓
         Anomaly Detection (Isolation Forest)
         Risk Prediction (Gradient Boosting)
                    ↓
         Combined with rule-based → Final Risk
```

**Key principle:** The AI supports the safety logic, never replaces it. If AI says higher risk, we use AI's level. If rule-based says higher, we keep rule-based.

## Quick Start

```bash
cd ai-module

# Install Python dependencies
pip install -r requirements.txt

# Train the models
python train.py

# Start the prediction server
python server.py
```

The server runs on port 5001 by default.

## Models

### Anomaly Detection (Isolation Forest)
- Trained on **normal data only**
- Flags unusual patterns the rule-based engine might miss
- Catches gradual drift, unusual combinations, sensor malfunctions
- Output: `is_anomaly` (bool), `anomaly_score` (0-1)

### Risk Prediction (Gradient Boosting)
- Trained on **all labeled scenarios**
- Predicts risk level: LOW / MEDIUM / HIGH / CRITICAL
- Output: `predicted_risk_level`, `confidence`, `probabilities`

## API Endpoints

| Endpoint | Method | Input | Output |
|---|---|---|---|
| `/health` | GET | — | Model status |
| `/predict/risk` | POST | Sensor data | Risk level + probabilities |
| `/predict/anomaly` | POST | Sensor data | Anomaly flag + score |
| `/predict/all` | POST | Sensor data | Combined analysis |

### Example Request

```json
POST /predict/all
{
  "temperature_c": 48,
  "gas_raw": 650,
  "water_level_cm": 5,
  "acceleration_x_ms2": 0,
  "acceleration_y_ms2": 0,
  "acceleration_z_ms2": 9.8,
  "sos": false
}
```

### Example Response

```json
{
  "risk": {
    "predicted_risk_level": "HIGH",
    "risk_score": 70,
    "confidence": 0.92,
    "probabilities": {"LOW": 0.02, "MEDIUM": 0.06, "HIGH": 0.92, "CRITICAL": 0.0}
  },
  "anomaly": {
    "is_anomaly": true,
    "anomaly_score": 0.85
  },
  "combined": {
    "risk_score": 70,
    "risk_level": "HIGH"
  }
}
```

## Files

| File | Purpose |
|---|---|
| `dataset_generator.py` | Generates labeled training data |
| `anomaly_detector.py` | Isolation Forest model |
| `risk_predictor.py` | Gradient Boosting model |
| `train.py` | Training script |
| `server.py` | Flask prediction server |
| `training_data.csv` | Generated dataset |
| `anomaly_model.pkl` | Saved anomaly model |
| `risk_model.pkl` | Saved risk model |
