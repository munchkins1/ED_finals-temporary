// js/scan.js
// Student QR check-in (camera + manual code) and the secure check_in() RPC call.
import { supabase } from './supabaseClient.js';
import { $, esc, toast, tableMessage } from './ui.js';
import { suppressRealtime } from './app.js';

let html5QrCode = null;
let scanning = false;
let cooldown = false; // prevents duplicate frames firing rapid repeated RPC calls

export function isScanning() { return scanning; }

function parseToken(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  if (text.toUpperCase().startsWith('CAMPUSQR:')) text = text.slice('CAMPUSQR:'.length).trim();
  return text;
}

/** Call the validated server-side RPC that records attendance. */
export async function checkIn(rawToken) {
  const token = parseToken(rawToken);
  if (!token) { showResult('invalid', 'No QR data was detected. Please try again.'); return; }

  const { data, error } = await supabase.rpc('check_in', { p_token: token });
  if (error) {
    console.error(error);
    showResult('error', 'Could not reach the server: ' + error.message);
    return;
  }
  showResult(data.result, data.message, data.event);
  if (data.result === 'success') {
    // The realtime echo of this check-in would otherwise re-run the same refresh.
    suppressRealtime();
    document.dispatchEvent(new CustomEvent('attendance:changed'));
  }
}

function showResult(kind, message, eventName) {
  const box = document.getElementById('scan-result');
  if (!box) return;
  const map = {
    success:      { bg: 'bg-emerald-50 border-emerald-200 text-emerald-800', icon: 'fa-circle-check', label: 'Attendance recorded' },
    duplicate:    { bg: 'bg-amber-50 border-amber-200 text-amber-800',       icon: 'fa-triangle-exclamation', label: 'Already checked in' },
    closed:       { bg: 'bg-slate-100 border-slate-300 text-slate-700',      icon: 'fa-lock', label: 'Event closed' },
    invalid:      { bg: 'bg-rose-50 border-rose-200 text-rose-800',          icon: 'fa-circle-xmark', label: 'Invalid QR code' },
    unauthorized: { bg: 'bg-rose-50 border-rose-200 text-rose-800',          icon: 'fa-ban', label: 'Not permitted' },
    error:        { bg: 'bg-rose-50 border-rose-200 text-rose-800',          icon: 'fa-triangle-exclamation', label: 'Error' }
  };
  const c = map[kind] || map.error;
  box.className = `mt-4 border rounded-lg p-4 text-sm ${c.bg}`;
  box.innerHTML = `
    <div class="font-semibold flex items-center gap-2"><i class="fa-solid ${c.icon}"></i>${esc(c.label)}</div>
    <div class="mt-1">${esc(message || '')}${eventName ? ` (${esc(eventName)})` : ''}</div>`;
  box.classList.remove('hidden');
  const t = { success: 'success', duplicate: 'warning', closed: 'warning', invalid: 'error', unauthorized: 'error', error: 'error' }[kind] || 'info';
  toast(message || c.label, t);
}

export async function startScanner() {
  if (scanning) return;
  if (typeof Html5Qrcode === 'undefined') {
    toast('Scanner library failed to load. Check your internet connection.', 'error');
    return;
  }
  const reader = document.getElementById('reader');
  reader.innerHTML = '';
  html5QrCode = new Html5Qrcode('reader');
  try {
    await html5QrCode.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 220, height: 220 } },
      async (decodedText) => {
        if (cooldown) return;
        cooldown = true;
        await checkIn(decodedText);
        setTimeout(() => { cooldown = false; }, 2500);
      },
      () => { /* per-frame decode misses are expected; ignore */ }
    );
    scanning = true;
    toast('Camera started. Point it at the event QR code.', 'info');
  } catch (err) {
    console.error(err);
    toast('Unable to start camera. Grant permission and use HTTPS or localhost.', 'error');
    reader.innerHTML = 'Camera unavailable';
  }
}

export async function stopScanner() {
  if (html5QrCode && scanning) {
    try { await html5QrCode.stop(); } catch (e) { /* ignore */ }
    scanning = false;
    const reader = document.getElementById('reader');
    if (reader) reader.innerHTML = 'Camera inactive or permission needed';
  }
}

/** Manual fallback: type/paste the event code shown under the QR. */
export async function manualCheckIn() {
  const input = document.getElementById('manual-token');
  await checkIn(input.value);
  input.value = '';
}

/** Load and render the student's own recent check-ins. */
export async function renderMyRecent() {
  const tbody = document.getElementById('scan-recent-body');
  if (!tbody) return;
  tableMessage(tbody, 2, 'Loading...', 'loading');
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('attendance')
    .select('recorded_at, status, events(name)')
    .eq('student_id', user.id)
    .order('recorded_at', { ascending: false })
    .limit(8);
  if (error) { tableMessage(tbody, 2, 'Could not load check-ins.', 'error'); return; }
  if (!data || data.length === 0) {
    tableMessage(tbody, 2, 'No check-ins yet. Scan an event QR code to begin.');
    return;
  }
  tbody.innerHTML = data.map(r => `
    <tr class="hover:bg-slate-50">
      <td class="p-3 font-medium">${esc(r.events?.name || 'Event')}</td>
      <td class="p-3 text-right text-xs text-slate-500">${esc(new Date(r.recorded_at).toLocaleString())}</td>
    </tr>`).join('');
}
