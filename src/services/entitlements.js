// ============================================
// FILE: services/entitlements.js
// Server-side RevenueCat entitlement lookup with an in-memory cache.
//
// RevenueCat REST v1: GET {base}/v1/subscribers/{app_user_id} with
// "Authorization: Bearer <secret key>". The response carries
// subscriber.entitlements[<id>].expires_date — null for a lifetime
// entitlement, otherwise an ISO 8601 timestamp.
//
// A lookup returns one of:
//   "active"   — entitlement present and not expired
//   "inactive" — no such entitlement, or it expired
//   "unknown"  — RevenueCat could not be reached, or no secret key is set
// "unknown" never blocks a request: a third-party outage must not lock out
// paying users.
// ============================================
const apiConfig = require("../config/apiConfig");
const logger = require("../utils/logger");
const { hashUserId, shortHash } = require("../middleware/requestContext");

const cache = new Map(); // userHash -> { status, expiresAt }

function cacheGet(userHash) {
  const hit = cache.get(userHash);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(userHash);
    return null;
  }
  return hit.status;
}

function cacheSet(userHash, status) {
  // "unknown" is never cached — retry the next request instead of pinning an
  // outage in memory for minutes.
  if (status === "unknown") return;
  const ttl =
    status === "active"
      ? apiConfig.revenueCat.activeCacheMs
      : apiConfig.revenueCat.inactiveCacheMs;
  cache.set(userHash, { status, expiresAt: Date.now() + ttl });
}

/**
 * @param {object} entitlement  RevenueCat entitlement object
 * @returns {boolean}
 */
function isEntitlementActive(entitlement) {
  if (!entitlement || typeof entitlement !== "object") return false;
  const expires = entitlement.expires_date;
  if (expires === null || expires === undefined) return true; // lifetime
  const ts = Date.parse(expires);
  return Number.isFinite(ts) && ts > Date.now();
}

/**
 * Look up the premium entitlement for a RevenueCat app user id.
 *
 * @param {string} userId
 * @param {object} deps  { fetchImpl } — injectable for tests
 * @returns {Promise<"active"|"inactive"|"unknown">}
 */
async function checkPremium(userId, deps = {}) {
  if (!userId) return "inactive";

  const { secretKey, entitlementId, apiBase, timeoutMs } = apiConfig.revenueCat;
  if (!secretKey) return "unknown";

  const userHash = hashUserId(userId);
  const cached = cacheGet(userHash);
  if (cached) return cached;

  const doFetch = deps.fetchImpl || globalThis.fetch;
  const url = `${apiBase.replace(/\/+$/, "")}/v1/subscribers/${encodeURIComponent(userId)}`;

  let status;
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404) {
      status = "inactive"; // no subscriber record yet
    } else if (res.status === 401 || res.status === 403) {
      // Our key is wrong — an owner misconfiguration, not a user problem.
      logger.error("premium_check_rejected", {
        status: res.status,
        hint: "REVENUECAT_SECRET_API_KEY appears invalid",
      });
      status = "unknown";
    } else if (!res.ok) {
      status = "unknown";
    } else {
      const body = await res.json();
      const entitlements = body?.subscriber?.entitlements || {};
      status = isEntitlementActive(entitlements[entitlementId]) ? "active" : "inactive";
    }
  } catch (err) {
    logger.warn("premium_check_unavailable", {
      user: shortHash(userHash),
      error: err.message,
    });
    return "unknown";
  }

  if (status === "unknown") {
    logger.warn("premium_check_unavailable", { user: shortHash(userHash) });
  }

  cacheSet(userHash, status);
  return status;
}

/** Test seam. */
function _resetCache() {
  cache.clear();
}

module.exports = { checkPremium, isEntitlementActive, _resetCache };
