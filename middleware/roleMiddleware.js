require("dotenv").config();
const supabase = require("../config/supabase");

/**
 * Role Middleware
 *
 * Extends the existing authMiddleware instead of replacing it.
 * authMiddleware verifies the Supabase JWT and sets req.user.
 * This module resolves the user's ROLE (backend-side) and
 * enforces role requirements on rescue endpoints.
 *
 * Roles: 'user' | 'rescue_team' (there is no admin role)
 *
 * Role resolution order:
 *   1. app_metadata.role on the Supabase auth user (set via Supabase dashboard/SQL)
 *   2. profiles table row (created by migration 001 trigger)
 *   3. fallback: 'user'  (deny by default)
 *
 * AVIGHNAA has exactly TWO roles: 'user' and 'rescue_team'.
 * There is no admin role. Legacy rows that still say 'admin' are folded
 * into 'rescue_team' so accounts created before the two-role cutover keep
 * working (migrations/006_two_roles.sql rewrites them properly).
 *
 * Frontend hiding is NOT sufficient — every rescue endpoint must run
 * through requireRole() so manual URL access is blocked.
 */

const VALID_ROLES = ["user", "rescue_team"];

function normalizeRole(role) {
  const r = String(role || "").toUpperCase();
  if (r === "RESCUE_TEAM" || r === "RESCUE" || r === "RESCUETEAM") return "rescue_team";
  if (r === "USER") return "user";
  // Legacy: the removed admin role now behaves as the rescue team, which
  // owns rescue control under the two-role architecture.
  if (r === "ADMIN") return "rescue_team";
  return null;
}

/**
 * Resolve and attach req.role + req.profile for an authenticated user.
 * Safe to call multiple times (caches on req).
 */
async function resolveRole(req) {
  if (req.role) return req.role;

  const user = req.user;
  if (!user) {
    req.role = null;
    return null;
  }

  // 1) app_metadata.role (backend-verifiable, comes from the verified JWT user)
  const metaRole = normalizeRole(user.app_metadata && user.app_metadata.role);
  if (metaRole) {
    req.role = metaRole;
    req.profile = {
      id: user.id,
      email: user.email || null,
      role: metaRole,
      team_id: (user.app_metadata && user.app_metadata.team_id) || null,
    };
    return metaRole;
  }

  // 2) profiles table (service-role key — backend only)
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, role, team_id")
      .eq("id", user.id)
      .limit(1);

    if (!error && data && data.length > 0) {
      const profile = data[0];
      const role = normalizeRole(profile.role) || "user";
      req.role = role;
      req.profile = { ...profile, role };
      return role;
    }
  } catch (err) {
    console.error("Role lookup failed:", err.message);
  }

  // 3) deny by default
  req.role = "user";
  req.profile = { id: user.id, email: user.email || null, role: "user", team_id: null };
  return "user";
}

/**
 * requireRole(...allowedRoles)
 *
 * Must run AFTER authMiddleware (which sets req.user).
 * Examples:
 *   requireRole("rescue_team")
 *   requireRole("user", "rescue_team")
 */
function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const role = await resolveRole(req);

      if (!role || !VALID_ROLES.includes(role)) {
        return res.status(403).json({
          success: false,
          message: "Role could not be verified",
        });
      }

      if (!allowedRoles.includes(role)) {
        return res.status(403).json({
          success: false,
          message: "Access denied: insufficient role permissions",
          required: allowedRoles,
          your_role: role,
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Authorization error",
        error: error.message,
      });
    }
  };
}

module.exports = {
  requireRole,
  resolveRole,
  VALID_ROLES,
};
