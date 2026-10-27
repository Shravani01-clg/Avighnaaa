/* ==========================================================================
   AVIGHNAA — SOS COORDINATION LAYER (control room)
   ==========================================================================

   Extends script.js / dashboard-rescue.js / rescue.js. Frontend only.

   Responsibilities:
     1. SOS Alert Detail modal for ONE alert/incident:
        - overview of the real incident record
        - "Ping Rescue Team" via POST /incidents/:id/request-rescue
        - per-alert AI recommendation (incident.ai_summary + the risk
          prediction recorded for this device/time)
        - the recorded communication timeline
     2. SOS History page (/api/incidents open emergencies + /api/alerts
        persisted alert history — the existing records, nothing else)
     3. "Latest response" line on the dashboard emergency panel.

   Everything shown here comes from the existing backend. Where the
   backend cannot provide something (free-form control-room messages,
   closed-incident listings for the user role), the UI says so instead
   of faking it.

   Depends on globals from script.js (API_BASE_URL, appState) and
   rescue.js (rescueFetch, esc, fmtTime, timeAgo, statusBadge,
   hazardLabel, timelineLabel, severityClass).
   ========================================================================== */

const sosState = {
    incident: null,        // enriched incident currently open in the modal
    alertRow: null,        // alert-level record when no incident exists
    timeline: [],
    teams: [],
    riskRows: [],
    reading: null,
    open: false,
    timer: null,
    historyLoaded: false,
    historyTimer: null,
};

const SOS_TERMINAL = ['RESOLVED', 'CANCELLED'];

// Ordered mission stages shown in the response-status track.
// Mirrors the backend STATUS_TRANSITIONS order (display only).
const SOS_STATUS_STEPS = [
    'AWAITING_RESPONSE',
    'ASSIGNED',
    'ACCEPTED',
    'EN_ROUTE',
    'ON_SCENE',
    'RESCUE_IN_PROGRESS',
    'PERSON_SAFE',
    'RESOLVED',
];

const SOS_STEP_LABELS = {
    AWAITING_RESPONSE: 'Awaiting response',
    ASSIGNED: 'Team assigned',
    ACCEPTED: 'Team acknowledged',
    EN_ROUTE: 'En route',
    ON_SCENE: 'On scene',
    RESCUE_IN_PROGRESS: 'Rescue in progress',
    PERSON_SAFE: 'Person safe',
    RESOLVED: 'Resolved',
};

const $sos = (id) => document.getElementById(id);

// ─── Small helpers ────────────────────────────────────────────

function sosfmt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function sosSeverityBadge(sev) {
    const s = (sev || '').toUpperCase();
    const cls =
        s === 'CRITICAL' ? 'badge-critical'
        : s === 'HIGH' ? 'badge-high'
        : s === 'MEDIUM' ? 'badge-warning'
        : 'badge-info';
    return `<span class="badge ${cls}">${esc(sev || '—')}</span>`;
}

function sosStatusLabel(status) {
    const map = {
        AWAITING_RESPONSE: 'Awaiting response',
        ASSIGNED: 'Team assigned',
        ACCEPTED: 'Acknowledged by team',
        EN_ROUTE: 'Team en route',
        ON_SCENE: 'Team on scene',
        RESCUE_IN_PROGRESS: 'Rescue in progress',
        PERSON_SAFE: 'Person safe',
        RESOLVED: 'Resolved',
        ESCALATED: 'Escalated — response overdue',
        CANCELLED: 'Cancelled',
        ACTIVE_ALERT: 'Active alert',
        ACKNOWLEDGED_ALERT: 'Acknowledged',
    };
    return map[status] || (status || '').replace(/_/g, ' ');
}

/** Who performed a timeline event — derived from the backend role rules
    for that event type (never guessed from names). */
function sosActorMeta(eventType) {
    const t = String(eventType || '');
    if (['INCIDENT_DETECTED', 'INCIDENT_CREATED', 'DETECTION_UPDATED'].includes(t)) {
        return { label: 'SYSTEM', cls: 'system' };
    }
    if (t === 'RESCUE_REQUESTED') {
        return { label: 'CONTROL ROOM', cls: 'admin' };
    }
    return { label: 'RESCUE TEAM', cls: 'rescue' };
}

function sosFindEvent(type) {
    return [...sosState.timeline]
        .reverse()
        .find((ev) => ev.event_type === type) || null;
}

// ─── Modal open / close ───────────────────────────────────────

/**
 * Open the SOS detail view for ONE alert.
 * Accepts { incidentId } and/or { deviceId } (+ optional alertRow).
 * The incident is always re-fetched — nothing is cached or invented.
 */
