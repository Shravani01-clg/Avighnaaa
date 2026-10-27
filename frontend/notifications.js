/* ==========================================================================
   AVIGHNAA — CROSS-LOGIN NOTIFICATIONS (plain JS, extends script.js)
   ==========================================================================

   The bell in the top header, fed by GET /api/notifications. The backend
   scopes the feed to the caller's login, so the SAME widget serves both:

     control-room (user)        -> "Team assigned / reassigned to AV-1024"
                                   (written when the rescue login assigns)
     rescue login (rescue_team) -> "Rescue requested for AV-1024"
                                   (written when the control room pings)

   Delivery is polling (10s) — there is no socket layer. Notifications
   that arrive WHILE the user is signed in also raise a toast; older
   unread rows simply light up the badge, so a late login never spams.

   Read state is per-audience (one shared control-room console), which
   matches the backend model exactly.
   ========================================================================== */

const NOTIF_API = API_BASE_URL; // inherits http://localhost:5002/api
const NOTIF_POLL_MS = 10000;
const NOTIF_TOAST_MS = 6500;

const notifState = {
    role: null,
    items: [],
    unread: 0,
    seenIds: new Set(),   // ids already handled this session
    firstLoad: true,      // suppress toasts for pre-existing history
    timer: null,
    open: false,
};

// ─── Helpers ───────────────────────────────────────────────────

