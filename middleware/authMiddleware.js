const supabase = require("../config/supabase");

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authorization token is required"
      });
    }

    const token = authHeader.split(" ")[1];

    const {
      data: { user },
      error
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired authorization token"
      });
    }

    // Store authenticated user for later use
    req.user = user;

    next();

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Authentication error",
      error: error.message
    });
  }
};

module.exports = authMiddleware;