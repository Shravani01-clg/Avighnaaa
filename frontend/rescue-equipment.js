/* ==========================================================================
   AVIGHNAA — RESCUE EQUIPMENT (RESCUE_TEAM only)

   Renders the equipment inventory / readiness dashboard, the maintenance
   attention list, usage history, and the PRE-DEPARTURE EQUIPMENT CHECK that
   gates the EN ROUTE mission step.

   Everything is read from the real backend:
     GET  /api/rescue-equipment
     GET  /api/rescue-equipment/:id
     PATCH/api/rescue-equipment/:id
     GET  /api/rescue-equipment/recommendations/:incidentId
     GET  /api/rescue-equipment/checklist/:incidentId
     POST /api/rescue-equipment/checklist/:incidentId
     POST /api/rescue-equipment/return
     GET  /api/rescue-equipment/usage
   ========================================================================== */

(function () {
  "use strict";

  const eqState = {
    items: [],
    summary: null,
    checklistIncident: null,
    checklist: null,
    selectedEquipment: new Set(),
  };

  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  async function eqFetch(path, options = {}) {
    const { data } = await supabaseClient.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error("Not signed in");

    const res = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.message || `Request failed (${res.status})`);
      err.body = body;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ── status presentation ──────────────────────────────────────

  const STATUS_META = {
    AVAILABLE:   { icon: "🟢", label: "Available" },
    IN_USE:      { icon: "🟡", label: "In use" },
    MAINTENANCE: { icon: "🔴", label: "Maintenance" },
    DAMAGED:     { icon: "🔴", label: "Damaged" },
    UNAVAILABLE: { icon: "⚫", label: "Unavailable" },
  };

  function statusMeta(status) {
    return STATUS_META[status] || { icon: "⚪", label: status || "Unknown" };
  }

  function renderSummary(summary, storageMode) {
    const el = $("equipment-summary");
    if (!el) return;

    const note = $("equipment-storage-note");
    if (note) {
      if (storageMode === "memory") {
        note.textContent =
          "MEMORY STORAGE — migration 006 has not been run in the Supabase SQL Editor, so " +
          "equipment records are held in server memory and lost on restart. Nothing is " +
          "pre-seeded: this list only ever shows items entered here. Run " +
          "migrations/006_two_roles_and_equipment.sql to store equipment in the database.";
        note.classList.remove("hidden");
      } else {
        note.classList.add("hidden");
      }
    }

    if (!summary || summary.total === 0) {
      el.innerHTML = '<p class="rescue-empty">No equipment records yet.</p>';
      return;
    }

    // Colour accents use the summary-card outline family (top border),
    // exactly like the dashboard tiles — badge classes are for chips and
    // looked wrong stretched over a whole card.
    const cards = [
      { label: "Total Equipment", value: summary.total, cls: "" },
      { label: "Available", value: summary.available, cls: "outline-safe" },
      { label: "In Use", value: summary.in_use, cls: "outline-warning" },
      { label: "Maintenance", value: summary.maintenance, cls: "outline-critical" },
      { label: "Damaged", value: summary.damaged, cls: "outline-critical" },
      { label: "Unavailable", value: summary.unavailable, cls: "" },
    ];

    el.innerHTML =
      cards
        .map(
          (c) => `
        <div class="summary-card ${c.cls}">
          <div class="card-label">${esc(c.label)}</div>
          <div class="card-value">${esc(c.value)}</div>
        </div>`
        )
        .join("") +
      `
        <div class="summary-card ${summary.ready_percent >= 80 ? "outline-safe" : "outline-warning"}">
          <div class="card-label">Equipment Ready</div>
          <div class="card-value">${esc(summary.ready_percent)}%</div>
          <div class="card-subtext">${esc(summary.available)} of ${esc(summary.total)} items available</div>
        </div>`;
  }

  function equipmentCard(item) {
    const meta = statusMeta(item.status);
    const inspect = item.next_inspection_date
      ? `<span>📅 Next inspection: ${esc(item.next_inspection_date)}</span>`
      : `<span>📅 Next inspection: not set</span>`;

    return `
      <div class="rescue-card equip-card equip-${esc(item.status.toLowerCase())}">
        <div class="equip-head">
          <span class="equip-icon">${meta.icon}</span>
          <span class="equip-name">${esc(item.equipment_name)}</span>
          <span class="badge ${item.status === "AVAILABLE" ? "badge-safe" : item.status === "IN_USE" ? "badge-warning" : "badge-critical"}">
            ${esc(meta.label)}
          </span>
        </div>
        <div class="equip-meta">
          <span>ID: <b>${esc(item.equipment_id)}</b></span>
          <span>Qty: <b>${esc(item.quantity)}</b></span>
          <span>Type: <b>${esc(item.equipment_type)}</b></span>
          <span>Condition: <b>${esc(item.condition)}</b></span>
          <span>Team: <b>${esc(item.assigned_team_id || "—")}</b></span>
          <span>📍 ${esc(item.location || "—")}</span>
          ${inspect}
        </div>
        <div class="equip-actions">
          <select class="rescue-select" id="eq-status-${esc(item.equipment_id)}">
            ${Object.keys(STATUS_META)
              .map(
                (s) =>
                  `<option value="${s}"${s === item.status ? " selected" : ""}>${STATUS_META[s].label}</option>`
              )
              .join("")}
          </select>
          <button
            type="button"
            class="btn btn-outline btn-sm"
            data-eq-save="${esc(item.equipment_id)}"
          >
            Update status
          </button>
          <button
            type="button"
            class="btn btn-outline btn-sm"
            data-eq-detail="${esc(item.equipment_id)}"
          >
            History
          </button>
          <span class="rescue-note" id="eq-msg-${esc(item.equipment_id)}"></span>
        </div>
      </div>`;
  }

  function renderList(rows) {
    const el = $("equipment-list");
    if (!el) return;
    if (!rows || rows.length === 0) {
      el.innerHTML = '<p class="rescue-empty">No equipment matches these filters.</p>';
      return;
    }
    el.innerHTML = rows.map(equipmentCard).join("");
  }

  function renderMaintenance(rows) {
    const el = $("equipment-maintenance");
    if (!el) return;
    if (!rows || rows.length === 0) {
      el.innerHTML = '<p class="rescue-empty">All equipment is serviceable — nothing under maintenance, damage or unavailability.</p>';
      return;
    }
    el.innerHTML = rows
      .map((item) => {
        const meta = statusMeta(item.status);
        return `
        <div class="rescue-card equip-attention">
          <div class="equip-head">
            <span class="equip-icon">${meta.icon}</span>
            <span class="equip-name">${esc(item.equipment_name)} (#${esc(item.equipment_id)})</span>
            <span class="badge badge-critical">${esc(meta.label)}</span>
          </div>
          <div class="equip-meta">
            <span>Condition: <b>${esc(item.condition)}</b></span>
            <span>📅 Next inspection: <b>${esc(item.next_inspection_date || "not set")}</b></span>
            <span>📍 ${esc(item.location || "—")}</span>
          </div>
          <p class="rescue-note">Not counted as ready while in this state.</p>
        </div>`;
      })
      .join("");
  }

  function renderUsage(body) {
    const el = $("equipment-usage-history");
    if (!el) return;
    const usage = body.data || [];
    const events = body.events || [];

    if (usage.length === 0 && events.length === 0) {
      el.innerHTML = '<p class="rescue-empty">No equipment usage recorded yet.</p>';
      return;
    }

    const usageHtml = usage.length
      ? `<div class="rescue-table-wrap"><table class="rescue-table">
          <thead><tr>
            <th>Equipment</th><th>Incident</th><th>Team</th><th>Qty</th>
            <th>Checked out</th><th>Returned</th><th>Condition after use</th>
          </tr></thead>
          <tbody>
            ${usage
              .map(
                (u) => `<tr>
                  <td>${esc(u.equipment_id)}</td>
                  <td>${esc(u.incident_id || "—")}</td>
                  <td>${esc(u.team_id || "—")}</td>
                  <td>${esc(u.quantity_used)}</td>
                  <td>${esc(u.checked_out_at || "—")}</td>
                  <td>${u.returned_at ? esc(u.returned_at) : "<em>still out</em>"}</td>
                  <td>${esc(u.condition_after_use || "—")}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table></div>`
      : `<p class="rescue-empty">No equipment checked out yet.</p>`;

    const eventsHtml = events.length
      ? `<div class="rescue-timeline">${events
          .slice(0, 25)
          .map(
            (e) => `<div class="rescue-timeline-row">
              <span class="tl-time">${esc(e.created_at)}</span>
              <span class="tl-text">${esc(e.equipment_id)} — ${esc(e.event_type)}${e.notes ? ` (${esc(e.notes)})` : ""}</span>
            </div>`
          )
          .join("")}</div>`
      : "";

    el.innerHTML = usageHtml + eventsHtml;
  }

  // ── mission picker (pre-departure equipment check) ─────────────

  const ACTIVE_HAZARD_STATUSES = [
    "AWAITING_RESPONSE",
    "ASSIGNED",
    "ACCEPTED",
    "EN_ROUTE",
    "ON_SCENE",
    "RESCUE_IN_PROGRESS",
    "PERSON_SAFE",
    "ESCALATED",
  ];

  const HAZARD_ICONS = {
    SOS: "🆘",
    GAS_LEAK: "🔥",
    FIRE_HEAT: "🔥",
    FLOOD: "🌊",
    FALL: "🩺",
    COMBINED: "⚠️",
    ANOMALY: "👁️",
    HIGH_RISK: "⚠️",
  };

  function renderMissionPicker() {
    const el = $("checklist-missions");
    if (!el) return;
    el.innerHTML = '<p class="rescue-empty">Loading missions…</p>';

    eqFetch("/incidents")
      .then((body) => {
        const active = (body.data || []).filter((i) =>
          ACTIVE_HAZARD_STATUSES.includes(i.status)
        );
        if (!active.length) {
          el.innerHTML =
            '<p class="rescue-empty">No active missions right now — the equipment checklist for a mission appears here once an incident needs a team.</p>';
          return;
        }
        return Promise.all(
          active.map((i) =>
            eqFetch(`/rescue-equipment/checklist/${encodeURIComponent(i.incident_id)}`)
              .then((c) => ({ incident: i, checklist: c.data }))
              .catch(() => ({ incident: i, checklist: null }))
          )
        ).then((rows) => {
          el.innerHTML = rows
            .map((r) => {
              const i = r.incident;
              const cl = r.checklist;
              const kit = (cl && cl.required_items) || [];
              const checked = (cl && cl.checked_items) || [];
              const done = (cl && cl.status) || (kit.every((k) => checked.includes(k)) ? "COMPLETE" : "PENDING");
              const selected = eqState.checklistIncident === i.incident_id;
              const icon = HAZARD_ICONS[i.hazard_type] || "🚨";
              const progress = cl && cl.required_items
                ? `${cl.checked_items?.length || 0}/${cl.required_items.length} kit items confirmed`
                : "kit not loaded";
              return `
              <div class="rescue-card" style="margin-bottom:10px">
                <div class="equip-head">
                  <span class="equip-icon">${icon}</span>
                  <span class="equip-name">#${esc(i.incident_id)} — ${esc(i.hazard_label || i.hazard_type || "Incident")}</span>
                  <span class="badge badge-critical">${esc(i.status.replace(/_/g, " "))}</span>
                </div>
                <div class="equip-meta">
                  <span>🚒 Team: <b>${esc(i.assigned_team_id || "Unassigned")}</b></span>
                  <span>📍 ${esc(i.location || "Location not configured")}</span>
                  <span>🧰 Kit: <b>${esc(kit.join(", ") || "No items configured")}</b></span>
                  <span>📦 ${esc(progress)}${done !== "COMPLETE" && kit.length ? " — checklist open" : ""}</span>
                </div>
                <div class="equip-actions">
                  <button
                    type="button"
                    class="btn btn-rescue btn-sm"
                    data-checklist-open="${esc(i.incident_id)}"
                  >
                    OPEN EQUIPMENT CHECKLIST
                  </button>
                </div>
              </div>`;
            })
            .join("");
        });
      })
      .catch((err) => {
        el.innerHTML = `<p class="rescue-empty">Could not load active missions: ${esc(err.message)}</p>`;
      });
  }

  function render() {}

  // ── loaders ──────────────────────────────────────────────────
  async function loadEquipment() {
    const params = new URLSearchParams();
    const q = ($("equipment-search")?.value || "").trim();
    const status = ($("equipment-status-filter")?.value || "").trim();
    if (q) params.set("q", q);
    if (status) params.set("status", status);
    const qs = params.toString() ? `?${params}` : "";

    try {
      const body = await eqFetch(`/rescue-equipment${qs}`);
      eqState.items = body.data || [];
      eqState.summary = body.summary;
      renderSummary(body.summary, body.storage);
      renderList(body.data);
      renderMaintenance(body.needs_attention);

      const usage = await eqFetch("/rescue-equipment/usage");
      renderUsage(usage);
    } catch (err) {
      const el = $("equipment-list");
      if (el) el.innerHTML = `<p class="rescue-empty">${esc(err.message)}</p>`;
    }
  }

  async function saveStatus(equipmentId, status) {
    const msg = $(`eq-msg-${CSS.escape(equipmentId)}`);
    try {
      await eqFetch(`/rescue-equipment/${encodeURIComponent(equipmentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      if (msg) msg.textContent = "✅ Updated";
      loadEquipment();
    } catch (err) {
      if (msg) msg.textContent = `❌ ${err.message}`;
    }
  }

  async function showHistory(equipmentId) {
    const msg = $(`eq-msg-${CSS.escape(equipmentId)}`);
    try {
      const body = await eqFetch(`/rescue-equipment/${encodeURIComponent(equipmentId)}`);
      const events = body.history || [];
      if (msg) {
        msg.textContent = events.length
          ? `📜 ${events.length} history record(s): ` +
            events.slice(0, 3).map((e) => `${e.event_type} (${String(e.created_at).slice(0, 10)})`).join(", ")
          : "📜 No history recorded yet.";
      }
    } catch (err) {
      if (msg) msg.textContent = `❌ ${err.message}`;
    }
  }

  // ── pre-departure checklist ──────────────────────────────────

  async function openChecklist(incidentId) {
    eqState.checklistIncident = incidentId;
    try {
      const body = await eqFetch(`/rescue-equipment/checklist/${encodeURIComponent(incidentId)}`);
      eqState.checklist = body.data;
      renderChecklist(body.data);

      const rec = await eqFetch(
        `/rescue-equipment/recommendations/${encodeURIComponent(incidentId)}`
      );
      renderRecommendations(rec);
      eqState.selectedEquipment.clear();
      renderCheckoutChoices(rec.suggested_equipment || []);
      // Re-render the mission list so the picked mission is highlighted
      // even after it has been opened from the checklist page itself.
      renderMissionPicker();
    } catch (err) {
      const el = $("checklist-items");
      if (el) el.innerHTML = `<p class="rescue-empty">${esc(err.message)}</p>`;
    }
  }

  function renderChecklist(cl) {
    const head = $("checklist-head");
    if (head) {
      head.innerHTML = `
        <div class="equip-meta">
          <span>MISSION: <b>${esc(cl.incident_id)}</b></span>
          <span>TEAM: <b>${esc(cl.team_id || "unassigned")}</b></span>
          <span>STATUS: <b>${esc(cl.status)}</b></span>
        </div>`;
    }

    const el = $("checklist-items");
    if (!el) return;

    const required = cl.required_items || [];
    const checked = cl.checked_items || [];

    if (required.length === 0) {
      el.innerHTML = '<p class="rescue-empty">No checklist items required for this hazard.</p>';
    } else {
      el.innerHTML = required
        .map(
          (item) => `
        <label class="checklist-row">
          <input
            type="checkbox"
            class="checklist-box"
            value="${esc(item)}"
            ${checked.includes(item) ? "checked" : ""}
          >
          <span>${esc(item)}</span>
        </label>`
        )
        .join("");
    }

    const status = $("checklist-status");
    if (status) {
      const outstanding = cl.outstanding_items || [];
      status.textContent = outstanding.length
        ? `${outstanding.length} item(s) still outstanding — EN ROUTE stays blocked.`
        : "✅ All required items checked. The team may depart.";
    }

    const btn = $("checklist-complete");
    if (btn) btn.disabled = !required.length || outstanding0(cl);
  }

  function outstanding0(cl) {
    const required = cl.required_items || [];
    const checked = cl.checked_items || [];
    return required.filter((i) => !checked.includes(i)).length === 0;
  }

  function renderRecommendations(rec) {
    const el = $("checklist-recommendations");
    if (!el) return;

    const d = $("checklist-disclaimer");
    if (d) d.textContent = rec.disclaimer || "";

    el.innerHTML = (rec.suggested_equipment || [])
      .map(
        (e) => `
      <div class="rescue-card equip-card">
        <div class="equip-head">
          <span class="equip-icon">${statusMeta(e.status).icon}</span>
          <span class="equip-name">${esc(e.equipment_name)}</span>
          <span class="badge ${e.status === "AVAILABLE" ? "badge-safe" : "badge-warning"}">${esc(statusMeta(e.status).label)}</span>
        </div>
        <div class="equip-meta">
          <span>ID: <b>${esc(e.equipment_id)}</b></span>
          <span>Qty available: <b>${esc(e.quantity)}</b></span>
          <span>Type: <b>${esc(e.equipment_type)}</b></span>
          <span>📍 ${esc(e.location || "—")}</span>
        </div>
      </div>`
      )
      .join("") || '<p class="rescue-empty">No matching inventory for this hazard.</p>';
  }

  function renderCheckoutChoices(items) {
    const el = $("checklist-equipment");
    if (!el) return;
    if (!items.length) {
      el.innerHTML = '<p class="rescue-empty">No equipment available to check out.</p>';
      return;
    }
    el.innerHTML = items
      .filter((e) => e.status === "AVAILABLE")
      .map(
        (e) => `
      <label class="checklist-row">
        <input
          type="checkbox"
          class="equip-checkout-box"
          value="${esc(e.equipment_id)}"
          data-qty="${esc(e.quantity)}"
        >
        <span>${esc(e.equipment_name)} (#${esc(e.equipment_id)}) — ${esc(e.quantity)} available</span>
      </label>`
      )
      .join("") || '<p class="rescue-empty">Nothing currently available to check out.</p>';
  }

  async function saveChecklist(markComplete) {
    const status = $("checklist-status");
    const incidentId = eqState.checklistIncident;
    if (!incidentId) return;

    const checked = [...document.querySelectorAll(".checklist-box")]
      .filter((b) => b.checked)
      .map((b) => b.value);

    try {
      const body = await eqFetch(`/rescue-equipment/checklist/${encodeURIComponent(incidentId)}`, {
        method: "POST",
        body: JSON.stringify({ checked_items: checked, mark_complete: markComplete }),
      });
      eqState.checklist = body.data;
      renderChecklist(body.data);
      if (status) status.textContent = body.message;
      addLogEntry("STATUS", "tag-status", body.message);
    } catch (err) {
      // The API refuses to claim completion while items are outstanding —
      // surface the real reason instead of pretending it worked.
      if (status) status.textContent = `❌ ${err.message}`;
      const outstanding = err.body && err.body.outstanding_items;
      if (outstanding) {
        renderChecklist({
          ...eqState.checklist,
          checked_items: checked,
          outstanding_items: outstanding,
        });
      }
    }
  }

  async function checkoutSelected() {
    const incidentId = eqState.checklistIncident;
    if (!incidentId) return;
    const boxes = [...document.querySelectorAll(".equip-checkout-box")].filter((b) => b.checked);
    if (boxes.length === 0) {
      const el = $("checklist-status");
      if (el) el.textContent = "Select at least one item to check out.";
      return;
    }

    const equipment_used = boxes.map((b) => ({
      equipment_id: b.value,
      quantity_used: Number(b.dataset.qty) || 1,
    }));

    try {
      await eqFetch(`/rescue-equipment/checklist/${encodeURIComponent(incidentId)}`, {
        method: "POST",
        body: JSON.stringify({
          checked_items: (eqState.checklist && eqState.checklist.checked_items) || [],
          equipment_used,
        }),
      });
      const el = $("checklist-status");
      if (el) el.textContent = `✅ Checked out ${equipment_used.length} item(s).`;
      loadEquipment();
    } catch (err) {
      const el = $("checklist-status");
      if (el) el.textContent = `❌ ${err.message}`;
    }
  }

  // ── wiring ───────────────────────────────────────────────────

  function wire() {
    const on = (id, ev, fn) => {
      const el = $(id);
      if (el) el.addEventListener(ev, fn);
    };

    on("equipment-refresh", "click", loadEquipment);
    on("equipment-status-filter", "change", loadEquipment);
    on("equipment-search", "input", () => {
      clearTimeout(window.__eqSearch);
      window.__eqSearch = setTimeout(loadEquipment, 300);
    });
    on("checklist-complete", "click", () => saveChecklist(true));
    on("checkout-equipment", "click", checkoutSelected);

    document.addEventListener("change", (e) => {
      const saveId = e.target.getAttribute && e.target.getAttribute("data-eq-save");
      if (saveId) return; // handled via the button below
      if (e.target.classList && e.target.classList.contains("checklist-box")) {
        saveChecklist(false);
      }
    });

    document.addEventListener("click", (e) => {
      const target = e.target;
      if (!target || !target.getAttribute) return;
      const saveId = target.getAttribute("data-eq-save");
      if (saveId) {
        const sel = $(`eq-status-${CSS.escape(saveId)}`);
        if (sel) saveStatus(saveId, sel.value);
        return;
      }
      const detailId = target.getAttribute("data-eq-detail");
      if (detailId) showHistory(detailId);
    });

    // Load when the rescue portal becomes active, and on session changes.
    window.addEventListener("avighnaa:session", (ev) => {
      const role = ev.detail && ev.detail.role;
      if (role === "rescue_team") {
        loadEquipment();
        renderMissionPicker();
      }
      else {
        eqState.items = [];
        eqState.checklist = null;
      }
    });

    document.addEventListener("click", (e) => {
      const nav = e.target.closest && e.target.closest('[data-target="equipment"]');
      if (nav) setTimeout(loadEquipment, 200);
      const ck = e.target.closest && e.target.closest('[data-target="equipmentcheck"]');
      if (ck) setTimeout(() => {
        if (eqState.checklistIncident) openChecklist(eqState.checklistIncident);
        else renderMissionPicker();
      }, 200);
      const openMk = e.target.closest && e.target.closest("[data-checklist-open]");
      if (openMk) {
        const id = openMk.getAttribute("data-checklist-open");
        if (id) openChecklist(id);
      }
    });
  }

  // Exposed so rescue.js can open the checklist for the selected mission.
  window.openEquipmentChecklist = openChecklist;
  window.loadRescueEquipment = loadEquipment;
  window.equipmentState = eqState;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();