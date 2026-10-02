/* ==========================================================================
   AVIGHNAA - Frontend Application Logic
   ========================================================================== */

// --- Authentication Bootstrap ---
(function () {
    document.body.classList.remove('logged-in', 'logged-out');
    document.body.classList.add('logged-out');
    document.body.classList.remove('auth-loading');
})();

lucide.createIcons();

const API_BASE_URL = "http://localhost:5002/api";
const SUPABASE_URL = "https://qsymativfurrwguffwvc.supabase.co";
const SUPABASE_KEY = "sb_publishable_NBqLNkIQT-nxb7rfvJFJ0Q_Pyu6wsCg";

const supabaseClient = supabase.createClient(
    SUPABASE_URL,
    SUPABASE_KEY
);

// ==========================================================================
// UI Helpers
// ==========================================================================

function riskTierClass(level) {
    switch ((level || '').toUpperCase()) {
        case 'CRITICAL': return 'text-critical';
        case 'HIGH': return 'text-high';
        case 'MEDIUM': return 'text-warning';
        case 'LOW': return 'text-safe';
        default: return '';
    }
}

function tierOutlineClass(level) {
    switch ((level || '').toUpperCase()) {
        case 'CRITICAL': return 'outline-critical';
        case 'HIGH': return 'outline-high';
        case 'MEDIUM': return 'outline-warning';
        case 'LOW': return 'outline-safe';
        default: return '';
    }
}

function severityTier(severity) {
    const s = (severity || '').toUpperCase();

    if (s === 'CRITICAL') return 'critical';
    if (s === 'HIGH' || s === 'WARNING') return 'warning';
    if (s === 'MEDIUM' || s === 'INFO') return 'info';

    return 'info';
}

function typeChipClass(alertType) {
    const t = (alertType || '').toUpperCase();

    if (t === 'SOS') return 'chip-sos';
    if (t === 'ANOMALY') return 'chip-anomaly';
    if (t === 'AI_RISK_UPGRADE') return 'chip-ai';
    if (t === 'FALL_DETECTED' || t === 'COMBINED_DANGER') return 'chip-critical';
    if (t === 'GAS_DANGER' || t === 'FLOOD_DANGER' || t === 'TEMP_DANGER') return 'chip-high';
    if (t === 'SENSOR_STUCK') return 'chip-anomaly';

    return '';
}

// ==========================================================================
// AI Integration Extras (source badge, ML chip, warnings, why-score)
// ==========================================================================

function normalizeAISource(source) {
    return String(source || '').trim().toLowerCase();
}

function formatAIConfidencePercent(value) {
    const num = Number(value);

    if (!Number.isFinite(num)) return null;

    // The API may send confidence as 0-1 or already as 0-100.
    const pct = num > 1 ? num : num * 100;

    return Math.round(pct);
}

function renderAISourceBadge(aiRisk) {
    const badge = document.getElementById('ai-source-badge');

    if (!badge) return;

    const source = normalizeAISource(aiRisk?.source);

    if (source === 'ml_fusion') {
        badge.dataset.source = 'online';
        badge.innerText = 'AI Online';
    } else if (source === 'rules_fallback') {
        badge.dataset.source = 'offline';
        badge.innerText = 'Rules Only (AI Offline)';
    } else {
        badge.dataset.source = 'unknown';
        badge.innerText = 'AI status unknown';
    }
}

function renderAIMLchip(aiRisk) {
    const chip = document.getElementById('ai-ml-chip');

    if (!chip) return;

    const source = normalizeAISource(aiRisk?.source);
    const prediction = aiRisk?.mlRiskPrediction;

    if (
        source !== 'ml_fusion' ||
        prediction === null ||
        prediction === undefined ||
        prediction === ''
    ) {
        chip.classList.add('is-hidden');
        chip.innerText = '';
        return;
    }

    const pct = formatAIConfidencePercent(aiRisk?.mlConfidence);

    chip.innerText =
        `ML: ${String(prediction).toUpperCase()}` +
        (pct !== null ? ` (${pct}%)` : '');

    chip.classList.remove('is-hidden');
}

function renderAIRecommendationInline(aiRisk) {
    const el = document.getElementById('ai-recommendation-inline');

    if (!el) return;

    const recommendation =
        aiRisk?.recommendation || aiRisk?.reason;

    if (
        recommendation === null ||
        recommendation === undefined ||
        String(recommendation).trim() === ''
    ) {
        el.classList.add('is-hidden');
        el.innerText = '';
        return;
    }

    el.innerText = String(recommendation);
    el.classList.remove('is-hidden');
}

function collectWorkerField(workers, picker) {
    const out = [];
    const seen = new Set();

    (workers || []).forEach(worker => {
        const value = picker(worker);
        const items = Array.isArray(value)
            ? value
            : value === null ||
              value === undefined ||
              value === ''
            ? []
            : [value];

        items.forEach(item => {
            if (item === null || item === undefined) return;

            const key =
                typeof item === 'object'
                    ? JSON.stringify(item)
                    : String(item);

            if (seen.has(key)) return;

            seen.add(key);
            out.push(item);
        });
    });

    return out;
}

function trendWarningMessage(warning) {
    if (warning === null || warning === undefined) return '';

    if (typeof warning === 'string') return warning;

    if (typeof warning === 'object') {
        return (
            warning.message ||
            warning.text ||
            warning.detail ||
            ''
        );
    }

    return String(warning);
}

function renderAIWarnings(stuckSensors, trendWarnings) {
    const stuckEl = document.getElementById('ai-stuck-warning');

    if (stuckEl) {
        const stuck = (Array.isArray(stuckSensors)
            ? stuckSensors
            : []
        ).filter(Boolean);

        if (stuck.length) {
            stuckEl.innerText =
                '⚠ Frozen sensor — ' +
                stuck.join(', ') +
                (stuck.length > 1
                    ? ' readings unreliable'
                    : ' reading unreliable');

            stuckEl.classList.remove('is-hidden');
        } else {
            stuckEl.innerText = '';
            stuckEl.classList.add('is-hidden');
        }
    }

    const trendEl = document.getElementById('ai-trend-warning');

    if (trendEl) {
        const messages = (Array.isArray(trendWarnings)
            ? trendWarnings
            : []
        )
            .map(trendWarningMessage)
            .filter(message => String(message).trim() !== '');

        if (messages.length) {
            trendEl.innerText = messages
                .map(message => `⚠ ${message}`)
                .join('\n');

            trendEl.classList.remove('is-hidden');
        } else {
            trendEl.innerText = '';
            trendEl.classList.add('is-hidden');
        }
    }
}

function renderAIWhyScore(factors) {
    const panel = document.getElementById('ai-why');
    const list = document.getElementById('ai-why-list');

    if (!panel || !list) return;

    const items = Array.isArray(factors)
        ? factors.filter(Boolean)
        : [];

    if (!items.length) {
        list.innerHTML = '';
        panel.classList.add('is-hidden');
        return;
    }

    list.innerHTML = items
        .map(factor => {
            const source = normalizeAISource(factor.source);
            const name = safeText(factor.name, 'Risk factor');
            const points = Number(factor.points);
            const pointsText = Number.isFinite(points)
                ? `${points > 0 ? '+' : ''}${points}`
                : '';
            const detail = factor.detail
                ? `<div class="why-detail">${safeText(
                      factor.detail,
                      ''
                  )}</div>`
                : '';

            return `
                <li>
                    ${
                        source
                            ? `<span class="why-source why-source-${source}">${source}</span>`
                            : ''
                    }
                    <span class="why-name">${name}</span>
                    ${
                        pointsText
                            ? `<span class="why-points">${pointsText}</span>`
                            : ''
                    }
                    ${detail}
                </li>
            `;
        })
        .join('');

    panel.classList.remove('is-hidden');
}

function renderAIExtras(aiRisk, workers) {
    renderAISourceBadge(aiRisk);
    renderAIMLchip(aiRisk);
    renderAIRecommendationInline(aiRisk);
    renderAIWhyScore(aiRisk?.aiRiskFactors);
    renderAIWarnings(
        collectWorkerField(
            workers,
            worker => worker.aiRisk?.stuckSensors
        ),
        collectWorkerField(
            workers,
            worker => worker.aiRisk?.trendWarnings
        )
    );
}

function resetAIExtras() {
    const badge = document.getElementById('ai-source-badge');

    if (badge) {
        badge.dataset.source = 'unknown';
        badge.innerText = 'AI status unknown';
    }

    const chip = document.getElementById('ai-ml-chip');

    if (chip) {
        chip.classList.add('is-hidden');
        chip.innerText = '';
    }

    const inlineRec = document.getElementById(
        'ai-recommendation-inline'
    );

    if (inlineRec) {
        inlineRec.classList.add('is-hidden');
        inlineRec.innerText = '';
    }

    const whyPanel = document.getElementById('ai-why');

    if (whyPanel) {
        whyPanel.classList.add('is-hidden');
    }

    const whyList = document.getElementById('ai-why-list');

    if (whyList) {
        whyList.innerHTML = '';
    }

    renderAIWarnings([], []);
}

function setRiskPill(level) {
    const pill = document.getElementById('ai-state-pill');
    const hero = document.getElementById('ai-hero');
    const normalized = (level || '').toUpperCase();

    if (pill) {
        pill.dataset.level = normalized || 'none';
        pill.innerText = normalized || 'NO DATA';
    }

    if (hero) {
        hero.dataset.state = normalized || 'idle';
    }
}

