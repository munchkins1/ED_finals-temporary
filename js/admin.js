// js/admin.js
// Administrator section ONLY. Every export below is gated on role === 'admin'
// and uses its own DOM ids (admin-*) so it can never collide with, or leak
// into, the shared student/teacher tabs (events.js / attendance.js).
import { supabase } from './supabaseClient.js';
import { $, esc, toast, tableMessage, statusBadge, fmtDateTime } from './ui.js';
import { suppressRealtime, realtimeSuppressed, applyLocalProfileUpdate } from './app.js';
import {
  COURSES, YEARS, BLOCKS, courseLabel, yearLabel,
  fillSelect, ensureOption, applyLevelFields, readLevelFields,
  formatGradeClass, parseGradeClass, validateLevelFields, validatePhone
} from './education.js';

let profile = null;
let users = [];
const STATUS_OPTIONS = ['present', 'late', 'absent', 'excused'];

/* Columns saveUserProfile() submits, plus the labels used when the database
 * refuses to write them. Also the set compared against the reloaded row. */
const PROFILE_FIELDS = [
  'full_name', 'phone', 'student_no', 'title',
  'educational_level', 'course', 'year_level', 'block', 'section',
  'department', 'grade_class'
];
const PROFILE_FIELD_LABELS = {
  full_name: 'Full name', phone: 'Phone', student_no: 'School ID', title: 'Title',
  educational_level: 'Educational Level', course: 'Course / Track',
  year_level: 'Year / Grade Level', block: 'Block', section: 'Section',
  department: 'Department', grade_class: 'Grade / Class'
};
/** The database and the payload can disagree on null vs '' and 3 vs '3'. */
const norm = v => (v === null || v === undefined) ? '' : String(v);

export function initAdmin(p) { profile = p; }

/** Called by the global realtime dispatcher (app.js) when profiles change:
 *  reload + re-render the Manage Users table. Admins only, and the echo of a
 *  local mutation (changeRole/toggleActive/saveUserProfile) is skipped. */
export async function refreshUsersRealtime() {
  if (!requireAdmin() || realtimeSuppressed()) return;
  await loadUsers({ silent: true });
  renderUsers();
}

/** Hard gate: every admin-section renderer returns early unless the user is an admin. */
function requireAdmin() {
  return Boolean(profile && profile.role === 'admin');
}

export async function loadUsers({ silent = false } = {}) {
  const tbody = document.getElementById('users-body');
  if (tbody && !silent) tableMessage(tbody, 5, 'Loading users...', 'loading');
  const { data, error } = await supabase
    .from('profiles').select('*').order('created_at', { ascending: false });
  if (error) {
    if (tbody) tableMessage(tbody, 5, 'Could not load users.', 'error');
    toast('Could not load users: ' + error.message, 'error');
    users = [];
    return false;
  }
  users = data || [];
  return true;
}

function roleBadge(role) {
  const map = {
    admin: 'bg-purple-500/20 text-purple-200 border border-purple-400/30',
    teacher: 'bg-blue-500/20 text-blue-200 border border-blue-400/30',
    student: 'bg-white/15 text-slate-200 border border-white/25'
  };
  return `<span class="px-2.5 py-1 rounded-full text-xs font-semibold ${map[role] || ''}">${esc(role)}</span>`;
}

/* ---------- Manage Users → "Details" column ----------
 * One row per field, in the format the registrar asked for:
 *   College            -> Student ID, Course, Year Level (1st–4th Year), Block
 *   Senior High School -> Student ID, Track, Grade Level (11–12), Section
 *   Junior High School -> Student ID, Grade Level, Section
 *   Elementary         -> Student ID, Grade Level, Section
 *
 * Accounts created before sql/10_education_levels.sql have no stored
 * `educational_level`, so the level is inferred and the values are recovered
 * from the denormalised `grade_class` through parseGradeClass(). A row with
 * nothing education-related at all (staff accounts) only prints Student ID. */

