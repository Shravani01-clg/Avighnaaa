// Calculate risk based on sensor values
const calculateRisk = (sensorData) => {
  let riskScore = 0;
  const reasons = [];

  // Temperature
  if (sensorData.temperature_c >= 45) {
    riskScore += 30;
    reasons.push("High temperature");
  } else if (sensorData.temperature_c >= 40) {
    riskScore += 15;
    reasons.push("Elevated temperature");
  }

  // Gas
  if (sensorData.gas_raw >= 700) {
    riskScore += 30;
    reasons.push("High gas level");
  } else if (sensorData.gas_raw >= 500) {
    riskScore += 15;
    reasons.push("Elevated gas level");
  }

  // Water
  if (sensorData.water_level_cm >= 30) {
    riskScore += 25;
    reasons.push("High water level");
  } else if (sensorData.water_level_cm >= 20) {
    riskScore += 10;
    reasons.push("Rising water level");
  }

  // SOS
  if (sensorData.sos === true) {
    riskScore += 40;
    reasons.push("SOS activated");
  }

  // Keep score within 0–100
  riskScore = Math.min(riskScore, 100);

  let riskLevel = "LOW";

  if (riskScore >= 70) {
    riskLevel = "HIGH";
  } else if (riskScore >= 40) {
    riskLevel = "MEDIUM";
  }

  return {
    risk_score: riskScore,
    risk_level: riskLevel,
    reason: reasons.length > 0
      ? reasons.join(", ")
      : "No major risk detected"
  };
};

module.exports = {
  calculateRisk
};