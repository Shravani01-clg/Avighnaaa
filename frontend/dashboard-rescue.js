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

  // The dashboard's emergency panel is the CONTROL-ROOM view of an SOS.
  // It stays on the dashboard for as long as the SOS alert is open, and
  // leaves only once that alert is closed — the incident row itself stays
  // untouched in the database (closing incidents is the rescue team's
  // workflow, and the record stays in SOS History). Non-SOS incidents
  // (falls, equipment) have no SOS alert to close, so they keep showing
  // while active.
  function isClosedSosIncident(incident) {
    const alerts = (typeof appState !== "undefined" && appState.alerts) || [];
    const deviceSos = alerts.filter(
      (a) => a.belt === incident.device_id && (a.isSOS || a.synthetic)
    );
    if (deviceSos.length === 0) return false; // not SOS-derived

    // Any unacknowledged SOS for this device means the emergency is still
    // live — never hide it, no matter what other (older) alerts exist.
    if (deviceSos.some((a) => !a.ack)) return false;

    // Everything is closed: hide the panel only when at least one of those
    // closed SOS alerts belongs to THIS incident (same ±10 min window SOS
    // History uses), so an old closed SOS on the same belt cannot hide a
    // new, different emergency.
    const start = new Date(
      incident.detected_at || incident.created_at || 0
    ).getTime();
    return deviceSos.some((a) => {
      const t = new Date(a.createdAt || 0).getTime();
      return !t || !start || Math.abs(t - start) <= 10 * 60 * 1000;
    });
  }

  let currentIncident = null;
  // The incident the admin is focusing on (null = newest active). A newly
  // generated SOS must surface immediately — it is never shadowed by an
  // older open incident, and every other active one stays reachable via
  // the chip row rendered under the panel header.
  let selectedIncidentId = null;
  let lastOpenIncidents = []; // last poll's active list (chip switcher)
  let refreshTimer = null;
  // Guards against a second ping while the first one is still in flight.
  // The button is also disabled, but the 10s poll re-renders the panel and
  // would otherwise re-enable it mid-request (a second click would then
  // reach the backend).
  let pingInFlight = false;
  // One CLOSE ALERT operation at a time (mirrors pingInFlight).
  let closeAlertInFlight = false;

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
  function render(incident, openList) {
    const panel = $("dashboard-emergency");
    if (!panel) return;
    currentIncident = incident;

    // Remember which incident the admin is on while it stays active, so
    // the 10s poll refreshes the SAME incident instead of jumping around.
    if (incident && ACTIVE_STATUSES.includes(incident.status)) {
      selectedIncidentId = incident.incident_id;
    }

    if (!incident) {
      panel.classList.add("hidden");
      selectedIncidentId = null;
      renderIncidentChips(null, openList || []);
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

    // CLOSE ALERT closes the SOS alert for this incident's device through
    // the existing backend mechanism. As soon as that alert is closed the
    // panel itself leaves the dashboard (see isClosedSosIncident) — the
    // incident row stays untouched in the backend and in SOS History.
    const closeBtn = $("dash-close-alert");
    if (closeBtn) {
      const hasOpenSos = (appState.alerts || []).some(
        (a) => !a.ack && (a.isSOS || a.synthetic) && a.belt === incident.device_id
      );
      if (closeAlertInFlight) {
        closeBtn.disabled = true;
        closeBtn.textContent = "✖ CLOSING…";
        closeBtn.classList.remove("hidden");
      } else if (hasOpenSos && !isDone) {
        closeBtn.disabled = false;
        closeBtn.textContent = "✖ CLOSE ALERT";
        closeBtn.classList.remove("hidden");
      } else {
        // Nothing to close (e.g. a non-SOS incident) — don't offer it.
        closeBtn.disabled = true;
        closeBtn.classList.add("hidden");
      }
    }

    // Users can only open the incident view; the rescue team gets its portal.
    viewBtn.dataset.target = window.avighnaaRole === "user" ? "" : incident.incident_id;

    renderIncidentChips(incident, openList || lastOpenIncidents);
  }

  /**
   * Chip row for the OTHER active emergencies. Nothing is hidden when a
   * new SOS arrives: the panel focuses the newest active incident, and
   * every other open one stays one click away here.
   */
  function renderIncidentChips(current, open) {
    const chipsEl = $("dash-emergency-others");
    if (!chipsEl) return;

    const others = (open || []).filter(
      (i) => !current || i.incident_id !== current.incident_id
    );

    if (others.length === 0) {
      chipsEl.classList.add("hidden");
      chipsEl.innerHTML = "";
      return;
    }

    chipsEl.classList.remove("hidden");
    chipsEl.innerHTML =
      `<span class="de-chip-label">${open.length} active &mdash; switch:</span>` +
      others
        .map((i) => {
          // incident ids are backend-generated (e.g. AV-1024); strip any
          // character that could break out of the inline handler.
          const safe = String(i.incident_id).replace(/[^A-Za-z0-9_-]/g, "");
          return `
            <button
              type="button"
              class="dash-em-chip${i.status === "ESCALATED" ? " escalated" : ""}"
              onclick="dashSelectIncident('${safe}')"
              title="${i.severity || ""} ${i.hazard_type || "incident"}${i.location ? ` at ${i.location}` : ""}"
            >
              ${i.status === "ESCALATED" ? "⚠️ " : ""}#${safe}
              · ${String(i.status || "").replace(/_/g, " ")}
            </button>`;
        })
        .join("");
  }

  /** Chip click — focus another active incident without a refetch. */
  window.dashSelectIncident = function (id) {
    const inc = lastOpenIncidents.find((i) => i.incident_id === id);
    if (inc) render(inc, lastOpenIncidents);
  };

  /** Pull the most relevant open incident (or the latest resolved one). */
  async function refresh() {
    const headers = await authHeaders();
    if (!headers) return;

    try {
      const res = await fetch(`${API_BASE_URL}/incidents`, { headers });
      if (!res.ok) return;
      const body = await res.json();
      const all = Array.isArray(body.data) ? body.data : [];

      // Shared with renderAlerts (script.js) so every SOS alert card can
      // show the rescue status ("🚒 ASSIGNED · RT-01") from the same poll
      // — one source of truth, no extra request.
      if (typeof appState !== "undefined") appState.incidents = all;

      const open = all
        .filter((i) => ACTIVE_STATUSES.includes(i.status))
        // A closed SOS leaves the dashboard; the incident row stays in the
        // backend and SOS History untouched.
        .filter((i) => !isClosedSosIncident(i))
        // NEWEST FIRST: a newly generated SOS incident must surface
        // immediately instead of being shadowed by an older open one
        // (previously an old ESCALATED incident always won the panel).
        // Every other active incident stays reachable via the chip row.
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      lastOpenIncidents = open;

      if (open.length > 0) {
        // Keep the admin's explicit selection while that incident is
        // still active; otherwise fall back to the newest active one.
        const stillOpen = selectedIncidentId
          ? open.find((i) => i.incident_id === selectedIncidentId)
          : null;
        render(stillOpen || open[0], open);
      } else {
        // Nothing open for the control room: hide the panel entirely.
        // (Closed records stay in the backend + SOS History.)
        render(null, []);
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
        window.showAppToast?.(
          "Rescue request failed",
          `Could not send the rescue request: ${body.message || res.status}`,
          "error"
        );
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

      if (body.already_requested) {
        if (msg) msg.textContent = `Rescue was already requested for ${target.incident_id} (${where}) — ${who}.`;
        window.showAppToast?.(
          "Rescue already requested",
          `Rescue was already requested for ${target.incident_id} — no duplicate request was sent.`,
          "info"
        );
      } else {
        if (msg) msg.textContent = `🚨 Rescue team pinged for ${target.incident_id} — ${where} · ${who}. The Rescue Portal now lists this alert.`;
        // Prominent confirmation, shown only after the backend confirmed
        // the request (never optimistically).
        window.showAppToast?.(
          "Rescue request sent",
          "Rescue team request sent successfully.",
          "success"
        );
      }
      addLogEntry("STATUS", "tag-status", `Rescue requested for ${target.incident_id}`);
    } catch (err) {
      if (msg) msg.textContent = `Ping failed: ${err.message}`;
      window.showAppToast?.(
        "Rescue request failed",
        `Could not send the rescue request: ${err.message}`,
        "error"
      );
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

  // ── CLOSE ALERT (control room) ───────────────────────────────
  // Closes the SOS ALERT for this incident's device through the existing
  // backend mechanism — PATCH /api/alerts/:id/resolve (authenticated route,
  // same one the alerts page uses). The incident row is NOT modified: the
  // database record stays (closing incidents is the rescue team's
  // workflow), but the dashboard panel disappears together with the alert —
  // see isClosedSosIncident(). Confirmation is required; a backend failure
  // keeps everything on screen with an error toast.
  async function closeIncidentAlert() {
    const incident = currentIncident;
    if (!incident || closeAlertInFlight) return;

    const device = incident.device_id;
    const targets = (appState.alerts || []).filter(
      (a) => !a.ack && (a.isSOS || a.synthetic) && a.belt === device
    );

    if (targets.length === 0) {
      window.showAppToast?.(
        "Nothing to close",
        `No open SOS alert for ${incident.incident_id}.`,
        "info"
      );
      return;
    }

    if (
      !confirm(
        `Close the SOS alert for ${incident.incident_id} (Belt ${device})?\n\n` +
          "The alert leaves the dashboard but stays saved in SOS History."
      )
    )
      return;

    closeAlertInFlight = true;
    const btn = $("dash-close-alert");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "✖ CLOSING…";
    }

    let failed = 0;
    for (const alert of targets) {
      if (!(await resolveAlertOnBackend(alert))) failed++;
    }

    closeAlertInFlight = false;

    if (failed > 0) {
      window.showAppToast?.(
        "Close failed",
        `Could not close ${failed} SOS alert${failed > 1 ? "s" : ""} — the backend did not confirm. The alert stays on the dashboard.`,
        "error"
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = "✖ CLOSE ALERT";
      }
      return;
    }

    // Clear the matching full-screen SOS overlay for this device, if open,
    // so the overlay and the dashboard can never disagree.
    if (
      typeof emergencyState !== "undefined" &&
      emergencyState.activeDeviceIds.has(device)
    ) {
      emergencyState.activeDeviceIds.delete(device);
      delete emergencyState.snapshots[device];
      if (emergencyState.selectedDeviceId === device) {
        emergencyState.selectedDeviceId = null;
      }
      if (emergencyState.activeDeviceIds.size === 0) {
        emergencyState.minimized = false;
      }
      if (typeof emergencyRefresh === "function") emergencyRefresh();
    }

    window.showAppToast?.(
      "SOS alert closed",
      "SOS alert closed successfully. The record stays in SOS History.",
      "success"
    );

    const msg = $("dash-emergency-msg");
    if (msg) {
      msg.textContent = `SOS alert closed for ${incident.incident_id} — record kept in SOS History.`;
    }

    if (typeof addLogEntry === "function") {
      addLogEntry(
        "STATUS",
        "tag-status",
        `SOS alert closed by ${appState.auth?.username || "control room"} (Belt ${device})`
      );
    }

    if (typeof renderAlerts === "function") renderAlerts();
    refresh(); // re-sync the panel + button state with the backend
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
    $("dash-close-alert")?.addEventListener("click", closeIncidentAlert);

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
