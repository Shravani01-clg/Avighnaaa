# RockFall API Contract

## Base URL

http://localhost:5002/api

## 1. Sensor Data

### POST /sensor-data

Used by the ESP32 to send sensor readings to the backend.

### Required Header

x-device-key: <DEVICE_API_KEY>

### Request Body

```json
{
  "device_id": "RF-001",
  "temperature_c": 32.5,
  "gas_raw": 420,
  "water_level_cm": 15.0,
  "acceleration_x_ms2": 0.20,
  "acceleration_y_ms2": 0.10,
  "acceleration_z_ms2": 9.70,
  "sos": false,
  "timestamp": "2026-09-05T10:20:00Z"
}