function resetAIPanel() {
    setRiskPill(null);

    const aiHeroMeta = document.getElementById('ai-hero-meta');

    if (aiHeroMeta) {
        aiHeroMeta.innerText = 'Waiting for AI analysis…';
    }

    const aiModelConfidence =
        document.getElementById('ai-model-confidence');

    if (aiModelConfidence) {
        aiModelConfidence.innerText = '--';
        aiModelConfidence.title =
            'Confidence not provided by the risk API';
    }

    const aiLastUpdated =
        document.getElementById('ai-last-updated');

    if (aiLastUpdated) {
        aiLastUpdated.innerText = '--';
    }

    const aiFactorsList =
        document.getElementById('ai-factors-list');

    if (aiFactorsList) {
        aiFactorsList.innerHTML =
            '<li>Waiting for AI analysis…</li>';
    }

    const aiRecommendation =
        document.getElementById('ai-recommendation');

    if (aiRecommendation) {
        aiRecommendation.innerHTML =
            '<strong>AI Recommendation:</strong><br>Waiting for latest AI risk analysis.';
    }

    resetAIExtras();
}

function safeText(value, fallback = 'N/A') {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }

    return String(value);
}

function emergencySensorValue(
    value,
    digits = 1,
    suffix = ''
) {
    const num = Number(value);

    if (!Number.isFinite(num)) {
        return 'N/A';
    }

    return `${num.toFixed(digits)}${suffix}`;
}

// ==========================================================================
// SOS Emergency Mode
// ==========================================================================

const emergencyState = {
    activeDeviceIds: new Set(),
    minimized: false
};

function emergencyRiskInfo(worker) {
    const fallback = evaluateStatus(worker);
    const risk = worker.aiRisk;

    return {
        score:
            risk && Number.isFinite(Number(risk.score))
                ? Math.round(Number(risk.score))
                : fallback.risk,

        level: risk?.level || fallback.status
    };
}

function emergencyRefresh() {
    const affected = appState.workers.filter(
        worker =>
            worker.sensorData &&
            worker.sensorData.sos === true
    );

    affected.forEach(worker => {
        const deviceId = worker.sensorData.device_id;

        if (!emergencyState.activeDeviceIds.has(deviceId)) {
            emergencyState.activeDeviceIds.add(deviceId);

            addLogEntry(
                'ALERT',
                'tag-alert',
                `EMERGENCY: SOS activated by ${
                    worker.name || worker.workerId
                } (Belt ${deviceId})`
            );
        }
    });

    [...emergencyState.activeDeviceIds].forEach(deviceId => {
        const stillActive = affected.some(
            worker =>
                worker.sensorData.device_id === deviceId
        );

        if (!stillActive) {
            emergencyState.activeDeviceIds.delete(deviceId);

            addLogEntry(
                'STATUS',
                'tag-status',
                `SOS cleared for Belt ${deviceId}`
            );
        }
    });

    const overlay =
        document.getElementById('emergency-overlay');

    const miniBar =
        document.getElementById('emergency-mini-bar');

    if (affected.length > 0) {
        renderEmergencyOverlay(affected);

        document.body.classList.add('emergency-active');

        if (emergencyState.minimized) {
            overlay?.classList.add('hidden');
            miniBar?.classList.add('visible');

            document.body.classList.remove(
                'emergency-fullscreen'
            );

            const miniText =
                document.getElementById(
                    'emergency-mini-bar-text'
                );

            if (miniText) {
                miniText.innerText =
                    affected.length > 1
                        ? `SOS ACTIVE · ${affected.length} WORKERS`
                        : 'SOS ACTIVE';
            }
        } else {
            overlay?.classList.remove('hidden');
            miniBar?.classList.remove('visible');

            document.body.classList.add(
                'emergency-fullscreen'
            );
        }
    } else {
        overlay?.classList.add('hidden');
        miniBar?.classList.remove('visible');

        document.body.classList.remove(
            'emergency-active'
        );

        document.body.classList.remove(
            'emergency-fullscreen'
        );

        emergencyState.minimized = false;
    }

    const countEl =
        document.getElementById('emergency-count');

    if (countEl) {
        countEl.innerText =
            `${affected.length} worker${
                affected.length === 1 ? '' : 's'
            } affected`;
    }

    const returnBtn =
        document.getElementById('emergency-return');

    if (returnBtn) {
        returnBtn.disabled = affected.length > 0;

        returnBtn.title =
            affected.length > 0
                ? 'SOS still active'
                : 'Return to the normal dashboard';
    }
}

function renderEmergencyOverlay(affectedWorkers) {
    const container =
        document.getElementById('emergency-workers');

    if (!container) return;

    const sorted = [...affectedWorkers].sort(
        (a, b) =>
            emergencyRiskInfo(b).score -
            emergencyRiskInfo(a).score
    );

    container.innerHTML = sorted.map(worker => {
        const d = worker.sensorData;
        const risk = emergencyRiskInfo(worker);

        const sosTime =
            d.timestamp &&
            !Number.isNaN(
                new Date(d.timestamp).getTime()
            )
                ? new Date(d.timestamp).toLocaleString()
                : 'Unknown';

        const recParts = [
            'Contact the worker immediately and dispatch assistance to their location.'
        ];

        if (
            Number(d.gas_raw) >=
            appState.settings.gasWarn
        ) {
            recParts.push(
                'Gas level is elevated — ensure ventilation before entry.'
            );
        }

        if (
            Number(d.water_level_cm) >=
            appState.settings.waterWarn
        ) {
            recParts.push(
                'Water level is elevated — verify flood escape route.'
            );
        }

        if (
            Number(d.temperature_c) >=
            appState.settings.tempWarn
        ) {
            recParts.push(
                'Temperature is elevated — check for heat or equipment hazards.'
            );
        }

        return `
            <div class="emergency-worker-card">

                <div class="emergency-worker-header">

                    <h3>
                        ${worker.name || worker.workerId}
                        <span>
                            · ID ${
                                worker.worker_id ||
                                worker.workerId
                            }
                        </span>
                    </h3>

                    <span class="sos-indicator">
                        <i data-lucide="radio"></i>
                        SOS ACTIVE
                    </span>

                </div>

                <div class="emergency-details">

                    <div class="emergency-detail">
                        <div class="detail-label">Worker ID</div>
                        <div class="detail-value">
                            ${safeText(
                                worker.worker_id ||
                                worker.workerId
                            )}
                        </div>
                    </div>

                    <div class="emergency-detail">
                        <div class="detail-label">Belt / Device</div>
                        <div class="detail-value">
                            ${safeText(d.device_id)}
                        </div>
                    </div>

                    <div class="emergency-detail">
                        <div class="detail-label">Location</div>
                        <div class="detail-value">
                            ${safeText(
                                worker.mine_location ||
                                worker.location
                            )}
                        </div>
                    </div>

                    <div class="emergency-detail">
                        <div class="detail-label">SOS Time</div>
                        <div class="detail-value">
                            ${sosTime}
                        </div>
                    </div>

                    <div class="emergency-detail">
                        <div class="detail-label">Temperature</div>
                        <div class="detail-value">
                            ${emergencySensorValue(
                                d.temperature_c,
                                1,
                                ' °C'
                            )}
                        </div>
                    </div>

                    <div class="emergency-detail">
                        <div class="detail-label">Gas Level</div>
                        <div class="detail-value">
                            ${emergencySensorValue(
                                d.gas_raw,
                                0,
                                ' raw'
                            )}
                        </div>
                    </div>

                    <div class="emergency-detail">
                        <div class="detail-label">Water Level</div>
                        <div class="detail-value ${
                            Number(d.water_level_cm) >=
                            appState.settings.waterWarn
                                ? 'emg-critical'
                                : ''
                        }">
                            ${emergencySensorValue(
                                d.water_level_cm,
                                1,
                                ' cm'
                            )}
                        </div>
                    </div>

                    <div class="emergency-detail">
                        <div class="detail-label">
                            Risk Score / Level
                        </div>
                        <div class="detail-value">
                            ${risk.score}/100 · ${
                                safeText(risk.level)
                            }
                        </div>
                    </div>

                </div>

                <div class="emergency-recommendation">
                    <strong>
                        ⚠️ IMMEDIATE ATTENTION REQUIRED:
                    </strong>
                    ${recParts.join(' ')}
                </div>

            </div>
        `;
    }).join('');

    lucide.createIcons();
}

window.emergencyToggleMinimize = function () {
    emergencyState.minimized =
        !emergencyState.minimized;

    emergencyRefresh();
};

window.emergencyOpen = function () {
    emergencyState.minimized = false;
    emergencyRefresh();
};

// ==========================================================================
// Backend
// ==========================================================================

async function getWorkersFromBackend() {

    const {
        data: { session }
    } = await supabaseClient.auth.getSession();

    if (!session) {
        console.log("❌ No Supabase session found");
        return;
    }

    const response =
        await fetch(`${API_BASE_URL}/workers`, {

            headers: {
                Authorization:
                    `Bearer ${session.access_token}`
            }
        });

    const result = await response.json();

    console.log(
        "👷 Backend workers:",
        result
    );
}

async function testBackendConnection() {

    try {

        const response =
            await fetch("http://localhost:5002/");

        if (response.ok) {
            console.log(
                "✅ Backend connected successfully"
            );

            return true;
        }

        console.log(
            "⚠️ Backend responded, but with an error"
        );

        return false;

    } catch (error) {

        console.log(
            "❌ Backend not reachable"
        );

        return false;
    }
}

