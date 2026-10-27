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

const {
  startEscalationScheduler
} = require("./controllers/incidentController");

const app = express();

// =====================================================
//                    MIDDLEWARE
// =====================================================

app.use(cors());
app.use(express.json());

// =====================================================
//                    HOME ROUTE
// =====================================================

app.get("/", (req, res) => {
  res.json({
    message: "RockFall Backend is running!"
  });
});

// =====================================================
//                    API ROUTES
// =====================================================

// Sensor API
app.use("/api", sensorRoutes);

// Worker API
app.use("/api", workerRoutes);

// Device API
app.use("/api", deviceRoutes);

// Alert API
app.use("/api", alertRoutes);

// Risk API
app.use("/api", riskRoutes);

// Authentication API
app.use("/api", authRoutes);

// Incident API
app.use("/api", incidentRoutes);

// Rescue response API
app.use("/api", rescueRoutes);

// Equipment API
app.use("/api", equipmentRoutes);

// =====================================================
//              SUPABASE CONNECTION TEST
// =====================================================

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

// =====================================================
//                    SERVER PORT
// =====================================================

const parsedPort = Number.parseInt(
  process.env.PORT,
  10
);

const PORT =
  Number.isInteger(parsedPort) &&
  parsedPort > 0 &&
  parsedPort < 65536
    ? parsedPort
    : 5002;

if (
  process.env.PORT &&
  String(PORT) !== String(process.env.PORT)
) {

  console.warn(
    `⚠️ PORT=${JSON.stringify(
      process.env.PORT
    )} is not a valid port - using ${PORT}`
  );
}

// =====================================================
//              START SERVER
// =====================================================

// IMPORTANT:
// 0.0.0.0 allows devices on the same network,
// including the ESP32, to reach this backend.

const server = app.listen(
  PORT,
  "0.0.0.0"
);

// =====================================================
//                 SERVER STARTED
// =====================================================

server.on("listening", () => {

  console.log("");
  console.log("========================================");
  console.log("       ROCKFALL BACKEND RUNNING");
  console.log("========================================");

  console.log(
    `Local:   http://localhost:${PORT}`
  );

  console.log(
    `Network: http://0.0.0.0:${PORT}`
  );

  console.log(
    `Sensor API: /api/sensor-data`
  );

  console.log("========================================");
  console.log("");

  // ---------------------------------------------------
  // Rescue layer:
  // escalation scheduler
  // ---------------------------------------------------

  startEscalationScheduler();
});

// =====================================================
//                    SERVER ERROR
// =====================================================

server.on("error", (err) => {

  if (err && err.code === "EADDRINUSE") {

    console.error(
      `\n❌ Port ${PORT} is already in use — the API is probably already running.\n` +
      `Stop it first with:\n` +
      `Get-NetTCPConnection -State Listen | ? { $_.LocalPort -eq ${PORT} } | % { Stop-Process -Id $_.OwningProcess -Force }\n` +
      `Or use another port:\n` +
      `$env:PORT=5003; node server.js\n`
    );

    process.exit(1);
  }

  console.error(
    `Backend failed to start: ${err.message}`
  );

  process.exit(1);
});