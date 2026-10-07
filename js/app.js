// js/app.js  -- application bootstrap & event wiring (main dashboard)
import { supabase, CONFIG_OK } from './supabaseClient.js';
import { $, $$, esc, toast, tableMessage, statusBadge } from './ui.js';
import { requireAuth, signOut, ROLE_LABEL } from './auth.js';
import { renderEventQR } from './qrRenderer.js';
import * as Events from './events.js';
import * as Scan from './scan.js';
import * as Att from './attendance.js';
import * as Admin from './admin.js';
import * as Reports from './reports.js';
import { initGlobalRealtime } from './realtime.js';
import {
  COURSES, YEARS, BLOCKS, labelForLevel, courseLabel, yearLabel,
  fillSelect, ensureOption, applyLevelFields, readLevelFields,
  validateLevelFields, fieldsForLevel, formatGradeClass, parseGradeClass
} from './education.js';

let profile = null;
let activeTab = 'dashboard';

/* Cooldown that suppresses the realtime attendance echo right after a local
 * mutation (delete/update), so it can't resurrect a row we just removed. */
let suppressRealtimeUntil = 0;
export function suppressRealtime(ms = 1500) {
  suppressRealtimeUntil = Date.now() + ms;
}
export function realtimeSuppressed() { return Date.now() < suppressRealtimeUntil; }

/* ---------- Role navigation (labels, icons and links, per role) ----------
 * Each entry renders an <a class="nav-btn"> pill and maps its public hash
 * (e.g. "#monitor") to an internal tab id (e.g. "records"). Access is still
 * enforced per item by navForRole() in switchTab(), so a link can never
 * open a tab the current role is not allowed to see. */
const NAV_BY_ROLE = {
  student: [
    { tab: 'events',  href: 'app.html#events',  label: 'Events',        icon: 'fa-calendar-days' },
    { tab: 'scan',    href: 'app.html#scan',    label: 'Scan QR',       icon: 'fa-camera' },
    { tab: 'history', href: 'app.html#history', label: 'My Attendance', icon: 'fa-clock-rotate-left' },
    { tab: 'profile', href: 'app.html#profile', label: 'Profile',       icon: 'fa-user' }
  ],
  teacher: [
    { tab: 'events',  href: 'app.html#events',    label: 'Manage Events',      icon: 'fa-calendar-plus' },
    { tab: 'qr',      href: 'app.html#qr',        label: 'Generate QR',        icon: 'fa-qrcode' },
    { tab: 'records', href: 'app.html#monitor',   label: 'Monitor Attendance', icon: 'fa-chart-line' },
    { tab: 'reports', href: 'app.html#summaries', label: 'Summaries',          icon: 'fa-file-lines' }
  ],
  admin: [
    { tab: 'users',      href: 'app.html#users',      label: 'Manage Users',       icon: 'fa-users-gear' },
    { tab: 'events',     href: 'app.html#events',     label: 'Manage Events',      icon: 'fa-calendar-days' },
    { tab: 'attendance', href: 'app.html#attendance', label: 'Overall Attendance', icon: 'fa-clipboard-user' },
    { tab: 'correct',    href: 'app.html#correct',    label: 'Correct Records',    icon: 'fa-pen-to-square' },
    { tab: 'reports',    href: 'app.html#reports',    label: 'System Reports',     icon: 'fa-chart-pie' }
  ]
};

function navForRole(role) { return NAV_BY_ROLE[role] || []; }
/* Internal tab ids reachable by role (used for access gating + hash routing). */
function tabsForRole(role) { return navForRole(role).map(n => n.tab); }
/* The tab every role lands on (first nav item). */
function defaultTabForRole(role) { return navForRole(role)[0]?.tab || 'events'; }

/* ---------- Bootstrap ---------- */
// Loaded as a deferred module script: DOMContentLoaded may already have fired.
// Boot immediately when the document is ready, otherwise wait for the event.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}

