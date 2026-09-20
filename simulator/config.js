require("dotenv").config();
const config = {
  // Backend API
apiUrl: process.env.API_URL || "http://localhost:5002",
deviceApiKey: process.env.DEVICE_API_KEY,
  // Device identity (simulates an ESP32)
deviceId: process.env.SIM_DEVICE_ID || "RF-001",
  // How often to send data (ms)
  intervalMs: parseInt(process.env.SIM_INTERVAL_MS) || 3000,

  // Normal operating ranges (safe zone)
  normal: {
    temperature: { min: 22, max: 34 },        // °C
    gasRaw: { min: 80, max: 350 },             // raw ADC value
    waterLevelCm: { min: 0, max: 12 },         // cm
    // Acceleration in m/s² (gravity ≈ 9.8 on Z axis when standing)
    accel: {
      x: { min: -0.5, max: 0.5 },
      y: { min: -0.5, max: 0.5 },
      z: { min: 9.3, max: 10.3 },  // ~9.8 (gravity) ± small noise
    },
    sos: false,
  },

  // Scenario durations (how many readings each scenario lasts)
  scenarioDuration: {
    short: 10,   // ~30 seconds at 3s interval
    medium: 30,  // ~90 seconds
    long: 60,    // ~180 seconds
  },

  // Probability of triggering a random danger event per reading (normal mode)
  randomEventChance: 0.02, // 2% chance per reading

  // Logging
  verbose: process.env.SIM_VERBOSE === "true" || false,
};

module.exports = config;
