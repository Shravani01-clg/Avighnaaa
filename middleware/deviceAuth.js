require("dotenv").config();

const deviceAuth = (req, res, next) => {
  const apiKey = req.headers["x-device-key"];

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      message: "Device API key is required"
    });
  }

  if (apiKey !== process.env.DEVICE_API_KEY) {
    return res.status(403).json({
      success: false,
      message: "Invalid device API key"
    });
  }

  next();
};

module.exports = deviceAuth;