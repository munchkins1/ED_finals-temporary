// js/attendance.js
// Student attendance history + staff attendance records (view / correct / delete).
import { supabase } from './supabaseClient.js';
import { $, esc, statusBadge, toast, tableMessage, fmtDateTime, setBusy } from './ui.js';
import { getEvents, canManage } from './events.js';
import { suppressRealtime } from './app.js';

let profile = null;
export function initAttendance(p) { profile = p; }

/* ===================== STUDENT ===================== */
export async function renderMyAttendance() {
  const tbody = document.getElementById('my-attendance-body');
  if (!tbody) return;
  tableMessage(tbody, 4, 'Loading your attendance history...', 'loading');

  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('attendance')
    .select('id, status, method, recorded_at, events(name, venue, start_datetime)')
    .eq('student_id', user.id)
    .order('recorded_at', { ascending: false });

  if (error) {
    tableMessage(tbody, 4, 'Could not load your attendance.', 'error');
    return;
  }
  const list = data || [];

  // summary card
  const total = list.length;
  const present = list.filter(r => r.status === 'present').length;
  const rate = total ? Math.round((present / total) * 100) : 0;
  const sc = document.getElementById('my-attendance-summary');
  if (sc) {
    sc.innerHTML = `
      <div class="grid grid-cols-3 gap-3">
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <div class="text-2xl font-bold text-indigo-600">${total}</div>
          <div class="text-xs text-slate-500 uppercase font-semibold">Events attended</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <div class="text-2xl font-bold text-emerald-600">${present}</div>
          <div class="text-xs text-slate-500 uppercase font-semibold">Present</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-4 text-center">
          <div class="text-2xl font-bold text-slate-800">${rate}%</div>
          <div class="text-xs text-slate-500 uppercase font-semibold">Attendance rate</div>
        </div>
      </div>`;
  }

  if (list.length === 0) {
    tableMessage(tbody, 4, 'You have no attendance records yet. Scan an event QR code to check in.');
    return;
  }
  tbody.innerHTML = list.map(r => `
    <tr class="hover:bg-slate-50">
      <td class="p-4 font-medium">${esc(r.events?.name || 'Event')}</td>
      <td class="p-4 text-slate-600">${esc(r.events?.venue || '-')}</td>
      <td class="p-4">${statusBadge(r.status)}</td>
      <td class="p-4 text-slate-500 text-sm">${esc(fmtDateTime(r.recorded_at))}</td>
    </tr>`).join('');
}

/* ===================== STAFF (teacher / admin) ===================== */
const STATUS_OPTIONS = ['present', 'late', 'absent', 'excused'];

/** Fill the event filter dropdown with events this staff member can see. */
export function populateRecordsFilter() {
  const sel = document.getElementById('records-event-select');
  if (!sel) return;
  const list = getEvents().filter(e =>
    profile.role === 'admin' || e.created_by === profile.id);
  const keep = sel.value;
  sel.innerHTML = `<option value="">${profile.role === 'admin' ? 'All events' : '-- Select an event --'}</option>` +
    list.map(e => `<option value="${e.id}">${esc(e.name)} (${esc(e.status)})</option>`).join('');
  if (keep) sel.value = keep;
}

