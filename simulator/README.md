# 🪨 RockFall Sensor Simulator

Simulates an ESP32 device sending sensor data to the backend. No hardware needed.

## Quick Start

```bash
# From the project root
cd simulator
node index.js

# Or from project root
node simulator/index.js
```

**Make sure the backend is running first:**
```bash
cd .. && node server.js
```

## Modes

| Command | What it does |
|---|---|
| `node index.js` | Normal mode — safe values, 2% chance of random danger |
| `node index.js --once` | Send one reading and exit |
| `node index.js --scenario gas` | Simulate a gas leak |
| `node index.js --scenario flood` | Simulate flooding |
| `node index.js --scenario overheat` | Simulate overheating |
| `node index.js --scenario fall` | Simulate a worker fall |
| `node index.js --scenario sos` | Simulate SOS with gas danger |
| `node index.js --scenario combined` | All dangers at once (CRITICAL) |
| `node index.js --loop` | Run all scenarios one after another |

## Sensor Values Generated

| Sensor | Normal Range | Danger Range | Unit |
|---|---|---|---|
| Temperature | 22–34 | 40–55+ | °C |
| Gas (raw) | 80–350 | 500–850+ | ADC |
| Water Level | 0–12 | 20–45+ | cm |
| Accel X | -0.5 to 0.5 | spikes during fall | m/s² |
| Accel Y | -0.5 to 0.5 | spikes during fall | m/s² |
| Accel Z | 9.3–10.3 | 0 (free-fall) / 35 (impact) | m/s² |
| SOS | false | true | bool |

## Configuration

Create a `.env` file in the simulator directory (or the project root):

```env
API_URL=http://localhost:5000
DEVICE_API_KEY=test-device-key-123
SIM_DEVICE_ID=SIM-DEVICE-001
SIM_INTERVAL_MS=3000
SIM_VERBOSE=true
```

## How It Works

1. **Generator** creates realistic sensor values with smooth drift and noise
2. **Scenarios** are generator sequences that simulate specific danger events
3. **Runner** sends the JSON to `POST /api/sensor-data` with the device API key
4. The backend processes it, calculates risk, and creates alerts automatically