async function openSosDetail(opts = {}) {
    const modal = $sos('sos-detail-modal');
    if (!modal) return;

    sosState.open = true;
    sosState.incident = null;
    sosState.alertRow = opts.alertRow || null;
    sosState.timeline = [];
    sosState.riskRows = [];
    sosState.reading = null;

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    $sos('sos-ping-msg').textContent = '';
    $sos('sos-ping-msg').className = 'sos-ping-msg';
    showSosState('Loading alert…', { loading: true });

    try {
        let incident = null;

        if (opts.incidentId) {
            const res = await rescueFetch(
                `/incidents/${encodeURIComponent(opts.incidentId)}`
            );
            incident = res.data || null;
        } else if (opts.deviceId) {
            // Active emergencies for this device (the control-room role
            // can read open incidents through /api/incidents).
            const res = await rescueFetch('/incidents');
            const rows = Array.isArray(res.data) ? res.data : [];
            incident =
                rows
                    .filter((i) => i.device_id === opts.deviceId)
                    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
        }

        if (incident) {
            sosState.incident = incident;
            await sosLoadRelated(incident);
            renderSosDetail();
            hideSosState();
        } else if (opts.deviceId || opts.alertRow) {
            // No incident record — render the alert-level view honestly.
            await sosLoadAlertLevel(opts.deviceId, opts.alertRow);
            renderSosDetail();
            hideSosState();
        } else {
            showSosState('Incident not found.', { error: true });
        }
    } catch (err) {
        showSosState(`Could not load this alert: ${err.message}`, {
            error: true,
            retry: true,
        });
    }

    startSosPolling();
    if (typeof lucide !== 'undefined') lucide.createIcons();
}
window.openSosDetail = openSosDetail;

function closeSosDetail() {
    const modal = $sos('sos-detail-modal');
    if (modal) modal.classList.add('hidden');
    document.body.style.overflow = '';
    sosState.open = false;
    stopSosPolling();
}
window.closeSosDetail = closeSosDetail;

function showSosState(text, opts = {}) {
    const el = $sos('sos-detail-state');
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.toggle('error', !!opts.error);
    $sos('sos-detail-state-text').textContent = text;
    const retry = $sos('sos-detail-retry');
    if (retry) retry.classList.toggle('hidden', !opts.retry);
    const content = $sos('sos-detail-content');
    if (content) content.classList.toggle('hidden', !opts.keepContent);
}

function hideSosState() {
    const el = $sos('sos-detail-state');
    if (el) el.classList.add('hidden');
    const content = $sos('sos-detail-content');
    if (content) content.classList.remove('hidden');
}

// ─── Data loading ─────────────────────────────────────────────

async function sosLoadRelated(incident) {
    const deviceId = incident.device_id;

    // Teams ride along with the other lookups instead of queueing behind
    // them — everything here is independent, so the modal fills in after
    // ONE round of network latency instead of two.
    const teamsP = sosState.teams.length
        ? Promise.resolve({ data: sosState.teams })
        : rescueFetch('/rescue-teams').catch(() => ({ data: sosState.teams }));

    const [tlRes, riskRes, readingRes, teamsRes] = await Promise.allSettled([
        rescueFetch(`/incidents/${encodeURIComponent(incident.incident_id)}/timeline`),
        deviceId ? rescueFetch(`/risk/${encodeURIComponent(deviceId)}`) : Promise.reject(new Error('no device')),
        deviceId ? rescueFetch(`/sensor-data/${encodeURIComponent(deviceId)}`) : Promise.reject(new Error('no device')),
        teamsP,
    ]);

    sosState.timeline =
        tlRes.status === 'fulfilled' ? tlRes.value.data || [] : [];

    sosState.riskRows =
        riskRes.status === 'fulfilled' ? riskRes.value.data || [] : [];

    const readings =
        readingRes.status === 'fulfilled' ? readingRes.value.data || [] : [];

    // Reading closest to the incident's detection time (real record).
    const detected = new Date(incident.detected_at || incident.created_at).getTime();
    sosState.reading =
        readings
            .map((r) => ({
                row: r,
                diff: Math.abs(new Date(r.timestamp || r.recorded_at || 0).getTime() - detected),
            }))
            .filter((x) => Number.isFinite(x.diff))
            .sort((a, b) => a.diff - b.diff)[0]?.row || readings[0] || null;

    if (teamsRes.status === 'fulfilled' && teamsRes.value && teamsRes.value.data) {
        sosState.teams = teamsRes.value.data;
    }
}

/** Alert-level fallback: no incident row exists for this alert. */
async function sosLoadAlertLevel(deviceId, alertRow) {
    sosState.alertRow = alertRow || sosState.alertRow || null;
    const device = deviceId || sosState.alertRow?.belt || null;

    sosState.riskRows = [];
    if (device) {
        try {
            const riskRes = await rescueFetch(`/risk/${encodeURIComponent(device)}`);
            sosState.riskRows = riskRes.data || [];
        } catch { /* device may have no risk records */ }
    }
}

/** Silent refresh used by the poller while the modal is open. */
async function sosRefreshSilent() {
    if (!sosState.open) return;
    if (sosState.incident?.incident_id) {
        try {
            // Incident + timeline are independent — fetch them together so
            // the 10s modal poll costs one round trip of waiting, not two.
            const incId = encodeURIComponent(sosState.incident.incident_id);
            const [res, tl] = await Promise.all([
                rescueFetch(`/incidents/${incId}`),
                rescueFetch(`/incidents/${incId}/timeline`),
            ]);
            if (res.data) sosState.incident = res.data;
            sosState.timeline = tl.data || [];
            renderSosDetail();
        } catch { /* keep last known state; next tick retries */ }
    } else if (sosState.alertRow?.belt) {
        // Alert-level view: keep the AI risk fresh for this device.
        try {
            const riskRes = await rescueFetch(
                `/risk/${encodeURIComponent(sosState.alertRow.belt)}`
            );
            sosState.riskRows = riskRes.data || [];
            renderSosDetail();
        } catch { /* ignore */ }
    }
}

function startSosPolling() {
    stopSosPolling();
    // Existing real-time mechanism in this app is polling; keep the open
    // alert fresh so rescue responses appear without a manual refresh.
    sosState.timer = setInterval(sosRefreshSilent, 10000);
}

