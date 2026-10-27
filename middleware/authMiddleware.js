const supabase = require("../config/supabase");

/**
 * Verifies the Supabase JWT on every API request.
 *
 * ── Why there is a small token cache ──────────────────────────
 * supabase.auth.getUser(token) asks the Supabase AUTH SERVER over the
 * network — on a typical connection that is a few hundred milliseconds.
 * Without a cache EVERY API call paid that round trip on top of its own
 * database query, which made the app (dashboard, incident details, the
 * rescue console, the notification bell) feel slow for no visible reason.
 *
 * Supabase access tokens are valid for ~1 hour, so a validated
 * token → user result is reused for a short window instead of being
 * re-verified on every request. The trade-off: a token that was just
 * revoked may keep working for at most AUTH_CACHE_TTL_MS. Five minutes
 * is the deliberate balance between revocation freshness and speed; the
 * window can be lowered to 0 here without touching anything else.
 */

const AUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AUTH_CACHE_MAX = 500; // bounded — oldest entries are evicted first

/** Insertion-ordered Map used as a simple LRU-ish cache. */
const tokenCache = new Map();

function cacheGet(token) {
  const hit = tokenCache.get(token);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    tokenCache.delete(token);
    return null;
  }
  // Refresh insertion order so hot tokens are evicted last.
  tokenCache.delete(token);
  tokenCache.set(token, hit);
  return hit.user;
}

function cacheSet(token, user) {
  if (tokenCache.size >= AUTH_CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = tokenCache.keys().next().value;
    tokenCache.delete(oldest);
  }
  tokenCache.set(token, { user, expires: Date.now() + AUTH_CACHE_TTL_MS });
}

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

    // Already verified recently → skip the network round trip.
    const cachedUser = cacheGet(token);
    if (cachedUser) {
      req.user = cachedUser;
      return next();
    }

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
    cacheSet(token, user);

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