export async function renderRecords() {
  const tbody = document.getElementById('records-body');
  if (!tbody) return;
  const eventId = document.getElementById('records-event-select')?.value || '';

  const cols = 5;
  tableMessage(tbody, cols, 'Loading attendance records...', 'loading');

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
      events:events!attendance_event_id_fkey ( name, created_by )
    `)
    .order('recorded_at', { ascending: false });

  if (eventId) query = query.eq('event_id', eventId);

  const { data, error } = await query;
  if (error) {
    console.error(error);
    tableMessage(tbody, cols, 'Could not load records: ' + error.message, 'error');
    return;
  }
  console.log("RAW ATTENDANCE DATA FROM SUPABASE:", JSON.stringify(data, null, 2));
  const rows = data || [];
  renderRecordsSummary(rows);

  const missing = rows.filter(r => !r.student);
  if (missing.length > 0) {
    console.warn(
      `renderRecords: ${missing.length} row(s) returned no student profile. ` +
      'Check RLS on profiles (is_staff / is_active) or missing profile rows (06_backfill_profiles.sql).'
    );
  }

  if (rows.length === 0) {
    tableMessage(tbody, cols, eventId
      ? 'No attendance recorded for this event yet.'
      : 'No attendance records found.');
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const editable = profile.role === 'admin' || (r.events && r.events.created_by === profile.id);
    const opts = STATUS_OPTIONS.map(s =>
      `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');
    const studentName = r.profiles?.full_name || r.student_id || 'Unknown';
    const studentNo = r.student?.student_no || r.profiles?.student_no || '';
    const gradeClass = r.student?.grade_class || r.profiles?.grade_class || '';
    return `
      <tr class="hover:bg-slate-50">
        <td class="p-4">
          <div class="font-semibold">${esc(studentName)}</div>
          <div class="text-xs text-slate-500">${esc(studentNo)} ${esc(gradeClass)}</div>
        </td>
        <td class="p-4 text-slate-600">${esc(r.events?.name || '-')}</td>
        <td class="p-4">
          ${editable
            ? `<select data-status="${r.id}" class="text-xs border border-slate-300 rounded px-2 py-1">${opts}</select>`
            : statusBadge(r.status)}
        </td>
        <td class="p-4 text-slate-500 text-sm">${esc(fmtDateTime(r.recorded_at))}</td>
        <td class="p-4 text-right">
          ${editable
            ? `<button data-del-record="${r.id}" class="px-2.5 py-1 text-xs bg-rose-50 text-rose-600 rounded hover:bg-rose-100 font-medium">Delete</button>`
            : '<span class="text-xs text-slate-400">View only</span>'}
        </td>
      </tr>`;
  }).join('');
}

function renderRecordsSummary(rows) {
  const box = document.getElementById('records-summary');
  if (!box) return;
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const card = (label, val, color) => `
    <div class="bg-white rounded-xl border border-slate-200 p-4 text-center">
      <div class="text-2xl font-bold ${color}">${val}</div>
      <div class="text-xs text-slate-500 uppercase font-semibold">${label}</div>
    </div>`;
  box.innerHTML = `<div class="grid grid-cols-2 sm:grid-cols-5 gap-3">
    ${card('Total', rows.length, 'text-indigo-600')}
    ${card('Present', counts.present, 'text-emerald-600')}
    ${card('Late', counts.late, 'text-amber-600')}
    ${card('Absent', counts.absent, 'text-rose-600')}
    ${card('Excused', counts.excused, 'text-blue-600')}
  </div>`;
}

export async function updateRecordStatus(recordId, status) {
  const { error } = await supabase.from('attendance').update({ status }).eq('id', recordId);
  if (error) { toast('Could not update record: ' + error.message, 'error'); return; }
  suppressRealtime();
  toast('Attendance status updated.', 'success');
  renderRecords();
}

export async function deleteRecord(recordId, rowEl = null) {
  if (!confirm('Delete this attendance record?')) return;
  // Request the removed row back: RLS can make a DELETE a silent no-op
  // (success, zero rows), so only proceed when Supabase confirms removal.
  // (Server-side RLS is the permission check here: teachers may only delete
  // rows for events they own, admins may delete any row.)
  const { data, error } = await supabase.from('attendance').delete().eq('id', recordId).select('id');
  if (error) { console.error('deleteRecord', error); toast('Could not delete record: ' + error.message, 'error'); return; }
  if (!data || data.length === 0) {
    console.error('deleteRecord: 0 rows removed for id', recordId);
    toast('Delete blocked — the record still exists. Check event ownership and try again.', 'error');
    return;
  }
  // Remove the deleted row instantly, then re-fetch so counts stay truthful.
  // The realtime echo is suppressed briefly so it can't resurrect the row.
  if (rowEl && rowEl.isConnected) rowEl.remove();
  suppressRealtime();
  toast('Attendance record deleted.', 'success');
  renderRecords();
}