async function loadAlertsFromBackend() {

    try {

        const {
            data: sessionData
        } = await supabaseClient.auth.getSession();

        const token =
            sessionData?.session?.access_token;

        if (!token) return;

        const response =
            await fetch(`${API_BASE_URL}/alerts`, {
                headers: {
                    'Authorization':
                        `Bearer ${token}`
                }
            });

        if (!response.ok) {
            throw new Error(
                `Alerts API error: ${response.status}`
            );
        }

        const result =
            await response.json();

        appState.alerts =
            (result.data || []).map(alert => {

                const severityUpper =
                    (alert.severity || '').toUpperCase();

                const alertTypeUpper =
                    (alert.alert_type || '').toUpperCase();

                return {

                    id: alert.id,

                    type:
                        severityUpper === 'CRITICAL'
                            ? 'CRITICAL'
                            : severityUpper === 'HIGH'
                            ? 'HIGH'
                            : severityUpper === 'WARNING'
                            ? 'WARNING'
                            : 'INFO',

                    alertType:
                        alertTypeUpper || undefined,

                    isSOS:
                        alertTypeUpper === 'SOS',

                    msg: alert.message,

                    aiAction: '',

                    worker: 'Worker',

                    belt: alert.device_id,

                    time:
                        alert.created_at
                            ? new Date(
                                alert.created_at
                              ).toLocaleString()
                            : 'Recently',

                    ack: alert.is_resolved
                };
            });

        console.log(
            `Loaded ${appState.alerts.length} alerts`
        );

        renderAlerts();

    } catch (error) {

        console.error(
            '❌ Alerts loading failed:',
            error
        );
    }
}

