// js/events.js
// Event management: list, create, edit, view, close/reopen, delete, and QR generation.
import { supabase } from './supabaseClient.js';
import { esc, fmtDateTime, statusBadge, toast, tableMessage, setBusy, toLocalInputValue } from './ui.js';
import { renderEventQR, qrPayload } from './qrRenderer.js';

let profile = null;
let events = [];

/* Realtime events arrive via the global 'campusqr-global-sync' channel (js/realtime.js)
 * whose dispatcher lives in app.js bootstrap; the cooldown below only filters
 * this client's own local writes. */
/* Cooldown that skips the realtime echo of a local write: saveEvent() /
 * setEventStatus() / deleteEvent() already re-render and dispatch
 * 'events:changed' themselves (mirrors suppressRealtime() in app.js). */
let suppressEventsEchoUntil = 0;
function suppressEventsEcho(ms = 1500) { suppressEventsEchoUntil = Date.now() + ms; }
function eventsEchoSuppressed() { return Date.now() < suppressEventsEchoUntil; }

export function initEvents(p) { profile = p; }

/** Called by the global realtime dispatcher (app.js) when the events table
 *  changes: reload + re-render, then notify every 'events:changed' listener,
 *  unless this client's own echo cooldown is active. Remote changes are also
 *  announced with a toast so students see "event opened" without refreshing;
 *  the cooldown above already filters this client's own local writes. */
export async function refreshEventsRealtime(payload) {
  console.log('Realtime event change received:', payload);
  if (eventsEchoSuppressed()) return;
  // Capture the cached status BEFORE reloading: payload.old only carries the
  // primary key (no REPLICA IDENTITY FULL), so the cache is our "old value".
  const row = payload && payload.new;
  const prevStatus = row && row.id ? (events.find(e => e.id === row.id) || {}).status : null;
  await loadEvents({ silent: true });
  renderEvents();
  document.dispatchEvent(new CustomEvent('events:changed'));

  if (!row || !row.status) return;
  if (payload.eventType === 'INSERT') {
    if (profile && profile.role !== 'student') {
      toast('New event created: ' + (row.name || 'Untitled'), 'info');
    } else if (row.status === 'open') {
      toast((row.name || 'A new event') + ' is now open - you can check in.', 'info');
    }
  } else if (payload.eventType === 'UPDATE' && prevStatus !== row.status) {
    // draft -> open / open -> closed: tell every connected client instantly.
    toast((row.name || 'An event') + ' is now ' + row.status + '.', 'info');
  }
}

export function getEvents() { return events; }
export function getEventById(id) { return events.find(e => e.id === id) || null; }

/** Whether this user may manage (edit/close/delete) the given event. */
export function canManage(evt) {
  if (!profile || !evt) return false;
  return profile.role === 'admin' || evt.created_by === profile.id;
}

export async function loadEvents({ silent = false } = {}) {
  const tbody = document.getElementById('events-table-body');
  if (tbody && !silent) tableMessage(tbody, 4, 'Loading events...', 'loading');

  const isStaff = profile && (profile.role === 'teacher' || profile.role === 'admin');
  const select = isStaff ? '*, creator:profiles(full_name)' : '*';

  const { data, error } = await supabase
    .from('events').select(select).order('start_datetime', { ascending: false });

  if (error) {
    console.error(error);
    if (tbody) tableMessage(tbody, 4, 'Failed to load events.', 'error');
    toast('Failed to load events: ' + error.message, 'error');
    events = [];
    return events;
  }
  events = data || [];
  return events;
}

/** Events in the management table (staff) or the "available events" list (student). */
function visibleEvents() {
  if (!profile) return [];
  if (profile.role === 'admin') return events;
  if (profile.role === 'teacher') return events.filter(e => e.created_by === profile.id);
  return events.filter(e => e.status === 'open');
}

/* ---------------- Event table rendering ---------------- */
export function renderEvents() {
  const tbody = document.getElementById('events-table-body');
  if (!tbody) return;
  const list = visibleEvents();

  if (list.length === 0) {
    tableMessage(tbody, 4, profile && profile.role === 'student'
      ? 'No events are currently open for check-in.'
      : 'No events yet. Click "Create Event" to add one.');
    return;
  }
  tbody.innerHTML = list.map(renderEventRow).join('');
}

