const supabase = require("../config/supabase");

// GET all devices
const getDevices = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch devices",
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


// GET one device
const getDeviceById = async (req, res) => {
  try {
    const { deviceId } = req.params;

    const { data, error } = await supabase
      .from("devices")
      .select("*")
      .eq("device_id", deviceId)
      .single();

    if (error) {
      return res.status(404).json({
        success: false,
        message: "Device not found",
        error: error.message
      });
    }

    res.json({
      success: true,
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
  getDevices,
  getDeviceById
};