function stopSosPolling() {
    if (sosState.timer) clearInterval(sosState.timer);
    sosState.timer = null;
}

// ─── Rendering ────────────────────────────────────────────────

function renderSosDetail() {
    const inc = sosState.incident;
    const alert = sosState.alertRow;

    // Header
    $sos('sos-detail-title').textContent = inc
        ? `SOS Alert · #${inc.incident_id}`
        : `SOS Alert · ${alert?.alertType || 'Alert'}${alert?.belt ? ` · ${alert.belt}` : ''}`;

    $sos('sos-detail-sub').textContent = inc
        ? `${inc.hazard_label || inc.hazard_type || ''}${inc.device_id ? ` · device ${inc.device_id}` : ''}`
        : (alert?.belt ? `device ${alert.belt}` : '—');

    const sevBadge = $sos('sos-detail-sev');
    const statusBadgeEl = $sos('sos-detail-status');
    const severity = inc?.severity || alert?.type;
    if (severity) {
        sevBadge.classList.remove('hidden');
        sevBadge.className = `badge ${
            severity === 'CRITICAL' ? 'badge-critical'
            : severity === 'HIGH' ? 'badge-high'
            : severity === 'MEDIUM' ? 'badge-warning'
            : 'badge-info'
        }`;
        sevBadge.textContent = severity;
    } else {
        sevBadge.classList.add('hidden');
    }

    if (inc) {
        statusBadgeEl.classList.remove('hidden');
        statusBadgeEl.className = `badge ${sosStatusBadgeClass(inc.status)}`;
        statusBadgeEl.textContent = sosStatusLabel(inc.status);
    } else if (alert) {
        statusBadgeEl.classList.remove('hidden');
        statusBadgeEl.className = `badge ${alert.ack ? 'badge-safe' : 'badge-critical'}`;
        statusBadgeEl.textContent = alert.ack ? 'Acknowledged' : 'Active alert';
    } else {
        statusBadgeEl.classList.add('hidden');
    }

    // Overview fields
    $sos('sos-f-id').textContent = inc
        ? `#${inc.incident_id}`
        : (alert ? `${alert.alertType || 'ALERT'}${alert.id ? ` (${String(alert.id).slice(0, 8)})` : ''}` : '—');
    $sos('sos-f-hazard').textContent = inc
        ? (inc.hazard_label || inc.hazard_type || '—')
        : (alert?.alertType || '—');
    $sos('sos-f-device').textContent = inc
        ? (inc.device_id || '—')
        : (alert?.belt || '—');
    $sos('sos-f-location').textContent = inc
        ? (inc.location || 'Location not configured')
        : 'Location only available on the incident record';
    $sos('sos-f-detected').textContent = inc
        ? sosfmt(inc.detected_at || inc.created_at)
        : (alert?.time || '—');
    $sos('sos-f-risk').textContent = inc
        ? `${num(inc.risk_score)} / 100`
        : '—';
    $sos('sos-f-person').textContent = inc
        ? (inc.person_detected ? 'YES' : 'No signal')
        : '—';
    $sos('sos-f-team').textContent = inc
        ? (inc.assigned_team_id
            ? `${inc.assigned_team_id}${inc.assigned_team_name ? ` — ${inc.assigned_team_name}` : ''}`
            : 'Unassigned')
        : '—';

    renderSosStatusTrack();
    renderSosTeamPanel();
    renderSosAi();
    renderSosSensor();
    renderSosTimeline();

    const pingBtn = $sos('sos-ping-btn');
    if (pingBtn) pingBtn.disabled = !inc || SOS_TERMINAL.includes(inc.status);
    const pingNote = $sos('sos-ping-note');
    if (pingNote) {
        if (!inc) {
            pingNote.textContent =
                'This alert has no incident record, so it cannot be pinged. ' +
                'The risk engine creates an incident for HIGH severity and above — ' +
                'monitor it on the Alerts page.';
        } else if (SOS_TERMINAL.includes(inc.status)) {
            pingNote.textContent =
                `This incident is ${sosStatusLabel(inc.status)} — a new rescue request is not applicable.`;
        } else {
            pingNote.textContent =
                'Pinging records a rescue request for THIS alert on the incident timeline ' +
                'and surfaces it in the Rescue Portal. Team assignment is confirmed by the ' +
                'rescue team in Rescue Control.';
        }
    }

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function sosStatusBadgeClass(status) {
    switch (status) {
        case 'AWAITING_RESPONSE':
        case 'ESCALATED':
            return 'badge-critical';
        case 'ASSIGNED':
        case 'ACCEPTED':
            return 'badge-warning';
        case 'EN_ROUTE':
        case 'ON_SCENE':
            return 'badge-info';
        case 'RESCUE_IN_PROGRESS':
            return 'badge-high';
        case 'PERSON_SAFE':
        case 'RESOLVED':
            return 'badge-safe';
        default:
            return 'badge-info';
    }
}

function renderSosStatusTrack() {
    const track = $sos('sos-status-track');
    if (!track) return;
    const inc = sosState.incident;

    if (!inc) {
        const alert = sosState.alertRow;
        track.innerHTML = alert
            ? `<span class="sos-step ${alert.ack ? 'done' : 'alert'}">
                 ${alert.ack ? 'Alert acknowledged' : 'Alert active — not acknowledged'}
               </span>
               <span class="sos-step">No incident record</span>`
            : '';
        return;
    }

    if (inc.status === 'ESCALATED') {
        track.innerHTML = `
            <span class="sos-step done">Detected</span>
            ${inc.rescue_requested ? '<span class="sos-step done">Rescue requested</span>' : ''}
            <span class="sos-step alert">Escalated — response overdue</span>`;
        return;
    }

    if (inc.status === 'CANCELLED') {
        track.innerHTML = `
            <span class="sos-step done">Detected</span>
            ${inc.rescue_requested ? '<span class="sos-step done">Rescue requested</span>' : ''}
            <span class="sos-step">Incident cancelled</span>`;
        return;
    }

    const currentIdx = SOS_STATUS_STEPS.indexOf(inc.status);
    const steps = [];

    steps.push(`
        <span class="sos-step done">Detected</span>
        <span class="sos-step ${inc.rescue_requested ? 'done' : (currentIdx <= 0 ? 'current' : '')}">
            Rescue requested${inc.rescue_requested_at ? ` · ${sosfmt(inc.rescue_requested_at)}` : ''}
        </span>`);

    SOS_STATUS_STEPS.forEach((status, idx) => {
        if (currentIdx < 0) return;
        const cls =
            idx < currentIdx ? 'done'
            : idx === currentIdx ? 'current'
            : '';
        steps.push(
            `<span class="sos-step ${cls}">${SOS_STEP_LABELS[status]}</span>`
        );
    });

    track.innerHTML = steps.join('');
}

function renderSosTeamPanel() {
    const panel = $sos('sos-team-panel');
    if (!panel) return;
    const inc = sosState.incident;

    if (!inc) {
        panel.innerHTML =
            '<span class="workflow-hint">No incident record for this alert — rescue notification is unavailable.</span>';
        return;
    }

    const lines = [];

    if (inc.assigned_team_id) {
        lines.push(`
            <div class="team-line">
                <span>Assigned team:</span>
                <strong class="team-rec">${esc(inc.assigned_team_id)}${
                    inc.assigned_team_name ? ` — ${esc(inc.assigned_team_name)}` : ''
                }</strong>
            </div>`);
    } else {
        lines.push(`
            <div class="team-line">
                <span>Recommended team type:</span>
                <strong class="team-rec">${esc((inc.recommended_team_type || '—').replace(/_/g, ' '))}</strong>
            </div>`);

        const available = sosState.teams.filter((t) => t.status === 'AVAILABLE');
        if (sosState.teams.length) {
            lines.push(`
                <div class="team-line">
                    <span>Rescue teams:</span>
                    ${sosState.teams.map((t) => `
                        <span class="st st-${esc((t.status || '').toLowerCase())}">
                            ${esc(t.team_id)} (${esc((t.team_type || '').replace(/_/g, ' '))}) — ${esc(t.status)}
                        </span>`).join('')}
                </div>`);
            if (!available.length) {
                lines.push('<div class="team-line">No team is currently AVAILABLE — the request will still reach the Rescue Portal.</div>');
            }
        }

        lines.push(`
            <div class="team-line">
                Team assignment is confirmed by the rescue team in Rescue Control
                (enforced server-side) — the ping below notifies them immediately.
            </div>`);
    }

    panel.innerHTML = lines.join('');
}

function renderSosAi() {
    const body = $sos('sos-ai-body');
    if (!body) return;

    const inc = sosState.incident;

    // Risk prediction recorded for this device, nearest to the alert time.
    let riskRow = null;
    if (inc && sosState.riskRows.length) {
        const detected = new Date(inc.detected_at || inc.created_at).getTime();
        riskRow = [...sosState.riskRows]
            .map((r) => ({
                row: r,
                diff: Math.abs(new Date(r.created_at || 0).getTime() - detected),
            }))
            .filter((x) => Number.isFinite(x.diff))
            .sort((a, b) => a.diff - b.diff)[0]?.row || null;
    } else if (!inc && sosState.riskRows.length) {
        // Alert-level view: newest device record, clearly labelled as such.
        riskRow = sosState.riskRows[0];
    }

    const ai = riskRow?.ai || {};

    if (!inc && !riskRow) {
        body.classList.add('unavailable');
        body.innerHTML = `
            <h4>AI recommendation</h4>
            <p>AI recommendation unavailable for this alert.</p>`;
        return;
    }

    body.classList.remove('unavailable');

    const rows = [];

    if (inc) {
        rows.push(['AI risk assessment',
            `${num(inc.risk_score)} / 100 · ${esc(inc.severity || '—')}`]);
        rows.push(['Recommended immediate response',
            inc.ai_summary
                ? esc(inc.ai_summary)
                : 'No AI summary was recorded for this incident.']);
        if (inc.recommended_team_type) {
            rows.push(['Recommended rescue team',
                `<span class="recommended">${esc((inc.recommended_team_type || '').replace(/_/g, ' '))}</span>`]);
        }
    }

    if (riskRow) {
        rows.push(['Explanation (risk record)',
            `${esc(riskRow.reason || '—')} <span class="workflow-hint">(recorded ${sosfmt(riskRow.created_at)})</span>`]);

        if (ai.recommendation) {
            rows.push(['AI recommended action', esc(ai.recommendation)]);
        }
        if (ai.mlRiskPrediction) {
            const pct = formatAIConfidencePercent(ai.mlConfidence);
            rows.push(['ML model prediction',
                `${esc(String(ai.mlRiskPrediction).toUpperCase())}${
                    pct !== null ? ` (${pct}% confidence)` : ''}`]);
        }
        if (Array.isArray(ai.aiRiskFactors) && ai.aiRiskFactors.length) {
            rows.push(['Contributing factors', ai.aiRiskFactors.map(esc).join(' · ')]);
        }
        if (ai.anomalyDetected) {
            rows.push(['Anomaly detector',
                `Flagged unusual sensor behaviour${
                    ai.anomalyScore != null ? ` (score ${num(ai.anomalyScore)})` : ''}`]);
        }

        const uncertainties = [];
        if (Array.isArray(ai.stuckSensors) && ai.stuckSensors.length) {
            uncertainties.push(`Frozen sensor(s): ${ai.stuckSensors.join(', ')}`);
        }
        if (Array.isArray(ai.trendWarnings) && ai.trendWarnings.length) {
            ai.trendWarnings.forEach((w) => {
                const text = typeof w === 'string' ? w : (w?.message || JSON.stringify(w));
                uncertainties.push(text);
            });
        }
        if (ai.source === 'rules_fallback') {
            uncertainties.push('ML model offline for this reading — rules-based fallback used.');
        }
        if (uncertainties.length) {
            rows.push(['Uncertainties / missing data', uncertainties.map(esc).join('<br>')]);
        }
    } else if (inc) {
        rows.push(['Risk record',
            'No risk prediction record could be read for this device — the assessment above is the incident summary recorded at detection time.']);
    }

    body.innerHTML = `
        <h4>${inc ? 'AI analysis for this alert' : `Latest AI risk record for device ${esc(sosState.alertRow?.belt || '')}`}</h4>
        ${rows.map(([k, v]) => `<div class="ai-row"><span class="k">${k}</span><span>${v}</span></div>`).join('')}
        <p class="workflow-hint" style="margin-top:8px;">
            AI output supports the operator's decision — it never dispatches teams or
            resolves emergencies on its own.
        </p>`;
}

function renderSosSensor() {
    const body = $sos('sos-sensor-body');
    const note = $sos('sos-sensor-note');
    if (!body) return;

    const reading = sosState.reading;
    if (!reading) {
        body.innerHTML = '';
        if (note) {
            note.textContent =
                'No sensor readings available for this device — the readings below are missing because none were recorded.';
        }
        return;
    }

    const ts = reading.timestamp || reading.recorded_at;
    // appState is a top-level const in script.js (not on window).
    const settings =
        (typeof appState !== 'undefined' && appState.settings) || {};
    const warn = (value, warnAt, critAt) => {
        const v = Number(value);
        if (!Number.isFinite(v)) return '';
        if (critAt != null && v >= critAt) return 'text-critical';
        if (warnAt != null && v >= warnAt) return 'text-warning';
        return '';
    };

    body.innerHTML = `
        <div class="sensor-cell"><span class="k">Temperature</span>
            <span class="v ${warn(reading.temperature_c, settings.tempWarn, settings.tempCrit)}">${num(reading.temperature_c)} °C</span></div>
        <div class="sensor-cell"><span class="k">Gas (raw)</span>
            <span class="v ${warn(reading.gas_raw, settings.gasWarn, settings.gasCrit)}">${num(reading.gas_raw)}</span></div>
        <div class="sensor-cell"><span class="k">Water level</span>
            <span class="v ${warn(reading.water_level_cm, settings.waterWarn, settings.waterCrit)}">${num(reading.water_level_cm)} cm</span></div>
        <div class="sensor-cell"><span class="k">Touch / SOS</span>
            <span class="v ${reading.sos ? 'text-critical' : ''}">${reading.sos ? 'ACTIVE' : 'Inactive'}</span></div>
        <div class="sensor-cell"><span class="k">Battery</span>
            <span class="v">${reading.battery_level_percent != null ? `${num(reading.battery_level_percent)}%` : 'not reported'}</span></div>`;

    if (note) {
        note.textContent =
            `Confirmed sensor reading closest to the alert time — recorded ${sosfmt(ts)}. ` +
            'Sensor readings are shown separately from AI suggestions and human actions.';
    }
}

function renderSosTimeline() {
    const container = $sos('sos-timeline');
    if (!container) return;

    const updated = $sos('sos-timeline-updated');

    if (!sosState.incident) {
        container.innerHTML =
            '<p class="rescue-empty">No incident timeline exists for this alert — the alert record itself is shown above.</p>';
        if (updated) updated.textContent = '';
        return;
    }

    const events = [...sosState.timeline].sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    if (!events.length) {
        container.innerHTML =
            '<p class="rescue-empty">No events recorded yet.</p>';
        if (updated) updated.textContent = '';
        return;
    }

    container.innerHTML = events.map((ev) => {
        const actor = sosActorMeta(ev.event_type);
        const label =
            typeof timelineLabel === 'function'
                ? timelineLabel(ev.event_type)
                : String(ev.event_type || '').replace(/_/g, ' ').toLowerCase();
        const done = String(ev.event_type).includes('RESOLVED');
        const crit =
            String(ev.event_type).includes('ESCALAT') ||
            String(ev.event_type).includes('CANCEL');

        return `
            <div class="tl-item ${done ? 'done' : crit ? 'crit' : ''}">
                <div class="tl-time">
                    ${sosfmt(ev.timestamp)}
                    <span class="tl-actor ${actor.cls}">${actor.label}</span>
                </div>
                <div class="tl-label">${esc(label)}</div>
                ${ev.notes ? `<div class="tl-msg">${esc(ev.notes)}</div>` : ''}
                ${ev.performed_by ? `<div class="tl-note">recorded by ${esc(ev.performed_by)}</div>` : ''}
            </div>`;
    }).join('');

    if (updated) {
        const last = events[events.length - 1];
        updated.textContent = `Last event ${sosfmt(last.timestamp)}`;
    }
}

// ─── Ping Rescue Team ─────────────────────────────────────────

async function sosPingRescueTeam() {
    const inc = sosState.incident;
    const btn = $sos('sos-ping-btn');
    const msg = $sos('sos-ping-msg');

    if (!inc || !btn || btn.disabled) return;

    // Prevent duplicate submissions while the request is in flight.
    btn.disabled = true;
    msg.className = 'sos-ping-msg';
    msg.textContent = 'Sending rescue request…';

    try {
        const res = await rescueFetch(
            `/incidents/${encodeURIComponent(inc.incident_id)}/request-rescue`,
            { method: 'POST', body: JSON.stringify({}) }
        );

        // Reload the real record + timeline so the delivery evidence
        // shown below comes from the backend, not from this click.
        await sosRefreshSilent();

        const requestedEvent = sosFindEvent('RESCUE_REQUESTED');
        const requestedAt =
            sosState.incident?.rescue_requested_at ||
            requestedEvent?.timestamp ||
            null;

        msg.className = 'sos-ping-msg ok';
        msg.textContent = res.already_requested
            ? `Rescue was already requested for this alert${
                requestedAt ? ` — recorded ${sosfmt(requestedAt)}` : ''}.`
            : `✅ Rescue request recorded${requestedAt ? ` at ${sosfmt(requestedAt)}` : ''} — the Rescue Portal now lists this alert.`;

        if (typeof addLogEntry === 'function') {
            addLogEntry(
                'STATUS',
                'tag-status',
                `Rescue team pinged for ${inc.incident_id}`
            );
        }
    } catch (err) {
        msg.className = 'sos-ping-msg err';
        msg.textContent = `Ping failed: ${err.message}`;
        btn.disabled = false;
        return;
    }

    btn.disabled = SOS_TERMINAL.includes(sosState.incident?.status);
}
window.sosPingRescueTeam = sosPingRescueTeam;

// ─── SOS HISTORY PAGE ─────────────────────────────────────────

const sosHistoryState = {
    incidents: [],
    alerts: [],
    teams: [],
};

function sosHistVal(id) {
    return ($sos(id)?.value || '').trim();
}

async function loadSosHistory(opts = {}) {
    const statusEl = $sos('sos-history-status');
    const statusText = $sos('sos-history-status-text');
    const retryBtn = $sos('sos-history-retry');
    const tbody = $sos('sos-history-tbody');

    if (!tbody) return;

    if (!opts.silent) {
        statusEl?.classList.remove('hidden', 'error');
        if (statusText) statusText.textContent = 'Loading records…';
        if (retryBtn) retryBtn.classList.add('hidden');
    }

    try {
        const [incRes, alertRes, teamsRes] = await Promise.all([
            rescueFetch('/incidents'),
            rescueFetch('/alerts'),
            rescueFetch('/rescue-teams').catch(() => ({ data: [] })),
        ]);

        sosHistoryState.incidents = incRes.data || [];
        sosHistoryState.alerts = alertRes.data || [];
        sosHistoryState.teams = teamsRes.data || [];

        populateSosHistoryTeamFilter();
        renderSosHistory();
        statusEl?.classList.add('hidden');
        sosHistoryState.loadedAt = new Date().toISOString();
    } catch (err) {
        if (!opts.silent) {
            statusEl?.classList.remove('hidden');
            statusEl?.classList.add('error');
            if (statusText) {
                statusText.textContent = `Could not load SOS records: ${err.message}`;
            }
            if (retryBtn) retryBtn.classList.remove('hidden');
        }
    }
}
window.loadSosHistory = loadSosHistory;

function populateSosHistoryTeamFilter() {
    const sel = $sos('sos-history-team');
    if (!sel || sel.options.length > 1) return;

    sosHistoryState.teams.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = t.team_id;
        opt.textContent = `${t.team_id} — ${t.team_name}`;
        sel.appendChild(opt);
    });

    const unassigned = document.createElement('option');
    unassigned.value = 'UNASSIGNED';
    unassigned.textContent = 'Unassigned';
    sel.appendChild(unassigned);
}

