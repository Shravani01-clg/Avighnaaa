/**
 * AVIGHNAA — MAIN DASHBOARD RESCUE INTEGRATION
 *
 * Closes the loop between the existing Avighnaa detection stack and the
 * rescue response layer:
 *
 *   sensor -> risk engine -> AI -> alert -> incident (automatic)
 *          -> this panel -> [REQUEST RESCUE TEAM] -> rescue portal
 *
 * Everything here reads the SAME backend incident state that the rescue
 * portal and rescue control use. There is no separate client-side status:
 * the panel is a view over /api/incidents.
 *
 * Loaded after script.js; uses API_BASE_URL + supabaseClient from there.
 */
(function () {
  "use strict";

  // Same incident state machine as the backend, mirrored for display only.
  const STATUS_TEXT = {
    AWAITING_RESPONSE: "Awaiting rescue request",
    ASSIGNED: "🚒 TEAM ASSIGNED",
    ACCEPTED: "🚒 TEAM ACCEPTED MISSION",
    EN_ROUTE: "🚒 TEAM EN ROUTE",
    ON_SCENE: "🚒 TEAM ON SCENE",
    RESCUE_IN_PROGRESS: "🟢 RESCUE IN PROGRESS",
    PERSON_SAFE: "✅ PERSON SAFE",
    RESOLVED: "✅ INCIDENT RESOLVED",
    ESCALATED: "⚠️ ESCALATED — RESPONSE OVERDUE",
    CANCELLED: "Incident cancelled",
  };

  const ACTIVE_STATUSES = [
    "AWAITING_RESPONSE", "ASSIGNED", "ACCEPTED", "EN_ROUTE",
    "ON_SCENE", "RESCUE_IN_PROGRESS", "PERSON_SAFE", "ESCALATED",
  ];

  let currentIncident = null;
  let refreshTimer = null;
  // Guards against a second ping while the first one is still in flight.
  // The button is also disabled, but the 10s poll re-renders the panel and
  // would otherwise re-enable it mid-request (a second click would then
  // reach the backend).
  let pingInFlight = false;

  const $ = (id) => document.getElementById(id);

  async function authHeaders() {
    const { data } = await supabaseClient.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : null;
  }

  function timeAgoShort(iso) {
    if (!iso) return "—";
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  }

  /** Render the panel for one incident (or hide it when there is none). */
  function render(incident) {
    const panel = $("dashboard-emergency");
    if (!panel) return;
    currentIncident = incident;

    if (!incident) {
      panel.classList.add("hidden");
      return;
    }

    panel.classList.remove("hidden");

    const isDone = ["RESOLVED", "CANCELLED"].includes(incident.status);
    panel.classList.toggle("resolved", isDone);

    const sev = incident.severity || "—";
    $("dash-emergency-sev").textContent = sev;
    $("dash-emergency-icon").textContent = isDone ? "✅" : "🚨";
    $("dash-emergency-heading").textContent = isDone
      ? "INCIDENT RESOLVED"
      : incident.rescue_requested
        ? "RESCUE TEAM REQUESTED"
        : "EMERGENCY DETECTED";

    $("dash-emergency-id").textContent = incident.incident_id
      ? `#${incident.incident_id}`
      : "—";
    $("dash-emergency-hazard").textContent =
      incident.hazard_label || incident.hazard_type || "—";
    $("dash-emergency-location").textContent = incident.location || "Location not configured";
    $("dash-emergency-person").textContent = incident.person_detected ? "YES" : "NO";
    $("dash-emergency-time").textContent = timeAgoShort(
      incident.detected_at || incident.created_at
    );

    const team = incident.assigned_team_name || incident.assigned_team_id;
    $("dash-emergency-team").textContent = team || "Unassigned";

    $("dash-emergency-status").textContent =
      STATUS_TEXT[incident.status] || incident.status_label || incident.status;

    // Button state follows the real backend state.
    const reqBtn = $("dash-request-rescue");
    const viewBtn = $("dash-view-incident");

    if (isDone) {
      reqBtn.disabled = true;
      reqBtn.textContent = "🚒 RESCUE COMPLETED";
    } else if (pingInFlight) {
      // A ping is on the wire — never re-enable the button underneath it.
      reqBtn.disabled = true;
      reqBtn.textContent = "🚒 PINGING RESCUE TEAM…";
    } else if (incident.rescue_requested) {
      reqBtn.disabled = true;
      reqBtn.textContent = "🚒 RESCUE REQUESTED";
    } else {
      reqBtn.disabled = false;
      reqBtn.textContent = "🚒 REQUEST RESCUE TEAM";
    }

    // Users can only open the incident view; the rescue team gets its portal.
    viewBtn.dataset.target = window.avighnaaRole === "user" ? "" : incident.incident_id;
  }

  /** Pull the most relevant open incident (or the latest resolved one). */
  async function refresh() {
    const headers = await authHeaders();
    if (!headers) return;

    try {
      const res = await fetch(`${API_BASE_URL}/incidents`, { headers });
      if (!res.ok) return;
      const body = await res.json();
      const all = Array.isArray(body.data) ? body.data : [];

      const open = all
        .filter((i) => ACTIVE_STATUSES.includes(i.status))
        .sort((a, b) => {
          const rank = { ESCALATED: 0, AWAITING_RESPONSE: 1 };
          const ra = rank[a.status] ?? 2;
          const rb = rank[b.status] ?? 2;
          if (ra !== rb) return ra - rb;
          return new Date(b.created_at) - new Date(a.created_at);
        });

      if (open.length > 0) {
        render(open[0]);
      } else {
        const done = all
          .filter((i) => ["RESOLVED", "CANCELLED"].includes(i.status))
          .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
        render(done[0] || null);
      }

      // Keep the sidebar incident badge in step with the same data.
      const badge = $("sidebar-incident-badge");
      if (badge) {
        badge.textContent = String(open.length);
        badge.style.display = open.length > 0 ? "" : "none";
      }
    } catch (err) {
      console.warn("Emergency panel refresh failed:", err.message);
    }
  }

  async function requestRescue() {
    const msg = $("dash-emergency-msg");
    const btn = $("dash-request-rescue");

    if (!currentIncident) {
      if (msg) msg.textContent = "No active incident to request.";
      return;
    }

    if (pingInFlight) return; // duplicate click — one request only

    const headers = await authHeaders();
    if (!headers) {
      if (msg) msg.textContent = "Not signed in — sign in to request rescue.";
      return;
    }

    // Snapshot the incident this ping belongs to, so a poll that swaps
    // currentIncident mid-flight cannot mislabel the result.
    const target = currentIncident;

    pingInFlight = true;
    btn.disabled = true;
    btn.textContent = "🚒 PINGING RESCUE TEAM…";
    if (msg) msg.textContent = "Requesting rescue team…";

    try {
      const res = await fetch(
        `${API_BASE_URL}/incidents/${encodeURIComponent(target.incident_id)}/request-rescue`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      const body = await res.json();

      if (!res.ok) {
        if (msg) msg.textContent = `Ping failed: ${body.message || res.status}`;
        pingInFlight = false;
        await refresh();
        return;
      }

      // The backend response is the source of truth for what was pinged.
      const data = body.data || {};
      const where = data.location || target.location;
      const who = data.assigned_team_id
        ? data.assigned_team_name
          ? `${data.assigned_team_id} (${data.assigned_team_name})`
          : data.assigned_team_id
        : "no team assigned yet";

      if (msg) {
        msg.textContent = body.already_requested
          ? `Rescue was already requested for ${target.incident_id} (${where}) — ${who}.`
          : `🚨 Rescue team pinged for ${target.incident_id} — ${where} · ${who}. The Rescue Portal now lists this alert.`;
      }
      addLogEntry("STATUS", "tag-status", `Rescue requested for ${target.incident_id}`);
    } catch (err) {
      if (msg) msg.textContent = `Ping failed: ${err.message}`;
      pingInFlight = false;
      await refresh();
      return;
    }

    pingInFlight = false;
    await refresh();
  }

  function viewIncident() {
    if (!currentIncident) return;
    const target = window.avighnaaRole === "user" ? null : "rescue";
    if (target) {
      const link = document.querySelector(`[data-target="${target}"]`);
      if (link) link.click();
    }
    // Control-room users get the SOS detail modal for this incident:
    // overview, per-alert AI recommendation, ping action and the
    // recorded communication timeline (sos-coordination.js).
    if (window.avighnaaRole === "user") {
      if (typeof window.openSosDetail === "function") {
        window.openSosDetail({
          incidentId: currentIncident.incident_id,
          deviceId: currentIncident.device_id,
        });
      }
      return;
    }
    const msg = $("dash-emergency-msg");
    if (msg && window.avighnaaRole === "user") {
      msg.textContent =
        `Incident ${currentIncident.incident_id} — status ${currentIncident.status}. ` +
        `Detailed mission view is available to the rescue team.`;
    }
  }

  function startPolling() {
    stopPolling();
    refreshTimer = setInterval(refresh, 10000);
  }

  function stopPolling() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function wire() {
    const reqBtn = $("dash-request-rescue");
    const viewBtn = $("dash-view-incident");
    if (reqBtn) reqBtn.addEventListener("click", requestRescue);
    if (viewBtn) viewBtn.addEventListener("click", viewIncident);

    // Start/stop with the session.
    window.addEventListener("avighnaa:session", (ev) => {
      const role = ev.detail && ev.detail.role;
      if (role) {
        refresh();
        startPolling();
      } else {
        render(null);
        stopPolling();
      }
    });
    window.addEventListener("avighnaa:logout", () => {
      render(null);
      stopPolling();
    });

    // Expose a refresh hook so sign-out/sign-in cycles always resync.
    window.refreshDashboardEmergency = refresh;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
