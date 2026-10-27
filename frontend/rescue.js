/* ==========================================================================
   AVIGHNAA — RESCUE RESPONSE LAYER (plain JS, extends script.js)
   ========================================================================== */

const RESCUE_API = API_BASE_URL; // inherits http://localhost:5002/api

const rescueState = {
    role: null,
    teamId: null,
    email: null,
    incidents: [],
    completed: [],          // closed incidents (/incidents/history, rescue role)
    inboxFilter: 'all',     // all | new | acknowledged | inprogress | completed
    renderedStatus: null,   // status of the incident currently rendered
    lastResponseMsg: null,  // one-shot feedback after a recorded update
    teams: [],
    devices: [],
    selectedId: null,
    refreshTimer: null,
    tickTimer: null,
};

// Mirror of the backend STATUS_TRANSITIONS map (display only — the
// backend remains the single authority and still validates every call).
const RESCUE_TRANSITIONS = {
    AWAITING_RESPONSE: ['ASSIGN', 'CANCEL', 'ESCALATE'],
    ASSIGNED: ['ACCEPT', 'REASSIGN', 'CANCEL', 'ESCALATE'],
    ACCEPTED: ['EN_ROUTE', 'CANCEL', 'ESCALATE'],
    EN_ROUTE: ['ARRIVE', 'ESCALATE'],
    ON_SCENE: ['START_RESCUE', 'ESCALATE'],
    RESCUE_IN_PROGRESS: ['PERSON_SAFE', 'ESCALATE'],
    PERSON_SAFE: ['RESOLVE'],
    ESCALATED: ['ASSIGN', 'ACCEPT', 'CANCEL', 'RESOLVE'],
    RESOLVED: [],
    CANCELLED: [],
};

// "Send update to control room" presets. Every preset is a REAL mission
// action recorded on the incident timeline (with an optional custom
// message attached as the action's notes). A preset whose transition is
// not currently legal is shown disabled — nothing is ever faked.
const RESPONSE_PRESETS = [
    { label: 'Alert received. Assessing the situation.', endpoint: 'accept', action: 'ACCEPT' },
    { label: 'Rescue team dispatched.', endpoint: 'en-route', action: 'EN_ROUTE' },
    { label: 'Team is approaching the incident location.', endpoint: 'en-route', action: 'EN_ROUTE' },
    { label: 'Team arrived at the incident location.', endpoint: 'arrive', action: 'ARRIVE' },
    { label: 'Rescue operation in progress.', endpoint: 'start-rescue', action: 'START_RESCUE' },
    { label: 'Person is safe — securing the scene.', endpoint: 'person-safe', action: 'PERSON_SAFE' },
    { label: 'Rescue operation completed.', endpoint: 'resolve', action: 'RESOLVE' },
    { label: 'Unable to respond — assistance required from another team.', endpoint: 'escalate', action: 'ESCALATE' },
];

// Inbox filter groups (statuses come from the backend incident rows).
const INBOX_GROUPS = {
    new: ['AWAITING_RESPONSE', 'ASSIGNED', 'ESCALATED'],
    acknowledged: ['ACCEPTED', 'EN_ROUTE'],
    inprogress: ['ON_SCENE', 'RESCUE_IN_PROGRESS', 'PERSON_SAFE'],
    completed: ['RESOLVED', 'CANCELLED'],
};

// Status → mission action (mirrors backend STATUS_TRANSITIONS)
const MISSION_STEPS = {
    ASSIGNED:        { action: 'accept',       label: 'ACCEPT MISSION',    endpoint: 'accept' },
    ACCEPTED:        { action: 'en-route',     label: 'MARK EN ROUTE',     endpoint: 'en-route' },
    EN_ROUTE:        { action: 'arrive',       label: 'MARK ARRIVED',      endpoint: 'arrive' },
    ON_SCENE:        { action: 'start-rescue', label: 'START RESCUE',      endpoint: 'start-rescue' },
    RESCUE_IN_PROGRESS: { action: 'person-safe', label: 'PERSON SAFE',     endpoint: 'person-safe' },
    PERSON_SAFE:     { action: 'resolve',      label: 'RESOLVE INCIDENT',  endpoint: 'resolve' },
};

const STATUS_BADGE = {
    AWAITING_RESPONSE: 'badge-critical',
    ASSIGNED: 'badge-warning',
    ACCEPTED: 'badge-warning',
    EN_ROUTE: 'badge-info',
    ON_SCENE: 'badge-info',
    RESCUE_IN_PROGRESS: 'badge-high',
    PERSON_SAFE: 'badge-safe',
    RESOLVED: 'badge-safe',
    ESCALATED: 'badge-critical',
    CANCELLED: 'badge-info',
};

const ACTIVE_STATUSES = [
    'AWAITING_RESPONSE', 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE',
    'ON_SCENE', 'RESCUE_IN_PROGRESS', 'PERSON_SAFE', 'ESCALATED',
];

// ─── Helpers ───────────────────────────────────────────────────