/** College: "1" → "1st Year". School levels: "11" → "Grade 11". */
function formatYearOrGrade(level, raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (level !== 'college') return `Grade ${digits}`;
  const n = parseInt(digits, 10);
  const suffix = (n % 100 >= 11 && n % 100 <= 13) ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix} Year`;
}

/**
 * The stored level, or a best-effort guess for accounts that predate
 * sql/10_education_levels.sql (whose `department` / `grade_class` still hold
 * legacy free text such as "College Department" or "Grade 11-A").
 * @returns {'college'|'senior_high'|'junior_high'|'elementary'|''}
 */
function inferEducationalLevel(u) {
  if (u.educational_level) return u.educational_level;
  const dept  = String(u.course || u.department || '').trim();
  const grade = String(u.grade_class || '').trim();

  if (u.block || /^year\b/i.test(grade) || /college/i.test(dept) ||
      (COURSES.college || []).includes(dept)) return 'college';
  if (/senior/i.test(dept))  return 'senior_high';
  if (/junior/i.test(dept))  return 'junior_high';
  if (/element|kindergarten/i.test(dept)) return 'elementary';

  let n = parseInt(String(u.year_level || '').replace(/\D/g, ''), 10);
  if (!n) { const m = grade.match(/grade\s+(\d+)/i); n = m ? parseInt(m[1], 10) : 0; }
  if (n >= 11 && n <= 12) return 'senior_high';
  if (n >= 7  && n <= 10) return 'junior_high';
  if (n >= 1  && n <= 6)  return 'elementary';
  return '';
}

/** Build the labelled Student ID / Course / Year / Block ... block for one row. */
function renderUserDetails(u) {
  // Staff accounts hold no student details: labels are omitted entirely and
  // four centered "-" lines mirror a student row's text-xs height and gap-y-1
  // rhythm, so every Details cell keeps the exact same vertical structure.
  if (u.role !== 'student') {
    return `<div class="grid grid-cols-1 gap-y-1 text-xs">
      ${['-', '-', '-', '-'].map(v => `<div class="text-slate-700 font-medium text-center">${v}</div>`).join('')}
    </div>`;
  }
  const level  = inferEducationalLevel(u);
  const parsed = parseGradeClass(u.grade_class);
  const set    = v => String(v || '').trim() || '-';
  const year   = String(u.year_level || parsed.year || '').trim();
  // `department` mirrors `course` on modern rows, but legacy accounts store
  // free text there ("College Department" / "Senior High"), so it is only
  // trusted when it is a real course/track for this level.
  const rawCourse = String(u.course || u.department || '').trim();
  const course = u.course || ((COURSES[level] || []).includes(rawCourse) ? rawCourse : '');

  const rows = [['Student ID', set(u.student_no)]];

  if (level === 'college') {
    rows.push(['Course',      set(course)]);
    rows.push(['Year Level',  year ? formatYearOrGrade(level, year) : 'Not set']);
    rows.push(['Block',       set(u.block || parsed.block)]);
  } else if (level === 'senior_high') {
    rows.push(['Track',       set(course)]);
    rows.push(['Grade Level', year ? formatYearOrGrade(level, year) : 'Not set']);
    rows.push(['Section',     set(u.section || parsed.section)]);
  } else if (level === 'junior_high' || level === 'elementary') {
    rows.push(['Grade Level', year ? formatYearOrGrade(level, year) : 'Not set']);
    rows.push(['Section',     set(u.section || parsed.section)]);
  } else if (u.grade_class || u.department) {
    // Level still unknown (an old account an admin has not classified yet):
    // show what is stored instead of inventing labels.
    if (u.grade_class) rows.push(['Grade / Class', u.grade_class]);
    if (u.department)  rows.push(['Department',    u.department]);
  }

  return `<div class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
    ${rows.map(([label, value]) => `
      <div class="text-slate-400 font-semibold whitespace-nowrap">${esc(label)}</div>
      <div class="text-slate-700 font-medium break-words">${esc(value)}</div>`).join('')}
  </div>`;
}

export function renderUsers() {
  const tbody = document.getElementById('users-body');
  if (!tbody) return;
  const term = (document.getElementById('user-search')?.value || '').toLowerCase().trim();
  const list = users.filter(u =>
    !term ||
    (u.full_name || '').toLowerCase().includes(term) ||
    (u.email || '').toLowerCase().includes(term) ||
    (u.student_no || '').toLowerCase().includes(term));

  if (list.length === 0) {
    tableMessage(tbody, 5, term ? 'No users match your search.' : 'No users found.');
    return;
  }

  tbody.innerHTML = list.map(u => {
    const isSelf = u.id === profile.id;
    const roleOpts = ['student', 'teacher', 'admin'].map(r =>
      `<option value="${r}" ${r === u.role ? 'selected' : ''}>${r}</option>`).join('');
    return `
      <tr class="hover:bg-white/5 transition-colors duration-200 align-middle">
        <td class="p-4 w-1/5 align-middle">
          <div class="font-semibold text-white">${esc(u.full_name || '(no name)')}</div>
          <div class="text-xs text-slate-300">${esc(u.email)}</div>
        </td>
        <td class="p-4 w-1/5 align-middle">${renderUserDetails(u)}</td>
        <td class="p-4 w-1/5 align-middle">${roleBadge(u.role)}</td>
        <td class="p-4 w-1/5 align-middle">
          ${u.is_active
            ? '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-200">Active</span>'
            : '<span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/20 text-rose-200">Inactive</span>'}
        </td>
        <td class="p-4 w-1/5 align-middle text-right whitespace-nowrap">
          <select data-role-user="${u.id}" ${isSelf ? 'disabled' : ''} class="text-xs border border-white/20 bg-white/10 text-white rounded px-2 py-1 transition-all duration-200 ease-in-out ${isSelf ? 'opacity-50' : ''}">${roleOpts}</select>
          <button data-edit-user="${u.id}" class="px-2.5 py-1 text-xs bg-indigo-500/20 text-indigo-200 rounded hover:bg-indigo-500/30 font-medium transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95">Edit</button>
          <button data-toggle-active="${u.id}" data-active="${u.is_active}" ${isSelf ? 'disabled' : ''}
            class="px-2.5 py-1 text-xs rounded font-medium transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95 ${isSelf ? 'bg-white/10 text-slate-400 cursor-not-allowed' : (u.is_active ? 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30' : 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30')}">
            ${u.is_active ? 'Deactivate' : 'Activate'}
          </button>
        </td>
      </tr>`;
  }).join('');
}

export async function changeRole(userId, role) {
  const { data, error } = await supabase.rpc('admin_set_role', { p_user_id: userId, p_role: role });
  if (error) { toast('Could not change role: ' + error.message, 'error'); return; }
  suppressRealtime(); // ignore this change's realtime echo
  if (data.result !== 'success') { toast(data.message, 'error'); return; }
  toast(data.message, 'success');
  await loadUsers(); renderUsers();
}

export async function toggleActive(userId, currentActive) {
  const { data, error } = await supabase.rpc('admin_set_active',
    { p_user_id: userId, p_active: !currentActive });
  if (error) { toast('Could not update account: ' + error.message, 'error'); return; }
  suppressRealtime(); // ignore this change's realtime echo
  if (data.result !== 'success') { toast(data.message, 'error'); return; }
  toast(data.message, 'success');
  await loadUsers(); renderUsers();
}

/* ---------- edit user profile modal ---------- */
let editId = null;

/**
 * Repopulate + show/hide the level-driven selects in the edit-user modal.
 * Called on every open and on every Educational Level change (delegated from
 * app.js, which owns the single document-level change listener).
 */
export function renderEditUserLevelFields() {
  const levelSel = document.getElementById('modal-user-level');
  const form = document.getElementById('user-form');
  if (!levelSel || !form) return;
  const level = levelSel.value;
  const waiting = level ? 'Select...' : 'Select Educational Level first';

  fillSelect(document.getElementById('modal-user-course'), COURSES[level], { placeholder: waiting });
  fillSelect(document.getElementById('modal-user-year'),   YEARS[level],   { placeholder: waiting });
  fillSelect(document.getElementById('modal-user-block'),  BLOCKS,         { placeholder: 'Select Block...' });

  applyLevelFields(form, level);

  const c = document.getElementById('modal-user-course-label');
  if (c) c.textContent = courseLabel(level);
  const y = document.getElementById('modal-user-year-label');
  if (y) y.textContent = yearLabel(level);
}

export function openEditUser(id) {
  const u = users.find(x => x.id === id);
  if (!u) return;
  editId = id;
  $('#modal-user-name').value = u.full_name || '';
  $('#modal-user-phone').value = u.phone || '';
  $('#modal-user-studentno').value = u.student_no || '';
  $('#modal-user-title').value = u.title || '';
  // Sign-in address: shown for identification, never submitted (see the modal
  // comment - it is outside the column-level UPDATE grant on purpose).
  $('#modal-user-email').value = u.email || '';

  // Rebuild the option lists for this level BEFORE restoring the values, so
  // ensureOption() has a full list to check against.
  const levelSel = $('#modal-user-level');
  ensureOption(levelSel, u.educational_level);
  levelSel.value = u.educational_level || '';
  renderEditUserLevelFields();

  const courseSel = $('#modal-user-course');
  const yearSel   = $('#modal-user-year');
  const blockSel  = $('#modal-user-block');
  ensureOption(courseSel, u.course);    courseSel.value = u.course || '';
  ensureOption(yearSel,   u.year_level); yearSel.value   = u.year_level || '';
  ensureOption(blockSel,  u.block);      blockSel.value  = u.block || '';
  $('#modal-user-section').value = u.section || '';

  const m = document.getElementById('user-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
}

export function closeEditUser() {
  const m = document.getElementById('user-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
}

export async function saveUserProfile(e) {
  e.preventDefault();
  const edu = readLevelFields(e.target);

  // ---- personal information validation (same rules as registration/profile)
  const fullName = $('#modal-user-name').value.trim();
  if (!fullName) { toast('Please enter the user\'s full name.', 'error'); return; }

  const phone = $('#modal-user-phone').value.trim();
  const phoneError = validatePhone(phone);
  if (phoneError) { toast(phoneError, 'error'); return; }

  // Choosing "Not set" clears the whole education group (applyLevelFields()
  // disables every dependent control, so readLevelFields() reads nulls) and is
  // allowed. When a level IS chosen, it has to be complete - the same
  // validateLevelFields() rule the registration form and profile use.
  if (edu.educational_level) {
    const eduError = validateLevelFields(edu);
    if (eduError) { toast(eduError, 'error'); return; }
  }

  const payload = {
    full_name: fullName,
    phone,
    student_no: $('#modal-user-studentno').value.trim() || null,
    title: $('#modal-user-title').value.trim() || null,
    educational_level: edu.educational_level,
    course:            edu.course,
    year_level:        edu.year_level,
    block:             edu.block,
    section:           edu.section,
    // denormalised pair, regenerated from the columns above so the reports in
    // js/reports.js and the Manage Users table stay in step
    department: edu.course || null,
    grade_class: formatGradeClass(edu.educational_level, edu.year_level, edu.block, edu.section) || null
  };

  // PostgREST may answer an UPDATE with an empty body ("no content") even when
  // the write succeeded, while an RLS-blocked write answers with success and
  // zero rows. Neither response shape can prove anything on its own, so the
  // saved ROW is the source of truth: reload it and compare what was actually
  // submitted. A save that landed is therefore never reported as blocked - no
  // matter which columns were changed - and one that did not names exactly
  // which fields the database refused.
  const { error } = await supabase
    .from('profiles').update(payload).eq('id', editId).select('id');
  if (error) { console.error('saveUserProfile', error); toast('Could not save user: ' + error.message, 'error'); return; }

  suppressRealtime(); // ignore this change's realtime echo

  const loaded = await loadUsers();
  const row = loaded ? users.find(u => u.id === editId) : null;

  if (loaded && !row) {
    renderUsers();
    toast('Save blocked - that account no longer exists. The list has been refreshed.', 'error');
    return;
  }
  const refused = row ? PROFILE_FIELDS.filter(k => norm(row[k]) !== norm(payload[k])) : [];
  if (refused.length) {
    renderUsers();
    toast('Save blocked - the database kept the old value for: ' +
      refused.map(k => PROFILE_FIELD_LABELS[k]).join(', ') +
      '. Nothing was written. Usual cause: the UPDATE policies/grants on public.profiles are out of date - run the "Fix: Save blocked" SQL in SUPABASE_SQL.md (sql/11_crud_policies.sql).', 'error');
    return;
  }

  toast('User profile updated.', 'success');
  closeEditUser();

  // Manage Users already holds the reloaded rows - render the new details now.
  renderUsers();

  // Editing your OWN row: the realtime echo is suppressed on this client, so
  // patch the session copy here - the header and the Profile tab's Personal /
  // Educational Information refresh immediately instead of on the next reload.
  // Other users' clients pick the change up through the profiles realtime
  // event (see the dispatcher in js/app.js).
  if (editId && editId === profile?.id) applyLocalProfileUpdate(payload);

  renderAdminOverview();
}

/* ---------- School-wide attendance oversight ---------- */
/** Admin-only. RLS (profiles_admin_all / audit_select_admin) scopes what is returned. */
export async function renderAdminOverview() {
  const box = document.getElementById('admin-overview');
  if (!box || !profile || profile.role !== 'admin') return;

  box.innerHTML = '<p class="text-sm text-slate-400">Loading attendance overview...</p>';

  const [eventsRes, attRes] = await Promise.all([
    supabase.from('events').select('id, name, status, start_datetime'),
    supabase.from('attendance').select('event_id, status, recorded_at')
  ]);

  if (eventsRes.error || attRes.error) {
    box.innerHTML = `<p class="text-sm text-rose-300">${
      esc((eventsRes.error || attRes.error).message)}</p>`;
    return;
  }

  const events = eventsRes.data || [];
  const attendance = attRes.data || [];

  // Roll attendance up per event so an admin sees totals across the whole school.
  const byEvent = new Map();
  attendance.forEach(a => {
    if (!byEvent.has(a.event_id)) byEvent.set(a.event_id, { total: 0, present: 0 });
    const bucket = byEvent.get(a.event_id);
    bucket.total += 1;
    if (a.status === 'present' || a.status === 'late') bucket.present += 1;
  });

  if (events.length === 0) {
    box.innerHTML = '<p class="text-sm text-slate-400">No events have been created yet.</p>';
    return;
  }

  const card = (label, val, color) => `
    <div class="bg-white/15 backdrop-blur-md border border-white/30 shadow-2xl rounded-3xl p-4 text-center">
      <div class="${color} font-bold text-2xl">${val}</div>
      <div class="text-slate-100 text-xs uppercase font-semibold">${label}</div>
    </div>`;

  const totals = { present: 0, late: 0, absent: 0, excused: 0 };
  attendance.forEach(a => { totals[a.status] = (totals[a.status] || 0) + 1; });

  box.innerHTML = `
    <div class="grid grid-cols-4 lg:grid-cols-5 gap-4 mb-5">
      ${card('Events', events.length, 'text-white')}
      ${card('Check-ins', attendance.length, 'text-white')}
      ${card('Present', totals.present, 'text-white')}
      ${card('Late', totals.late, 'text-white')}
      ${card('Absent', totals.absent, 'text-white')}
    </div>
    <div class="w-full overflow-x-auto">
      <table class="w-full text-left border-collapse text-sm min-w-[520px]">
        <thead class="bg-white/10 text-slate-200 uppercase text-xs">
          <tr class="hover:bg-white/5 transition-colors duration-200">
            <th class="p-3 flex-1 align-middle">Event</th>
            <th class="p-3 flex-1 align-middle">Status</th>
            <th class="p-3 flex-1 align-middle">Date</th>
            <th class="p-3 flex-1 align-middle text-right">Check-ins</th>
            <th class="p-3 flex-1 align-middle text-right">Attended</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/10">
          ${events.map(e => {
            const b = byEvent.get(e.id) || { total: 0, present: 0 };
            return `<tr class="hover:bg-white/5 transition-colors duration-200 align-middle">
              <td class="p-3 flex-1 align-middle font-medium text-white whitespace-nowrap">${esc(e.name)}</td>
              <td class="p-3 flex-1 align-middle">${statusBadge(e.status)}</td>
              <td class="p-3 flex-1 align-middle text-slate-300 whitespace-nowrap">${esc(fmtDateTime(e.start_datetime))}</td>
              <td class="p-3 flex-1 align-middle text-right text-white">${b.total}</td>
              <td class="p-3 flex-1 align-middle text-right text-emerald-300 font-semibold">${b.present}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}
/* ============ 2. MANAGE EVENTS (admin only) ============ */

/** Fill the admin-only event filter. Admins may filter across every event. */
export function populateAdminRecordsFilter(events) {
  const sel = document.getElementById('admin-records-event-select');
  if (!sel || !requireAdmin()) return;
  const list = Array.isArray(events) ? events : [];
  const keep = sel.value;
  sel.innerHTML = '<option value="">All events</option>' +
    list.map(e => `<option value="${esc(String(e.id))}">${esc(e.name)} (${esc(e.status)})</option>`).join('');
  if (keep) sel.value = keep;
}

export async function renderAdminEvents() {
  const tbody = document.getElementById('admin-events-body');
  if (!tbody || !requireAdmin()) return;
  tableMessage(tbody, 4, 'Loading events...', 'loading');

  const { data, error } = await supabase
    .from('events')
    .select('id, name, venue, status, start_datetime')
    .order('start_datetime', { ascending: false });

  if (error) {
    tableMessage(tbody, 4, 'Could not load events: ' + error.message, 'error');
    return;
  }
  const rows = data || [];
  if (rows.length === 0) {
    tableMessage(tbody, 4, 'No events yet. Use "Create Event" to add one.');
    return;
  }

  tbody.innerHTML = rows.map(e => `
    <tr class="hover:bg-white/5 transition-colors duration-200 align-middle">
      <td class="p-4 w-1/4 align-middle">
        <div class="font-semibold text-white whitespace-nowrap">${esc(e.name)}</div>
        <div class="text-xs text-slate-300">${e.venue ? esc(e.venue) : ''}</div>
      </td>
      <td class="p-4 w-1/4 align-middle text-slate-300 text-sm whitespace-nowrap">${esc(fmtDateTime(e.start_datetime))}</td>
      <td class="p-4 w-1/4 align-middle">${statusBadge(e.status)}</td>
      <td class="p-4 w-1/4 align-middle text-right">
        <div class="inline-flex items-center gap-1 whitespace-nowrap justify-end">
          <button data-admin-act="qr" data-id="${e.id}"
            class="px-2.5 py-1 text-xs bg-purple-500/20 text-purple-200 rounded hover:bg-purple-500/30 font-medium transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95">QR</button>
          <button data-admin-act="edit" data-id="${e.id}"
            class="px-2.5 py-1 text-xs bg-indigo-500/20 text-indigo-200 rounded hover:bg-indigo-500/30 font-medium transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95">Edit</button>
          ${e.status === 'open'
            ? `<button data-admin-act="close" data-id="${e.id}"
                 class="px-2.5 py-1 text-xs bg-amber-500/20 text-amber-200 rounded hover:bg-amber-500/30 font-medium transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95">Close</button>`
            : `<button data-admin-act="open" data-id="${e.id}"
                 class="px-2.5 py-1 text-xs bg-emerald-500/20 text-emerald-200 rounded hover:bg-emerald-500/30 font-medium transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95">Open</button>`}
          <button data-admin-act="del" data-id="${e.id}"
            class="px-2.5 py-1 text-xs bg-rose-500/20 text-rose-200 rounded hover:bg-rose-500/30 font-medium transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95">Delete</button>
        </div>
      </td>
    </tr>`).join('');
}
/* ====== 3. MANAGE / CORRECT ATTENDANCE RECORDS (admin only) ====== */

export async function renderAdminRecords() {
  const tbody = document.getElementById('admin-records-body');
  if (!tbody || !requireAdmin()) return;
  const eventId = document.getElementById('admin-records-event-select')?.value || '';

  tableMessage(tbody, 5, 'Loading attendance records...', 'loading');

  // Attendance fetch with FK embeds. `attendance` has TWO FKs to profiles
  // (student_id, recorded_by), so the profiles embed MUST name the exact
  // constraint (see sql/01_schema.sql). The events column is `name`.
  let query = supabase
    .from('attendance')
    .select(`
      id,
      status,
      recorded_at,
      student_id,
      event_id,
      profiles:profiles!attendance_student_id_fkey ( full_name ),
      events:events!attendance_event_id_fkey ( name )
    `)
    .order('recorded_at', { ascending: false });
  if (eventId) query = query.eq('event_id', eventId);

  const { data, error } = await query;
  if (error) {
    tableMessage(tbody, 5, 'Could not load records: ' + error.message, 'error');
    return;
  }
  console.log("RAW ATTENDANCE DATA FROM SUPABASE:", JSON.stringify(data, null, 2));
  const rows = data || [];
  renderAdminRecordsSummary(rows);

  const missing = rows.filter(r => !r.student);
  if (missing.length > 0) {
    console.warn(
      `renderAdminRecords: ${missing.length} row(s) returned no student profile. ` +
      'Check RLS on profiles (is_admin / is_active) or missing profile rows (06_backfill_profiles.sql).'
    );
  }

  if (rows.length === 0) {
    tableMessage(tbody, 5, eventId
      ? 'No attendance recorded for this event yet.'
      : 'No attendance records found.');
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const opts = STATUS_OPTIONS.map(s =>
      `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');
    const studentName = r.profiles?.full_name || r.student_id || 'Unknown';
    const studentNo = r.student?.student_no || r.profiles?.student_no || '';
    const gradeClass = r.student?.grade_class || r.profiles?.grade_class || '';
    return `
      <tr class="hover:bg-white/5 transition-colors duration-200 align-middle">
        <td class="p-4 w-1/5 align-middle">
          <div class="font-semibold text-white">${esc(studentName)}</div>
          <div class="text-xs text-slate-300">${esc(studentNo)} ${esc(gradeClass)}</div>
        </td>
        <td class="p-4 w-1/5 align-middle text-slate-200">${esc(r.events?.name || '-')}</td>
        <td class="p-4 w-1/5 align-middle">
          <select data-admin-status="${r.id}"
            class="text-xs border border-white/20 bg-white/10 text-white rounded px-2 py-1 focus:ring-2 focus:ring-indigo-400 focus:outline-none transition-all duration-200 ease-in-out">${opts}</select>
        </td>
        <td class="p-4 w-1/5 align-middle text-slate-300 text-sm">${esc(fmtDateTime(r.recorded_at))}</td>
        <td class="p-4 w-1/5 align-middle text-right">
          <button data-admin-del-record="${r.id}"
            class="px-2.5 py-1 text-xs bg-rose-500/20 text-rose-200 rounded hover:bg-rose-500/30 font-medium whitespace-nowrap transition-all duration-200 ease-in-out hover:scale-[1.03] active:scale-95">Delete</button>
        </td>
      </tr>`;
  }).join('');
}