async function bootstrap() {
  if (!CONFIG_OK) {
    document.body.innerHTML = configErrorMarkup();
    return;
  }

  profile = await requireAuth();
  if (!profile) {
    // Stay hidden while the auth failure toast / sign-in redirect plays out.
    const bootText = document.getElementById('app-boot-text');
    if (bootText) bootText.textContent = 'Redirecting to sign-in…';
    return;
  }

  Events.initEvents(profile);
  Att.initAttendance(profile);
  Admin.initAdmin(profile);
  Reports.initReports(profile);

  renderHeader();
  renderNav();
  applyRoleVisibility();
  // hash routing: app.html#events-style links switch tabs
  // (registered before the reveal so deep links open the right tab)
  window.addEventListener('hashchange', () => {
    const id = tabFromHash();
    if (id && id !== activeTab) switchTab(id);
  });

  // Load data and select the role's landing tab WHILE the boot spinner is still
  // shown, so the portal is revealed complete (no raw dashboard flash).
  // try/catch: a data error must never leave the spinner up forever.
  try {
    await refreshAll();
    const initial = tabFromHash();
    if (initial && initial !== activeTab) switchTab(initial);
  } catch (err) {
    console.error('bootstrap/refreshAll', err);
    toast('Some data could not be loaded. Please refresh the page.', 'error');
  }

  // Role, nav and data are all in place: reveal the portal.
  revealApp();
  wireGlobalHandlers();

  // live session handling: redirect out if the session ends elsewhere
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace('index.html');
  });

  // Global realtime: one channel drives every table refresh (js/realtime.js).
  // Each branch preserves the refresh behaviour and echo suppression of the
  // per-table channels it replaces (public:events, attendance-self/staff,
  // admin-manage-users).
  console.log('Starting global realtime sync...');
  initGlobalRealtime((table, payload) => {
    if (table === 'events') {
      Events.refreshEventsRealtime(payload);
    } else if (table === 'profiles') {
      const updated = payload && payload.new;
      if (updated && profile && updated.id === profile.id) {
        // The signed-in user's own row changed (rename by admin, role change...).
        if (updated.role !== profile.role) {
          toast('Your role changed to ' + updated.role + '. The page will refresh.', 'info');
          setTimeout(() => location.reload(), 1200);
          return;
        }
        profile = { ...profile, ...updated };
        Admin.initAdmin(profile);   // admin.js holds its own reference to the row
        renderHeader();
        if (activeTab === 'profile') fillProfileForm();
      }
      Admin.refreshUsersRealtime();
    } else if (table === 'attendance') {
      if (realtimeSuppressed()) return;
      // Staff get a live "pop-up" for check-ins made from any other device
      // (the acting student's own client suppresses its echo above).
      if (payload.eventType === 'INSERT' && payload.new && profile && profile.role !== 'student') {
        const evt = Events.getEvents().find(e => e.id === payload.new.event_id);
        toast('New check-in' + (evt ? ' - ' + evt.name : '') + '.', 'success');
      }
      // One event routes every view: the attendance:changed listener below
      // refreshes the active tab, reports.js refreshes the summaries.
      document.dispatchEvent(new CustomEvent('attendance:changed'));
      document.dispatchEvent(new CustomEvent('data:refreshed'));
    } else if (table === 'audit_logs') {
      // Admin-only RLS: only administrators receive these payloads.
      if (profile.role === 'admin' && activeTab === 'reports') Reports.renderAuditLog();
    }
  });

  // Listen for real-time changes to the current user's profile row so a
  // deactivated account is signed out immediately, without a manual reload.
  if (profile && profile.id) {
    let handled = false;
    supabase
      .channel('user-deactivation-channel')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${profile.id}` // Only listen for changes to the logged-in user
        },
        async (payload) => {
          if (handled) return;
          // public.profiles stores the flag as a boolean is_active column
          // (there is no status column); set by the admin_set_active() RPC.
          const updatedUser = payload.new;
          if (updatedUser.is_active === false) {
            handled = true;
            // Alert first: signOut() fires SIGNED_OUT, whose handler (set up
            // above in bootstrap) already redirects to index.html.
            alert('Your account has been deactivated by an administrator.');
            await supabase.auth.signOut();
            window.location.replace('index.html'); // Redirect to login page
          }
        }
      )
      .subscribe();
  }
}

function configErrorMarkup() {
  return `<div class="min-h-screen flex items-center justify-center p-6">
    <div class="max-w-lg glass rounded-xl p-6 text-center">
      <i class="fa-solid fa-triangle-exclamation text-3xl text-amber-500"></i>
      <h1 class="text-lg font-bold mt-3">Supabase is not configured</h1>
      <p class="text-sm text-slate-600 mt-2">
        Copy <code>supabase-config.example.js</code> to <code>supabase-config.js</code> and add your
        project URL and the public anon key. Then reload this page.
      </p>
    </div></div>`;
}

/* ---------- Header + navigation ---------- */
/* ---------- Gated reveal (kills the empty-header flash) ----------
 * The portal shell (header / mobile nav / main) starts hidden in app.html.
 * Call this once the role is known and the role-specific nav is injected. */
function revealApp() {
  const boot = document.getElementById('app-boot');
  if (boot) boot.classList.add('hidden');
  const header = document.getElementById('app-header');
  if (header) { header.classList.remove('hidden'); header.style.display = ''; header.classList.add('animate-fade-in'); }
  const mobile = document.getElementById('mobile-nav');
  if (mobile) { mobile.classList.remove('hidden'); mobile.style.display = ''; }
  const main = document.getElementById('app-main');
  if (main) {
    main.classList.remove('hidden');
    main.style.display = ''; // clear the inline display:none fallback
    main.classList.add('animate-fade-in');
    main.removeAttribute('aria-busy');
  }
}

function renderHeader() {
  const nameEl = document.getElementById('current-user-name');
  const roleEl = document.getElementById('current-user-role');
  if (nameEl) nameEl.innerText = profile.full_name || profile.email;
  if (roleEl) roleEl.innerText = ROLE_LABEL[profile.role] || profile.role;
}

function renderNav() {
  const items = navForRole(profile.role);

  const nav = document.getElementById('main-nav');
  const mobile = document.getElementById('mobile-nav');

  // Desktop: pill links exactly like the per-role nav designs.
  if (nav) {
    const links = items.map(n =>
      `<a href="${n.href}" class="nav-btn px-4 py-2 rounded-full transition flex items-center gap-1.5 whitespace-nowrap" data-tab="${n.tab}"><i class="fa-solid ${n.icon}"></i> ${n.label}</a>`
    );
    // Admin's five tabs stack as two balanced rows (2 + 3) instead of one line.
    if (links.length > 4) {
      links.splice(2, 0, '<span aria-hidden="true" style="flex-basis:100%;height:0;line-height:0;margin:0;padding:0"></span>');
    }
    nav.innerHTML = links.join('');
  }

  // Mobile: same items, icon-over-label, horizontally scrollable.
  if (mobile) {
    mobile.innerHTML = items.map(n =>
      `<a href="${n.href}" class="nav-btn flex flex-col items-center flex-none px-2 py-1 rounded-lg" data-tab="${n.tab}">
        <i class="fa-solid ${n.icon} mb-1"></i><span class="text-[10px] whitespace-nowrap">${n.label}</span></a>`
    ).join('');
  }
}

/** Resolve the current location.hash to an internal tab id for this role.
 *  Matches the role's nav hrefs ("#monitor") and falls back to raw tab ids. */
function tabFromHash() {
  const hash = (location.hash || '').replace(/^#/, '').toLowerCase();
  if (!hash || !profile) return null;
  const items = navForRole(profile.role);
  const byHref = items.find(n => n.href.split('#')[1]?.toLowerCase() === hash);
  if (byHref) return byHref.tab;
  return items.some(n => n.tab === hash) ? hash : null;
}

/** Hide/show elements carrying data-roles="a,b" based on the current role. */
function applyRoleVisibility() {
  $$('[data-roles]').forEach(el => {
    const roles = el.dataset.roles.split(',').map(s => s.trim());
    el.classList.toggle('hidden', !roles.includes(profile.role));
  });
}

export function switchTab(id) {
  const allowed = tabsForRole(profile.role).includes(id);
  if (!allowed) { toast('You do not have access to that section.', 'error'); return; }
  activeTab = id;

  $$('.tab-content').forEach(el => el.classList.add('hidden'));
  const section = document.getElementById('tab-' + id);
  if (section) section.classList.remove('hidden');

  $$('.nav-btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === id));

  // keep the URL hash in sync so app.html#... links stay bookmarkable
  const item = navForRole(profile.role).find(n => n.tab === id);
  if (item) {
    const want = '#' + item.href.split('#')[1];
    if (location.hash !== want) history.replaceState(null, '', want);
  }

  if (id !== 'scan' && Scan.isScanning()) Scan.stopScanner();
  onTabShown(id);
}

function onTabShown(id) {
  if (id === 'events') { Events.loadEvents().then(Events.renderEvents); }
  else if (id === 'history') Att.renderMyAttendance();
  else if (id === 'records') { Att.populateRecordsFilter(); Att.renderRecords(); }
  else if (id === 'reports') {
    Reports.renderOverview();
    Reports.renderSummaryTable();
    if (profile.role === 'admin') Reports.renderAuditLog();
  }
  else if (id === 'users') Admin.loadUsers().then(Admin.renderUsers);
  else if (id === 'attendance') Admin.renderAdminOverview();
  else if (id === 'correct') {
    Admin.populateAdminRecordsFilter(Events.getEvents());
    Admin.renderAdminRecords();
  }
  else if (id === 'qr') renderQRSection();
  else if (id === 'scan') Scan.renderMyRecent();
  else if (id === 'profile') fillProfileForm();
}

async function refreshAll() {
  await Events.loadEvents();
  Events.renderEvents();
  Reports.renderOverview();
  // land each role on its first nav item (student/teacher: events, admin: users)
  switchTab(defaultTabForRole(profile.role));
}

/* ---------- Global event handlers ---------- */
function wireGlobalHandlers() {
  document.addEventListener('click', (e) => {
    const tabLink = e.target.closest('.nav-btn[data-tab]');
    if (tabLink) {
      e.preventDefault();
      // switch immediately and publish the link's hash (fires hashchange too)
      switchTab(tabLink.dataset.tab);
      const item = navForRole(profile.role).find(n => n.tab === tabLink.dataset.tab);
      if (item) location.hash = item.href.split('#')[1];
      return;
    }

    if (e.target.closest('#logout-btn')) { doLogout(); return; }
    if (e.target.closest('#create-event-btn')) { Events.openEventModal(); return; }
    if (e.target.closest('#close-event-modal')) { Events.closeEventModal(); return; }
    if (e.target.closest('#close-event-qr')) { Events.closeEventQR(); return; }
    if (e.target.closest('#event-qr-download')) { Events.downloadEventQR(); return; }
    if (e.target.closest('#download-inline-qr')) { downloadInlineQR(); return; }
    if (e.target.closest('#start-scan-btn')) { Scan.startScanner(); return; }
    if (e.target.closest('#stop-scan-btn')) { Scan.stopScanner(); return; }
    if (e.target.closest('#manual-checkin-btn')) { Scan.manualCheckIn(); return; }
    if (e.target.closest('#export-csv-btn')) { Reports.exportRecordsCSV(); return; }
    if (e.target.closest('#close-user-modal')) { Admin.closeEditUser(); return; }
    if (e.target.closest('#close-view-modal')) { closeViewModal(); return; }

    // ---- Administrator section only (own ids, never used by student/teacher tabs) ----
    if (profile && profile.role === 'admin') {
      if (e.target.closest('#admin-records-export-btn')) { Admin.exportAdminCSV(); return; }
      if (e.target.closest('#admin-audit-refresh-btn')) { Reports.renderAuditLog(); return; }

      const adminDel = e.target.closest('[data-admin-del-record]');
      if (adminDel) {
        // capture the row before the async delete: remove it instantly on success.
        const row = adminDel.closest('tr');
        Admin.deleteAdminRecord(adminDel.dataset.adminDelRecord, row);
        return;
      }
    }

    const act = e.target.closest('[data-act]');
    if (act) {
      const id = act.dataset.id;
      if (act.dataset.act === 'qr') Events.showEventQR(id);
      else if (act.dataset.act === 'edit') Events.openEventModal(id);
      else if (act.dataset.act === 'view') viewEvent(id);
      else if (act.dataset.act === 'close') Events.setEventStatus(id, 'closed');
      else if (act.dataset.act === 'open') Events.setEventStatus(id, 'open');
      else if (act.dataset.act === 'del') Events.deleteEvent(id);
      else if (act.dataset.act === 'checkin') switchTab('scan');
      return;
    }

    const editUser = e.target.closest('[data-edit-user]');
    if (editUser) { Admin.openEditUser(editUser.dataset.editUser); return; }

    const toggle = e.target.closest('[data-toggle-active]');
    if (toggle) { Admin.toggleActive(toggle.dataset.toggleActive, toggle.dataset.active === 'true'); return; }

    const delRec = e.target.closest('[data-del-record]');
    if (delRec) {
      // capture the row before the async delete: remove it instantly on success.
      const row = delRec.closest('tr');
      Att.deleteRecord(delRec.dataset.delRecord, row);
      return;
    }
  });

  document.addEventListener('change', (e) => {
    // Administrator section: status correction + its own event filter.
    if (profile && profile.role === 'admin') {
      if (e.target.matches('[data-admin-status]')) {
        Admin.updateAdminRecordStatus(e.target.dataset.adminStatus, e.target.value);
        return;
      }
      if (e.target.id === 'admin-records-event-select') {
        Admin.renderAdminRecords();
        return;
      }
    }

    if (e.target.matches('[data-status]')) {
      Att.updateRecordStatus(e.target.dataset.status, e.target.value);
    } else if (e.target.matches('[data-role-user]')) {
      Admin.changeRole(e.target.dataset.roleUser, e.target.value);
    } else if (e.target.id === 'records-event-select') {
      Att.renderRecords();
    } else if (e.target.id === 'qr-event-select') {
      drawQRSection();
    // Educational Level drives its dependent selects in both the profile form
    // and the admin edit-user modal.
    } else if (e.target.id === 'profile-educational-level') {
      renderProfileFormLevelFields();
    } else if (e.target.id === 'modal-user-level') {
      Admin.renderEditUserLevelFields();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'user-search') Admin.renderUsers();
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'event-form') Events.saveEvent(e);
    else if (e.target.id === 'user-form') Admin.saveUserProfile(e);
    else if (e.target.id === 'profile-form') saveProfile(e);
  });

  document.addEventListener('events:changed', () => {
    if (activeTab === 'records') { Att.populateRecordsFilter(); Att.renderRecords(); }
    // The event list also changed: refresh tabs that embed it or its filters.
    if (activeTab === 'correct') {
      Admin.populateAdminRecordsFilter(Events.getEvents());
      Admin.renderAdminRecords();
    }
    if (activeTab === 'qr') renderQRSection();
  });
  document.addEventListener('attendance:changed', () => {
    if (activeTab === 'history') Att.renderMyAttendance();
    if (activeTab === 'scan') Scan.renderMyRecent();
    if (activeTab === 'records') Att.renderRecords();
    if (activeTab === 'correct') Admin.renderAdminRecords();
    if (activeTab === 'attendance') Admin.renderAdminOverview();
    if (activeTab === 'profile') renderProfileStats();
    // reports: refreshed by its own attendance:changed listener (reports.js)
  });
}

async function doLogout() {
  if (Scan.isScanning()) await Scan.stopScanner();
  try { localStorage.setItem('campusqr-toast', JSON.stringify({ message: 'Signed out successfully.', type: 'success' })); } catch { /* storage unavailable */ }
  await signOut();
  location.replace('index.html');
}

/* ---------- Event view modal ---------- */
function viewEvent(id) {
  const evt = Events.getEventById(id);
  if (!evt) return;
  document.getElementById('view-name').innerText = evt.name;
  document.getElementById('view-venue').innerText = evt.venue || '—';
  document.getElementById('view-start').innerText = new Date(evt.start_datetime).toLocaleString();
  document.getElementById('view-end').innerText = evt.end_datetime ? new Date(evt.end_datetime).toLocaleString() : 'Open ended';
  document.getElementById('view-desc').innerText = evt.description || 'No description provided.';
  document.getElementById('view-status').innerHTML = statusBadge(evt.status);
  const m = document.getElementById('event-view-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
}
function closeViewModal() {
  const m = document.getElementById('event-view-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
}

/* ---------- Event QR section ---------- */
function renderQRSection() {
  const sel = document.getElementById('qr-event-select');
  if (!sel) return;
  const list = Events.getEvents().filter(e => profile.role === 'admin' || e.created_by === profile.id);
  const keep = sel.value;
  sel.innerHTML = '<option value="">-- Select an event --</option>' +
    list.map(e => `<option value="${e.id}">${esc(e.name)} (${esc(e.status)})</option>`).join('');
  if (keep) sel.value = keep;
  drawQRSection();
}

async function drawQRSection() {
  const box = document.getElementById('qr-inline-container');
  const meta = document.getElementById('qr-inline-meta');
  const tokenEl = document.getElementById('qr-inline-token');
  if (!box) return;
  const id = document.getElementById('qr-event-select').value;
  const evt = Events.getEventById(id);

  // Clears the container, then draws at 512px / H-level via the shared renderer.
  const drawn = await renderEventQR(box, { event: evt });
  if (!drawn) {
    if (meta) meta.innerText = '';
    if (tokenEl) tokenEl.innerText = '';
    return;
  }
  const cur = drawn.event;
  if (meta) meta.innerText = `${cur.name} - ${new Date(cur.start_datetime).toLocaleString()}`;
  if (tokenEl) tokenEl.innerText = cur.qr_token;
  const dl = document.getElementById('download-inline-qr');
  if (dl) dl.dataset.id = cur.id;
}

function downloadInlineQR() {
  const canvas = document.querySelector('#qr-inline-container canvas');
  if (!canvas) { toast('QR image is not ready yet.', 'warning'); return; }
  const link = document.createElement('a');
  link.download = 'event-qr.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

/* ---------- Profile ---------- */

/**
 * Repopulate + show/hide the level-driven selects in the profile edit form.
 * Mirrors renderRegLevelFields() in js/authPage.js, but reading the
 * profile-* ids declared in app.html.
 */
function renderProfileFormLevelFields() {
  const levelSel = document.getElementById('profile-educational-level');
  const form = document.getElementById('profile-form');
  if (!levelSel || !form) return;
  const level = levelSel.value;
  const waiting = level ? 'Select...' : 'Select Educational Level first';

  fillSelect(document.getElementById('profile-course'),     COURSES[level], { placeholder: waiting });
  fillSelect(document.getElementById('profile-year-level'), YEARS[level],   { placeholder: waiting });
  fillSelect(document.getElementById('profile-block'),      BLOCKS,         { placeholder: 'Select Block...' });

  applyLevelFields(form, level);

  const courseLbl = document.getElementById('profile-course-label');
  if (courseLbl) courseLbl.textContent = courseLabel(level);
  const yearLbl = document.getElementById('profile-year-label');
  if (yearLbl) yearLbl.textContent = yearLabel(level);
}

/**
 * Fill the read-only education card on a student's profile.
 *
 * WHICH rows appear is decided by fieldsForLevel() - the same rule the
 * registration form (js/authPage.js) and the admin modal (js/admin.js) use -
 * so the card mirrors exactly the level the student picked: College gets
 * Department/Course + Year Level + Block, the school levels get Grade Level +
 * Section. A row with no stored educational_level falls back to "show whatever
 * is set" until an admin fills the level in.
 *
 * WHAT each row shows comes from the structured columns written at
 * registration or by an admin; for migrated rows those are still NULL, so the
 * values are recovered from `grade_class`.
 */
function renderProfileEducation() {
  const level  = profile.educational_level || '';
  const need   = fieldsForLevel(level);
  const parsed = parseGradeClass(profile.grade_class);

  const values = {
    course:    profile.course    || profile.department || '',
    yearLevel: profile.year_level || parsed.year,
    block:     profile.block     || parsed.block,
    section:   profile.section   || parsed.section
  };

  const lvl = document.getElementById('edu-level-input');
  // Educational Level anchors the "Education Level / Information" group, so it
  // always renders a real string. A blank input reads as a missing field.
  if (lvl) lvl.value = level ? labelForLevel(level) : 'Not set';

  // No level stored -> the account was created before
  // sql/10_education_levels.sql, or an admin has not filled it in yet.
  const note = document.getElementById('edu-empty-note');
  if (note) note.classList.toggle('hidden', Boolean(level));

  const setRow = (rowId, inputId, key) => {
    const value = values[key];
    // Known level -> the level decides whether the row exists, even when the
    // value is missing, so an unset Block still shows a labelled gap.
    // Unknown level -> show only what is actually stored.
    const show = level ? need[key] : Boolean(value);
    const row = document.getElementById(rowId);
    if (row) row.classList.toggle('hidden', !show);
    const input = document.getElementById(inputId);
    if (input) input.value = value || 'Not set';
  };
  setRow('edu-course-row',  'edu-course-input',  'course');
  setRow('edu-year-row',    'edu-year-input',    'yearLevel');
  setRow('edu-block-row',   'edu-block-input',   'block');
  setRow('edu-section-row', 'edu-section-input', 'section');

  const c = document.getElementById('edu-course-label');
  if (c) c.textContent = level ? courseLabel(level) : 'Department / Course';
  const y = document.getElementById('edu-year-label');
  if (y) y.textContent = level ? yearLabel(level) : 'Grade / Class';
}

function fillProfileForm() {
  const f = document.getElementById('profile-form');
  if (!f) return;

  // Students get the read-only card; teachers/admins keep the edit form.
  const isStudent = profile.role === 'student';
  const studentView = document.getElementById('profile-student-view');
  const formView = document.getElementById('profile-form-view');
  const subtitle = document.getElementById('profile-subtitle');
  if (studentView) studentView.classList.toggle('hidden', !isStudent);
  if (formView) formView.classList.toggle('hidden', isStudent);
  if (subtitle) subtitle.innerText = isStudent
    ? 'View your personal student registration details.'
    : 'View and update your personal information.';
  if (isStudent) {
    const ro = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || 'N/A'; };
    const tx = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || 'N/A'; };
    ro('full-name-input', profile.full_name);
    ro('email-input', profile.email);
    ro('phone-input', profile.phone);
    ro('student-number-input', profile.student_no);
    tx('student-card-name', profile.full_name);
    tx('student-card-id', profile.student_no);
    // Colorful avatar initial mirrors the centered left-column design.
    const avatar = document.getElementById('student-avatar');
    renderProfileEducation();
    renderProfileStats();
    return;
  }

  f.full_name.value = profile.full_name || '';
  f.phone.value = profile.phone || '';
  f.student_no.value = profile.student_no || '';
  // Staff never see the student education group, but keep it correct so the
  // form stays valid if the visibility rule ever changes.
  const levelSel = document.getElementById('profile-educational-level');
  if (levelSel) {
    ensureOption(levelSel, profile.educational_level);
    levelSel.value = profile.educational_level || '';
    renderProfileFormLevelFields();          // rebuild the option lists first
    const courseSel  = document.getElementById('profile-course');
    const yearSel    = document.getElementById('profile-year-level');
    const blockSel   = document.getElementById('profile-block');
    const sectionIn  = document.getElementById('profile-section');
    if (courseSel) { ensureOption(courseSel, profile.course);   courseSel.value = profile.course || ''; }
    if (yearSel)   { ensureOption(yearSel,   profile.year_level); yearSel.value = profile.year_level || ''; }
    if (blockSel)  { ensureOption(blockSel,  profile.block);     blockSel.value = profile.block || ''; }
    if (sectionIn) { sectionIn.value = profile.section || ''; }
  }
  f.department.value = profile.department || '';
  f.title.value = profile.title || '';
  // show only the fields relevant to the role
  document.getElementById('profile-student-fields').classList.toggle('hidden', profile.role !== 'student');
  document.getElementById('profile-staff-fields').classList.toggle('hidden', profile.role === 'student');
  const emailField = document.getElementById('profile-email');
  if (emailField) emailField.value = profile.email;
  renderProfileStats();
}

/** Live stats card: role, account age and an RLS-scoped check-in count. */
async function renderProfileStats() {
  if (!profile) return;
  const roleEls = document.querySelectorAll('#role-display, [data-role-display]');
  roleEls.forEach(el => { el.innerText = ROLE_LABEL[profile.role] || profile.role; });
  const createdEls = document.querySelectorAll('#created-date-display, [data-created-display]');
  if (profile.created_at) {
    const dateStr = new Date(profile.created_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    createdEls.forEach(el => { el.innerText = dateStr; });
  }
  const countEls = document.querySelectorAll('#events-attended-display, [data-events-display]');
  if (countEls.length === 0) return;
  const { count, error } = await supabase
    .from('attendance').select('*', { count: 'exact', head: true })
    .eq('student_id', profile.id);
  if (error) { console.error('renderProfileStats', error); return; }
  countEls.forEach(el => { el.innerText = count || 0; });
}

async function saveProfile(e) {
  e.preventDefault();
  const form = e.target;
  // Students get the read-only card, so this form is normally the staff one.
  // Branch on which field group is actually visible rather than on the role.
  const studentGroup = document.getElementById('profile-student-fields');
  const showStudentFields = studentGroup && !studentGroup.classList.contains('hidden');

  const payload = {
    full_name: form.full_name.value.trim(),
    phone: form.phone.value.trim(),
    student_no: form.student_no.value.trim() || null
  };

  if (showStudentFields) {
    const edu = readLevelFields(form);
    const eduError = validateLevelFields(edu);
    if (eduError) { toast(eduError, 'error'); return; }
    Object.assign(payload, edu);
    // denormalised pair kept in step for the admin reports
    payload.department = edu.course || null;
    payload.grade_class = formatGradeClass(edu.educational_level, edu.year_level, edu.block, edu.section) || null;
  } else {
    payload.department = form.department.value.trim() || null;
    payload.title = form.title.value.trim() || null;
  }

  const { error } = await supabase.from('profiles').update(payload).eq('id', profile.id);
  if (error) { toast('Could not save profile: ' + error.message, 'error'); return; }
  profile = { ...profile, ...payload };
  renderHeader();
  fillProfileForm();
  toast('Profile updated successfully.', 'success');
}

/**
 * Merge a profile patch saved somewhere else into the signed-in user's session
 * copy and refresh the header + Profile tab.
 *
 * js/admin.js calls this when an administrator saves their OWN row from
 * Manage Users: that write suppresses its realtime echo (so the users table
 * does not double-refresh), which would otherwise leave the header and the
 * Profile page's Personal / Educational Information stale until a reload.
 * Changes made to *other* users travel to their clients through the profiles
 * realtime event handled in bootstrap().
 *
 * @param {object} patch the columns that were just written to public.profiles
 */
export function applyLocalProfileUpdate(patch) {
  profile = { ...profile, ...patch };
  Admin.initAdmin(profile);   // keep admin.js's copy (role / id) in step too
  renderHeader();
  if (activeTab === 'profile') fillProfileForm();
}


