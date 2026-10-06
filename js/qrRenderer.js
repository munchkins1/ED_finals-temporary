// js/qrRenderer.js
// Single source of truth for drawing an event QR code.
//
// The library (qrcodejs 1.0.0, loaded as a classic script in app.html) attaches
// a global `QRCode`. It is deliberately NOT imported here: qrcodejs has no ES
// module build, so the global is the only supported integration.
//
// Every render clears the container first. qrcodejs appends BOTH a <canvas> and
// an <img> to the container, so leftover nodes from a previous event would
// otherwise stack up and show two overlapping codes.

import { supabase } from './supabaseClient.js';
import { toast } from './ui.js';

const CORRECT_LEVELS = { L: 'L', M: 'M', Q: 'Q', H: 'H' };
const DEFAULT_SIZE = 512;

/** The payload students scan: CAMPUSQR:<qr_token>. Must match scan.js parseToken(). */
export function qrPayload(evt) {
  return 'CAMPUSQR:' + evt.qr_token;
}

/**
 * Remove every QR node from a container, including the <canvas> and <img>
 * that qrcodejs appends. Safe to call when the container is empty.
 * @param {string|HTMLElement} target container element or its id
 * @returns {HTMLElement|null} the cleared container, or null if not found
 */
export function clearEventQR(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return null;
  // replaceChildren() with no arguments removes all children in one atomic op.
  el.replaceChildren();
  return el;
}

/**
 * Look up an event by id straight from Supabase.
 * Used when the caller has only an id; the RLS policies in sql/03_rls_policies.sql
 * decide what the signed-in user is allowed to see.
 */
async function fetchEventById(eventId) {
  const { data, error } = await supabase
    .from('events')
    .select('id, name, qr_token, status, start_datetime, end_datetime, venue')
    .eq('id', eventId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

/**
 * Render an event QR code into a container.
 *
 * Duplicate prevention: the container is cleared before drawing, so calling this
 * repeatedly for different events never stacks codes.
 *
 * Resolution order for the event:
 *   1. options.event   - an already-loaded event object (no extra request)
 *   2. options.eventId - fetched from Supabase for the signed-in user
 *
 * @param {string|HTMLElement} target container element or its id
 * @param {object}  [options]
 * @param {object}  [options.event]  event row, if already loaded
 * @param {string}  [options.eventId] event id to fetch when `event` is absent
 * @param {number}  [options.size=512] pixels; high resolution so a projected or
 *                                 printed code stays sharp for student devices
 * @param {'L'|'M'|'Q'|'H'} [options.correctLevel='H'] error correction
 * @returns {Promise<{container:HTMLElement, event:object}|null>}
 */
export async function renderEventQR(target, options = {}) {
  const { size = DEFAULT_SIZE, correctLevel = 'H' } = options;

  const container = clearEventQR(target);
  if (!container) {
    console.error('renderEventQR: container not found', target);
    return null;
  }

  if (typeof QRCode === 'undefined') {
    toast('QR library failed to load. Check your internet connection.', 'error');
    return null;
  }

  // Resolve the event: caller-supplied first, Supabase second.
  let evt = options.event || null;
  if (!evt && options.eventId) {
    try {
      evt = await fetchEventById(options.eventId);
    } catch (err) {
      console.error('renderEventQR', err);
      toast('Could not load the event: ' + err.message, 'error');
      return null;
    }
  }
  if (!evt || !evt.qr_token) {
    container.innerHTML =
      '<p class="text-sm text-slate-400 p-6">Select an event to display its QR code for students to scan.</p>';
    return null;
  }

  const level = CORRECT_LEVELS[correctLevel] || 'H';
  // eslint-disable-next-line no-undef
  new QRCode(container, {
    text: qrPayload(evt),
    width: size,
    height: size,
    colorDark: '#0f172a',   // slate-900: maximum contrast against the white page
    colorLight: '#ffffff',  // keep the light modules white so scanners lock on
    correctLevel: QRCode.CorrectLevel[level]
  });

  return { container, event: evt };
}

/** PNG data URL of the code currently in a container, or null if not drawn yet. */
export function qrPngDataUrl(target) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  const canvas = el && el.querySelector('canvas');
  return canvas ? canvas.toDataURL('image/png') : null;
}