/** Merge the two real record sources into one row model. */
function sosHistoryRows() {
    const incidents = sosHistoryState.incidents.map((inc) => ({
        kind: 'incident',
        key: `inc-${inc.incident_id}`,
        id: inc.incident_id,
        raw: inc,
        deviceId: inc.device_id || '',
        time: inc.detected_at || inc.created_at,
        severity: inc.severity,
        status: inc.status,
        team: inc.assigned_team_id || '',
        location: inc.location || '',
        ai: inc.ai_summary || '',
        sos: inc.hazard_type === 'SOS',
        type: inc.hazard_type,
        resolved: SOS_TERMINAL.includes(inc.status),
    }));

    // Alerts already covered by a listed incident are not shown twice.
    const coveredAlertIds = new Set(
        sosHistoryState.incidents
            .map((inc) => String(inc.alert_id))
            .filter(Boolean)
    );

    const alerts = sosHistoryState.alerts
        .filter((a) => !coveredAlertIds.has(String(a.id)))
        .map((a) => ({
            kind: 'alert',
            key: `alert-${a.id}`,
            id: a.id,
            raw: a,
            deviceId: a.device_id || '',
            time: a.created_at,
            severity: a.severity,
            status: a.is_resolved ? 'ACKNOWLEDGED_ALERT' : 'ACTIVE_ALERT',
            team: '',
            location: '',
            ai: '',
            sos: String(a.alert_type || '').toUpperCase() === 'SOS',
            type: a.alert_type,
            resolved: !!a.is_resolved,
        }));

    return [...incidents, ...alerts];
}

