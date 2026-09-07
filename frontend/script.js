/* ==========================================================================
   AVIGHNAA - Frontend Application Logic
   ========================================================================== */

   // --- Authentication Bootstrap ---
// Prevent the dashboard from flashing before the login state is ready.
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

async function testBackendConnection() {
    try {
        const response = await fetch("http://localhost:5002/");

        if (response.ok) {
            console.log("✅ Backend connected successfully");
            return true;
        }

        console.log("⚠️ Backend responded, but with an error");
        return false;
    } catch (error) {
        console.log("❌ Backend not reachable");
        return false;
    }
}
async function loadWorkersFromBackend() {
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();

        if (!session) {
            console.log("❌ No Supabase session found");
            return;
        }

        const headers = {
            Authorization: `Bearer ${session.access_token}`
        };

        const workersResponse = await fetch(`${API_BASE_URL}/workers`, {
            headers
        });

        const workersResult = await workersResponse.json();

        if (!workersResult.success) {
            console.log("❌ Could not load workers:", workersResult.message);
            return;
        }

        const workers = workersResult.data;

        const devicesResponse = await fetch(`${API_BASE_URL}/devices`, {
            headers
        });

        const devicesResult = await devicesResponse.json();

        if (!devicesResult.success) {
            console.log("❌ Could not load devices:", devicesResult.message);
            return;
        }

        const devices = devicesResult.data;

        for (const worker of workers) {
            const device = devices.find(
                d => d.worker_id === worker.worker_id
            );

            if (!device) continue;

            const sensorResponse = await fetch(
                `${API_BASE_URL}/sensor-data/${device.device_id}`,
                { headers }
            );

            const sensorResult = await sensorResponse.json();

            const latestSensor =
                sensorResult.success && sensorResult.data.length
                    ? sensorResult.data[sensorResult.data.length - 1]
                    : null;

            if (!latestSensor) continue;

            worker.workerId = worker.worker_id;
            worker.battery = device.battery ?? 100;
            worker.location = worker.mine_location || "Unknown";
            worker.sensorData = latestSensor;
        }

        appState.workers = workers.filter(worker => worker.sensorData);

        renderDashboard();
        renderWorkersPage();

        addLogEntry(
            'STATUS',
            'tag-status',
            `Loaded ${appState.workers.length} worker(s) from backend`
        );

    } catch (error) {
        console.error("❌ Worker data loading failed:", error);
    }
}

   const appState = {
       settings: {
           tempWarn: 36, tempCrit: 40,
           gasWarn: 550, gasCrit: 750,
           waterWarn: 25, waterCrit: 45,
           refreshInterval: 3,
           logAlerts: true
       },
       activityLog: [],
       logSeq: 0,
       auth: { username: '', authenticated: false },
       
       // DEMO DATA - Includes full accelerometer + sos values
       workers: [
           {
               workerId: "Worker 01", simulated: false, 
               sensorData: {
                   "device_id": "RF-001", "temperature_c": 32.5, "gas_raw": 420, "water_level_cm": 15.0,
                   "acceleration_x_ms2": 0.20, "acceleration_y_ms2": 0.10, "acceleration_z_ms2": 9.70,
                   "sos": false, "timestamp": new Date().toISOString()
               },
               battery: 92, location: "Zone A - Main Shaft"
           },
           {
               workerId: "Worker 02", simulated: true, 
               sensorData: {
                   "device_id": "RF-002", "temperature_c": 36.5, "gas_raw": 510, "water_level_cm": 22.0,
                   "acceleration_x_ms2": 0.50, "acceleration_y_ms2": 0.10, "acceleration_z_ms2": 9.80,
                   "sos": false, "timestamp": new Date().toISOString()
               },
               battery: 78, location: "Zone B - West Tunnel"
           },
           {
               workerId: "Worker 03", simulated: true, 
               sensorData: {
                   "device_id": "RF-003", "temperature_c": 41.2, "gas_raw": 680, "water_level_cm": 10.0,
                   "acceleration_x_ms2": 0.0, "acceleration_y_ms2": 0.0, "acceleration_z_ms2": 9.81,
                   "sos": false, "timestamp": new Date().toISOString()
               },
               battery: 45, location: "Zone C - Deep Excavation"
           }
       ],
       // Alerts now feature an explicit "aiAction" string for the requested suggestions
       alerts: [
           { id: 3, type: "CRITICAL", msg: "Gas level approaching unsafe limit", aiAction: "Initiate immediate evacuation of Zone C. Dispatch emergency ventilation protocols.", worker: "Worker 03", belt: "RF-003", time: "6 min ago", ack: false },
           { id: 2, type: "WARNING", msg: "Temperature approaching threshold", aiAction: "Monitor worker vitals closely. Recommend 15-minute cooling break in secure area.", worker: "Worker 02", belt: "RF-002", time: "12 min ago", ack: false },
           { id: 1, type: "INFO", msg: "Worker RF-001 entered monitoring Zone A", aiAction: "Standard entry logged. No further action required.", worker: "Worker 01", belt: "RF-001", time: "15 min ago", ack: true }
       ],
       charts: {} 
   };
   
   // Seed initial log entries (boot + demo worker connections)
   (function seedLog() {
       const now = new Date();
       appState.activityLog.push({ ts: new Date(now.getTime() - 120000), tag: 'SYSTEM', tagClass: 'tag-info', msg: 'Control room session started' });
       appState.activityLog.push({ ts: new Date(now.getTime() - 90000), tag: 'STATUS', tagClass: 'tag-status', msg: 'Backend API connected (Simulated)' });
       appState.activityLog.push({ ts: new Date(now.getTime() - 60000), tag: 'STATUS', tagClass: 'tag-status', msg: 'Database (Supabase) connected (Simulated)' });
       appState.workers.forEach(w => {
           appState.activityLog.push({ ts: new Date(now.getTime() - 15000), tag: 'PING', tagClass: 'tag-ping', msg: `Belt ${w.sensorData.device_id} online \u2013 ${w.workerId} at ${w.location}` });
       });
       renderActivityLog();
   })();

   
   // --- Auth ---
   function setAuthenticated(user) {
       appState.auth.username = user;
       appState.auth.authenticated = true;

       document.body.classList.remove('logged-out');
       document.body.classList.add('logged-in');
       document.body.classList.remove('auth-loading');

       const overlay = document.getElementById('login-overlay');
       if (overlay) overlay.classList.add('hidden');
       addLogEntry('STATUS', 'tag-status', `User "${user}" signed in to the control room`);
   }

   function signOut() {
       appState.auth.authenticated = false;
       appState.auth.username = '';

       document.body.classList.remove('logged-in');
       document.body.classList.add('logged-out');
       document.body.classList.remove('auth-loading');

       const overlay = document.getElementById('login-overlay');
       if (overlay) overlay.classList.remove('hidden');
       addLogEntry('STATUS', 'tag-status', 'Control room session ended');
       updateOperatorDisplay();
   }

   window.handleLoginSubmit = function(e) {
       e.preventDefault();
       const userEl = document.getElementById('login-user');
       const passEl = document.getElementById('login-pass');
       const errEl = document.getElementById('login-error');
       const user = (userEl.value || '').trim();
       const pass = (passEl.value || '').trim();

       // Demo credentials: operator / admin
       if (user === 'operator' && pass === 'admin') {
           setAuthenticated(user);
           userEl.value = '';
           passEl.value = '';
           if (errEl) errEl.classList.add('hidden');
       } else {
           if (errEl) {
               errEl.classList.remove('hidden');
               setTimeout(() => errEl.classList.add('hidden'), 4000);
           }
       }
       updateOperatorDisplay();
   };

   window.signOut = signOut;

   // --- Single Page App Navigation ---
   document.querySelectorAll('.nav-item').forEach(link => {
       link.addEventListener('click', (e) => {
           e.preventDefault();
           
           document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
           e.currentTarget.classList.add('active');
   
           const targetPage = e.currentTarget.getAttribute('data-target');
           document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
           document.getElementById(`page-${targetPage}`).classList.add('active');
   
           const titleMap = {
               'dashboard': 'Dashboard',
               'workers': 'Worker Safety Management',
               'alerts': 'System Alerts & AI Intelligence',
               'analytics': 'Sensor Analytics',
               'settings': 'System Settings'
           };
           document.getElementById('page-title').innerText = titleMap[targetPage];
   
           // Guard: require authentication to view any dashboard page
           if (!appState.auth.authenticated) {
               document.getElementById('login-overlay').classList.remove('hidden');
               document.getElementById('page-title').innerText = 'Control Room Access';
               return;
           }
   
           // Force Chart.js to recalculate dimensions since their container just went from display:none to block
           if(targetPage === 'analytics') {
               Object.values(appState.charts).forEach(chart => {
                   chart.resize();
                   chart.update();
               });
           }
       });
   });
   
   // --- Modal Functionality ---
   window.openModal = function(workerId) {
       if (!appState.auth.authenticated) {
           document.getElementById('login-overlay').classList.remove('hidden');
           return;
       }
       const worker = appState.workers.find(w => w.workerId === workerId);
       if(!worker) return;
       
       const { status, risk } = evaluateStatus(worker);
       const d = worker.sensorData;
       
       document.getElementById('modal-worker-name').innerText = worker.workerId + ' &middot; Detailed Telemetry';
       
       const body = document.getElementById('modal-worker-body');
       body.innerHTML = `
           <div class="detail-grid">
               <div class="detail-item">
                   <div class="detail-label">Status & Risk</div>
                   <div class="detail-value ${getStatusColor(status)}">${status} (Risk: ${risk}/100)</div>
               </div>
               <div class="detail-item">
                   <div class="detail-label">Belt ID / Location</div>
                   <div class="detail-value">${d.device_id} &middot; ${worker.location}</div>
               </div>
               <div class="detail-item">
                   <div class="detail-label">Temperature</div>
                   <div class="detail-value ${d.temperature_c >= appState.settings.tempWarn ? getStatusColor(status) : ''}">${d.temperature_c.toFixed(2)} &deg;C</div>
               </div>
               <div class="detail-item">
                   <div class="detail-label">Gas Level</div>
                   <div class="detail-value ${d.gas_raw >= appState.settings.gasWarn ? getStatusColor(status) : ''}">${Math.round(d.gas_raw)} raw</div>
               </div>
               <div class="detail-item">
                   <div class="detail-label">Water Level</div>
                   <div class="detail-value ${d.water_level_cm >= appState.settings.waterWarn ? getStatusColor(status) : ''}">${d.water_level_cm.toFixed(2)} cm</div>
               </div>
               <div class="detail-item">
                   <div class="detail-label">Battery / SOS</div>
                   <div class="detail-value">${worker.battery}% / ${d.sos ? '<span class="text-critical">ACTIVE</span>' : '<span class="text-safe">Normal</span>'}</div>
               </div>
               <div class="detail-item" style="grid-column: 1 / -1;">
                   <div class="detail-label">3-Axis Acceleration (X, Y, Z)</div>
                   <div class="detail-value">${d.acceleration_x_ms2.toFixed(3)}, ${d.acceleration_y_ms2.toFixed(3)}, ${d.acceleration_z_ms2.toFixed(3)} m/s&sup2;</div>
               </div>
               <div class="detail-item" style="grid-column: 1 / -1;">
                   <div class="detail-label">Last Ping Time</div>
                   <div class="detail-value" style="font-size:13px; color: var(--text-muted);">${new Date(d.timestamp).toLocaleString()}</div>
               </div>
           </div>
       `;
       
       document.getElementById('worker-modal').classList.remove('hidden');
   };
   
   window.closeModal = function() {
       document.getElementById('worker-modal').classList.add('hidden');
   };
   
   window.renderModalLiveTracking = renderModalLiveTracking;
   
   // Close modal when clicking on the dark overlay background
   document.getElementById('worker-modal').addEventListener('click', function(e) {
       if (e.target === this) closeModal();
   });
   
   
   // --- Core Evaluator ---
   function evaluateStatus(worker) {
       const s = appState.settings;
       const d = worker.sensorData;
       let status = 'SAFE';
       let risk = 20;
   
       if (d.temperature_c >= s.tempCrit || d.gas_raw >= s.gasCrit || d.water_level_cm >= s.waterCrit || d.sos) {
           status = 'CRITICAL'; risk = 90;
       } else if (d.temperature_c >= s.tempWarn || d.gas_raw >= s.gasWarn || d.water_level_cm >= s.waterWarn) {
           status = 'WARNING'; risk = 60;
       }
   
       return { status, risk };
   }
   
   function getBadgeClass(status) { return status === 'SAFE' ? 'badge-safe' : (status === 'WARNING' ? 'badge-warning' : 'badge-critical'); }
   function getStatusColor(status) { return status === 'SAFE' ? 'text-safe' : (status === 'WARNING' ? 'text-warning' : 'text-critical'); }
   
   // --- Activity Log ---
   function addLogEntry(tag, tagClass, msg) {
       const ts = new Date();
       appState.activityLog.unshift({ ts, tag, tagClass, msg });
       if (appState.activityLog.length > 200) appState.activityLog.length = 200;
       appState.logSeq++;
       renderActivityLog();
   }
   
   function renderActivityLog() {
       const container = document.getElementById('activity-log-container');
       if (!container) return;
       container.innerHTML = '';
       appState.activityLog.forEach(e => {
           const ts = e.ts.toLocaleTimeString();
           const div = document.createElement('div');
           div.className = 'log-entry';
           div.innerHTML = `<span class="log-ts">${ts}</span>
               <span class="log-msg"><span class="log-tag ${e.tagClass}">${e.tag}</span>${e.msg}</span>`;
           container.appendChild(div);
       });
       const countEl = document.getElementById('activity-log-count');
       if (countEl) countEl.innerText = appState.activityLog.length + ' entries';
   }
   
   function logAlertAsEvent(alert) {
       if (!appState.settings.logAlerts) return;
       const tag = alert.type === 'CRITICAL' ? 'CRITICAL' : (alert.type === 'WARNING' ? 'WARNING' : 'INFO');
       addLogEntry('ALERT', 'tag-alert', `${alert.type}: ${alert.msg} (Worker ${alert.worker}, Belt ${alert.belt})`);
   }
   
   function logStatusChange(workerId, fromStatus, toStatus, detail) {
       if (toStatus !== fromStatus) {
           addLogEntry('STATUS', 'tag-status', `${workerId} status changed: ${fromStatus} \u2192 ${toStatus}${detail ? ' (' + detail + ')' : ''}`);
       }
   }
   
   window.pingBelt = function() {
       const btn = document.getElementById('btn-belt-ping');
       if (!btn || btn.disabled) return;
       btn.disabled = true;
       btn.innerHTML = '<i data-lucide="loader-2" class="spin"></i> Pinging...';
       lucide.createIcons();
       const workerId = document.getElementById('modal-worker-name').innerText.split(' ')[0] + ' ' + document.getElementById('modal-worker-name').innerText.split(' ')[1];
       const worker = appState.workers.find(w => w.workerId === workerId);
       if (!worker) {
           btn.disabled = false;
           btn.innerHTML = '<i data-lucide="send"></i> Ping Belt';
           lucide.createIcons();
           return;
       }
       const d = worker.sensorData;
       d.timestamp = new Date().toISOString();
       addLogEntry('PING', 'tag-ping', `Belt ${d.device_id} pinged \u2013 RSSI OK, last data ${d.temperature_c.toFixed(1)}\u00b0C, ${Math.round(d.gas_raw)} gas, ${d.water_level_cm.toFixed(1)}cm water`);
       setTimeout(() => {
           btn.disabled = false;
           btn.innerHTML = '<i data-lucide="send"></i> Ping Belt';
           lucide.createIcons();
       }, 900);
       renderModalLiveTracking();
   };
   
   function renderModalLiveTracking() {
       const workerId = document.getElementById('modal-worker-name').innerText.split(' ')[0] + ' ' + document.getElementById('modal-worker-name').innerText.split(' ')[1];
       const worker = appState.workers.find(w => w.workerId === workerId);
       if (!worker) return;
       const d = worker.sensorData;
       const body = document.getElementById('modal-worker-body');
       if (!body) return;
       // Append live-tracking block if present
       let block = body.querySelector('.live-tracking');
       const html = `
           <div class="live-tracking">
               <div class="live-tracking-head">
                   <strong>Live Tracking</strong>
                   <span class="badge badge-info">Real-time</span>
               </div>
               <div class="detail-grid">
                   <div class="detail-item">
                       <div class="detail-label">Last Data Ping</div>
                       <div class="detail-value" style="font-size:13px; color: var(--text-main);">${new Date(d.timestamp).toLocaleString()}</div>
                   </div>
                   <div class="detail-item">
                       <div class="detail-label">Belt / Location</div>
                       <div class="detail-value" style="font-size:13px;">${d.device_id} \u00b7 ${worker.location}</div>
                   </div>
                   <div class="detail-item" style="grid-column: 1 / -1;">
                       <div class="detail-label">Last Event</div>
                       <div class="detail-value" style="font-size:13px; color: var(--text-main);">
                           ${appState.activityLog.length ? 'Logged ' + appState.activityLog[0].ts.toLocaleTimeString() + ' \u2013 ' + appState.activityLog[0].msg : 'No events yet'}
                       </div>
                   </div>
               </div>
               <div class="tracking-history">
                   <div class="tracking-history-head">Recent Activity (last 8)</div>
                   ${appState.activityLog.slice(0, 8).map(e => `<div class="tracking-event">
                       <span class="track-ts">${e.ts.toLocaleTimeString()}</span>
                       <span class="track-msg">${e.msg}</span>
                   </div>`).join('')}
               </div>
           </div>`;
       if (block) block.outerHTML = html; else body.insertAdjacentHTML('beforeend', html);
   }
   
   // --- Render Logic ---
   function renderDashboard() {
       const container = document.getElementById('dashboard-workers-container');
       container.innerHTML = '';
       
       let sumTemp = 0, sumGas = 0, sumWater = 0;
   
       appState.workers.forEach(worker => {
           const { status, risk } = evaluateStatus(worker);
           const d = worker.sensorData;
           
           sumTemp += d.temperature_c; sumGas += d.gas_raw; sumWater += d.water_level_cm;
           const isMotion = (Math.abs(d.acceleration_x_ms2) + Math.abs(d.acceleration_y_ms2)) > 0.5 ? 'Active' : 'Idle';
   
           const card = document.createElement('div');
           card.className = 'worker-card';
           card.innerHTML = `
               <div class="worker-card-header">
                   <div class="worker-identity">
                       <!-- Added onclick event here to open modal -->
                       <strong class="clickable-name" onclick="openModal('${worker.workerId}')">${worker.workerId}</strong>
                       <span>Belt: ${d.device_id}</span>
                   </div>
                   <div class="badge ${getBadgeClass(status)}">${status}</div>
               </div>
               <div class="worker-metrics">
                   <div class="metric">
                       <span class="metric-label">Temp / Gas</span>
                       <span class="metric-value"><span class="${d.temperature_c >= appState.settings.tempWarn ? getStatusColor(status) : ''}">${d.temperature_c.toFixed(1)}&deg;C</span> / ${Math.round(d.gas_raw)}</span>
                   </div>
                   <div class="metric">
                       <span class="metric-label">Water Level</span>
                       <span class="metric-value">${d.water_level_cm.toFixed(1)} cm</span>
                   </div>
                   <div class="metric">
                       <span class="metric-label">Motion / Battery</span>
                       <span class="metric-value">${isMotion} / ${worker.battery}%</span>
                   </div>
                   <div class="metric">
                       <span class="metric-label">Risk Score</span>
                       <span class="metric-value ${getStatusColor(status)}">${risk} / 100</span>
                   </div>
               </div>
           `;
           container.appendChild(card);
       });
   
       const count = appState.workers.length;
       document.getElementById('dash-avg-temp').innerHTML = `${(sumTemp/count).toFixed(1)} &deg;C`;
       document.getElementById('dash-avg-gas').innerHTML = `${Math.round(sumGas/count)} <span class="unit">raw</span>`;
       document.getElementById('dash-avg-water').innerHTML = `${(sumWater/count).toFixed(1)} cm`;
   }
   
   function renderWorkersPage() {
       const tbody = document.getElementById('workers-table-body');
       tbody.innerHTML = '';
       
       let safeCount = 0, obsCount = 0;
   
       appState.workers.forEach(worker => {
           const { status, risk } = evaluateStatus(worker);
           const d = worker.sensorData;
           
           if(status === 'SAFE') safeCount++; else obsCount++;
   
           const tr = document.createElement('tr');
           tr.innerHTML = `
               <!-- Make name clickable inside the table too -->
               <td><strong class="clickable-name" onclick="openModal('${worker.workerId}')">${worker.workerId}</strong></td>
               <td class="data-font">${d.device_id}</td>
               <td><span class="badge ${getBadgeClass(status)}">${status}</span></td>
               <td class="data-font ${d.temperature_c >= appState.settings.tempWarn ? getStatusColor(status) : ''}">${d.temperature_c.toFixed(1)}</td>
               <td class="data-font">${Math.round(d.gas_raw)}</td>
               <td class="data-font">${d.water_level_cm.toFixed(1)}</td>
               <td class="data-font">${worker.battery}%</td>
               <td class="data-font ${getStatusColor(status)}">${risk}</td>
           `;
           tbody.appendChild(tr);
       });
   
       document.getElementById('workers-safe-count').innerText = safeCount < 10 ? '0'+safeCount : safeCount;
       document.getElementById('workers-obs-count').innerText = obsCount < 10 ? '0'+obsCount : obsCount;
   }
   
   function renderAlerts() {
       const dashContainer = document.getElementById('dashboard-alerts-container');
       const pageContainer = document.getElementById('alerts-page-container');
       
       dashContainer.innerHTML = ''; pageContainer.innerHTML = '';
       let activeCount = 0, critCount = 0, warnCount = 0;
   
       appState.alerts.forEach(alert => {
           if (!alert.ack) {
               activeCount++;
               if (alert.type === 'CRITICAL') critCount++;
               if (alert.type === 'WARNING') warnCount++;
           }
   
           const iconMap = { 'CRITICAL': 'alert-triangle', 'WARNING': 'alert-circle', 'INFO': 'info' };
           const lowerType = alert.type.toLowerCase();
           
           // Build AI suggestion HTML if available
           const aiHtml = alert.aiAction ? `
               <div class="ai-suggestion">
                   <i data-lucide="bot"></i>
                   <div><strong>AI Suggestion:</strong> ${alert.aiAction}</div>
               </div>` : '';
   
           // Dashboard HTML
           if (dashContainer.children.length < 3) {
               dashContainer.innerHTML += `
                   <div class="alert-item ${lowerType}" style="${alert.ack ? 'opacity: 0.5' : ''}">
                       <div class="alert-icon"><i data-lucide="${iconMap[alert.type]}"></i></div>
                       <div class="alert-content">
                           <div class="alert-title">${alert.type}: ${alert.msg}</div>
                           <div class="alert-meta">${alert.worker} &middot; ${alert.belt} &middot; ${alert.time}</div>
                           ${aiHtml}
                       </div>
                   </div>
               `;
           }
   
           // Full Page HTML
           pageContainer.innerHTML += `
               <div class="alert-item ${lowerType}" style="${alert.ack ? 'opacity: 0.5' : ''}">
                   <div class="alert-icon"><i data-lucide="${iconMap[alert.type]}"></i></div>
                   <div class="alert-content">
                       <div class="alert-title">${alert.type}: ${alert.msg}</div>
                       <div class="alert-meta">${alert.worker} &middot; ${alert.belt} &middot; Sensor triggered &middot; ${alert.time}</div>
                       ${aiHtml}
                   </div>
                   ${!alert.ack ? `<button class="btn btn-small" style="margin-left: 12px; height: fit-content;" onclick="ackAlert(${alert.id})">Acknowledge</button>` : `<span class="badge badge-safe" style="margin-left: 12px;">Acknowledged</span>`}
               </div>
           `;
       });
   
       const sidebarBadge = document.getElementById('sidebar-alert-badge');
       if(activeCount > 0) {
           sidebarBadge.style.display = 'inline-block'; sidebarBadge.innerText = activeCount;
       } else {
           sidebarBadge.style.display = 'none';
       }
   
       document.getElementById('alert-total-count').innerText = activeCount;
       document.getElementById('alert-crit-count').innerText = critCount;
       document.getElementById('alert-warn-count').innerText = warnCount;
       
       lucide.createIcons();
   }
   
   window.ackAlert = function(id) {
       const alert = appState.alerts.find(a => a.id === id);
       if(alert) {
           const wasAcked = alert.ack;
           alert.ack = true;
           if (!wasAcked) logAlertAsEvent(alert);
       }
       renderAlerts();
   };
   
   window.acknowledgeAllAlerts = function() {
       appState.alerts.forEach(a => {
           if (!a.ack) logAlertAsEvent(a);
           a.ack = true;
       });
       renderAlerts();
   };
   
   window.saveSettings = function() {
       appState.settings.tempWarn = parseFloat(document.getElementById('set-temp-warn').value);
       appState.settings.tempCrit = parseFloat(document.getElementById('set-temp-crit').value);
       appState.settings.gasWarn = parseFloat(document.getElementById('set-gas-warn').value);
       appState.settings.gasCrit = parseFloat(document.getElementById('set-gas-crit').value);
       appState.settings.waterWarn = parseFloat(document.getElementById('set-water-warn').value);
       appState.settings.waterCrit = parseFloat(document.getElementById('set-water-crit').value);
       appState.settings.refreshInterval = parseFloat(document.getElementById('set-interval').value);
       appState.settings.logAlerts = document.getElementById('log-alerts').checked;
       
       const toast = document.getElementById('settings-toast');
       toast.classList.remove('hidden');
       setTimeout(() => toast.classList.add('hidden'), 3000);
       
       renderDashboard(); renderWorkersPage(); renderActivityLog();
   };
   
   window.resetSettings = function() {
       document.getElementById('set-temp-warn').value = 36; document.getElementById('set-temp-crit').value = 40;
       document.getElementById('set-gas-warn').value = 550; document.getElementById('set-gas-crit').value = 750;
       document.getElementById('set-water-warn').value = 25; document.getElementById('set-water-crit').value = 45;
       document.getElementById('set-interval').value = 3;
       saveSettings();
   };
   
   // --- Live Clock ---
   function startClock() {
       const el = document.getElementById('live-clock');
       if (!el) return;
       function tick() { el.innerText = new Date().toLocaleTimeString(); }
       tick(); setInterval(tick, 1000);
   }
   
   // --- Chart.js ---
   function initCharts() {
       Chart.defaults.color = '#94a3b8';
       Chart.defaults.borderColor = '#2a303c';
       Chart.defaults.font.family = "'Inter', sans-serif";
   
       const commonOptions = {
           responsive: true,
           // Crucial fix: maintainAspectRatio: false allows the chart to fill the .chart-container perfectly
           maintainAspectRatio: false, 
           plugins: { legend: { display: false } },
           scales: {
               x: { grid: { display: false } },
               y: { beginAtZero: false }
           },
           elements: {
               line: { tension: 0.4, borderWidth: 2 },
               point: { radius: 0 }
           }
       };
   
       const createChart = (id, color, initialData) => {
           const ctx = document.getElementById(id).getContext('2d');
           return new Chart(ctx, {
               type: 'line',
               data: {
                   labels: ['10m', '8m', '6m', '4m', '2m', 'Now'],
                   datasets: [{
                       data: initialData,
                       borderColor: color,
                       backgroundColor: `${color}33`,
                       fill: true
                   }]
               },
               options: commonOptions
           });
       };
   
       appState.charts.temp = createChart('chart-temp', '#f59e0b', [32, 32.5, 33, 34.5, 36.1, 36.5]);
       appState.charts.gas = createChart('chart-gas', '#ef4444', [410, 420, 450, 480, 500, 510]);
       appState.charts.water = createChart('chart-water', '#3b82f6', [10, 10, 12, 15, 18, 22]);
       appState.charts.risk = createChart('chart-risk', '#f97316', [20, 25, 30, 45, 60, 65]);
   }
   
   // --- Background Simulator Loop ---
   function startSimulation() {
       setInterval(() => {
           appState.workers.forEach(worker => {
               let d = worker.sensorData;
               const noise = () => (Math.random() * 0.4) - 0.2;
               
               d.temperature_c += noise();
               d.gas_raw += (Math.random() * 4) - 2;
               
               if(worker.workerId === "Worker 02") {
                   d.water_level_cm += 0.1; 
               } else {
                   d.water_level_cm += noise() * 0.1;
               }
   
               if(d.temperature_c < 20) d.temperature_c = 20;
               if(d.gas_raw < 300) d.gas_raw = 300;
               if(d.water_level_cm < 0) d.water_level_cm = 0;
               
               d.timestamp = new Date().toISOString();
           });
   
           // Simulating a random future alert with an AI suggestion
           if(Math.random() < 0.01) {
               appState.alerts.unshift({
                   id: Date.now(),
                   type: "WARNING",
                   msg: "Simulated motion anomaly detected",
                   aiAction: "Radio worker to confirm status. Monitor accelerometer graph closely for the next 5 minutes.",
                   worker: "Worker 01", belt: "RF-001",
                   time: "Just now", ack: false
               });
           }
   
           renderDashboard();
           renderWorkersPage();
           renderAlerts();
           
           const tempChart = appState.charts.temp;
           tempChart.data.datasets[0].data.shift();
           if (appState.workers.length > 0) {
            tempChart.data.datasets[0].data.push(
                appState.workers[0].sensorData.temperature_c
            );
        }
           tempChart.update();
   
           // Update active modal data if it's currently open
           if (!document.getElementById('worker-modal').classList.contains('hidden')) {
               const currentTitle = document.getElementById('modal-worker-name').innerText;
               const workerName = currentTitle.split(' ')[0] + ' ' + currentTitle.split(' ')[1]; 
               openModal(workerName); // Refresh the modal with live data
               if (typeof renderModalLiveTracking === 'function') renderModalLiveTracking();
           }
   
       }, appState.settings.refreshInterval * 1000);
   }   document.addEventListener('DOMContentLoaded', () => {
       testBackendConnection();
       loadWorkersFromBackend();
       renderDashboard();
       renderWorkersPage();
       renderAlerts();
       renderActivityLog();
       initCharts();
       startClock();
       startSimulation();
       document.getElementById('log-alerts')?.addEventListener('change', () => {
           appState.settings.logAlerts = document.getElementById('log-alerts').checked;
       });
       const loginForm = document.getElementById('login-form');
       if (loginForm) loginForm.addEventListener('submit', window.handleLoginSubmit);
       updateOperatorDisplay();
   });

   function updateOperatorDisplay() {
       const el = document.getElementById('operator-display');
       if (!el) return;
       if (appState.auth.authenticated && appState.auth.username) {
           el.innerText = appState.auth.username;
       } else {
           el.innerText = 'Operator';
       }
   }