async function rescueFetch(path, options = {}) {
    const { data } = await supabaseClient.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('Not signed in');

    const res = await fetch(`${RESCUE_API}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(options.headers || {}),
        },
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(body.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
}

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function timeAgo(iso) {
    if (!iso) return '--';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    // A timestamp in the future means the reporting clock disagrees with
    // this one — say so instead of pretending it just happened.
    if (diff < 0) return 'clock skew';
    const s = diff;
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
}

function elapsedClock(iso) {
    if (!iso) return '--:--';
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
}

function fmtTime(iso) {
    if (!iso) return '--';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
    if (!iso) return '--';
    return new Date(iso).toLocaleDateString();
}

function severityClass(sev) {
    switch ((sev || '').toUpperCase()) {
        case 'CRITICAL': return 'sev-critical';
        case 'HIGH': return 'sev-high';
        case 'MEDIUM': return 'sev-medium';
        default: return '';
    }
}

function statusBadge(status) {
    const cls = STATUS_BADGE[status] || 'badge-info';
    const label = (status || '').replace(/_/g, ' ');
    return `<span class="badge ${cls}">${esc(label)}</span>`;
}

// ─── Role gating ───────────────────────────────────────────────

// window.rescueCanOpen is owned by script.js (single source of truth).
// It must NOT be redefined here: a top-level `function rescueCanOpen`
// becomes a global, overwrites the script.js guard, and then calls itself
// forever (RangeError: Maximum call stack size exceeded), which silently
// broke every nav click. Role-based nav visibility is handled below by
// applyRoleToNav(); click-level enforcement lives in script.js.

function applyRoleToNav() {
    // Gates EVERY nav item that declares data-roles — the control-room
    // items (user only) as well as the rescue items. A rescue-team user
    // therefore never sees Dashboard / Workers / Alerts / Analytics /
    // Settings, and a plain user never sees the rescue sections.
    document.querySelectorAll('.nav-item[data-roles]').forEach(el => {
        const roles = (el.getAttribute('data-roles') || '').split(/\s+/).filter(Boolean);
        if (rescueState.role && roles.includes(rescueState.role)) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });

    // The "EMERGENCY RESPONSE" divider only makes sense if at least one
    // rescue nav item is visible.
    const anyRescueVisible = [...document.querySelectorAll('.nav-rescue')]
        .some(el => !el.classList.contains('hidden'));
    document.querySelectorAll('.nav-divider').forEach(div => {
        if (div.textContent.trim().toUpperCase().includes('EMERGENCY RESPONSE')) {
            div.classList.toggle('hidden', !anyRescueVisible);
        }
    });
}

function goToPage(target) {
    document.querySelectorAll('.nav-item').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-target') === target);
    });
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = document.getElementById(`page-${target}`);
    if (page) page.classList.add('active');
    const titles = {
        rescue: 'Rescue Dispatch Console',
        history: 'Rescue History & Analytics',
        rescuecontrol: 'Admin Rescue Control',
        dashboard: 'Dashboard',
    };
    const titleEl = document.getElementById('page-title');
    if (titleEl && titles[target]) titleEl.innerText = titles[target];
}

// ─── Session hooks ──────────────────────────────────────────────
// script.js resolves the role ONCE and announces it here. Previously
// this file defined its own window.onAvighnaaLogin, which overwrote the
// script.js version (rescue.js loads later) and caused unpredictable
// routing. Now there is exactly one resolver.

function applyRescueSession(session) {
    rescueState.role = session.role || null;
    rescueState.teamId = session.teamId || null;
    rescueState.email = session.email || null;

    applyRoleToNav();

    const teamChip = document.getElementById('rescue-my-team');
    if (teamChip) {
        if (rescueState.role === 'rescue_team') {
            // The rescue login is the DISPATCH CONSOLE — it assigns
            // incidents to the available teams. It is not a field team
            // itself, so there is no "your team" identity anymore.
            teamChip.textContent = 'RESCUE DISPATCH';
            teamChip.classList.remove('hidden');
        } else {
            teamChip.classList.add('hidden');
        }
    }

    console.log(`🔐 Role verified server-side: ${rescueState.role || 'none'}`);

    if (rescueState.role === 'rescue_team' || rescueState.role === 'rescue_team') {
        rescueRefresh();
        startRescuePolling();
    } else {
        stopRescuePolling();
    }
}

window.addEventListener('avighnaa:session', (ev) => {
    applyRescueSession(ev.detail || {});
});

window.addEventListener('avighnaa:logout', () => {
    rescueState.role = null;
    rescueState.teamId = null;
    rescueState.email = null;
    rescueState.incidents = [];
    rescueState.selectedId = null;
    stopRescuePolling();
    applyRoleToNav();

    const teamChip = document.getElementById('rescue-my-team');
    if (teamChip) teamChip.classList.add('hidden');
});

// ─── Rescue login button ───────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Inbox filter tabs (Feature 7: which part of the response workflow)
    document.querySelectorAll('.inbox-tab[data-inbox-filter]').forEach(tab => {
        tab.addEventListener('click', () => {
            setInboxFilter(tab.getAttribute('data-inbox-filter'));
        });
    });

    // Retry button for a failed inbox load
    document.getElementById('rescue-inbox-retry')
        ?.addEventListener('click', () => loadRescueInbox().catch(() => {}));

    const btn = document.getElementById('rescue-login-btn');
    if (btn) {
        btn.addEventListener('click', () => {
            const title = document.querySelector('.login-title');
            const sub = document.querySelector('.login-sub');
            if (title) title.textContent = 'Rescue Dispatch Access';
            if (sub) {
                sub.innerHTML =
                    'Sign in with the rescue-dispatch account. Role is verified on the server. ' +
                    'The console assigns incidents to the available rescue teams.';
            }
            document.getElementById('login-user')?.focus();
        });
    }
});

// ─── Polling ───────────────────────────────────────────────────

function startRescuePolling() {
    stopRescuePolling();
    rescueState.refreshTimer = setInterval(() => {
        if (!rescueState.role) return;
        if (rescueState.role === 'rescue_team' || rescueState.role === 'rescue_team') {
            silentRefresh();
        }
    }, 10000);

    // Timers tick every second (elapsed / overdue clocks)
    rescueState.tickTimer = setInterval(tickTimers, 1000);
}

function stopRescuePolling() {
    if (rescueState.refreshTimer) clearInterval(rescueState.refreshTimer);
    if (rescueState.tickTimer) clearInterval(rescueState.tickTimer);
    rescueState.refreshTimer = null;
    rescueState.tickTimer = null;
}

function tickTimers() {
    document.querySelectorAll('[data-elapsed-from]').forEach(el => {
        el.textContent = elapsedClock(el.getAttribute('data-elapsed-from'));
    });
    document.querySelectorAll('[data-time-ago]').forEach(el => {
        el.textContent = timeAgo(el.getAttribute('data-time-ago'));
    });
}

async function silentRefresh() {
    try {
        const onRescue = document.getElementById('page-rescue')?.classList.contains('active');
        const onControl = document.getElementById('page-rescuecontrol')?.classList.contains('active');
        const onHistory = document.getElementById('page-history')?.classList.contains('active');
        if (onRescue) {
            await loadRescueInbox();
            // Keep the open incident's detail fresh: re-render when its
            // status changed (e.g. control room reassigned/escalated) so
            // new responses appear without a manual refresh.
            if (rescueState.selectedId) {
                const inc = rescueState.incidents.find(
                    i => i.incident_id === rescueState.selectedId
                );
                if (inc && inc.status !== rescueState.renderedStatus) {
                    await openIncident(rescueState.selectedId);
                }
            }
        }
        if (onControl) await loadAdminIncidents();
        if (onHistory) await rescueLoadHistory();
    } catch { /* poll errors are non-fatal */ }
}

// ─── RESCUE PORTAL ─────────────────────────────────────────────

async function rescueRefresh() {
    try {
        await Promise.all([loadRescueInbox(), loadTeams(), loadDeviceHealth()]);
    } catch (err) {
        console.warn('Rescue refresh failed:', err.message);
    }
}
window.rescueRefresh = rescueRefresh;

async function loadRescueInbox() {
    const list = document.getElementById('rescue-inbox-list');
    const statusEl = document.getElementById('rescue-inbox-status');
    const statusText = document.getElementById('rescue-inbox-status-text');

    // Loading state — keep the previous list visible under the note.
    if (statusEl && statusText) {
        statusEl.classList.remove('hidden', 'error');
        statusText.textContent = 'Loading emergencies…';
    }

    let all;
    try {
        const res = await rescueFetch('/incidents');
        all = res.data || [];
        if (statusEl) statusEl.classList.add('hidden');
    } catch (err) {
        rescueState.incidents = [];
        if (list) {
            list.innerHTML = '<p class="rescue-empty">Could not load emergencies.</p>';
        }
        if (statusEl && statusText) {
            statusEl.classList.remove('hidden');
            statusEl.classList.add('error');
            statusText.textContent = `Failed to load the emergency inbox: ${err.message}`;
        }
        updateInboxCounts([]);
        return;
    }

    rescueState.incidents = all;

    // Completed operations (closed incidents) are only listable with the
    // rescue-team role — fetched for the Completed view.
    if (rescueState.inboxFilter === 'completed' && rescueState.role === 'rescue_team') {
        try {
            const hist = await rescueFetch('/incidents/history?limit=25');
            rescueState.completed = hist.data || [];
        } catch { /* keep previous list on failure */ }
    }

    const active = all.filter(i => ACTIVE_STATUSES.includes(i.status));
    const crit = active.filter(i => i.severity === 'CRITICAL').length;
    const high = active.filter(i => i.severity === 'HIGH').length;
    // Dispatch view: how many incidents currently sit with a team.
    const assigned = active.filter(i => i.assigned_team_id).length;

    setText('rc-crit-count', crit);
    setText('rc-high-count', high);
    setText('rc-active-count', active.length);
    setText('rc-mine-count', assigned);

    const badge = document.getElementById('sidebar-incident-badge');
    if (badge) {
        badge.textContent = active.length;
        badge.style.display = active.length > 0 ? '' : 'none';
    }

    updateInboxCounts(active);

    // Fresh incident data → the teams availability panel (which shows
    // each team's active missions) re-renders against it.
    renderTeamsTable();

    if (!list) return;

    const filter = rescueState.inboxFilter;
    const source = filter === 'completed' ? rescueState.completed : active;
    const filtered = filter === 'all'
        ? active
        : (INBOX_GROUPS[filter]
            ? source.filter(i => INBOX_GROUPS[filter].includes(i.status))
            : source);

    const sorted = [...filtered].sort((a, b) => {
        const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        const sr = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
        if (sr !== 0) return sr;
        return new Date(a.created_at) - new Date(b.created_at);
    });

    if (sorted.length === 0) {
        const emptyByFilter = {
            completed: 'No completed operations yet.',
            new: 'No emergencies waiting for acknowledgement. All clear.',
            acknowledged: 'No acknowledged emergencies right now.',
            inprogress: 'No rescue operations in progress.',
        };
        list.innerHTML = `<p class="rescue-empty">${
            emptyByFilter[filter] || 'No active emergencies. All clear.'
        }</p>`;
        return;
    }

    list.innerHTML = sorted.map(inc => {
        const sel = inc.incident_id === rescueState.selectedId ? ' selected' : '';
        const overdue = isOverdue(inc);
        const closed = ['RESOLVED', 'CANCELLED'].includes(inc.status);
        return `
        <div class="inc-card ${severityClass(inc.severity)}${sel}"
             onclick="openIncident('${esc(inc.incident_id)}')">
            <div class="inc-card-top">
                <span class="badge ${inc.severity === 'CRITICAL' ? 'badge-critical' : 'badge-warning'}">
                    ${esc(inc.severity)}
                </span>
                <span class="inc-id">INCIDENT #${esc(inc.incident_id)}</span>
            </div>
            <div class="inc-hazard">${esc(hazardLabel(inc))}</div>
            <div class="inc-meta">
                <span>📍 ${esc(inc.location || 'Location not configured')}</span>
                ${inc.person_detected ? '<span class="inc-person">👤 Person Detected</span>' : ''}
                <span>Detected: ${fmtTime(inc.created_at)}</span>
                <span data-time-ago="${esc(inc.created_at)}">${timeAgo(inc.created_at)}</span>
                <span>${inc.assigned_team_id ? `🚒 ${esc(inc.assigned_team_id)}` : 'Unassigned'}</span>
            </div>
            <div class="inc-meta" style="margin-top:6px;">
                ${statusBadge(inc.status)}
                ${inc.rescue_requested ? '<span class="req-chip">🔔 RESCUE REQUESTED</span>' : ''}
                ${closed ? '<span class="badge badge-info">Closed</span>' : ''}
            </div>
            ${overdue ? `
            <div class="overdue-strip">
                ⚠️ RESPONSE OVERDUE — Timer: <span data-elapsed-from="${esc(overdue)}">${elapsedClock(overdue)}</span>
            </div>` : ''}
        </div>`;
    }).join('');
}
window.loadRescueInbox = loadRescueInbox;

function updateInboxCounts(active) {
    const counts = {
        all: active.length,
        new: active.filter(i => INBOX_GROUPS.new.includes(i.status)).length,
        acknowledged: active.filter(i => INBOX_GROUPS.acknowledged.includes(i.status)).length,
        inprogress: active.filter(i => INBOX_GROUPS.inprogress.includes(i.status)).length,
        completed: rescueState.completed.length,
    };

    document.querySelectorAll('[data-inbox-count]').forEach(el => {
        const key = el.getAttribute('data-inbox-count');
        el.textContent = counts[key] ?? 0;
    });
}

function setInboxFilter(filter) {
    rescueState.inboxFilter = filter || 'all';
    document.querySelectorAll('.inbox-tab').forEach(tab => {
        const active = tab.getAttribute('data-inbox-filter') === rescueState.inboxFilter;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    loadRescueInbox().catch(() => {});
}
window.setInboxFilter = setInboxFilter;

function isOverdue(inc) {
    if (!['AWAITING_RESPONSE', 'ASSIGNED', 'ACCEPTED'].includes(inc.status)) return null;
    const base = new Date(inc.updated_at || inc.created_at).getTime();
    // Mirrors backend default of 5 minutes (display-only hint)
    return (Date.now() - base) > 5 * 60 * 1000 ? (inc.updated_at || inc.created_at) : null;
}

function hazardLabel(inc) {
    const labels = {
        GAS_LEAK: 'Possible Fire / Gas',
        FIRE_HEAT: 'High Temperature / Fire Risk',
        FLOOD: 'Flooding / Water Hazard',
        FALL: 'Fall / Impact Detected',
        SOS: 'SOS Emergency',
        COMBINED: 'Multiple Combined Hazards',
        ANOMALY: 'Sensor Anomaly',
        HIGH_RISK: 'High Risk Detected',
    };
    return labels[inc.hazard_type] || inc.hazard_type;
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

// ─── INCIDENT DETAIL ───────────────────────────────────────────

async function openIncident(incidentId) {
    if (rescueState.selectedId !== incidentId) {
        // Fresh incident view → clear one-shot feedback from the last one.
        rescueState.lastResponseMsg = null;
    }
    rescueState.selectedId = incidentId;
    const body = document.getElementById('rescue-detail-body');
    if (!body) return;
    body.innerHTML = '<p class="rescue-empty">Loading incident...</p>';

    try {
        // Everything this view needs is independent of everything else, so
        // it is ALL fired at once. The device id is usually already known
        // from the inbox list, which lets the sensor + location lookups
        // start alongside the incident fetch itself instead of waiting for
        // it — previously each of these phases ran one after the other and
        // the panel sat on "Loading incident..." for the sum of four
        // network round trips.
        const listed = rescueState.incidents.find(i => i.incident_id === incidentId);
        const knownDevice = listed && listed.device_id ? listed.device_id : null;
        const devicePromise = knownDevice
            ? Promise.resolve(knownDevice)
            : rescueFetch(`/incidents/${encodeURIComponent(incidentId)}`)
                  .then(r => (r.data && r.data.device_id) || null)
                  .catch(() => null);

        const incP = rescueFetch(`/incidents/${encodeURIComponent(incidentId)}`);
        const tlP = rescueFetch(`/incidents/${encodeURIComponent(incidentId)}/timeline`);
        const teamsP = (rescueState.teams && rescueState.teams.length > 0)
            ? Promise.resolve(null)
            : loadTeams(); // never throws — assign options must never be empty
        const readingP = devicePromise.then(d => d
            ? rescueFetch(`/devices/${encodeURIComponent(d)}/latest-reading`).catch(() => null)
            : null);
        const locP = devicePromise.then(d => d
            ? rescueFetch(`/device-locations/${encodeURIComponent(d)}`).catch(() => null)
            : null);

        const [incRes, tlRes, readingR, locR] = await Promise.all([
            incP, tlP, teamsP, readingP, locP,
        ]);

        const inc = incRes.data;
        const timeline = tlRes.data || [];
        const reading = readingR ? readingR.data : null;
        const readingNote = readingR && readingR.note ? readingR.note : '';
        const loc = locR ? locR.data : null;

        renderIncidentDetail(inc, timeline, reading, readingNote, loc);
        loadRescueInbox();
    } catch (err) {
        body.innerHTML = `
            <p class="rescue-empty">Failed to load incident: ${esc(err.message)}</p>
            <button class="btn-outline" onclick="openIncident('${esc(incidentId)}')">
                Retry
            </button>`;
    }
}
window.openIncident = openIncident;

function renderIncidentDetail(inc, timeline, reading, readingNote, loc) {
    const body = document.getElementById('rescue-detail-body');
    if (!body) return;

    // Remember what is on screen so the poller only re-renders on change.
    rescueState.renderedStatus = inc.status;

    const readingAge = reading ? (Date.now() - new Date(reading.recorded_at).getTime()) / 1000 : null;
    const isLive = readingAge !== null && readingAge <= 15;

    const sensorHtml = reading ? `
        <p class="detail-sub">Latest Sensor Information
            <span class="source-pill ${isLive ? '' : 'historical'}" style="margin-left:8px;">
                ${isLive ? 'LIVE' : 'LATEST RECEIVED'}
            </span>
        </p>
        <div class="sensor-rows">
            <div class="sensor-cell"><span class="k">Temperature</span><span class="v">${num(reading.temperature_c)} °C</span></div>
            <div class="sensor-cell"><span class="k">Gas (raw)</span><span class="v">${num(reading.gas_raw)}</span></div>
            <div class="sensor-cell"><span class="k">Water</span><span class="v">${num(reading.water_level_cm)} cm</span></div>
            <div class="sensor-cell"><span class="k">MPU6050 (x/y/z)</span><span class="v" style="font-size:11px;">${num(reading.acceleration_x_ms2)} / ${num(reading.acceleration_y_ms2)} / ${num(reading.acceleration_z_ms2)}</span></div>
            <div class="sensor-cell"><span class="k">Touch / SOS</span><span class="v">${reading.sos ? 'ACTIVE' : 'Inactive'}</span></div>
            ${reading.battery_level_percent != null
                ? `<div class="sensor-cell"><span class="k">Battery</span><span class="v">${num(reading.battery_level_percent)}%</span></div>`
                : ''}
        </div>
        <p class="workflow-hint">Recorded at ${fmtTime(reading.recorded_at)} (${timeAgo(reading.recorded_at)}).
           ${esc(readingNote)}</p>
    ` : `<p class="workflow-hint">No sensor readings available for this device.</p>`;

    const mapsUrl = loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number'
        ? `https://www.google.com/maps/dir/?api=1&destination=${loc.latitude},${loc.longitude}`
        : null;

    const locationPanel = `
        <p class="detail-sub">Last Known Location</p>
        <div class="location-panel">
            <div class="loc-main">📍 ${esc(inc.location || 'Location not configured')}</div>
            <div class="loc-sub">
                Device: ${esc(inc.device_id)} · Configured installation position
                ${loc && loc.zone ? ` · Zone: ${esc(loc.zone)}` : ''}
            </div>
            <div class="location-actions">
                ${mapsUrl
                    ? `<a class="btn btn-outline" href="${mapsUrl}" target="_blank" rel="noopener">Open Directions</a>`
                    : `<span class="workflow-hint">No coordinates configured — directions unavailable.</span>`}
            </div>
            <div class="gps-unavailable">
                Responder live location unavailable — Avighnaa does not track responders by GPS.
                This is the device's configured location, not a person's tracked position.
            </div>
        </div>`;

    const personHtml = `
        <p class="detail-sub">Person Information</p>
        <div class="detail-grid">
            <div class="detail-item"><span class="k">Person Detected</span><span class="v">${inc.person_detected ? 'YES' : 'No signal'}</span></div>
            <div class="detail-item"><span class="k">Fall Detected</span><span class="v">${['FALL'].includes(inc.hazard_type) ? 'YES' : 'Not detected'}</span></div>
            <div class="detail-item"><span class="k">SOS / Touch</span><span class="v">${['SOS'].includes(inc.hazard_type) || (reading && reading.sos) ? 'ACTIVATED' : 'Not activated'}</span></div>
            <div class="detail-item"><span class="k">Last Known Zone</span><span class="v">${esc((loc && loc.zone) || 'Not configured')}</span></div>
        </div>
        <p class="workflow-hint">The system does not track individuals — counts and identity are not supported by the hardware.</p>`;

    body.innerHTML = `
        <div class="detail-grid">
            <div class="detail-item"><span class="k">Incident ID</span><span class="v inc-id">#${esc(inc.incident_id)}</span></div>
            <div class="detail-item"><span class="k">Hazard</span><span class="v">${esc(hazardLabel(inc))}</span></div>
            <div class="detail-item"><span class="k">Severity</span><span class="v">${statusBadge(inc.severity)}</span></div>
            <div class="detail-item"><span class="k">Risk Score</span><span class="v">${num(inc.risk_score)} / 100</span></div>
            <div class="detail-item"><span class="k">Detected</span><span class="v">${fmtTime(inc.created_at)} · <span data-time-ago="${esc(inc.created_at)}">${timeAgo(inc.created_at)}</span></span></div>
            <div class="detail-item"><span class="k">Status</span><span class="v">${statusBadge(inc.status)}</span></div>
        </div>

        <div>
            <p class="detail-sub">AI Rescue Brief</p>
            <div class="ai-brief">
                <h4>${inc.severity === 'CRITICAL' ? '🔴' : '🟠'} ${esc(inc.severity)} INCIDENT</h4>
                <p>${esc(inc.ai_summary || 'No AI summary available for this incident.')}</p>
                <span class="recommended">RECOMMENDED TEAM: ${esc((inc.recommended_team_type || '').replace(/_/g, ' '))}</span>
                <p style="margin-top:8px;font-size:11px;color:var(--text-muted);">
                    AI output is assistive only — not an official emergency authority.
                </p>
            </div>
        </div>

        ${personHtml}

        ${sensorHtml}

        <div>
            <p class="detail-sub">Team Assignment</p>
            ${renderAssignment(inc)}
        </div>

        <div>
            <p class="detail-sub">Mission Control</p>
            ${renderMissionControls(inc)}
        </div>

        <div>
            <p class="detail-sub">Acknowledge &amp; Send Update to Control Room</p>
            ${renderResponsePanel(inc, timeline)}
        </div>

        ${locationPanel}

        <div>
            <p class="detail-sub">Incident Timeline</p>
            <div class="timeline">
                ${timeline.map(ev => `
                    <div class="tl-item ${ev.event_type.includes('RESOLVED') ? 'done' : ev.event_type.includes('ESCALAT') ? 'crit' : ''}">
                        <div class="tl-time">${fmtTime(ev.timestamp)}</div>
                        <div class="tl-label">${esc(timelineLabel(ev.event_type))}</div>
                        ${ev.notes ? `<div class="tl-note">${esc(ev.notes)}</div>` : ''}
                        ${ev.performed_by ? `<div class="tl-note">by ${esc(ev.performed_by)}</div>` : ''}
                    </div>`).join('') || '<p class="rescue-empty">No events yet.</p>'}
            </div>
        </div>

        <div>
            <button class="btn-outline" onclick="sendDeviceAlert('${esc(inc.device_id)}')">
                ACTIVATE DEVICE ALERT
            </button>
            <p class="workflow-hint">DEMO / SIMULATED — the current ESP32 firmware does not poll backend commands; the command is queued only.</p>
        </div>
    `;

    lucide.createIcons();
}

function num(v) {
    if (v === null || v === undefined) return '—';
    return typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v;
}

function timelineLabel(type) {
    const labels = {
        RESCUE_REQUESTED: 'Rescue requested by control room',
        INCIDENT_DETECTED: 'Incident detected',
        INCIDENT_CREATED: 'Incident created',
        DETECTION_UPDATED: 'New sensor reading received',
        TEAM_ASSIGNED: 'Team assigned',
        TEAM_REASSIGNED: 'Team reassigned',
        MISSION_ACCEPTED: 'Mission accepted',
        TEAM_EN_ROUTE: 'Team en route',
        TEAM_ARRIVED: 'Team arrived',
        RESCUE_STARTED: 'Rescue started',
        PERSON_SAFE: 'Person safe',
        INCIDENT_RESOLVED: 'Incident resolved',
        INCIDENT_ESCALATED: 'Incident escalated',
        INCIDENT_CANCELLED: 'Incident cancelled',
    };
    return labels[type] || type.replace(/_/g, ' ').toLowerCase();
}

function renderAssignment(inc) {
    const isDispatch = rescueState.role === 'rescue_team';
    const terminal = ['RESOLVED', 'CANCELLED'].includes(inc.status);

    const current = inc.assigned_team_id
        ? `<p class="workflow-hint">Currently assigned: <strong>${esc(inc.assigned_team_id)}</strong>${
              inc.assigned_team_name ? ` (${esc(inc.assigned_team_name)})` : ''
          }</p>`
        : '<p class="workflow-hint">No team assigned yet.</p>';

    if (terminal || !isDispatch) {
        return current;
    }

    // Dispatch panel: every available team, with the free ones first so
    // the obvious next pick is at the top. The AI-recommended type for
    // this hazard keeps its tag.
    const freeRank = t => ((t.status || '').toUpperCase() === 'AVAILABLE' ? 0 : 1);
    const teams = [...rescueState.teams].sort((a, b) => freeRank(a) - freeRank(b));

    return `
        ${current}
        <p class="workflow-hint">
            Dispatch — assign this incident to one of the rescue teams below.${
                inc.assigned_team_id
                    ? ' Reassignment is recorded on the timeline and the control room is notified.'
                    : ''
            }
        </p>
        <div class="assign-row" style="margin-top:8px;">
            ${teams.map(t => `
                <div class="team-option">
                    <strong>${esc(t.team_id)}</strong>
                    <span>${esc(t.team_name)}</span>
                    <span class="st st-${(t.status || '').toLowerCase()}">${esc(t.status)}</span>
                    ${t.team_type === inc.recommended_team_type
                        ? '<span class="recommended-tag">RECOMMENDED</span>' : ''}
                    <button class="btn btn-small"
                        onclick="assignTeam('${esc(inc.incident_id)}', '${esc(t.team_id)}')">
                        ${inc.assigned_team_id ? 'REASSIGN' : 'ASSIGN'}
                    </button>
                </div>`).join('')}
        </div>`;
}

async function assignTeam(incidentId, teamId) {
    try {
        await rescueFetch(`/incidents/${encodeURIComponent(incidentId)}/assign`, {
            method: 'POST',
            body: JSON.stringify({ team_id: teamId }),
        });
        await openIncident(incidentId);
    } catch (err) {
        alert(`Assign failed: ${err.message}`);
    }
}
window.assignTeam = assignTeam;

function renderMissionControls(inc) {
    const step = MISSION_STEPS[inc.status];
    const isDispatch = rescueState.role === 'rescue_team';
    const hasTeam = !!inc.assigned_team_id;

    let html = '';

    if (step) {
        // Dispatch records progress on behalf of the assigned team — the
        // backend validates the transition and the equipment gate.
        const canAct = !isDispatch || hasTeam;
        const blockedReason = !hasTeam
            ? 'Assign a rescue team first — dispatch records progress for the assigned team.'
            : '';
        html += `
            <div class="mission-controls">
                <button class="btn-mission" ${canAct ? '' : 'disabled'}
                    onclick="missionAction('${esc(inc.incident_id)}', '${step.endpoint}')">
                    ${step.label}
                </button>
            </div>
            ${blockedReason ? `<p class="workflow-hint">${esc(blockedReason)}</p>` : ''}
            ${hasTeam ? `<p class="workflow-hint">Recorded on behalf of ${esc(inc.assigned_team_id)}.</p>` : ''}`;
    } else if (inc.status === 'AWAITING_RESPONSE') {
        html += `<p class="workflow-hint">Awaiting dispatch — assign a team and the mission steps appear here.</p>`;
    } else if (['RESOLVED', 'CANCELLED'].includes(inc.status)) {
        html += `<p class="workflow-hint">Incident closed (${esc(inc.status)}).</p>`;
    } else if (inc.status === 'ESCALATED') {
        html += `<p class="workflow-hint">⚠️ Escalated to control room — awaiting reassignment.</p>`;
    }

    if (isDispatch && !['RESOLVED', 'CANCELLED'].includes(inc.status)) {
        html += `
            <div class="mission-controls" style="margin-top:10px;">
                <button class="btn-danger" onclick="rescueControlAction('${esc(inc.incident_id)}', 'escalate')">
                    ESCALATE
                </button>
                <button class="btn-danger" onclick="rescueControlAction('${esc(inc.incident_id)}', 'cancel')">
                    CANCEL INCIDENT
                </button>
                ${inc.status !== 'AWAITING_RESPONSE' ? `
                <button class="btn-outline" onclick="rescueControlAction('${esc(inc.incident_id)}', 'resolve')">
                    FORCE RESOLVE
                </button>` : ''}
            </div>
            <p class="workflow-hint">Dispatch actions (escalate / cancel / force-resolve) are recorded on the incident timeline.</p>`;
    }

    return html;
}

async function missionAction(incidentId, endpoint) {
    try {
        await rescueFetch(`/incidents/${encodeURIComponent(incidentId)}/${endpoint}`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        await openIncident(incidentId);
    } catch (err) {
        alert(`Action failed: ${err.message}`);
    }
}
window.missionAction = missionAction;

// ─── ACKNOWLEDGE + SEND UPDATE TO CONTROL ROOM ───────────
//
// Every response below is a REAL mission action (the same endpoints the
// Mission Control buttons use). Each is recorded on the incident timeline
// with its timestamp, actor and optional custom note. Presets that are
// not a legal transition from the current status are shown disabled —
// the backend transition map stays the single authority.

function renderResponsePanel(inc, timeline) {
    const events = timeline || [];
    const terminal = ['RESOLVED', 'CANCELLED'].includes(inc.status);
    const isDispatch = rescueState.role === 'rescue_team';
    const hasTeam = !!inc.assigned_team_id;

    const msgHtml = rescueState.lastResponseMsg
        ? `<p class="response-msg ${rescueState.lastResponseMsg.ok ? 'ok' : 'err'}">${
            esc(rescueState.lastResponseMsg.text)
        }</p>`
        : '';

    if (!isDispatch) {
        return `
            <p class="workflow-hint">Responses are recorded by the rescue dispatch console.</p>
            ${msgHtml}`;
    }

    // ── Acknowledge row ──
    let ackHtml = '';
    if (terminal) {
        ackHtml = '<p class="workflow-hint">Incident closed — no further acknowledgement possible.</p>';
    } else if (['ACCEPTED', 'EN_ROUTE', 'ON_SCENE', 'RESCUE_IN_PROGRESS', 'PERSON_SAFE'].includes(inc.status)) {
        const accepted = [...events]
            .reverse()
            .find(e => e.event_type === 'MISSION_ACCEPTED');
        ackHtml = `
            <div class="ack-row">
                <span class="badge badge-safe">✓ Alert acknowledged</span>
                ${accepted ? `<span class="workflow-hint">Recorded ${fmtTime(accepted.timestamp)} by ${esc(accepted.performed_by || '—')}</span>` : ''}
            </div>`;
    } else {
        // Dispatch acknowledges on behalf of the assigned team; an
        // unassigned incident is acknowledged by assigning a team (above).
        const unassigned = !hasTeam;
        const hint = unassigned
            ? 'Assign a rescue team first — the assignment is the acknowledgement of this request.'
            : 'Dispatch acknowledges on behalf of the assigned team — recorded on the timeline.';
        ackHtml = `
            <div class="ack-row">
                <button class="btn-mission" ${unassigned ? 'disabled' : ''}
                    onclick="acknowledgeAlert('${esc(inc.incident_id)}')">
                    ACKNOWLEDGE ALERT
                </button>
            </div>
            ${hint ? `<p class="workflow-hint">${esc(hint)}</p>` : ''}`;
    }

    // ── Preset response rows ──
    const transitions = RESCUE_TRANSITIONS[inc.status] || [];
    const mayAct = isDispatch && hasTeam && !terminal;

    const presets = RESPONSE_PRESETS.map(p => {
        const legal = transitions.includes(p.action);
        const blocked = !legal
            ? `Not available while status is ${String(inc.status || '').replace(/_/g, ' ').toLowerCase()}.`
            : !mayAct
                ? 'Assign a rescue team first.'
                : '';
        return `
            <button type="button" class="response-preset"
                ${blocked ? 'disabled' : ''}
                title="${esc(blocked)}"
                onclick="sendResponseUpdate('${esc(inc.incident_id)}', '${esc(p.endpoint)}', '${esc(p.label)}')">
                ${esc(p.label)}
            </button>`;
    }).join('');

    const noteInput = `
        <div class="response-note-row">
            <input type="text" id="response-note-${esc(inc.incident_id)}"
                maxlength="200"
                placeholder="Optional detail for the control room (e.g. 2 responders, need stretcher)"
                ${mayAct ? '' : 'disabled'}>
        </div>`;

    return `
        <div class="response-panel">
            <h4>Send update to control room</h4>
            <p class="workflow-hint">
                Each update below is a real mission action recorded on this incident's
                timeline — the control room sees it on the SOS alert without refreshing.
                Sending an update never resolves the incident by itself; resolution is a
                separate, explicit step.
            </p>
            ${ackHtml}
            <div class="response-presets">${presets}</div>
            ${noteInput}
            ${msgHtml}
        </div>`;
}

async function acknowledgeAlert(incidentId) {
    const noteEl = document.getElementById(`response-note-${incidentId}`);
    const note = (noteEl?.value || '').trim();

    try {
        // Dispatch acknowledges on behalf of the assigned team — the
        // backend records MISSION_ACCEPTED on the incident timeline.
        await rescueFetch(`/incidents/${encodeURIComponent(incidentId)}/accept`, {
            method: 'POST',
            body: JSON.stringify({ notes: note || 'Alert received — acknowledged by dispatch.' }),
        });

        rescueState.lastResponseMsg = {
            ok: true,
            text: '✓ Alert acknowledged — recorded on the incident timeline. The incident is NOT resolved; continue the mission steps below.',
        };
    } catch (err) {
        rescueState.lastResponseMsg = { ok: false, text: `Acknowledgement failed: ${err.message}` };
    }

    await openIncident(incidentId);
    loadRescueInbox();
}
window.acknowledgeAlert = acknowledgeAlert;

async function sendResponseUpdate(incidentId, endpoint, presetLabel) {
    const noteEl = document.getElementById(`response-note-${incidentId}`);
    const note = (noteEl?.value || '').trim();

    const body = {
        notes: note ? `${presetLabel} — ${note}` : presetLabel,
    };

    try {
        await rescueFetch(`/incidents/${encodeURIComponent(incidentId)}/${endpoint}`, {
            method: 'POST',
            body: JSON.stringify(body),
        });

        rescueState.lastResponseMsg = {
            ok: true,
            text: `✓ Update recorded: “${presetLabel}”${note ? ` (${note})` : ''}.`,
        };
    } catch (err) {
        const extra = err.body && err.body.code === 'EQUIPMENT_CHECK_REQUIRED'
            ? ' — complete the pre-departure Equipment Checklist first.'
            : '';
        rescueState.lastResponseMsg = {
            ok: false,
            text: `Update failed: ${err.message}${extra}`,
        };
    }

    await openIncident(incidentId);
    loadRescueInbox();
}
window.sendResponseUpdate = sendResponseUpdate;

async function rescueControlAction(incidentId, endpoint) {
    const confirmMsg = {
        escalate: 'Escalate this incident to the control room?',
        cancel: 'Cancel this incident? This closes it without a rescue.',
        resolve: 'Force-resolve this incident?',
    }[endpoint];
    if (!confirm(confirmMsg)) return;
    await missionAction(incidentId, endpoint);
}
window.rescueControlAction = rescueControlAction;

async function sendDeviceAlert(deviceId) {
    try {
        const res = await rescueFetch(`/devices/${encodeURIComponent(deviceId)}/command`, {
            method: 'POST',
            body: JSON.stringify({ command: 'ACTIVATE_BUZZER' }),
        });
        alert(`${res.message}\n\n${res.note}`);
    } catch (err) {
        alert(`Command failed: ${err.message}`);
    }
}
window.sendDeviceAlert = sendDeviceAlert;

// ─── TEAMS + DEVICE HEALTH ─────────────────────────────────────

async function loadTeams() {
    try {
        const res = await rescueFetch('/rescue-teams');
        rescueState.teams = res.data || [];
    } catch (err) {
        console.warn('Teams load failed:', err.message);
        return;
    }

    renderTeamsTable();
}

/**
 * Teams-available panel for the dispatch console. Availability comes from
 * the team row (the backend flips it BUSY on assign, AVAILABLE on close),
 * cross-checked against the live incident list for the mission each team
 * is currently working on. FREE teams sort to the top.
 */
function renderTeamsTable() {
    const activeInc = rescueState.incidents.filter(
        i => ACTIVE_STATUSES.includes(i.status) && i.assigned_team_id
    );
    const freeRank = t => ((t.status || '').toUpperCase() === 'AVAILABLE' ? 0 : 1);
    const ordered = [...rescueState.teams].sort((a, b) => freeRank(a) - freeRank(b));

    const tableHtml = `
        <table class="rescue-table">
            <thead><tr>
                <th>Team</th><th>Name</th><th>Type</th><th>Status</th>
                <th>Active missions</th><th>Location</th>
            </tr></thead>
            <tbody>
                ${ordered.map(t => {
                    const missions = activeInc.filter(i => i.assigned_team_id === t.team_id);
                    return `
                    <tr>
                        <td><strong>${esc(t.team_id)}</strong></td>
                        <td>${esc(t.team_name)}</td>
                        <td>${esc((t.team_type || '').replace(/_/g, ' '))}</td>
                        <td><span class="st st-${(t.status || '').toLowerCase()}">● ${esc(t.status)}</span></td>
                        <td>${missions.length === 0
                            ? '<span class="workflow-hint">Free for dispatch</span>'
                            : missions.map(m => `<span class="req-chip">${esc(m.incident_id)}</span>`).join(' ')}</td>
                        <td>${esc(t.current_location || '—')}</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>`;

    // Render into both the portal panel and the rescue control panel
    const portalList = document.getElementById('rescue-teams-list');
    if (portalList) portalList.innerHTML = tableHtml;
    const adminList = document.getElementById('admin-teams-list');
    if (adminList) adminList.innerHTML = tableHtml;
}

async function loadDeviceHealth() {
    const list = document.getElementById('rescue-devices-list');
    try {
        const res = await rescueFetch('/device-health');
        const devices = res.data || [];
        if (!list) return;
        if (devices.length === 0) {
            list.innerHTML = '<p class="rescue-empty">No devices registered.</p>';
            return;
        }
        list.innerHTML = `
        <table class="rescue-table">
            <thead><tr><th>Device</th><th>Status</th><th>Last Seen</th><th>Battery</th></tr></thead>
            <tbody>
                ${devices.map(d => `
                    <tr>
                        <td><strong>${esc(d.device_id)}</strong></td>
                        <td>${d.status === 'ONLINE'
                            ? '<span class="st st-available">🟢 ONLINE</span>'
                            : '<span class="st st-busy" style="color:var(--color-critical);">🔴 OFFLINE</span>'}</td>
                        <td data-time-ago="${esc(d.last_seen || '')}">${d.last_seen ? timeAgo(d.last_seen) : 'never'}</td>
                        <td>${d.battery_level_percent != null ? `${num(d.battery_level_percent)}%` : 'not reported'}</td>
                    </tr>`).join('')}
            </tbody>
        </table>
        <p class="rescue-note">Battery shown only when the hardware reports it.</p>`;
    } catch (err) {
        if (list) list.innerHTML = `<p class="rescue-empty">Device health unavailable: ${esc(err.message)}</p>`;
    }
}

// ─── HISTORY + ANALYTICS ───────────────────────────────────────

async function rescueLoadHistory() {
    try {
        const params = new URLSearchParams();
        const from = val('hist-from'), to = val('hist-to');
        if (from) params.set('from', from);
        if (to) params.set('to', `${to}T23:59:59`);
        const sev = val('hist-severity'); if (sev) params.set('severity', sev);
        const haz = val('hist-hazard'); if (haz) params.set('hazard_type', haz);
        const team = val('hist-team'); if (team) params.set('team', team);
        const st = val('hist-status'); if (st) params.set('status', st);

        const qs = params.toString() ? `?${params.toString()}` : '';
        // /incidents/history returns closed incidents WITH real
        // response_seconds / resolution_seconds measured from the timeline.
        const [incRes, teamsRes, statsRes] = await Promise.all([
            rescueFetch(`/incidents/history${qs}`),
            rescueFetch('/rescue-teams').catch(() => ({ data: [] })),
            rescueFetch('/incidents/stats'),
        ]);

        // Team filter dropdown
        const teamSel = document.getElementById('hist-team');
        if (teamSel && teamSel.options.length <= 1) {
            (teamsRes.data || []).forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.team_id;
                opt.textContent = `${t.team_id} — ${t.team_name}`;
                teamSel.appendChild(opt);
            });
        }

        renderHistoryTable(incRes.data || []);
        renderAnalytics(statsRes);
    } catch (err) {
        const tbody = document.getElementById('history-tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="rescue-empty">${esc(err.message)}</td></tr>`;
    }
}
window.rescueLoadHistory = rescueLoadHistory;

function val(id) {
    return (document.getElementById(id)?.value || '').trim();
}

async function renderHistoryTable(rows) {
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;

    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="rescue-empty">No incidents match these filters.</td></tr>';
        return;
    }

    // Response/resolution times are computed server-side from the real
    // incident_events timeline (/incidents/history) — no N+1 fetching here.
    const secs = (s) => (s == null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

    tbody.innerHTML = rows.map(inc => {
        const responseTime = secs(inc.response_seconds);
        const resolutionTime = secs(inc.resolution_seconds);
        return `
        <tr>
            <td class="inc-id">#${esc(inc.incident_id)}</td>
            <td>${fmtDate(inc.created_at)}</td>
            <td>${fmtTime(inc.created_at)}</td>
            <td>${esc(hazardLabel(inc))}</td>
            <td><span class="badge ${inc.severity === 'CRITICAL' ? 'badge-critical' : 'badge-warning'}">${esc(inc.severity)}</span></td>
            <td>${esc(inc.location || '—')}</td>
            <td>${esc(inc.assigned_team_id || 'Unassigned')}</td>
            <td>${responseTime}</td>
            <td>${resolutionTime}</td>
            <td>${statusBadge(inc.status)}</td>
        </tr>`;
    }).join('');
}

function renderAnalytics(stats) {
    const el = document.getElementById('rescue-analytics-body');
    if (!el) return;

    if (!stats.sufficient_data || !stats.data) {
        el.innerHTML = '<p class="rescue-empty">No data available yet.</p>';
        return;
    }

    const d = stats.data;
    const fmtSec = s => (s == null ? '—' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

    const breakdown = (title, obj) => {
        const entries = Object.entries(obj || {});
        if (entries.length === 0) return '';
        return `
        <div class="stat-breakdown">
            <h4>${title}</h4>
            ${entries.sort((a, b) => b[1] - a[1]).map(([k, v]) =>
                `<div class="breakdown-row"><span>${esc(k)}</span><span>${v}</span></div>`).join('')}
        </div>`;
    };

    el.innerHTML = `
        <div class="stat-tile"><div class="k">Total Incidents</div><div class="v">${d.total_incidents}</div></div>
        <div class="stat-tile"><div class="k">Critical</div><div class="v" style="color:var(--color-critical);">${d.critical_incidents}</div></div>
        <div class="stat-tile"><div class="k">High Risk</div><div class="v" style="color:var(--color-high);">${d.high_incidents}</div></div>
        <div class="stat-tile"><div class="k">Active</div><div class="v">${d.active_incidents}</div></div>
        <div class="stat-tile"><div class="k">Resolved</div><div class="v" style="color:var(--color-safe);">${d.resolved_incidents}</div></div>
        <div class="stat-tile"><div class="k">Escalated</div><div class="v">${d.escalated_incidents}</div></div>
        <div class="stat-tile"><div class="k">Avg Acknowledgement</div><div class="v small">${fmtSec(d.avg_ack_seconds)}</div></div>
        <div class="stat-tile"><div class="k">Avg Resolution</div><div class="v small">${fmtSec(d.avg_resolution_seconds)}</div></div>
        ${breakdown('By Hazard', d.by_hazard)}
        ${breakdown('By Location', d.by_location)}
        ${breakdown('By Team', d.by_team)}
        ${breakdown('By Status', d.by_status)}
        <div class="stat-breakdown">
            <p class="workflow-hint">All metrics are computed from stored incident records only.</p>
        </div>`;
}

// ─── RESCUE CONTROL ──────────────────────────────────────

async function rescueAdminRefresh() {
    try {
        await Promise.all([loadAdminIncidents(), loadTeams(), loadAdminLocations()]);
    } catch (err) {
        console.warn('Admin refresh failed:', err.message);
    }
}
window.rescueAdminRefresh = rescueAdminRefresh;

async function loadAdminIncidents() {
    const res = await rescueFetch('/incidents');
    const active = (res.data || []).filter(i => ACTIVE_STATUSES.includes(i.status));
    const el = document.getElementById('admin-incidents-list');
    if (!el) return;

    if (active.length === 0) {
        el.innerHTML = '<p class="rescue-empty">No active incidents.</p>';
        return;
    }

    el.innerHTML = `
    <table class="rescue-table">
        <thead><tr>
            <th>Incident</th><th>Severity</th><th>Hazard</th><th>Location</th>
            <th>Team</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
            ${active.map(inc => `
                <tr>
                    <td class="inc-id">#${esc(inc.incident_id)}</td>
                    <td><span class="badge ${inc.severity === 'CRITICAL' ? 'badge-critical' : 'badge-warning'}">${esc(inc.severity)}</span></td>
                    <td>${esc(hazardLabel(inc))}</td>
                    <td>${esc(inc.location || '—')}</td>
                    <td>
                        <select id="team-sel-${esc(inc.incident_id)}">
                            ${rescueState.teams.map(t =>
                                `<option value="${esc(t.team_id)}" ${t.team_id === inc.assigned_team_id ? 'selected' : ''}>
                                    ${esc(t.team_id)} — ${esc(t.team_name)} (${esc(t.status)})
                                </option>`).join('')}
                        </select>
                    </td>
                    <td>${statusBadge(inc.status)}</td>
                    <td>
                        <button class="btn btn-small btn-primary"
                            onclick="rescueAssignFromSelect('${esc(inc.incident_id)}')">
                            ${inc.assigned_team_id ? 'REASSIGN' : 'ASSIGN'}
                        </button>
                        <button class="btn btn-small"
                            onclick="rescueControlAction('${esc(inc.incident_id)}', 'escalate')">ESCALATE</button>
                        <button class="btn btn-small btn-danger"
                            onclick="rescueControlAction('${esc(inc.incident_id)}', 'cancel')">CANCEL</button>
                    </td>
                </tr>`).join('')}
        </tbody>
    </table>`;
}

async function rescueAssignFromSelect(incidentId) {
    const sel = document.getElementById(`team-sel-${incidentId}`);
    if (!sel) return;
    await assignTeam(incidentId, sel.value);
    await loadAdminIncidents();
}
window.rescueAssignFromSelect = rescueAssignFromSelect;

async function loadAdminLocations() {
    const el = document.getElementById('admin-locations-list');
    if (!el) return;
    try {
        const res = await rescueFetch('/device-locations');
        const locs = res.data || [];
        if (locs.length === 0) {
            el.innerHTML = '<p class="rescue-empty">No device locations configured yet.</p>';
            return;
        }
        el.innerHTML = `
        <table class="rescue-table">
            <thead><tr><th>Device</th><th>Building</th><th>Floor</th><th>Room</th><th>Zone</th><th>Coords</th></tr></thead>
            <tbody>
                ${locs.map(l => `
                    <tr>
                        <td><strong>${esc(l.device_id)}</strong></td>
                        <td>${esc(l.building || '—')}</td>
                        <td>${esc(l.floor || '—')}</td>
                        <td>${esc(l.room || '—')}</td>
                        <td>${esc(l.zone || '—')}</td>
                        <td>${l.latitude != null && l.longitude != null
                            ? `${l.latitude}, ${l.longitude}`
                            : 'not configured'}</td>
                    </tr>`).join('')}
            </tbody>
        </table>`;
    } catch (err) {
        el.innerHTML = `<p class="rescue-empty">${esc(err.message)}</p>`;
    }
}

// ─── Init ──────────────────────────────────────────────────────
// Role lookup is triggered by script.js via window.onAvighnaaLogin
// after a successful Supabase sign-in.
