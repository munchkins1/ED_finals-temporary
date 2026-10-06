// js/realtime.js
// Global Realtime Subscription Initializer: one channel ('campusqr-global-sync')
// mirrors the main tables. The single onDataChanged dispatcher lives in
// app.js bootstrap, which routes each table to its view-refresh function
// (echo suppression, rendering, DOM events and admin gates all live there).

import { supabase } from './supabaseClient.js';
import { toast } from './ui.js';

/** Flips once per outage so we toast on break + recovery, not on every retry. */
let connWarned = false;

export function initGlobalRealtime(onDataChanged) {
  if (!supabase) return; // config missing -> nothing to subscribe to
  // Remove any existing instance of this channel first. (getChannels() finds the
  // live one; supabase.channel(name) alone would just create a new empty one.)
  const existing = supabase.getChannels().find(c => c.topic === 'campusqr-global-sync');
  if (existing) supabase.removeChannel(existing);

  supabase
    .channel('campusqr-global-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' },
      (payload) => {
        console.log('Global Event change:', payload);
        onDataChanged('events', payload);
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' },
      (payload) => {
        console.log('Global Attendance change:', payload);
        onDataChanged('attendance', payload);
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' },
      (payload) => {
        console.log('Global Profile change:', payload);
        onDataChanged('profiles', payload);
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_logs' },
      (payload) => {
        console.log('Global Audit change:', payload);
        onDataChanged('audit_logs', payload);
      })
    .subscribe((status) => {
      console.log('Global Realtime status:', status);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (!connWarned) { connWarned = true; toast('Live updates interrupted - retrying...', 'warning'); }
      } else if (status === 'SUBSCRIBED' && connWarned) {
        connWarned = false;
        toast('Live updates restored.', 'success');
      }
    });
}