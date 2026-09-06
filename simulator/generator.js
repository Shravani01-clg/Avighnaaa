/**
 * Sensor Data Generator
 *
 * Generates realistic sensor readings for each mode:
 * - normal: Safe operating values with natural noise
 * - danger: Gradual or sudden spikes in specific sensors
 * - fall: Accelerometer-based fall signature
 * - sos: Emergency button press
 *
 * Each call to generate() returns one JSON reading ready for the API.
 */

const config = require("./config");

// Internal state — allows smooth transitions between values
let state = {
  temperature: 28,
  gasRaw: 200,
  waterLevelCm: 5,
  accelX: 0,
  accelY: 0,
  accelZ: 9.8,
};

/**
 * Add random noise to a value within a range
 */
function jitter(value, noiseAmount) {
  return value + (Math.random() - 0.5) * 2 * noiseAmount;
}

/**
 * Clamp a value between min and max
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Smoothly drift a value toward a target
 */
function drift(current, target, speed) {
  return current + (target - current) * speed + (Math.random() - 0.5) * speed * 0.3;
}

/**
 * Generate one normal (safe) sensor reading.
 * Values drift slowly with small random noise — mimics real sensors.
 */
function generateNormal() {
  const { normal } = config;

  // Slow drift around a comfortable baseline
  state.temperature = drift(state.temperature, jitter(28, 2), 0.1);
  state.gasRaw = drift(state.gasRaw, jitter(200, 30), 0.1);
  state.waterLevelCm = drift(state.waterLevelCm, jitter(5, 2), 0.08);
  state.accelX = drift(state.accelX, 0, 0.3);
  state.accelY = drift(state.accelY, 0, 0.3);
  state.accelZ = drift(state.accelZ, 9.8, 0.2);

  // Clamp to safe ranges
  state.temperature = clamp(state.temperature, normal.temperature.min, normal.temperature.max);
  state.gasRaw = clamp(state.gasRaw, normal.gasRaw.min, normal.gasRaw.max);
  state.waterLevelCm = clamp(state.waterLevelCm, normal.waterLevelCm.min, normal.waterLevelCm.max);
  state.accelX = clamp(state.accelX, normal.accel.x.min, normal.accel.x.max);
  state.accelY = clamp(state.accelY, normal.accel.y.min, normal.accel.y.max);
  state.accelZ = clamp(state.accelZ, normal.accel.z.min, normal.accel.z.max);

  return {
    device_id: config.deviceId,
    temperature_c: Math.round(state.temperature * 10) / 10,
    gas_raw: Math.round(state.gasRaw),
    water_level_cm: Math.round(state.waterLevelCm * 10) / 10,
    acceleration_x_ms2: Math.round(state.accelX * 100) / 100,
    acceleration_y_ms2: Math.round(state.accelY * 100) / 100,
    acceleration_z_ms2: Math.round(state.accelZ * 100) / 100,
    sos: false,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Generate a danger reading with gradual buildup.
 * @param {string} dangerType - "gas" | "flood" | "temperature" | "combined"
 * @param {number} progress - 0.0 to 1.0 (how far into the danger event)
 */
function generateDanger(dangerType, progress) {
  const reading = generateNormal(); // start with base values

  const intensity = Math.min(progress, 1.0);

  switch (dangerType) {
    case "gas":
      // Gas builds up gradually: 200 → 800+
      reading.gas_raw = Math.round(200 + intensity * 650);
      break;

    case "flood":
      // Water rises: 5cm → 40cm+
      reading.water_level_cm = Math.round((5 + intensity * 40) * 10) / 10;
      break;

    case "temperature":
      // Temperature climbs: 28°C → 55°C+
      reading.temperature_c = Math.round((28 + intensity * 30) * 10) / 10;
      break;

    case "combined":
      // Multiple dangers at once — gas + temp (fire/explosion risk)
      reading.gas_raw = Math.round(200 + intensity * 600);
      reading.temperature_c = Math.round((28 + intensity * 25) * 10) / 10;
      reading.water_level_cm = Math.round((5 + intensity * 25) * 10) / 10;
      break;

    default:
      break;
  }

  return reading;
}

/**
 * Generate a fall detection reading.
 * Simulates: normal → free-fall → impact → lying down
 *
 * @param {number} phase - Which phase of the fall (0-3)
 *   0: Normal (just before fall)
 *   1: Free-fall (acceleration drops near 0)
 *   2: Impact (sudden spike)
 *   3: Post-fall (lying down — orientation changed)
 */
function generateFall(phase) {
  const reading = generateNormal();

  switch (phase) {
    case 0:
      // Normal — standing still
      reading.acceleration_x_ms2 = jitter(0, 0.2);
      reading.acceleration_y_ms2 = jitter(0, 0.2);
      reading.acceleration_z_ms2 = jitter(9.8, 0.2);
      break;

    case 1:
      // Free-fall — all axes drop near zero (no gravity felt)
      reading.acceleration_x_ms2 = jitter(0, 0.3);
      reading.acceleration_y_ms2 = jitter(0, 0.3);
      reading.acceleration_z_ms2 = jitter(0.5, 0.5); // near zero
      break;

    case 2:
      // Impact — huge spike on all axes
      reading.acceleration_x_ms2 = jitter(25, 5); // ~2.5g spike
      reading.acceleration_y_ms2 = jitter(20, 5);
      reading.acceleration_z_ms2 = jitter(35, 8); // big hit on Z
      break;

    case 3:
      // Post-fall — person is lying down (orientation changed)
      // Z axis no longer has full gravity, X or Y picks up some
      reading.acceleration_x_ms2 = jitter(6.0, 1.0);  // gravity shifted here
      reading.acceleration_y_ms2 = jitter(1.5, 0.5);
      reading.acceleration_z_ms2 = jitter(4.0, 1.0);  // reduced from 9.8
      break;
  }

  return reading;
}

/**
 * Generate an SOS reading
 */
function generateSOS() {
  const reading = generateNormal();
  reading.sos = true;
  return reading;
}

/**
 * Generate a random danger event (2% chance per normal reading)
 */
function maybeRandomEvent() {
  if (Math.random() < config.randomEventChance) {
    const events = ["gas", "flood", "temperature"];
    const event = events[Math.floor(Math.random() * events.length)];
    return { type: "danger", dangerType: event, reading: generateDanger(event, 0.8) };
  }
  return null;
}

module.exports = {
  generateNormal,
  generateDanger,
  generateFall,
  generateSOS,
  maybeRandomEvent,
  resetState: () => {
    state = { temperature: 28, gasRaw: 200, waterLevelCm: 5, accelX: 0, accelY: 0, accelZ: 9.8 };
  },
};