// Resolve an alert via the backend. Only real backend alerts (numeric id) are
// sent to PATCH /api/alerts/:alertId/resolve — synthetic client-only alerts
// (e.g. the SOS fallback) are acknowledged locally without an API call.
async function resolveAlertOnBackend(alert) {
    if (!alert || alert.ack) return true; // nothing to do

    // Synthetic alerts have no backend row — acknowledge locally only.
    if (alert.synthetic || typeof alert.id !== 'number') {
        alert.ack = true;
        return true;
    }

    try {
        const { data: sessionData } = await supabaseClient.auth.getSession();
        const token = sessionData?.session?.access_token;

        if (!token) {
            console.error('❌ Cannot resolve alert: no auth token');
            return false;
        }

        const response = await fetch(`${API_BASE_URL}/alerts/${alert.id}/resolve`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Resolve API error: ${response.status}`);
        }

        alert.ack = true;
        return true;

    } catch (error) {
        // Leave alert.ack unchanged so the next poll can retry
        console.error(`❌ Failed to resolve alert ${alert.id}:`, error);
        return false;
    }
}

async function loadWorkersFromBackend() {

    try {

        const {
            data: { session }
        } = await supabaseClient.auth.getSession();

        if (!session) {
            console.log(
                "❌ No Supabase session found"
            );

            return;
        }

        const headers = {
            Authorization:
                `Bearer ${session.access_token}`
        };

        const workersResponse =
            await fetch(
                `${API_BASE_URL}/workers`,
                { headers }
            );

        const workersResult =
            await workersResponse.json();

        if (!workersResult.success) {

            console.log(
                "❌ Could not load workers:",
                workersResult.message
            );

            return;
        }

        const workers =
            workersResult.data;

        const devicesResponse =
            await fetch(
                `${API_BASE_URL}/devices`,
                { headers }
            );

        const devicesResult =
            await devicesResponse.json();

        if (!devicesResult.success) {

            console.log(
                "❌ Could not load devices:",
                devicesResult.message
            );

            return;
        }

        const devices =
            devicesResult.data;

        for (const worker of workers) {

            const device =
                devices.find(
                    d =>
                        d.worker_id === worker.id
                );

            if (!device) continue;

            const sensorResponse =
                await fetch(
                    `${API_BASE_URL}/sensor-data/${device.device_id}`,
                    { headers }
                );

            const sensorResult =
                await sensorResponse.json();

            // Backend returns newest FIRST.
            // Therefore data[0] is the latest sensor reading.

            const latestSensor =
                sensorResult.success &&
                sensorResult.data.length
                    ? sensorResult.data[0]
                    : null;

            if (!latestSensor) continue;

            worker.workerId =
                worker.worker_id;

            worker.battery =
                device.battery ?? 100;

            worker.location =
                worker.mine_location ||
                "Unknown";

            worker.sensorData =
                latestSensor;

            worker.sensorHistory =
                sensorResult.data;

            if (latestSensor.sos === true) {
                // Fallback-only synthetic SOS alert: at most ONE per device, and only
                // when the backend has no real unresolved SOS alert for that device.
                const hasRealSOSAlert = appState.alerts.some(
                    a => a.isSOS && a.belt === device.device_id && !a.ack
                );
                const hasSyntheticSOSAlert = appState.alerts.some(
                    a => a.synthetic && a.belt === device.device_id && !a.ack
                );

                if (!hasRealSOSAlert && !hasSyntheticSOSAlert) {
                    appState.alerts.unshift({
                        id: `SOS-${worker.worker_id}-${device.device_id}`,
                        synthetic: true,
                        type: "CRITICAL",
                        msg: "SOS button pressed. Immediate assistance required.",
                        aiAction: "Contact the worker immediately and dispatch emergency assistance to the reported location.",
                        worker: worker.name || worker.worker_id,
                        belt: device.device_id,
                        time: "Just now",
                        ack: false
                    });
                }

            }
        }

        appState.workers =
            workers.filter(
                worker =>
                    worker.sensorData
            );

        renderDashboard();

        renderWorkersPage();

        addLogEntry(
            'STATUS',
            'tag-status',
            `Loaded ${appState.workers.length} worker(s) from backend`
        );

    } catch (error) {

        console.error(
            "❌ Worker data loading failed:",
            error
        );
    }
}
async function loadRiskFromBackend() {

    try {

        const {
            data: { session }
        } = await supabaseClient.auth.getSession();

        if (!session) {
            console.log(
                "❌ No Supabase session found"
            );

            return;
        }

        const headers = {
            Authorization:
                `Bearer ${session.access_token}`
        };

        for (const worker of appState.workers) {

            const deviceId =
                worker.sensorData?.device_id;

            if (!deviceId) continue;

            const response =
                await fetch(
                    `${API_BASE_URL}/risk/${deviceId}`,
                    { headers }
                );

            const result =
                await response.json();

            if (
                !result.success ||
                !result.data?.length
            ) {
                continue;
            }

            const latestRisk = result.data[0];

            worker.aiRisk = {

                score:
                    Number(
                        latestRisk.risk_score
                    ),

                level:
                    latestRisk.risk_level,

                reason:
                    latestRisk.reason,

                createdAt:
                    latestRisk.created_at,

                mlConfidence:
                    latestRisk.ai?.mlConfidence,

                mlRiskPrediction:
                    latestRisk.ai?.mlRiskPrediction,

                anomalyDetected:
                    latestRisk.ai?.anomalyDetected,

                anomalyScore:
                    latestRisk.ai?.anomalyScore,

                combinedScore:
                    latestRisk.ai?.combinedScore,

                source:
                    latestRisk.ai?.source ??
                    latestRisk.source,

                recommendation:
                    latestRisk.ai?.recommendation ??
                    latestRisk.recommendation,

                aiRiskFactors:
                    latestRisk.ai?.aiRiskFactors ??
                    latestRisk.aiRiskFactors,

                stuckSensors:
                    latestRisk.ai?.stuckSensors ??
                    latestRisk.stuckSensors,

                trendWarnings:
                    latestRisk.ai?.trendWarnings ??
                    latestRisk.trendWarnings
            };
        }

        renderDashboard();
        renderWorkersPage();

        console.log(
            "✅ AI risk data loaded from backend"
        );

    } catch (error) {

        console.error(
            "❌ AI risk loading failed:",
            error
        );
    }
}


let backendRefreshTimer = null;

function startBackendRefresh() {

    if (backendRefreshTimer) {
        clearInterval(
            backendRefreshTimer
        );
    }

    backendRefreshTimer = setInterval(async () => {
        await loadRiskHistory();
        await loadAlertsFromBackend();
        await loadWorkersFromBackend();
        // Refresh analytics charts in place with the latest real data
        refreshCharts();
        // Part 3: keep Emergency Mode in sync with the latest sensor data
        emergencyRefresh();
    }, appState.settings.refreshInterval * 1000);

}

async function loadRiskHistory() {

    try {

        const {
            data: { session }
        } = await supabaseClient.auth.getSession();

        if (!session) {

            console.log(
                "❌ No Supabase session found"
            );

            return;
        }

        const headers = {
            Authorization:
                `Bearer ${session.access_token}`
        };

        let allRiskData = [];

        for (
            const worker
            of appState.workers
        ) {

            const deviceId =
                worker.sensorData?.device_id;

            if (!deviceId) continue;

            const response =
                await fetch(
                    `${API_BASE_URL}/risk/${deviceId}`,
                    { headers }
                );

            const result =
                await response.json();

            if (
                !result.success ||
                !result.data?.length
            ) {
                continue;
            }

            allRiskData.push(
                ...result.data
            );

            const latestRisk = result.data[0];

            worker.aiRisk = {

                score:
                    Number(
                        latestRisk.risk_score
                    ),

                level:
                    latestRisk.risk_level,

                reason:
                    latestRisk.reason,

                createdAt:
                    latestRisk.created_at,

                mlConfidence:
                    latestRisk.ai?.mlConfidence,

                mlRiskPrediction:
                    latestRisk.ai?.mlRiskPrediction,

                anomalyDetected:
                    latestRisk.ai?.anomalyDetected,

                anomalyScore:
                    latestRisk.ai?.anomalyScore,

                combinedScore:
                    latestRisk.ai?.combinedScore,

                source:
                    latestRisk.ai?.source ??
                    latestRisk.source,

                recommendation:
                    latestRisk.ai?.recommendation ??
                    latestRisk.recommendation,

                aiRiskFactors:
                    latestRisk.ai?.aiRiskFactors ??
                    latestRisk.aiRiskFactors,

                stuckSensors:
                    latestRisk.ai?.stuckSensors ??
                    latestRisk.stuckSensors,

                trendWarnings:
                    latestRisk.ai?.trendWarnings ??
                    latestRisk.trendWarnings
            };
        }

        appState.riskHistory =
            allRiskData;

        const workersWithRisk =
            appState.workers.filter(
                worker =>
                    worker.aiRisk
            );

        if (
            workersWithRisk.length > 0
        ) {

            const averageRisk =
                workersWithRisk.reduce(
                    (sum, worker) =>
                        sum +
                        worker.aiRisk.score,
                    0
                ) /
                workersWithRisk.length;

            let overallLevel = "LOW";

            if (averageRisk >= 75) {
                overallLevel = "CRITICAL";
            } else if (averageRisk >= 50) {
                overallLevel = "HIGH";
            } else if (averageRisk >= 25) {
                overallLevel = "MEDIUM";
            }

            const overallRiskLevel =
                document.getElementById(
                    "overall-risk-level"
                );

            const overallRiskScore =
                document.getElementById(
                    "overall-risk-score"
                );

            if (overallRiskLevel) {
                overallRiskLevel.innerText =
                    overallLevel;
            }

            if (overallRiskScore) {

                overallRiskScore.innerText =
                    `${Math.round(
                        averageRisk
                    )} / 100 Score`;
            }

            const overallRiskCard =
                overallRiskLevel?.closest(
                    ".summary-card"
                );

            if (overallRiskCard) {

                overallRiskCard.classList.remove(
                    "outline-safe",
                    "outline-warning",
                    "outline-high",
                    "outline-critical"
                );

                overallRiskCard.classList.add(
                    tierOutlineClass(
                        overallLevel
                    )
                );
            }

            if (overallRiskScore) {

                overallRiskScore.classList.remove(
                    "text-safe",
                    "text-warning",
                    "text-high",
                    "text-critical"
                );

                overallRiskScore.classList.add(
                    riskTierClass(
                        overallLevel
                    )
                );
            }

            const aiRiskScore =
                document.getElementById(
                    "ai-risk-score"
                );

            const aiPredictedRisk =
                document.getElementById(
                    "ai-predicted-risk"
                );

            const aiRecommendation =
                document.getElementById(
                    "ai-recommendation"
                );

            if (aiRiskScore) {

                aiRiskScore.innerHTML =
                    `${Math.round(
                        averageRisk
                    )} <span class="unit">/ 100</span>`;

                aiRiskScore.classList.remove(
                    "text-safe",
                    "text-warning",
                    "text-high",
                    "text-critical"
                );

                aiRiskScore.classList.add(
                    riskTierClass(
                        overallLevel
                    )
                );
            }

            if (aiPredictedRisk) {

                aiPredictedRisk.innerText =
                    overallLevel;

                aiPredictedRisk.classList.remove(
                    "text-safe",
                    "text-warning",
                    "text-high",
                    "text-critical"
                );

                aiPredictedRisk.classList.add(
                    riskTierClass(
                        overallLevel
                    )
                );
            }

            setRiskPill(
                overallLevel
            );

            const latestWorker = workersWithRisk[0];

            if (
                aiRecommendation &&
                latestWorker.aiRisk?.reason
            ) {

                aiRecommendation.innerHTML = `
                    <strong>AI Recommendation:</strong><br>
                    ${latestWorker.aiRisk.reason}
                `;
            }

            const latestAiRisk =
                latestWorker.aiRisk;

            renderAIExtras(
                latestAiRisk,
                workersWithRisk
            );

            const aiHeroMeta =
                document.getElementById(
                    "ai-hero-meta"
                );

            if (aiHeroMeta) {

                aiHeroMeta.innerText =
                    (latestAiRisk?.createdAt
                        ? `Latest analysis · ${
                            new Date(
                                latestAiRisk.createdAt
                            ).toLocaleTimeString()
                          }`
                        : "Latest risk engine analysis") +
                    (latestAiRisk?.mlRiskPrediction
                        ? ` · AI: ${latestAiRisk.mlRiskPrediction}`
                        : "");
            }

            const aiModelConfidence =
                document.getElementById(
                    "ai-model-confidence"
                );

            if (aiModelConfidence) {

                if (
                    latestAiRisk?.mlConfidence != null
                ) {

                    aiModelConfidence.innerText =
                        `${Math.round(
                            latestAiRisk.mlConfidence * 100
                        )}%`;

                    aiModelConfidence.title =
                        "ML model confidence from the risk API";

                } else {

                    aiModelConfidence.innerText =
                        "--";

                    aiModelConfidence.title =
                        "Confidence not provided by the risk API";
                }
            }

            const aiLastUpdated =
                document.getElementById(
                    "ai-last-updated"
                );

            if (aiLastUpdated) {

                aiLastUpdated.innerText =
                    latestAiRisk?.createdAt
                        ? new Date(
                            latestAiRisk.createdAt
                          ).toLocaleTimeString()
                        : "--";
            }

            const aiFactorsList =
                document.getElementById(
                    "ai-factors-list"
                );

            if (aiFactorsList) {

                const reasons =
                    (
                        latestAiRisk?.reason ||
                        ""
                    )
                        .split(";")
                        .map(
                            part =>
                                part.trim()
                        )
                        .filter(Boolean);

                if (
                    latestAiRisk?.anomalyDetected === true
                ) {

                    reasons.unshift(
                        `Anomalous sensor pattern detected${
                            latestAiRisk.anomalyScore != null
                                ? ` (score ${latestAiRisk.anomalyScore})`
                                : ""
                        }`
                    );
                }

                aiFactorsList.innerHTML =
                    reasons.length
                        ? reasons
                            .map(
                                reason =>
                                    `<li>${reason}</li>`
                            )
                            .join("")
                        : "<li>No major risk factors reported</li>";
            }

        } else {

            resetAIPanel();
        }

        renderDashboard();
        renderWorkersPage();

        console.log(
            `✅ AI risk data loaded: ${allRiskData.length} records`
        );

    } catch (error) {

        console.error(
            "❌ AI risk loading failed:",
            error
        );
    }
}

// ==========================================================================
// App State
// ==========================================================================

const appState = {

    settings: {

        tempWarn: 36,
        tempCrit: 40,

        gasWarn: 550,
        gasCrit: 750,

        waterWarn: 25,
        waterCrit: 45,

        refreshInterval: 3,

        logAlerts: true
    },

    activityLog: [],

    logSeq: 0,

    auth: {
        username: '',
        authenticated: false
    },

    workers: [],

    alerts: [],

    charts: {
        temp: null,
        gas: null,
        water: null,
        risk: null
    },

    riskHistory: []
};

// ==========================================================================
// Initial Log
// ==========================================================================

(function seedLog() {

    appState.activityLog.push({

        ts: new Date(),

        tag: 'SYSTEM',

        tagClass: 'tag-info',

        msg:
            'Control room session started'

    });

    renderActivityLog();

})();

// ==========================================================================
// Authentication
// ==========================================================================

function setAuthenticated(user) {

    appState.auth.username =
        user;

    appState.auth.authenticated =
        true;

    document.body.classList.remove(
        'logged-out'
    );

    document.body.classList.add(
        'logged-in'
    );

    document.body.classList.remove(
        'auth-loading'
    );

    const overlay =
        document.getElementById(
            'login-overlay'
        );

    if (overlay) {
        overlay.classList.add(
            'hidden'
        );
    }

    addLogEntry(
        'STATUS',
        'tag-status',
        `User "${user}" signed in to the control room`
    );
}

function signOut() {

    appState.auth.authenticated =
        false;

    appState.auth.username =
        '';

    document.body.classList.remove(
        'logged-in'
    );

    document.body.classList.add(
        'logged-out'
    );

    document.body.classList.remove(
        'auth-loading'
    );

    const overlay =
        document.getElementById(
            'login-overlay'
        );

    if (overlay) {
        overlay.classList.remove(
            'hidden'
        );
    }

    addLogEntry(
        'STATUS',
        'tag-status',
        'Control room session ended'
    );

    updateOperatorDisplay();
}

window.handleLoginSubmit =
    async function (e) {

        e.preventDefault();

        const userEl =
            document.getElementById(
                'login-user'
            );

        const passEl =
            document.getElementById(
                'login-pass'
            );

        const errEl =
            document.getElementById(
                'login-error'
            );

        const user =
            (userEl.value || '').trim();

        const pass =
            (passEl.value || '').trim();

        try {

            const {
                data,
                error
            } =
                await supabaseClient.auth
                    .signInWithPassword({
                        email: user,
                        password: pass
                    });

            if (error) {

                console.error(
                    "❌ Login failed:",
                    error.message
                );

                if (errEl) {

                    errEl.textContent =
                        "Invalid email or password.";

                    errEl.classList.remove(
                        'hidden'
                    );

                    setTimeout(
                        () =>
                            errEl.classList.add(
                                'hidden'
                            ),
                        4000
                    );
                }

                return;
            }

            setAuthenticated(
                data.user.email
            );

            userEl.value = '';
            passEl.value = '';

            if (errEl) {
                errEl.classList.add(
                    'hidden'
                );
            }

            await loadAlertsFromBackend();
            await loadWorkersFromBackend();
            await loadRiskHistory();

            startBackendRefresh();

            updateOperatorDisplay();

        } catch (error) {

            console.error(
                "❌ Login error:",
                error
            );

            if (errEl) {

                errEl.textContent =
                    "Unable to sign in. Please try again.";

                errEl.classList.remove(
                    'hidden'
                );
            }
        }
    };

window.signOut =
    signOut;

// ==========================================================================
// Navigation
// ==========================================================================

document
    .querySelectorAll('.nav-item')
    .forEach(link => {

        link.addEventListener(
            'click',
            e => {

                e.preventDefault();

                document
                    .querySelectorAll(
                        '.nav-item'
                    )
                    .forEach(
                        el =>
                            el.classList.remove(
                                'active'
                            )
                    );

                e.currentTarget.classList.add(
                    'active'
                );

                const targetPage =
                    e.currentTarget.getAttribute(
                        'data-target'
                    );

                document
                    .querySelectorAll(
                        '.page'
                    )
                    .forEach(
                        page =>
                            page.classList.remove(
                                'active'
                            )
                    );

                document
                    .getElementById(
                        `page-${targetPage}`
                    )
                    .classList.add(
                        'active'
                    );

                const titleMap = {

                    dashboard:
                        'Dashboard',

                    workers:
                        'Worker Safety Management',

                    alerts:
                        'System Alerts & AI Intelligence',

                    analytics:
                        'Sensor Analytics',

                    settings:
                        'System Settings'
                };

                document.getElementById(
                    'page-title'
                ).innerText =
                    titleMap[targetPage];

                if (
                    !appState.auth.authenticated
                ) {

                    document
                        .getElementById(
                            'login-overlay'
                        )
                        .classList.remove(
                            'hidden'
                        );

                    document.getElementById(
                        'page-title'
                    ).innerText =
                        'Control Room Access';

                    return;
                }

                if (
                    targetPage ===
                    'analytics'
                ) {

                    if (
                        !appState.charts.temp
                    ) {
                        initCharts();
                    }

                    requestAnimationFrame(
                        () => {

                            Object.values(
                                appState.charts
                            ).forEach(
                                chart => {

                                    chart.resize();
                                    chart.update();

                                }
                            );

                        }
                    );
                }

            }
        );

    });

// ==========================================================================
// Worker Modal
// ==========================================================================

window.openModal =
    function (workerId) {

        if (
            !appState.auth.authenticated
        ) {

            document
                .getElementById(
                    'login-overlay'
                )
                .classList.remove(
                    'hidden'
                );

            return;
        }

        const worker =
            appState.workers.find(
                w =>
                    w.workerId ===
                    workerId
            );

        if (!worker) return;

        const {
            status,
            risk
        } =
            evaluateStatus(worker);

        const d =
            worker.sensorData;

        document.getElementById(
            'modal-worker-name'
        ).innerText =
            `${worker.name || worker.workerId} · Detailed Telemetry`;

        const body =
            document.getElementById(
                'modal-worker-body'
            );

        body.innerHTML = `

            <div class="detail-grid">

                <div
                    class="detail-item"
                    style="grid-column: 1 / -1;"
                >
                    <div class="detail-label">
                        Worker Profile
                    </div>

                    <div class="detail-value">
                        ${
                            worker.name ||
                            'N/A'
                        }
                        ·
                        ${
                            worker.worker_id ||
                            worker.workerId
                        }
                    </div>
                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Age
                    </div>

                    <div class="detail-value">
                        ${
                            worker.age ??
                            'N/A'
                        }
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Gender
                    </div>

                    <div class="detail-value">
                        ${
                            worker.gender ||
                            'N/A'
                        }
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Contact
                    </div>

                    <div class="detail-value">
                        ${
                            worker.contact_number ||
                            'N/A'
                        }
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Shift
                    </div>

                    <div class="detail-value">
                        ${
                            worker.shift ||
                            'N/A'
                        }
                    </div>

                </div>

                <div
                    class="detail-item"
                    style="grid-column: 1 / -1;"
                >

                    <div class="detail-label">
                        Mine Location
                    </div>

                    <div class="detail-value">
                        ${
                            worker.mine_location ||
                            worker.location ||
                            'N/A'
                        }
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Status & Risk
                    </div>

                    <div
                        class="detail-value ${
                            getStatusColor(
                                status
                            )
                        }"
                    >
                        ${status}
                        (Risk: ${risk}/100)
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Belt ID / Location
                    </div>

                    <div class="detail-value">
                        ${d.device_id}
                        ·
                        ${worker.location}
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Temperature
                    </div>

                    <div
                        class="detail-value ${
                            d.temperature_c >=
                            appState.settings.tempWarn
                                ? getStatusColor(status)
                                : ''
                        }"
                    >
                        ${d.temperature_c.toFixed(2)}
                        &deg;C
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Gas Level
                    </div>

                    <div
                        class="detail-value ${
                            d.gas_raw >=
                            appState.settings.gasWarn
                                ? getStatusColor(status)
                                : ''
                        }"
                    >
                        ${Math.round(d.gas_raw)}
                        raw
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Water Level
                    </div>

                    <div
                        class="detail-value ${
                            d.water_level_cm >=
                            appState.settings.waterWarn
                                ? getStatusColor(status)
                                : ''
                        }"
                    >
                        ${d.water_level_cm.toFixed(2)}
                        cm
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Battery / SOS
                    </div>

                    <div class="detail-value">
                        ${worker.battery}%
                        /
                        ${
                            d.sos
                                ? '<span class="text-critical">ACTIVE</span>'
                                : '<span class="text-safe">Normal</span>'
                        }
                    </div>

                </div>

                <div
                    class="detail-item"
                    style="grid-column: 1 / -1;"
                >

                    <div class="detail-label">
                        3-Axis Acceleration (X, Y, Z)
                    </div>

                    <div class="detail-value">
                        ${
                            d.acceleration_x_ms2.toFixed(3)
                        },
                        ${
                            d.acceleration_y_ms2.toFixed(3)
                        },
                        ${
                            d.acceleration_z_ms2.toFixed(3)
                        }
                        m/s&sup2;
                    </div>

                </div>

                <div
                    class="detail-item"
                    style="grid-column: 1 / -1;"
                >

                    <div class="detail-label">
                        Last Ping Time
                    </div>

                    <div
                        class="detail-value"
                        style="font-size:13px; color: var(--text-muted);"
                    >
                        ${
                            new Date(
                                d.timestamp
                            ).toLocaleString()
                        }
                    </div>

                </div>

            </div>
        `;

        document
            .getElementById(
                'worker-modal'
            )
            .classList.remove(
                'hidden'
            );
    };

window.closeModal =
    function () {

        document
            .getElementById(
                'worker-modal'
            )
            .classList.add(
                'hidden'
            );
    };

window.renderModalLiveTracking =
    renderModalLiveTracking;

document
    .getElementById(
        'worker-modal'
    )
    .addEventListener(
        'click',
        function (e) {

            if (
                e.target === this
            ) {
                closeModal();
            }

        }
    );


function renderModalLiveTracking() {

    const workerId =
        document.getElementById(
            'modal-worker-name'
        ).innerText.split(' ')[0] +
        ' ' +
        document.getElementById(
            'modal-worker-name'
        ).innerText.split(' ')[1];

    const worker =
        appState.workers.find(
            w => w.workerId === workerId
        );

    if (!worker) return;

    const d = worker.sensorData;

    const body =
        document.getElementById('modal-worker-body');

    if (!body) return;

    let block =
        body.querySelector('.live-tracking');

    const html = `
            <div class="live-tracking">

                <div class="live-tracking-head">

                    <strong>Live Tracking</strong>

                    <span class="badge badge-info">Real-time</span>

            </div>

            <div class="detail-grid">

                <div class="detail-item">

                    <div class="detail-label">
                        Last Data Ping
                    </div>

                    <div
                        class="detail-value"
                        style="font-size:13px; color: var(--text-main);"
                    >
                        ${
                            new Date(
                                d.timestamp
                            ).toLocaleString()
                        }
                    </div>

                </div>

                <div class="detail-item">

                    <div class="detail-label">
                        Belt / Location
                    </div>

                    <div
                        class="detail-value"
                        style="font-size:13px;"
                    >
                        ${d.device_id}
                        ·
                        ${worker.location}
                    </div>

                </div>

                <div
                    class="detail-item"
                    style="grid-column: 1 / -1;"
                >

                    <div class="detail-label">
                        Last Event
                    </div>

                    <div
                        class="detail-value"
                        style="font-size:13px; color: var(--text-main);"
                    >
                        ${
                            appState.activityLog.length
                                ? 'Logged ' +
                                  appState.activityLog[0].ts.toLocaleTimeString() +
                                  ' – ' +
                                  appState.activityLog[0].msg
                                : 'No events yet'
                        }
                    </div>

                </div>

            </div>

            <div class="tracking-history">

                <div class="tracking-history-head">
                    Recent Activity (last 8)
                </div>

                ${
                    appState.activityLog
                        .slice(0, 8)
                        .map(
                            e =>
                                `<div class="tracking-event">
                                    <span class="track-ts">
                                        ${e.ts.toLocaleTimeString()}
                                    </span>

                                    <span class="track-msg">
                                        ${e.msg}
                                    </span>
                                </div>`
                        )
                        .join('')
                }

            </div>

        </div>
    `;

    if (block) {
        block.outerHTML = html;
    } else {
        body.insertAdjacentHTML(
            'beforeend',
            html
        );
    }
}

// ==========================================================================
// Dashboard Rendering
// ==========================================================================

// ==========================================================================
// Core Status Helpers (restored after merge corruption)
// ==========================================================================

function evaluateStatus(worker) {

    const s =
        appState.settings;

    const d =
        worker.sensorData;

    let status = 'SAFE';
    let risk = 20;

    if (
        d.temperature_c >= s.tempCrit ||
        d.gas_raw >= s.gasCrit ||
        d.water_level_cm >= s.waterCrit ||
        d.sos
    ) {

        status = 'CRITICAL';
        risk = 90;

    } else if (
        d.temperature_c >= s.tempWarn ||
        d.gas_raw >= s.gasWarn ||
        d.water_level_cm >= s.waterWarn
    ) {

        status = 'WARNING';
        risk = 60;
    }

    return {
        status,
        risk
    };
}

function getBadgeClass(status) {

    return status === 'SAFE'
        ? 'badge-safe'
        : status === 'WARNING'
        ? 'badge-warning'
        : 'badge-critical';
}

function getStatusColor(status) {

    return status === 'SAFE'
        ? 'text-safe'
        : status === 'WARNING'
        ? 'text-warning'
        : 'text-critical';
}

// ==========================================================================
// Activity Log
// ==========================================================================

function addLogEntry(
    tag,
    tagClass,
    msg
) {

    const ts =
        new Date();

    appState.activityLog.unshift({

        ts,
        tag,
        tagClass,
        msg
    });

    if (
        appState.activityLog.length >
        200
    ) {
        appState.activityLog.length =
            200;
    }

    appState.logSeq++;

    renderActivityLog();
}

function renderActivityLog() {

    const container =
        document.getElementById(
            'activity-log-container'
        );

    if (!container) return;

    container.innerHTML = '';

    appState.activityLog.forEach(
        e => {

            const ts =
                e.ts.toLocaleTimeString();

            const div =
                document.createElement(
                    'div'
                );

            div.className =
                'log-entry';

            div.innerHTML = `
                <span class="log-ts">
                    ${ts}
                </span>

                <span class="log-msg">

                    <span
                        class="log-tag ${e.tagClass}"
                    >
                        ${e.tag}
                    </span>

                    ${e.msg}

                </span>
            `;

            container.appendChild(
                div
            );
        }
    );

    const countEl =
        document.getElementById(
            'activity-log-count'
        );

    if (countEl) {

        countEl.innerText =
            appState.activityLog.length +
            ' entries';
    }
}

function logAlertAsEvent(
    alert
) {

    if (
        !appState.settings.logAlerts
    ) {
        return;
    }

    addLogEntry(
        'ALERT',
        'tag-alert',
        `${alert.type}: ${alert.msg} (Worker ${alert.worker}, Belt ${alert.belt})`
    );
}

// ==========================================================================
// Dashboard Rendering
// ==========================================================================

function renderDashboard() {

    const container =
        document.getElementById(
            'dashboard-workers-container'
        );

    container.innerHTML = '';

    if (
        appState.workers.length === 0
    ) {

        container.innerHTML = `

            <div class="empty-state">

                <i data-lucide="radar"></i>

                <strong>
                    No workers connected yet
                </strong>

                <span>
                    Waiting for live belt data from the backend…
                </span>

            </div>
        `;

        // Keep worker count synchronized even when there are no workers
        const workersMonitoredEmpty =
            document.getElementById('dash-workers-count');

        if (workersMonitoredEmpty) {
            workersMonitoredEmpty.innerHTML =
                `00 <span class="unit">Active</span>`;
        }

        lucide.createIcons();

        return;
    }

    let sumTemp = 0;
    let sumGas = 0;
    let sumWater = 0;

    appState.workers.forEach(
        worker => {

            const {
                status,
                risk
            } =
                evaluateStatus(
                    worker
                );

            const aiRiskScore =
                worker.aiRisk?.score ??
                risk;

            const aiRiskLevel =
                worker.aiRisk?.level ||
                status;

            const aiRiskColor =
                aiRiskLevel ===
                    'CRITICAL' ||
                aiRiskLevel === 'HIGH'
                    ? 'text-critical'
                    : aiRiskLevel ===
                      'MEDIUM'
                    ? 'text-warning'
                    : 'text-safe';

            const d =
                worker.sensorData;

            sumTemp +=
                d.temperature_c;

            sumGas +=
                d.gas_raw;

            sumWater +=
                d.water_level_cm;

            const isMotion =
                (
                    Math.abs(
                        d.acceleration_x_ms2
                    ) +
                    Math.abs(
                        d.acceleration_y_ms2
                    )
                ) > 0.5
                    ? 'Active'
                    : 'Idle';

            const card =
                document.createElement(
                    'div'
                );

            card.className =
                'worker-card';

            card.innerHTML = `

                <div class="worker-card-header">

                    <div class="worker-identity">

                        <strong
                            class="clickable-name"
                            onclick="openModal('${worker.workerId}')"
                        >
                            ${
                                worker.name ||
                                worker.workerId
                            }
                        </strong>

                        <span>
                            Belt: ${d.device_id}
                        </span>

                    </div>

                    <div
                        style="display:flex; gap:6px; align-items:center;"
                    >

                        ${
                            d.sos
                                ? '<span class="badge badge-sos">SOS</span>'
                                : ''
                        }

                        <div
                            class="badge ${getBadgeClass(
                                status
                            )}"
                        >
                            ${status}
                        </div>

                    </div>

                </div>

                <div class="worker-metrics">

                    <div class="metric">

                        <span class="metric-label">
                            Temp / Gas
                        </span>

                        <span class="metric-value">

                            <span
                                class="${
                                    d.temperature_c >=
                                    appState.settings.tempWarn
                                        ? getStatusColor(
                                            status
                                        )
                                        : ''
                                }"
                            >
                                ${
                                    d.temperature_c.toFixed(
                                        1
                                    )
                                }&deg;C
                            </span>

                            /
                            ${Math.round(
                                d.gas_raw
                            )}

                        </span>

                    </div>

                    <div class="metric">

                        <span class="metric-label">
                            Water Level
                        </span>

                        <span class="metric-value">
                            ${
                                d.water_level_cm.toFixed(
                                    1
                                )
                            }
                            cm
                        </span>

                    </div>

                    <div class="metric">

                        <span class="metric-label">
                            Motion / Battery
                        </span>

                        <span class="metric-value">
                            ${isMotion}
                            /
                            ${worker.battery}%
                        </span>

                    </div>

                    <div class="metric">

                        <span class="metric-label">
                            Risk Score
                        </span>

                        <span
                            class="metric-value ${aiRiskColor}"
                        >
                            ${Math.round(
                                aiRiskScore
                            )}
                            / 100
                        </span>

                    </div>

                </div>
            `;

            card.classList.remove(
                'risk-edge-safe',
                'risk-edge-warning',
                'risk-edge-high',
                'risk-edge-critical'
            );

            card.classList.add(
                `risk-edge-${(
                    aiRiskLevel ||
                    'safe'
                ).toLowerCase()}`
            );

            container.appendChild(
                card
            );
        }
    );

    // Update the dashboard "Workers Monitored" card
    const workersMonitored =
        document.getElementById('dash-workers-count');

    if (workersMonitored) {
        workersMonitored.innerHTML =
            `${appState.workers.length
                .toString()
                .padStart(2, '0')}
            <span class="unit">Active</span>`;
    }

    const count =
        appState.workers.length;

    if (count === 0) return;

    document.getElementById(
        'dash-avg-temp'
    ).innerHTML =
        `${(
            sumTemp / count
        ).toFixed(1)} &deg;C`;

    document.getElementById(
        'dash-avg-gas'
    ).innerHTML =
        `${Math.round(
            sumGas / count
        )} <span class="unit">raw</span>`;

    document.getElementById(
        'dash-avg-water'
    ).innerHTML =
        `${(
            sumWater / count
        ).toFixed(1)} cm`;
}

// ==========================================================================
// Workers Page
// ==========================================================================

function renderWorkersPage() {

    const tbody =
        document.getElementById(
            'workers-table-body'
        );

    tbody.innerHTML = '';

    if (
        appState.workers.length === 0
    ) {

        tbody.innerHTML = `

            <tr>

                <td colspan="8">

                    <div class="empty-state">

                        <i data-lucide="radar"></i>

                        <strong>
                            No workers connected yet
                        </strong>

                        <span>
                            Worker telemetry will appear here once belts check in.
                        </span>

                    </div>

                </td>

            </tr>
        `;

        document.getElementById(
            'workers-total-count'
        ).innerText = '00';

        document.getElementById(
            'workers-safe-count'
        ).innerText = '00';

        document.getElementById(
            'workers-obs-count'
        ).innerText = '00';

        document.getElementById(
            'workers-high-count'
        ).innerText = '00';

        lucide.createIcons();

        return;
    }

    let safeCount = 0;
    let obsCount = 0;

    appState.workers.forEach(
        worker => {

            const {
                status,
                risk
            } =
                evaluateStatus(
                    worker
                );

            const aiRiskScore =
                worker.aiRisk?.score ??
                risk;

            const aiRiskLevel =
                worker.aiRisk?.level ||
                status;

            const aiRiskColor =
                riskTierClass(
                    aiRiskLevel
                );

            const d =
                worker.sensorData;

            if (
                status === 'SAFE'
            ) {
                safeCount++;
            } else {
                obsCount++;
            }

            const tr =
                document.createElement(
                    'tr'
                );

            tr.innerHTML = `

                <td>
                    <strong
                        class="clickable-name"
                        onclick="openModal('${worker.workerId}')"
                    >
                        ${
                            worker.name ||
                            worker.workerId
                        }
                    </strong>
                </td>

                <td class="data-font">
                    ${d.device_id}
                </td>

                <td>

                    <span
                        style="display:inline-flex; gap:6px; align-items:center;"
                    >

                        ${
                            d.sos
                                ? '<span class="badge badge-sos">SOS</span>'
                                : ''
                        }

                        <span
                            class="badge ${getBadgeClass(
                                status
                            )}"
                        >
                            ${status}
                        </span>

                    </span>

                </td>

                <td
                    class="data-font ${
                        d.temperature_c >=
                        appState.settings.tempWarn
                            ? getStatusColor(
                                status
                            )
                            : ''
                    }"
                >
                    ${
                        d.temperature_c.toFixed(
                            1
                        )
                    }
                </td>

                <td class="data-font">
                    ${Math.round(
                        d.gas_raw
                    )}
                </td>

                <td class="data-font">
                    ${
                        d.water_level_cm.toFixed(
                            1
                        )
                    }
                </td>

                <td class="data-font">
                    ${worker.battery}%
                </td>

                <td
                    class="data-font ${aiRiskColor}"
                >
                    ${Math.round(
                        aiRiskScore
                    )}
                </td>

            `;

            tbody.appendChild(
                tr
            );
        }
    );

    const totalCount =
        appState.workers.length;

    document.getElementById(
        'workers-total-count'
    ).innerText =
        totalCount < 10
            ? '0' + totalCount
            : totalCount;

    document.getElementById(
        'workers-safe-count'
    ).innerText =
        safeCount < 10
            ? '0' + safeCount
            : safeCount;

    document.getElementById(
        'workers-obs-count'
    ).innerText =
        obsCount < 10
            ? '0' + obsCount
            : obsCount;

    const highCount =
        appState.workers.filter(
            worker => {

                const level =
                    (
                        worker.aiRisk?.level ||
                        evaluateStatus(
                            worker
                        ).status ||
                        ''
                    ).toUpperCase();

                return (
                    level === 'HIGH' ||
                    level === 'CRITICAL'
                );
            }
        ).length;

    document.getElementById(
        'workers-high-count'
    ).innerText =
        highCount < 10
            ? '0' + highCount
            : highCount;
}

// ==========================================================================
// Alerts
// ==========================================================================

function renderAlerts() {

    const dashContainer =
        document.getElementById(
            'dashboard-alerts-container'
        );

    const pageContainer =
        document.getElementById(
            'alerts-page-container'
        );

    dashContainer.innerHTML = '';
    pageContainer.innerHTML = '';

    let activeCount = 0;
    let critCount = 0;
    let warnCount = 0;

    if (
        appState.alerts.length === 0
    ) {

        const emptyHtml = `

            <div class="empty-state">

                <i data-lucide="bell-off"></i>

                <strong>
                    No alerts
                </strong>

                <span>
                    All clear. Alerts from connected belts will appear here.
                </span>

            </div>
        `;

        dashContainer.innerHTML =
            emptyHtml;

        pageContainer.innerHTML =
            emptyHtml;
    }

    const activeSOSCount =
        appState.alerts.filter(
            a =>
                !a.ack &&
                a.isSOS
        ).length;

    const anySOSActive =
        activeSOSCount > 0 ||
        appState.workers.some(
            w =>
                w.sensorData?.sos === true
        );

    appState.alerts.forEach(
        alert => {

            if (!alert.ack) {

                activeCount++;

                if (
                    alert.type ===
                    'CRITICAL'
                ) {
                    critCount++;
                }

                if (
                    alert.type ===
                        'WARNING' ||
                    alert.type ===
                        'HIGH'
                ) {
                    warnCount++;
                }
            }

            const iconMap = {
                CRITICAL:
                    'alert-triangle',

                WARNING:
                    'alert-circle',

                INFO:
                    'info'
            };

            const lowerType =
                (alert.type || 'INFO').toLowerCase();

            const aiHtml =
                alert.aiAction
                    ? `
                        <div class="ai-suggestion">

                            <i data-lucide="bot"></i>

                            <div>
                                <strong>
                                    AI Suggestion:
                                </strong>

                                ${alert.aiAction}
                            </div>

                        </div>
                    `
                    : '';

            const typeChipHtml =
                alert.alertType
                    ? `
                        <span
                            class="alert-type-chip ${typeChipClass(
                                alert.alertType
                            )}"
                        >
                            ${alert.alertType}
                        </span>
                    `
                    : '';

            if (
                dashContainer.children.length <
                3
            ) {

                dashContainer.innerHTML += `

                    <div
                        class="alert-item ${lowerType}${
                            alert.isSOS
                                ? ' sos'
                                : ''
                        }"
                        style="${
                            alert.ack
                                ? 'opacity: 0.5'
                                : ''
                        }"
                    >

                        <div class="alert-icon">
                            <i
                                data-lucide="${
                                    iconMap[
                                        alert.type
                                    ] ||
                                    'bell'
                                }"
                            ></i>
                        </div>

                        <div class="alert-content">

                            <div class="alert-title">

                                ${alert.type}:
                                ${alert.msg}

                                ${typeChipHtml}

                            </div>

                            <div class="alert-meta">

                                ${alert.worker}
                                ·
                                ${alert.belt}
                                ·
                                ${alert.time}

                            </div>

                            ${aiHtml}

                        </div>

                    </div>
                `;
            }

            pageContainer.innerHTML += `

                <div
                    class="alert-item ${lowerType}${
                        alert.isSOS
                            ? ' sos'
                            : ''
                    }"
                    style="${
                        alert.ack
                            ? 'opacity: 0.5'
                            : ''
                    }"
                >

                    <div class="alert-icon">

                        <i
                            data-lucide="${
                                iconMap[
                                    alert.type
                                ] ||
                                'bell'
                            }"
                        ></i>

                    </div>

                    <div class="alert-content">

                        <div class="alert-title">

                            ${alert.type}:
                            ${alert.msg}

                            ${typeChipHtml}

                        </div>

                        <div class="alert-meta">

                            ${alert.worker}
                            ·
                            ${alert.belt}
                            ·
                            Sensor triggered
                            ·
                            ${alert.time}

                        </div>

                        ${aiHtml}

                    </div>

                    ${
                        !alert.ack
                            ? `
                                <button
                                    class="btn btn-small"
                                    style="margin-left: 12px; height: fit-content;"
                                    onclick="ackAlert('${alert.id}')"
                                >
                                    Acknowledge
                                </button>
                            `
                            : `
                                <span
                                    class="badge badge-safe"
                                    style="margin-left: 12px;"
                                >
                                    Acknowledged
                                </span>
                            `
                    }

                </div>
            `;
        }
    );

    const strip =
        document.getElementById(
            'alerts-emergency-strip'
        );

    if (strip) {

        if (anySOSActive) {

            strip.style.display =
                'flex';

            strip.querySelector(
                '.strip-text'
            ).innerText =
                `${
                    activeSOSCount > 0
                        ? activeSOSCount
                        : appState.workers.filter(
                            w =>
                                w.sensorData?.sos ===
                                true
                          ).length
                } SOS alert(s) active — Emergency Mode engaged`;

        } else {

            strip.style.display =
                'none';
        }
    }

    const sidebarBadge =
        document.getElementById(
            'sidebar-alert-badge'
        );

    if (
        activeCount > 0
    ) {

        sidebarBadge.style.display =
            'inline-block';

        sidebarBadge.innerText =
            activeCount;

    } else {

        sidebarBadge.style.display =
            'none';
    }

    document.getElementById(
        'alert-total-count'
    ).innerText =
        activeCount;

    document.getElementById(
        'alert-crit-count'
    ).innerText =
        critCount;

    document.getElementById(
        'alert-warn-count'
    ).innerText =
        warnCount;

    lucide.createIcons();
}

window.ackAlert = async function(id) {
    const alert = appState.alerts.find(a => a.id === id);
    if (alert && !alert.ack) {
        logAlertAsEvent(alert);
        // Resolve via backend (real alerts) or locally (synthetic SOS alerts)
        await resolveAlertOnBackend(alert);
    }
    renderAlerts();
};

window.acknowledgeAllAlerts = async function() {
    const unresolved = appState.alerts.filter(a => !a.ack);
    unresolved.forEach(a => logAlertAsEvent(a));
    // Resolve each real backend alert via the API; synthetic ones locally
    await Promise.all(unresolved.map(a => resolveAlertOnBackend(a)));
    renderAlerts();
};

// ==========================================================================
// Settings
// ==========================================================================

window.saveSettings =
    function () {

        appState.settings.tempWarn =
            parseFloat(
                document.getElementById(
                    'set-temp-warn'
                ).value
            );

        appState.settings.tempCrit =
            parseFloat(
                document.getElementById(
                    'set-temp-crit'
                ).value
            );

        appState.settings.gasWarn =
            parseFloat(
                document.getElementById(
                    'set-gas-warn'
                ).value
            );

        appState.settings.gasCrit =
            parseFloat(
                document.getElementById(
                    'set-gas-crit'
                ).value
            );

        appState.settings.waterWarn =
            parseFloat(
                document.getElementById(
                    'set-water-warn'
                ).value
            );

        appState.settings.waterCrit =
            parseFloat(
                document.getElementById(
                    'set-water-crit'
                ).value
            );

        appState.settings.refreshInterval =
            parseFloat(
                document.getElementById(
                    'set-interval'
                ).value
            );

        appState.settings.logAlerts =
            document.getElementById(
                'log-alerts'
            ).checked;

        const toast =
            document.getElementById(
                'settings-toast'
            );

        toast.classList.remove(
            'hidden'
        );

        setTimeout(
            () =>
                toast.classList.add(
                    'hidden'
                ),
            3000
        );

        renderDashboard();
        renderWorkersPage();
        renderActivityLog();
    };

window.resetSettings =
    function () {

        document.getElementById(
            'set-temp-warn'
        ).value = 36;

        document.getElementById(
            'set-temp-crit'
        ).value = 40;

        document.getElementById(
            'set-gas-warn'
        ).value = 550;

        document.getElementById(
            'set-gas-crit'
        ).value = 750;

        document.getElementById(
            'set-water-warn'
        ).value = 25;

        document.getElementById(
            'set-water-crit'
        ).value = 45;

        document.getElementById(
            'set-interval'
        ).value = 3;

        saveSettings();
    };

// ==========================================================================
// Live Clock
// ==========================================================================

function startClock() {

    const el =
        document.getElementById(
            'live-clock'
        );

    if (!el) return;

    function tick() {

        el.innerText =
            new Date().toLocaleTimeString();
    }

    tick();

    setInterval(
        tick,
        1000
    );
}

// ==========================================================================
// Chart.js
// ==========================================================================

function initCharts() {

    Object.values(
        appState.charts
    ).forEach(
        chart => {

            if (chart) {
                chart.destroy();
            }

        }
    );

    Chart.defaults.color =
        '#94a3b8';

    Chart.defaults.borderColor =
        '#2a303c';

    Chart.defaults.font.family =
        "'Inter', sans-serif";

    const commonOptions = {

        responsive: true,

        maintainAspectRatio: false,

        plugins: {
            legend: {
                display: false
            }
        },

        scales: {

            x: {
                grid: {
                    display: false
                }
            },

            y: {
                beginAtZero: false
            }
        },

        elements: {

            line: {
                tension: 0.4,
                borderWidth: 2
            },

            point: {
                radius: 0
            }
        }
    };

    const createChart =
        (
            id,
            color,
            initialData,
            chartLabels
        ) => {

            const ctx =
                document
                    .getElementById(id)
                    .getContext('2d');

            return new Chart(
                ctx,
                {

                    type: 'line',

                    data: {

                        labels:
                            chartLabels,

                        datasets: [

                            {

                                data:
                                    initialData,

                                borderColor:
                                    color,

                                backgroundColor:
                                    `${color}33`,

                                fill:
                                    true
                            }
                        ]
                    },

                    options:
                        commonOptions
                }
            );
        };

    const allReadings =
        appState.workers
            .flatMap(
                worker =>
                    worker.sensorHistory ||
                    []
            )
            .filter(
                reading =>
                    reading.recorded_at
            )
            .sort(
                (a, b) =>
                    new Date(
                        a.recorded_at
                    ) -
                    new Date(
                        b.recorded_at
                    )
            );

    const tenMinutesAgo =
        Date.now() -
        (
            10 *
            60 *
            1000
        );

    let readings =
        allReadings.filter(
            reading =>
                new Date(
                    reading.recorded_at
                ).getTime() >=
                tenMinutesAgo
        );

    if (
        readings.length < 2
    ) {

        readings =
            allReadings.slice(-6);
    }

    const labels =
        readings.map(
            reading => {

                const date =
                    new Date(
                        reading.recorded_at
                    );

                return date.toLocaleTimeString(
                    [],
                    {
                        hour: '2-digit',
                        minute: '2-digit'
                    }
                );
            }
        );

    const riskReadings =
        appState.riskHistory
            .filter(
                risk =>
                    risk.created_at
            )
            .sort(
                (a, b) =>
                    new Date(
                        a.created_at
                    ) -
                    new Date(
                        b.created_at
                    )
            )
            .slice(-6);

    const riskLabels =
        riskReadings.map(
            risk => {

                const date =
                    new Date(
                        risk.created_at
                    );

                return date.toLocaleTimeString(
                    [],
                    {
                        hour: '2-digit',
                        minute: '2-digit'
                    }
                );
            }
        );

    appState.charts.risk =
        createChart(
            'chart-risk',
            '#f97316',
            riskReadings.map(
                r =>
                    r.risk_score ??
                    0
            ),
            riskLabels
        );

    appState.charts.temp =
        createChart(
            'chart-temp',
            '#f59e0b',
            readings.map(
                r =>
                    r.temperature_c ??
                    0
            ),
            labels
        );

    appState.charts.gas =
        createChart(
            'chart-gas',
            '#ef4444',
            readings.map(
                r =>
                    r.gas_raw ??
                    0
            ),
            labels
        );

    appState.charts.water =
        createChart(
            'chart-water',
            '#3b82f6',
            readings.map(
                r =>
                    r.water_level_cm ??
                    0
            ),
            labels
        );
}

// ==========================================================================
// ==========================================================================
// Chart Refresh (in place, no re-create)
// ==========================================================================

function refreshCharts() {

    // Nothing to do until the analytics charts have been initialised.
    if (
        !appState.charts.temp &&
        !appState.charts.gas &&
        !appState.charts.water &&
        !appState.charts.risk
    ) {
        return;
    }

    const allReadings =
        appState.workers
            .flatMap(
                worker =>
                    worker.sensorHistory ||
                    []
            )
            .filter(
                reading =>
                    reading.recorded_at
            )
            .sort(
                (a, b) =>
                    new Date(
                        a.recorded_at
                    ) -
                    new Date(
                        b.recorded_at
                    )
            );

    const tenMinutesAgo =
        Date.now() -
        (
            10 *
            60 *
            1000
        );

    let readings =
        allReadings.filter(
            reading =>
                new Date(
                    reading.recorded_at
                ).getTime() >=
                tenMinutesAgo
        );

    if (
        readings.length < 2
    ) {

        readings =
            allReadings.slice(-6);
    }

    const labels =
        readings.map(
            reading =>
                new Date(
                    reading.recorded_at
                ).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                })
        );

    const riskReadings =
        appState.riskHistory
            .filter(
                risk =>
                    risk.created_at
            )
            .sort(
                (a, b) =>
                    new Date(
                        a.created_at
                    ) -
                    new Date(
                        b.created_at
                    )
            )
            .slice(-6);

    const riskLabels =
        riskReadings.map(
            risk =>
                new Date(
                    risk.created_at
                ).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit'
                })
        );

    const updateChart =
        (
            chart,
            chartLabels,
            data
        ) => {

            if (!chart) return;

            chart.data.labels =
                chartLabels;

            chart.data.datasets[0].data =
                data;

            chart.update();
        };

    updateChart(
        appState.charts.risk,
        riskLabels,
        riskReadings.map(
            r =>
                r.risk_score ??
                0
        )
    );

    updateChart(
        appState.charts.temp,
        labels,
        readings.map(
            r =>
                r.temperature_c ??
                0
        )
    );

    updateChart(
        appState.charts.gas,
        labels,
        readings.map(
            r =>
                r.gas_raw ??
                0
        )
    );

    updateChart(
        appState.charts.water,
        labels,
        readings.map(
            r =>
                r.water_level_cm ??
                0
        )
    );
}

// ==========================================================================
// DOM Ready
// ==========================================================================

document.addEventListener(
    'DOMContentLoaded',
    async () => {

        testBackendConnection();

        await loadWorkersFromBackend();

        renderAlerts();

        renderActivityLog();

        resetAIPanel();

        emergencyRefresh();

        startClock();

        document
            .getElementById(
                'log-alerts'
            )
            ?.addEventListener(
                'change',
                () => {

                    appState.settings.logAlerts =
                        document.getElementById(
                            'log-alerts'
                        ).checked;
                }
            );

        const loginForm =
            document.getElementById(
                'login-form'
            );

        if (loginForm) {

            loginForm.addEventListener(
                'submit',
                window.handleLoginSubmit
            );
        }

        updateOperatorDisplay();
    }
);


   function updateOperatorDisplay() {
       const el = document.getElementById('operator-display');
       if (!el) return;
       if (appState.auth.authenticated && appState.auth.username) {
           el.innerText = appState.auth.username;
       } else {
           el.innerText = 'Operator';
       }
   }

