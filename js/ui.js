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
  open: 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30',
  draft: 'bg-amber-500/20 text-amber-200 border border-amber-400/30',
  closed: 'bg-white/15 text-slate-300 border border-white/25',
  present: 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/30',
  late: 'bg-amber-500/20 text-amber-200 border border-amber-400/30',
  absent: 'bg-rose-500/20 text-rose-200 border border-rose-400/30',
  excused: 'bg-blue-500/20 text-blue-200 border border-blue-400/30'
};

export function statusBadge(status) {
  const cls = STATUS_STYLES[status] || 'bg-white/15 text-slate-300 border border-white/25';
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
  el.className = `${conf.bg} text-white rounded-xl shadow-2xl px-4 py-3 text-sm flex items-start gap-3 transition-all duration-300 toast-float border border-white/20 backdrop-blur-md`;
  el.innerHTML = `<i class="fa-solid ${conf.icon} mt-0.5"></i><span class="flex-1">${esc(message)}</span>`;
  host.appendChild(el);
  requestAnimationFrame(() => { el.style.transform = 'translateY(0)'; el.style.opacity = '1'; });
  setTimeout(() => {
    el.style.transition = 'all .3s ease-in-out';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-12px) scale(.96)';
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

/** Render a loading / empty / error row inside a <tbody>. */
export function tableMessage(tbody, cols, text, kind = 'empty') {
  const color = kind === 'error' ? 'text-rose-300'
              : kind === 'loading' ? 'text-indigo-300' : 'text-slate-300';
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