function renderAdminRecordsSummary(rows) {
  const box = document.getElementById('admin-records-summary');
  if (!box) return;
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const card = (label, val, color) => `
    <div class="bg-white/15 backdrop-blur-md border border-white/30 shadow-2xl rounded-3xl p-4 text-center">
      <div class="text-2xl font-bold ${color} text-center">${val}</div>
      <div class="text-xs text-slate-100 uppercase font-semibold text-center">${label}</div>
    </div>`;
  box.innerHTML = `<div class="grid grid-cols-4 lg:grid-cols-5 gap-4">
    ${card('Total', rows.length, 'text-white')}
    ${card('Present', counts.present, 'text-white')}
    ${card('Late', counts.late, 'text-white')}
    ${card('Absent', counts.absent, 'text-white')}
    ${card('Excused', counts.excused, 'text-white')}
  </div>`;
}

export async function updateAdminRecordStatus(recordId, status) {
  if (!requireAdmin()) return;
  const { error } = await supabase.from('attendance').update({ status }).eq('id', recordId);
  if (error) { toast('Could not update record: ' + error.message, 'error'); return; }
  suppressRealtime();
  toast('Attendance status updated.', 'success');
  renderAdminRecords();
  renderAdminOverview();
}

export async function deleteAdminRecord(recordId, rowEl = null) {
  if (!requireAdmin()) return;
  if (!confirm('Delete this attendance record? This cannot be undone.')) return;
  // Request the removed row back: RLS can make a DELETE a silent no-op
  // (success, zero rows), so only proceed when Supabase confirms removal.
  const { data, error } = await supabase.from('attendance').delete().eq('id', recordId).select('id');
  if (error) { console.error('deleteAdminRecord', error); toast('Could not delete record: ' + error.message, 'error'); return; }
  if (!data || data.length === 0) {
    console.error('deleteAdminRecord: 0 rows removed for id', recordId);
    toast('Delete blocked — the record still exists. Check your permissions and try again.', 'error');
    return;
  }
  // Remove the deleted row instantly, then re-fetch so counts stay truthful.
  // The realtime echo is suppressed briefly so it can't resurrect the row.
  if (rowEl && rowEl.isConnected) rowEl.remove();
  suppressRealtime();
  toast('Attendance record deleted.', 'success');
  renderAdminRecords();
  renderAdminOverview();
}
/* ====== 4. SYSTEM RECORDS / REPORTS (admin only) ====== */

export async function exportAdminCSV() {
  if (!requireAdmin()) return;
  const eventId = document.getElementById('admin-records-event-select')?.value || '';

  let query = supabase.from('attendance').select(
    'status, method, recorded_at, ' +
    'student:profiles!attendance_student_id_fkey(full_name, student_no, grade_class, email), ' +
    'events!attendance_event_id_fkey(name, venue, start_datetime)'
  ).order('recorded_at', { ascending: false });
  if (eventId) query = query.eq('event_id', eventId);

  const { data, error } = await query;
  if (error) { toast('Export failed: ' + error.message, 'error'); return; }
  if (!data || data.length === 0) { toast('No records to export.', 'warning'); return; }

  const rows = [['Student Name', 'Student No', 'Grade/Class', 'Event', 'Venue', 'Status', 'Method', 'Recorded At']];
  data.forEach(r => rows.push([
    (r.student?.full_name || '').trim() || r.student?.email || '', r.student?.student_no || '', r.student?.grade_class || '',
    r.events?.name || '', r.events?.venue || '', r.status, r.method,
    new Date(r.recorded_at).toLocaleString()
  ]));

  const csv = rows.map(row =>
    row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `campusqr_admin_report_${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Report exported to CSV.', 'success');
}
