/**
 * Danger Scenarios
 *
 * Predefined sequences of sensor readings that simulate real-world events.
 * Each scenario is a function that yields one reading per call.
 *
 * Usage:
 *   const scenario = scenarios.gasLeak();
 *   const reading = scenario.next().value;  // call repeatedly to advance
 */

const { generateNormal, generateDanger, generateFall, generateSOS } = require("./generator");
const config = require("./config");

/**
 * Scenario: Gas Leak
 * Gas gradually builds up from normal → dangerous over ~30 readings
 * Then holds at danger level for ~15 readings, then returns to normal.
 */
function* gasLeak() {
  const buildup = config.scenarioDuration.medium;
  const hold = config.scenarioDuration.short;

  // Pre-event: normal readings
  for (let i = 0; i < 5; i++) yield generateNormal();

  // Buildup phase
  for (let i = 0; i < buildup; i++) {
    const progress = i / buildup;
    yield generateDanger("gas", progress);
  }

  // Hold at danger level
  for (let i = 0; i < hold; i++) {
    yield generateDanger("gas", 1.0);
  }

  // Recovery: gas dissipates
  for (let i = hold; i >= 0; i--) {
    yield generateDanger("gas", i / hold);
  }

  // Back to normal
  for (let i = 0; i < 5; i++) yield generateNormal();
}

/**
 * Scenario: Flood / Rising Water
 * Water level slowly rises from 5cm → 45cm over time.
 */
function* flood() {
  const buildup = config.scenarioDuration.medium;
  const hold = config.scenarioDuration.short;

  for (let i = 0; i < 5; i++) yield generateNormal();

  for (let i = 0; i < buildup; i++) {
    const progress = i / buildup;
    yield generateDanger("flood", progress);
  }

  for (let i = 0; i < hold; i++) {
    yield generateDanger("flood", 1.0);
  }

  for (let i = hold; i >= 0; i--) {
    yield generateDanger("flood", i / hold);
  }

  for (let i = 0; i < 5; i++) yield generateNormal();
}

/**
 * Scenario: High Temperature (equipment overheating / fire)
 */
function* overheat() {
  const buildup = config.scenarioDuration.medium;
  const hold = config.scenarioDuration.short;

  for (let i = 0; i < 5; i++) yield generateNormal();

  for (let i = 0; i < buildup; i++) {
    const progress = i / buildup;
    yield generateDanger("temperature", progress);
  }

  for (let i = 0; i < hold; i++) {
    yield generateDanger("temperature", 1.0);
  }

  for (let i = hold; i >= 0; i--) {
    yield generateDanger("temperature", i / hold);
  }

  for (let i = 0; i < 5; i++) yield generateNormal();
}

/**
 * Scenario: Worker Fall
 * Normal → free-fall → impact → lying down → recovery
 */
function* workerFall() {
  // Normal standing
  for (let i = 0; i < 3; i++) yield generateFall(0);

  // Free-fall (1-2 readings, very brief)
  yield generateFall(1);
  yield generateFall(1);

  // Impact (1 reading — the big spike)
  yield generateFall(2);

  // Lying down (several readings while SOS might be pressed)
  for (let i = 0; i < 8; i++) yield generateFall(3);

  // Recovery
  for (let i = 0; i < 5; i++) yield generateNormal();
}

/**
 * Scenario: SOS Emergency
 * Worker presses SOS button while in danger
 */
function* sosEmergency() {
  // Normal
  for (let i = 0; i < 3; i++) yield generateNormal();

  // Danger builds up
  for (let i = 0; i < 10; i++) {
    const reading = generateDanger("gas", i / 10);
    yield reading;
  }

  // SOS pressed (with danger still active)
  for (let i = 0; i < 15; i++) {
    const reading = generateDanger("gas", 1.0);
    reading.sos = true;
    yield reading;
  }

  // SOS off, danger persists
  for (let i = 0; i < 5; i++) {
    yield generateDanger("gas", 0.7);
  }

  for (let i = 0; i < 5; i++) yield generateNormal();
}

/**
 * Scenario: Combined Danger (gas + flood + temperature)
 * The worst case — triggers CRITICAL alerts.
 */
function* combinedDanger() {
  for (let i = 0; i < 3; i++) yield generateNormal();

  const buildup = config.scenarioDuration.medium;

  for (let i = 0; i < buildup; i++) {
    const progress = i / buildup;
    yield generateDanger("combined", progress);
  }

  // Peak danger with SOS
  for (let i = 0; i < 10; i++) {
    const reading = generateDanger("combined", 1.0);
    reading.sos = true;
    yield reading;
  }

  for (let i = config.scenarioDuration.short; i >= 0; i--) {
    yield generateDanger("combined", i / config.scenarioDuration.short);
  }

  for (let i = 0; i < 5; i++) yield generateNormal();
}

module.exports = {
  gasLeak,
  flood,
  overheat,
  workerFall,
  sosEmergency,
  combinedDanger,
};
