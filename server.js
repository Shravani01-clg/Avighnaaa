require("dotenv").config();
const workerRoutes = require("./routes/workerRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const alertRoutes = require("./routes/alertRoutes");
const riskRoutes = require("./routes/riskRoutes");
const authRoutes = require("./routes/authRoutes");
const incidentRoutes = require("./routes/incidentRoutes");
const rescueRoutes = require("./routes/rescueRoutes");
const equipmentRoutes = require("./routes/equipmentRoutes");
const express = require("express");
const cors = require("cors");
const supabase = require("./config/supabase");
const sensorRoutes = require("./routes/sensorRoutes");
const { startEscalationScheduler } = require("./controllers/incidentController");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Home route
app.get("/", (req, res) => {
  res.json({
    message: "RockFall Backend is running!"
  });
});

// Sensor API routes
app.use("/api", sensorRoutes);
app.use("/api", workerRoutes);
app.use("/api", deviceRoutes);
app.use("/api", alertRoutes);
app.use("/api", riskRoutes);

// Rescue response layer (extends the existing API — nothing replaced)
app.use("/api", authRoutes);
app.use("/api", incidentRoutes);
app.use("/api", rescueRoutes);
app.use("/api", equipmentRoutes);
// Temporary Supabase connection test
app.get("/test-supabase", async (req, res) => {
  const { data, error } = await supabase
    .from("workers")
    .select("*")
    .limit(1);

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }

  res.json({
    success: true,
    message: "Supabase connected successfully!",
    data: data
  });
});

// Start server
// Default 5002 to match .env / .env.example and API_BASE_URL in
// frontend/script.js. Keep all four in sync if you change the port.
// NOTE: PORT is validated numerically because a string "0" is truthy —
// `process.env.PORT || 5002` would happily bind to port 0 (random port)
// and the frontend would never find the backend.
const parsedPort = Number.parseInt(process.env.PORT, 10);
const PORT =
  Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536
    ? parsedPort
    : 5002;
if (process.env.PORT && String(PORT) !== String(process.env.PORT)) {
  console.warn(
    `⚠️  PORT=${JSON.stringify(process.env.PORT)} is not a valid port - using ${PORT}`
  );
}

const server = app.listen(PORT);

// 'listening' (not the listen callback) so the banner is only printed when
// the bind actually succeeded — otherwise a port clash printed
// "backend running" and then the error.
server.on("listening", () => {
  console.log(`RockFall backend running on http://localhost:${PORT}`);

  // Rescue layer: escalation scheduler (checks every tick for
  // unacknowledged incidents past RESPONSE_TIMEOUT_MINUTES)
  startEscalationScheduler();
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `\n❌ Port ${PORT} is already in use — the API is probably already running.\n` +
        `   Stop it first:\n` +
        `   Get-NetTCPConnection -State Listen | ? { $_.LocalPort -eq ${PORT} } | % { Stop-Process -Id $_.OwningProcess -Force }\n` +
        `   Or use another port:  $env:PORT=5003; node server.js\n`
    );
    process.exit(1);
  }
  console.error(`Backend failed to start: ${err.message}`);
  process.exit(1);
});