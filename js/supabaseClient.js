// js/supabaseClient.js
// Creates the shared Supabase client. The config comes from the git-ignored
// `supabase-config.js` (see `supabase-config.example.js`).
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.SUPABASE_CONFIG || {};
export const CONFIG_OK = Boolean(cfg.url && cfg.anonKey) &&
  !String(cfg.url).includes('YOUR-PROJECT-REF');

export const supabase = CONFIG_OK
  ? createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;
