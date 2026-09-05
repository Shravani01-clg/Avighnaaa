const supabase = require("../config/supabase");

// POST /api/risk
const createRiskPrediction = async (req, res) => {
  try {
    const {
      device_id,
      risk_score,
      risk_level,
      reason
    } = req.body;

    if (
      !device_id ||
      risk_score === undefined ||
      !risk_level ||
      !reason
    ) {
      return res.status(400).json({
        success: false,
        message: "device_id, risk_score, risk_level and reason are required"
      });
    }

    const { data, error } = await supabase
      .from("risk_predictions")
      .insert([
        {
          device_id,
          risk_score,
          risk_level,
          reason
        }
      ])
      .select();

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to create risk prediction",
        error: error.message
      });
    }

    res.status(201).json({
      success: true,
      message: "Risk prediction created successfully",
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};


// GET /api/risk
const getRiskPredictions = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("risk_predictions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch risk predictions",
        error: error.message
      });
    }

    res.json({
      success: true,
      count: data.length,
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};


// GET /api/risk/:deviceId
const getRiskByDevice = async (req, res) => {
  try {
    const { deviceId } = req.params;

    const { data, error } = await supabase
      .from("risk_predictions")
      .select("*")
      .eq("device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch device risk predictions",
        error: error.message
      });
    }

    res.json({
      success: true,
      device_id: deviceId,
      count: data.length,
      data
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message
    });
  }
};


module.exports = {
  createRiskPrediction,
  getRiskPredictions,
  getRiskByDevice
};