async function notifFetch(path, options = {}) {
    const { data } = await supabaseClient.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new Error('Not signed in');

    const res = await fetch(`${NOTIF_API}${path}`, {
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

function notifEsc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function notifTimeAgo(iso) {
    if (!iso) return '';
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 0) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    const m = Math.floor(diff / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    return `${Math.floor(h / 24)}d ago`;
}

// Notification type → icon (lucide) + accent class.
const NOTIF_META = {
    TEAM_ASSIGNED:   { icon: 'user-check',   cls: 'notif-team' },
    TEAM_REASSIGNED: { icon: 'refresh-cw',   cls: 'notif-team' },
    RESCUE_REQUESTED:{ icon: 'siren',        cls: 'notif-request' },
    GENERAL:         { icon: 'bell',         cls: '' },
};

// ─── Load + poll ───────────────────────────────────────────────

async function loadNotifications({ silent = true } = {}) {
    if (!notifState.role) return;
    try {
        const res = await notifFetch('/notifications');
        const rows = res.data || [];
        notifState.items = rows;
        notifState.unread =
            typeof res.unread_count === 'number'
                ? res.unread_count
                : rows.filter(n => !n.read).length;

        renderNotifBell();
        renderNotifList();

        // Toast only for notifications that appeared during THIS session
        // (first load = catch-up, badge only — no toast spam on login).
        if (!notifState.firstLoad) {
            rows
                .filter(n => !n.read && !notifState.seenIds.has(String(n.id)))
                .slice(0, 3)
                .forEach(pushNotifToast);
        }
        rows.forEach(n => notifState.seenIds.add(String(n.id)));
        notifState.firstLoad = false;
    } catch (err) {
        if (!silent) console.warn('Notifications load failed:', err.message);
    }
}

function startNotifPolling() {
    stopNotifPolling();
    loadNotifications({ silent: false });
    notifState.timer = setInterval(() => loadNotifications(), NOTIF_POLL_MS);
}

function stopNotifPolling() {
    if (notifState.timer) clearInterval(notifState.timer);
    notifState.timer = null;
}

// ─── Session hooks (same events rescue.js listens to) ─────────

window.addEventListener('avighnaa:session', (ev) => {
    const detail = ev.detail || {};
    notifState.role = detail.role || null;
    notifState.items = [];
    notifState.unread = 0;
    notifState.seenIds = new Set();
    notifState.firstLoad = true;
    closeNotifPanel();

    const wrap = document.getElementById('notif-wrap');
    if (wrap) wrap.classList.toggle('hidden', !notifState.role);

    if (notifState.role) startNotifPolling();
    else stopNotifPolling();
});

window.addEventListener('avighnaa:logout', () => {
    notifState.role = null;
    notifState.items = [];
    notifState.unread = 0;
    notifState.seenIds = new Set();
    notifState.firstLoad = true;
    stopNotifPolling();
    closeNotifPanel();

    const wrap = document.getElementById('notif-wrap');
    if (wrap) wrap.classList.add('hidden');
    renderNotifBell();
    renderNotifList();
});

// ─── Render: bell badge + dropdown ─────────────────────────────

function renderNotifBell() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (notifState.unread > 0) {
        badge.textContent = notifState.unread > 99 ? '99+' : notifState.unread;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function renderNotifList() {
    const list = document.getElementById('notif-list');
    if (!list) return;

    if (notifState.items.length === 0) {
        list.innerHTML = '<p class="notif-empty">No notifications yet.</p>';
        return;
    }

    list.innerHTML = notifState.items.map(n => {
        const meta = NOTIF_META[n.type] || NOTIF_META.GENERAL;
        return `
        <button type="button"
            class="notif-item ${meta.cls}${n.read ? '' : ' unread'}"
            data-notif-id="${notifEsc(n.id)}"
            data-notif-incident="${notifEsc(n.incident_id || '')}">
            <span class="notif-item-icon"><i data-lucide="${meta.icon}"></i></span>
            <span class="notif-item-body">
                <span class="notif-item-title">${notifEsc(n.title)}</span>
                <span class="notif-item-msg">${notifEsc(n.message)}</span>
                <span class="notif-item-time">${notifTimeAgo(n.created_at)}</span>
            </span>
            ${n.read ? '' : '<span class="notif-dot" title="Unread"></span>'}
        </button>`;
    }).join('');

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─── Panel open / close ───────────────────────────────────────

function openNotifPanel() {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    notifState.open = true;
    // Refresh on open so the list is never staler than the last poll.
    loadNotifications();
}

function closeNotifPanel() {
    const panel = document.getElementById('notif-panel');
    if (panel) panel.classList.add('hidden');
    notifState.open = false;
}

function toggleNotifPanel() {
    if (notifState.open) closeNotifPanel();
    else openNotifPanel();
}

// ─── Actions ───────────────────────────────────────────────────

async function notifMarkRead(id) {
    if (!id) return;
    const item = notifState.items.find(n => String(n.id) === String(id));
    if (item && item.read) return;
    try {
        await notifFetch(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
        if (item) item.read = true;
        notifState.unread = Math.max(0, notifState.unread - 1);
        renderNotifBell();
        renderNotifList();
    } catch { /* next poll re-syncs the truth */ }
}

async function notifMarkAllRead() {
    try {
        await notifFetch('/notifications/read-all', { method: 'POST' });
        notifState.items = notifState.items.map(n => ({ ...n, read: true }));
        notifState.unread = 0;
        renderNotifBell();
        renderNotifList();
    } catch (err) {
        alert(`Could not mark notifications read: ${err.message}`);
    }
}

// Take the user to the incident the notification is about.
function notifOpenIncident(incidentId) {
    if (!incidentId) return;
    if (notifState.role === 'rescue_team') {
        document.querySelector('.nav-item[data-target="rescue"]')?.click();
        if (typeof openIncident === 'function') openIncident(incidentId);
    } else {
        // Control room: the dashboard + SOS modal show live incident state.
        document.querySelector('.nav-item[data-target="dashboard"]')?.click();
    }
}

// ─── Toasts (new notifications while signed in) ────────────────

function pushNotifToast(n) {
    let host = document.getElementById('notif-toasts');
    if (!host) {
        host = document.createElement('div');
        host.id = 'notif-toasts';
        document.body.appendChild(host);
    }

    const meta = NOTIF_META[n.type] || NOTIF_META.GENERAL;
    const toast = document.createElement('div');
    toast.className = `notif-toast ${meta.cls}`;
    toast.innerHTML = `
        <span class="notif-toast-icon"><i data-lucide="${meta.icon}"></i></span>
        <span class="notif-toast-body">
            <strong>${notifEsc(n.title)}</strong>
            <span>${notifEsc(n.message)}</span>
        </span>
        <button type="button" class="notif-toast-close" aria-label="Dismiss">&times;</button>`;

    const dismiss = () => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 250);
    };
    toast.querySelector('.notif-toast-close')?.addEventListener('click', dismiss);
    toast.addEventListener('click', () => {
        notifOpenIncident(n.incident_id);
        notifMarkRead(n.id);
        dismiss();
    });

    host.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(dismiss, NOTIF_TOAST_MS);
}

// ─── Init ──────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Hidden until a session announces a role.
    document.getElementById('notif-wrap')?.classList.add('hidden');

    document.getElementById('notif-bell')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNotifPanel();
    });

    document.getElementById('notif-mark-all')
        ?.addEventListener('click', (e) => {
            e.stopPropagation();
            notifMarkAllRead();
        });

    // Item clicks (delegated — the list re-renders on every poll).
    document.getElementById('notif-list')?.addEventListener('click', (e) => {
        const item = e.target.closest('.notif-item');
        if (!item) return;
        e.stopPropagation();
        notifMarkRead(item.getAttribute('data-notif-id'));
        notifOpenIncident(item.getAttribute('data-notif-incident'));
        closeNotifPanel();
    });

    // Click outside / Escape closes the panel.
    document.addEventListener('click', (e) => {
        if (!notifState.open) return;
        if (e.target.closest('#notif-wrap')) return;
        closeNotifPanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && notifState.open) closeNotifPanel();
    });
});