function btn(act, id, cls, label, icon) {
  const ic = icon ? '<i class="fa-solid ' + icon + ' mr-1"></i>' : '';
  return '<button data-act="' + act + '" data-id="' + id + '" class="' + cls + '">' + ic + label + '</button>';
}

function renderEventRow(evt) {
  const manage = canManage(evt);
  const actions = manage ? manageActions(evt) : studentActions(evt);
  let html = '<tr class="hover:bg-slate-50 align-top">';
  html += '<td class="p-4"><div class="font-semibold text-slate-800">' + esc(evt.name) + '</div>';
  html += '<div class="text-xs text-slate-500">' + esc(evt.venue || '-') + '</div></td>';
  html += '<td class="p-4 text-slate-600 text-sm">' + esc(fmtDateTime(evt.start_datetime)) + '</td>';
  html += '<td class="p-4">' + statusBadge(evt.status) + '</td>';
  html += '<td class="p-4 text-right space-x-1 whitespace-nowrap">' + actions + '</td></tr>';
  return html;
}

function manageActions(evt) {
  const cls = 'px-2.5 py-1 text-xs rounded font-medium ';
  let html = btn('view', evt.id, 'px-2.5 py-1 text-xs bg-slate-100 text-slate-700 rounded hover:bg-slate-200 font-medium', 'View');
  html += btn('qr', evt.id, cls + 'bg-purple-50 text-purple-600 hover:bg-purple-100', 'QR', 'fa-qrcode');
  html += btn('edit', evt.id, cls + 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100', 'Edit');
  html += evt.status === 'open'
    ? btn('close', evt.id, cls + 'bg-amber-50 text-amber-700 hover:bg-amber-100', 'Close')
    : btn('open', evt.id, cls + 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100', 'Open');
  html += btn('del', evt.id, cls + 'bg-rose-50 text-rose-600 hover:bg-rose-100', 'Delete');
  return html;
}

function studentActions(evt) {
  return btn('view', evt.id, 'px-2.5 py-1 text-xs bg-slate-100 text-slate-700 rounded hover:bg-slate-200 font-medium', 'View')
    + btn('checkin', evt.id, 'px-2.5 py-1 text-xs bg-emerald-50 text-emerald-700 rounded hover:bg-emerald-100 font-medium', 'Check in', 'fa-camera');
}

/* ---------------- Create / Edit modal ---------------- */
let editingId = null;

export function openEventModal(id = null) {
  if (!(profile.role === 'teacher' || profile.role === 'admin')) {
    toast('Only teachers or administrators can manage events.', 'error');
    return;
  }
  editingId = id;
  document.getElementById('event-form').reset();
  document.getElementById('event-modal-title').innerText = id ? 'Edit Event' : 'Create Event';

  if (id) {
    const evt = getEventById(id);
    if (!evt) return;
    document.getElementById('modal-event-name').value = evt.name || '';
    document.getElementById('modal-event-desc').value = evt.description || '';
    document.getElementById('modal-event-venue').value = evt.venue || '';
    document.getElementById('modal-event-start').value = toLocalInputValue(evt.start_datetime);
    document.getElementById('modal-event-end').value = toLocalInputValue(evt.end_datetime);
    document.getElementById('modal-event-status').value = evt.status || 'draft';
  } else {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    document.getElementById('modal-event-start').value = now.toISOString().slice(0, 16);
    document.getElementById('modal-event-status').value = 'open';
  }
  const m = document.getElementById('event-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
}

export function closeEventModal() {
  const m = document.getElementById('event-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
}

export async function saveEvent(e) {
  e.preventDefault();
  const btn = document.querySelector('#event-form button[type="submit"]');
  const start = document.getElementById('modal-event-start').value;
  const end = document.getElementById('modal-event-end').value;

  if (!start) { toast('Start date/time is required.', 'error'); return; }
  if (end && new Date(end) < new Date(start)) {
    toast('End time cannot be before start time.', 'error'); return;
  }

  const eventName = document.getElementById('modal-event-name').value.trim();
  const description = document.getElementById('modal-event-desc').value.trim();
  const venue = document.getElementById('modal-event-venue').value.trim();
  const startDatetime = new Date(start).toISOString();
  const endDatetime = end ? new Date(end).toISOString() : null;
  const status = document.getElementById('modal-event-status').value;

  const payload = {
    name: eventName,
    description: description,
    venue: venue,
    start_datetime: startDatetime,
    end_datetime: endDatetime,
    status: status
  };
  if (!payload.name) { toast('Event name is required.', 'error'); return; }

  setBusy(btn, true, 'Saving...');
  try {
    // Cooldown starts before the write lands so the realtime echo cannot
    // double-render a change this client reloads and dispatches itself.
    suppressEventsEcho();
    if (editingId) {
      const eventId = editingId;
      const { error } = await supabase
        .from('events')
        .update({
          name: eventName,
          description: description,
          venue: venue,
          start_datetime: startDatetime,
          end_datetime: endDatetime,
          status: status
        })
        .eq('id', eventId); // <-- Make sure this line is present and correct!
      if (error) throw error;
      toast('Event updated successfully.', 'success');
    } else {
      const { error } = await supabase.from('events').insert({ ...payload, created_by: profile.id });
      if (error) throw error;
      toast('Event created and QR code generated.', 'success');
    }
    closeEventModal();
    await loadEvents();
    renderEvents();
    document.dispatchEvent(new CustomEvent('events:changed'));
  } catch (err) {
    console.error(err);
    toast('Could not save event: ' + err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
}

export async function setEventStatus(id, status) {
  try {
    suppressEventsEcho();
    const { error } = await supabase.from('events').update({ status }).eq('id', id);
    if (error) throw error;
    toast(status === 'closed' ? 'Event closed.' : ('Event marked as ' + status + '.'), 'success');
    await loadEvents(); renderEvents();
    document.dispatchEvent(new CustomEvent('events:changed'));
  } catch (err) {
    toast('Could not update event: ' + err.message, 'error');
  }
}

export async function deleteEvent(id) {
  if (!confirm('Delete this event and all of its attendance records? This cannot be undone.')) return;
  try {
    suppressEventsEcho();
    const { error } = await supabase.from('events').delete().eq('id', id);
    if (error) throw error;
    toast('Event deleted.', 'success');
    await loadEvents(); renderEvents();
    document.dispatchEvent(new CustomEvent('events:changed'));
  } catch (err) {
    toast('Could not delete event: ' + err.message, 'error');
  }
}

/* ---------------- Event QR code ---------------- */
// The actual drawing is shared with the dashboard "Event QR" tab via
// js/qrRenderer.js, so both screens render identical codes at the same quality.
export { qrPayload };

export async function showEventQR(id) {
  const evt = getEventById(id);
  if (!evt) return;

  // Renders at 512px with H-level error correction for reliable scanning.
  const drawn = await renderEventQR('event-qr-container', { event: evt });
  if (!drawn) return; // renderer has already surfaced the reason

  document.getElementById('event-qr-title').innerText = evt.name;
  document.getElementById('event-qr-meta').innerText =
    fmtDateTime(evt.start_datetime) + ' - ' + (evt.venue || 'No venue');
  document.getElementById('event-qr-token').innerText = evt.qr_token;
  document.getElementById('event-qr-status').innerHTML = statusBadge(evt.status);
  document.getElementById('event-qr-download').dataset.id = evt.id;
  const m = document.getElementById('event-qr-modal');
  m.classList.remove('hidden'); m.classList.add('flex');
}

export function closeEventQR() {
  const m = document.getElementById('event-qr-modal');
  m.classList.add('hidden'); m.classList.remove('flex');
}

export function downloadEventQR() {
  const canvas = document.querySelector('#event-qr-container canvas');
  const evt = getEventById(document.getElementById('event-qr-download').dataset.id);
  if (!canvas || !evt) { toast('QR image is not ready yet.', 'warning'); return; }
  const link = document.createElement('a');
  link.download = 'event-qr-' + evt.name.replace(/\s+/g, '_').toLowerCase() + '.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

