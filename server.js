require("dotenv").config();
const workerRoutes = require("./routes/workerRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const alertRoutes = require("./routes/alertRoutes");
const riskRoutes = require("./routes/riskRoutes");
const express = require("express");
const cors = require("cors");
const supabase = require("./config/supabase");
const sensorRoutes = require("./routes/sensorRoutes");

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
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`RockFall backend running on http://localhost:${PORT}`);
});