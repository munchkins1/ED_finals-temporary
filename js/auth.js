// js/auth.js
// Authentication + session handling (Supabase Auth) and role helpers.
import { supabase } from './supabaseClient.js';
import { toast } from './ui.js';

/** Current session (or null). */
export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

/**
 * Full profile row (role, name, is_active, ...) for the current user.
 *
 * Throws a descriptive Error on failure. The caller (requireAuth) turns that
 * into a message the user can actually act on.
 */
export async function getProfile() {
  if (!supabase) throw new Error('Supabase client is not initialised.');

  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr) {
    console.error('getProfile/auth.getUser', userErr);
    throw new Error('Your session could not be verified. Please sign in again.');
  }
  if (!user) throw new Error('You are not signed in.');

  const { data, error } = await supabase
    .from('profiles').select('*').eq('id', user.id).single();

  if (error) {
    console.error('getProfile/profiles', error);
    // PGRST116  -> .single() found zero rows: the profile row is missing.
    // 42501     -> permission denied: a genuine RLS problem.
    // 401       -> the access token was rejected / has expired.
    if (error.code === 'PGRST116') {
      throw new Error(
        'No profile row exists for your account. Run sql/06_backfill_profiles.sql ' +
        'in the Supabase SQL Editor to create it.'
      );
    }
    if (error.code === '42501' || /permission denied/i.test(error.message || '')) {
      throw new Error('Permission denied reading your profile (Row Level Security).');
    }
    if (error.code === '401') {
      throw new Error('Your session has expired. Please sign in again.');
    }
    throw new Error(error.message || 'Could not load your profile.');
  }

  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/**
 * Public registration.
 *
 * SECURITY: the role is NEVER accepted from the browser. It is assigned
 * server-side by the handle_new_user() trigger in sql/01_schema.sql (hardened
 * again in 07 and 10), which always inserts role = 'student'. A hand-crafted
 * request that adds `role: "admin"` to `options.data` only writes it into auth
 * user metadata, which the trigger ignores, and the RLS policies plus column
 * privileges prevent any later self-promotion.
 *
 * @param {string} email
 * @param {string} password
 * @param {string} fullName
 * @param {object} meta - self-editable profile fields:
 *   { phone, studentNumber, department, gradeClass,
 *     educational_level, course, year_level, block, section }
 */
export async function signUp(email, password, fullName, meta = {}) {
  const {
    phone, studentNumber, department, gradeClass,
    educational_level, course, year_level, block, section
  } = meta;

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Self-editable profile fields only. Do NOT add role, is_active or any
    // privileged field here: handle_new_user() hardcodes role = 'student' and
    // the column grants block any later self-promotion.
    options: {
      data: {
        full_name: fullName,
        student_no: studentNumber || null,
        phone: phone || null,
        educational_level: educational_level || null,
        course: course || null,
        year_level: year_level || null,
        block: block || null,
        section: section || null,
        // denormalised pair, still read by the admin reports
        department: department || null,
        grade_class: gradeClass || null
      }
    }
  });
  if (error) throw error;

  // Best-effort: once we have a session, copy the student number straight into
  // public.profiles. handle_new_user() does the same at insert time
  // (sql/09_registration_student_no.sql), so this only covers databases where that
  // migration has not been run yet. A failure here never fails the signup itself.
  if (data.session && data.user && studentNumber) {
    const { error: studentNoErr } = await supabase
      .from('profiles')
      .update({ student_no: studentNumber })
      .eq('id', data.user.id);
    if (studentNoErr) console.warn('signUp/student_no', studentNoErr);
  }

  return data;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** Redirect to the auth page if there is no valid, active session. */
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    location.replace('index.html');
    return null;
  }

  // getProfile() throws a descriptive Error; show it before bouncing the user out.
  let profile;
  try {
    profile = await getProfile();
  } catch (err) {
    console.error('requireAuth/getProfile', err);
    toast(err.message || 'Could not load your profile. Please sign in again.', 'error', 6000);
    await signOut();
    setTimeout(() => location.replace('index.html'), 2500);
    return null;
  }

  if (!profile) {
    toast('Could not load your profile. Please sign in again.', 'error');
    await signOut();
    location.replace('index.html');
    return null;
  }
  if (!profile.is_active) {
    toast('Your account has been deactivated. Contact an administrator.', 'error');
    await signOut();
    location.replace('index.html');
    return null;
  }
  return profile;
}

export const ROLE_LABEL = { student: 'Student', teacher: 'Teacher', admin: 'Administrator' };
