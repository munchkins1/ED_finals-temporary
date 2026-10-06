// js/ui.js
// Small shared UI helpers: DOM shortcuts, toasts, loading, formatting.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escape untrusted text before injecting into innerHTML (XSS protection). */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

export function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const STATUS_STYLES = {
  open: 'bg-emerald-100 text-emerald-700',
  draft: 'bg-amber-100 text-amber-700',
  closed: 'bg-slate-200 text-slate-600',
  present: 'bg-emerald-100 text-emerald-700',
  late: 'bg-amber-100 text-amber-700',
  absent: 'bg-rose-100 text-rose-700',
  excused: 'bg-blue-100 text-blue-700'
};

export function statusBadge(status) {
  const cls = STATUS_STYLES[status] || 'bg-slate-100 text-slate-600';
  return `<span class="px-2.5 py-1 rounded-full text-xs font-semibold ${cls}">${esc(status)}</span>`;
}

/* ---------------- Toasts ---------------- */
function ensureToastHost() {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'fixed top-4 right-4 z-[100] flex flex-col gap-2 w-[min(92vw,360px)]';
    document.body.appendChild(host);
  }
  return host;
}

const TOAST = {
  success: { bg: 'bg-emerald-600', icon: 'fa-circle-check' },
  error:   { bg: 'bg-rose-600',    icon: 'fa-circle-exclamation' },
  info:    { bg: 'bg-indigo-600',  icon: 'fa-circle-info' },
  warning: { bg: 'bg-amber-500',   icon: 'fa-triangle-exclamation' }
};

export function toast(message, type = 'info', timeout = 3800) {
  const host = ensureToastHost();
  const conf = TOAST[type] || TOAST.info;
  const el = document.createElement('div');
  el.className = `${conf.bg} text-white rounded-lg shadow-lg px-4 py-3 text-sm flex items-start gap-3 animate-fade-in`;
  el.innerHTML = `<i class="fa-solid ${conf.icon} mt-0.5"></i><span class="flex-1">${esc(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

/** Render a loading / empty / error row inside a <tbody>. */
export function tableMessage(tbody, cols, text, kind = 'empty') {
  const color = kind === 'error' ? 'text-rose-500'
              : kind === 'loading' ? 'text-indigo-500' : 'text-slate-400';
  const icon = kind === 'loading' ? '<i class="fa-solid fa-spinner fa-spin mr-2"></i>' : '';
  tbody.innerHTML =
    `<tr><td colspan="${cols}" class="p-6 text-center ${color} text-sm">${icon}${esc(text)}</td></tr>`;
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset._html = button.innerHTML;
    button.disabled = true;
    button.innerHTML =
      `<i class="fa-solid fa-spinner fa-spin mr-2"></i>${esc(label || 'Please wait...')}`;
  } else {
    button.disabled = false;
    if (button.dataset._html) button.innerHTML = button.dataset._html;
  }
}
