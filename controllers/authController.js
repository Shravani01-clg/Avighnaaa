const { resolveRole } = require("../middleware/roleMiddleware");

/**
 * GET /api/auth/me
 *
 * Returns the authenticated user's identity + backend-verified role.
 * The frontend uses this to decide which portal to show, but this is
 * display-only: every sensitive endpoint also checks the role server-side.
 */
const getMe = async (req, res) => {
  try {
    const role = await resolveRole(req);
    const profile = req.profile || {};

    res.json({
      success: true,
      data: {
        id: req.user.id,
        email: req.user.email || null,
        role: role || "user",
        team_id: profile.team_id || null,
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

module.exports = { getMe };