function renderSosHistory() {
    const tbody = $sos('sos-history-tbody');
    if (!tbody) return;

    const search = sosHistVal('sos-history-search').toLowerCase();
    const from = sosHistVal('sos-history-from');
    const to = sosHistVal('sos-history-to');
    const severity = sosHistVal('sos-history-severity');
    const status = sosHistVal('sos-history-status');
    const team = sosHistVal('sos-history-team');
    const sosOnly = !!$sos('sos-history-sosonly')?.checked;

    const all = sosHistoryRows();

    const rows = all.filter((row) => {
        if (sosOnly && !row.sos) return false;
        if (severity && (row.severity || '').toUpperCase() !== severity) return false;
        if (status && row.status !== status) return false;
        if (team === 'UNASSIGNED' && row.team) return false;
        if (team && team !== 'UNASSIGNED' && row.team !== team) return false;

        if (from) {
            const t = new Date(row.time).getTime();
            if (!Number.isFinite(t) || t < new Date(from).setHours(0, 0, 0, 0)) return false;
        }
        if (to) {
            const t = new Date(row.time).getTime();
            if (!Number.isFinite(t) || t > new Date(to).setHours(23, 59, 59, 999)) return false;
        }

        if (search) {
            const haystack = [
                row.id,
                row.deviceId,
                row.type,
                row.raw?.msg,
                row.raw?.message,
                row.team,
                row.location,
            ].join(' ').toLowerCase();
            if (!haystack.includes(search)) return false;
        }

        return true;
    }).sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

    // Summary cards
    const set = (id, v) => { const el = $sos(id); if (el) el.textContent = v; };
    set('sos-hist-sos', all.filter((r) => r.sos && !r.resolved).length);
    set('sos-hist-active', all.filter((r) => !r.resolved).length);
    set('sos-hist-critical', all.filter((r) => (r.severity || '').toUpperCase() === 'CRITICAL').length);
    set('sos-hist-shown', rows.length);

    if (!rows.length) {
        tbody.innerHTML = `
            <tr><td colspan="9" class="rescue-empty">
                No records match these filters.
                ${sosOnly ? 'Tip: uncheck “SOS records only” to include every alert type.' : ''}
            </td></tr>`;
        updateSosHistoryNote(all);
        return;
    }

    tbody.innerHTML = rows.map((row) => {
        const statusHtml = row.kind === 'incident'
            ? `<span class="badge ${sosStatusBadgeClass(row.status)}">${esc(sosStatusLabel(row.status))}</span>`
            : row.resolved
                ? '<span class="badge badge-safe">Acknowledged</span>'
                : '<span class="badge badge-sos-active">Active</span>';

        const aiShort = row.ai
            ? `${esc(String(row.ai).slice(0, 120))}${String(row.ai).length > 120 ? '…' : ''}`
            : '<span class="workflow-hint">—</span>';

        return `
            <tr class="${row.sos ? 'row-sos' : ''}">
                <td class="inc-id">${row.kind === 'incident' ? '#' : ''}${esc(String(row.id).slice(0, 12))}${row.sos ? ' <span class="badge badge-sos">SOS</span>' : ''}</td>
                <td>${esc(sosfmt(row.time))}</td>
                <td>${esc(row.deviceId || '—')}</td>
                <td>${esc(row.location || '—')}</td>
                <td>${sosSeverityBadge(row.severity)}</td>
                <td>${statusHtml}</td>
                <td>${esc(row.team || '—')}</td>
                <td class="row-ai">${aiShort}</td>
                <td><button type="button" class="link-open" data-sos-row="${esc(row.key)}">Open</button></td>
            </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-sos-row]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-sos-row');
            const row = all.find((r) => r.key === key);
            if (!row) return;
            if (row.kind === 'incident') {
                openSosDetail({ incidentId: row.id, deviceId: row.deviceId });
            } else {
                openSosDetail({
                    deviceId: row.deviceId,
                    alertRow: {
                        id: row.raw.id,
                        alertType: row.raw.alert_type,
                        belt: row.raw.device_id,
                        msg: row.raw.message,
                        time: sosfmt(row.raw.created_at),
                        ack: row.raw.is_resolved,
                        type: row.severity,
                    },
                });
            }
        });
    });

    updateSosHistoryNote(all);
}

function updateSosHistoryNote(all) {
    const note = $sos('sos-history-note');
    if (!note) return;

    const parts = [
        `Loaded ${sosHistoryState.incidents.length} open incident(s) and ${sosHistoryState.alerts.length} alert record(s)${sosHistoryState.loadedAt ? ` · last refreshed ${sosfmt(sosHistoryState.loadedAt)}` : ''}.`,
    ];

    parts.push(
        'Closed-incident listings (with response/resolution times) live on the rescue team’s Rescue History page — ' +
        'the current backend restricts /api/incidents/history to the rescue-team role, so this page shows the persisted ' +
        'alert history plus every incident the control-room role can read.'
    );

    note.textContent = parts.join(' ');
}

function sosHistoryPageActive() {
    return !!document.getElementById('page-soshistory')?.classList.contains('active');
}

// ─── Dashboard: latest recorded rescue response ───────────────

async function refreshDashEmergencyLatest() {
    const wrap = $sos('dash-emergency-latest');
    const text = $sos('dash-emergency-latest-text');
    if (!wrap || !text) return;

    // Control-room role only — the rescue team has its own portal.
    if (window.avighnaaRole && window.avighnaaRole !== 'user') {
        wrap.classList.add('hidden');
        return;
    }

    const dashActive = !!document.getElementById('page-dashboard')?.classList.contains('active');
    const panelVisible = !$sos('dashboard-emergency')?.classList.contains('hidden');
    const idText = ($sos('dash-emergency-id')?.textContent || '').replace('#', '').trim();

    if (!dashActive || !panelVisible || !idText || idText === '—') {
        wrap.classList.add('hidden');
        return;
    }

    try {
        const res = await rescueFetch(
            `/incidents/${encodeURIComponent(idText)}/timeline`
        );
        const events = (res.data || []).sort(
            (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );

        if (!events.length) {
            wrap.classList.add('hidden');
            return;
        }

        const last = events[events.length - 1];
        const label =
            typeof timelineLabel === 'function'
                ? timelineLabel(last.event_type)
                : String(last.event_type || '').replace(/_/g, ' ').toLowerCase();

        text.textContent =
            `${label} — ${sosfmt(last.timestamp)}${
                last.performed_by ? ` · by ${last.performed_by}` : ''}${
                last.notes ? ` · “${last.notes}”` : ''}`;
        wrap.classList.remove('hidden');
    } catch {
        wrap.classList.add('hidden');
    }
}

// ─── Wiring ───────────────────────────────────────────────────

(function wireSosCoordination() {
    function wire() {
        // Modal controls
        $sos('sos-detail-close')?.addEventListener('click', closeSosDetail);
        $sos('sos-detail-minimize')?.addEventListener('click', closeSosDetail);
        $sos('sos-detail-refresh')?.addEventListener('click', async () => {
            showSosState('Refreshing…', { loading: true });
            try {
                await sosRefreshSilent();
                hideSosState();
            } catch (err) {
                showSosState(`Refresh failed: ${err.message}`, { error: true, retry: true });
            }
        });
        $sos('sos-detail-retry')?.addEventListener('click', () => {
            if (sosState.incident?.incident_id) {
                openSosDetail({ incidentId: sosState.incident.incident_id });
            } else if (sosState.alertRow?.belt) {
                openSosDetail({ deviceId: sosState.alertRow.belt, alertRow: sosState.alertRow });
            }
        });
        $sos('sos-ping-btn')?.addEventListener('click', sosPingRescueTeam);

        // Click outside the modal closes it (state is preserved).
        $sos('sos-detail-modal')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) closeSosDetail();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && sosState.open) closeSosDetail();
        });

        // SOS History page controls
        $sos('sos-history-refresh')?.addEventListener('click', () => loadSosHistory());
        $sos('sos-history-retry')?.addEventListener('click', () => loadSosHistory());
        $sos('sos-history-clear')?.addEventListener('click', () => {
            ['sos-history-search', 'sos-history-from', 'sos-history-to'].forEach((id) => {
                const el = $sos(id);
                if (el) el.value = '';
            });
            ['sos-history-severity', 'sos-history-status', 'sos-history-team'].forEach((id) => {
                const el = $sos(id);
                if (el) el.value = '';
            });
            const cb = $sos('sos-history-sosonly');
            if (cb) cb.checked = true;
            renderSosHistory();
        });

        let searchDebounce = null;
        $sos('sos-history-search')?.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(renderSosHistory, 200);
        });
        ['sos-history-from', 'sos-history-to', 'sos-history-severity',
         'sos-history-status', 'sos-history-team', 'sos-history-sosonly'].forEach((id) => {
            $sos(id)?.addEventListener('change', renderSosHistory);
        });

        // Load the history page when the admin opens it.
        document.querySelectorAll('[data-target="soshistory"]').forEach((link) => {
            link.addEventListener('click', () => {
                // Refresh on every visit so records are current.
                loadSosHistory();
            });
        });

        // Dashboard emergency panel: "OPEN SOS DETAILS" button
        $sos('dash-open-sos-detail')?.addEventListener('click', () => {
            const idText = ($sos('dash-emergency-id')?.textContent || '').replace('#', '').trim();
            if (idText && idText !== '—') {
                openSosDetail({ incidentId: idText });
            }
        });

        // Session lifecycle
        window.addEventListener('avighnaa:session', () => {
            sosHistoryState.loadedAt = null;
            if (sosHistoryPageActive()) loadSosHistory();
        });
        window.addEventListener('avighnaa:logout', () => {
            closeSosDetail();
            sosHistoryState.incidents = [];
            sosHistoryState.alerts = [];
        });

        // Combined low-frequency poller (the app's existing real-time
        // mechanism is polling). Only runs work for visible surfaces.
        sosState.historyTimer = setInterval(async () => {
            if (sosState.open) await sosRefreshSilent();
            if (sosHistoryPageActive()) await loadSosHistory({ silent: true });
            if (document.getElementById('page-dashboard')?.classList.contains('active')) {
                await refreshDashEmergencyLatest();
            }
        }, 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();
