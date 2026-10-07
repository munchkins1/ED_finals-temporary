// js/reports.js
// Dashboard overview, CSV export, and (admin) audit log / system reports.
import { supabase } from './supabaseClient.js';
import { $, esc, toast, tableMessage, fmtDateTime, statusBadge } from './ui.js';

let profile = null;

export function initReports(p) {
  profile = p;

  /* Refresh the overview and stat cards automatically whenever shared data
   * changes: 'events:changed' fires on local event edits and from the
   * realtime channel in events.js; 'attendance:changed' fires after a
   * successful check-in. No per-view manual dispatching is needed. */
  document.addEventListener('events:changed', () => { renderOverview(); renderSummaryTable(); });
  document.addEventListener('attendance:changed', () => { renderOverview(); renderSummaryTable(); });
}

export async function renderOverview() {
  const isStaff = profile.role === 'teacher' || profile.role === 'admin';

  // counts (RLS naturally scopes what each role can see)
  const [studentsRes, eventsRes, attendanceRes] = await Promise.all([
    isStaff
      ? supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student')
      : Promise.resolve({ count: null }),
    supabase.from('events').select('id, status', { count: 'exact' }),
    supabase.from('attendance').select('id, recorded_at', { count: 'exact' })
  ]);

  const events = eventsRes.data || [];
  const openEvents = events.filter(e => e.status === 'open').length;
  const attendance = attendanceRes.data || [];
  const today = new Date().toDateString();
  const todayCount = attendance.filter(a => new Date(a.recorded_at).toDateString() === today).length;

  const studentCard = document.getElementById('stat-students');
  const studentLabel = document.getElementById('stat-students-label');
  if (profile.role === 'student') {
    if (studentLabel) studentLabel.innerText = 'Events available';
    setText('stat-students', openEvents);
  } else {
    if (studentLabel) studentLabel.innerText = 'Students';
    setText('stat-students', studentsRes.count ?? '-');
  }

  setText('stat-events', events.length);
  setText('stat-checkins', attendance.length);
  setText('stat-today', todayCount);
  setText('stat-active-events', openEvents);
  // Reports tab mirrors these same four numbers; the stat-*2 ids live there.
  setText('stat-checkins2', attendance.length);
  setText('stat-today2', todayCount);
  setText('stat-events2', events.length);
  setText('stat-open2', openEvents);
}


function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.innerText = val;
}

/** Fills the "Event Attendance Breakdown" table: one row per event with its
 *  venue, date/time, status badge and total check-ins (RLS-scoped counts). */
export async function renderSummaryTable() {
  const tbody = document.getElementById('summary-table-body');
  if (!tbody) return;
  // First paint shows the placeholder; realtime refreshes swap rows silently.
  if (!tbody.querySelector('tr')) tableMessage(tbody, 4, 'Loading summary...', 'loading');

  // Fetch events and attendance records (parallel; both scoped by RLS)
  const [{ data: eventsList, error: eventsErr }, { data: attendanceList }] = await Promise.all([
    supabase.from('events').select('*').order('start_datetime', { ascending: false }),
    supabase.from('attendance').select('event_id')
  ]);

  if (eventsErr) { tableMessage(tbody, 4, 'Could not load summary: ' + eventsErr.message, 'error'); return; }
  if (!eventsList || eventsList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-500">No events found.</td></tr>`;
    return;
  }

  // Map attendance counts per event ID
  const counts = {};
  (attendanceList || []).forEach(record => {
    counts[record.event_id] = (counts[record.event_id] || 0) + 1;
  });

  // Render rows: single clean line per event, uniform widths, vertical centering.
  tbody.innerHTML = eventsList.map(evt => {
    const totalCheckIns = counts[evt.id] || 0;
    return `
      <tr class="border-b border-white/10 hover:bg-white/5 transition-colors duration-200 align-middle">
        <td class="p-4 w-1/4 align-middle font-semibold text-white whitespace-nowrap">${esc(evt.name)}</td>
        <td class="p-4 w-1/4 align-middle text-slate-300 whitespace-nowrap">${fmtDateTime(evt.start_datetime)}</td>
        <td class="p-4 w-1/4 align-middle">${statusBadge(evt.status)}</td>
        <td class="p-4 w-1/4 align-middle text-center font-bold text-indigo-200">${totalCheckIns}</td>
      </tr>
    `;
  }).join('');
}

export async function exportRecordsCSV() {
  const eventId = document.getElementById('records-event-select')?.value || '';
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
  link.download = `campusqr_attendance_${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Attendance exported to CSV.', 'success');
}

export async function renderAuditLog() {
  const tbody = document.getElementById('audit-body');
  if (!tbody) return;
  tableMessage(tbody, 4, 'Loading system log...', 'loading');
  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, action, entity, entity_id, details, created_at, actor:profiles(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) { tableMessage(tbody, 4, 'Could not load log: ' + error.message, 'error'); return; }
  if (!data || data.length === 0) { tableMessage(tbody, 4, 'No system activity recorded yet.'); return; }

  tbody.innerHTML = data.map(l => `
    <tr class="hover:bg-white/5 transition-colors duration-200 align-middle">
      <td class="p-3 w-1/4 align-middle text-xs font-mono text-indigo-200">${esc(l.action)}</td>
      <td class="p-3 w-1/4 align-middle text-sm text-white">${esc(l.actor?.full_name || l.actor?.email || 'system')}</td>
      <td class="p-3 w-1/4 align-middle text-xs text-slate-300">${esc(l.entity || '-')} ${l.entity_id ? `<span class="font-mono">${esc(String(l.entity_id).slice(0, 8))}</span>` : ''}</td>
      <td class="p-3 w-1/4 align-middle text-xs text-slate-300">${esc(fmtDateTime(l.created_at))}</td>
    </tr>`).join('');
}
