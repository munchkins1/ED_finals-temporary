// js/authPage.js
// Login / registration page logic (runs on index.html).
import { supabase, CONFIG_OK } from './supabaseClient.js';
import { toast, setBusy } from './ui.js';
import { signIn, signUp, signOut } from './auth.js';
import {
  COURSES, YEARS, BLOCKS,
  fillSelect, applyLevelFields, readLevelFields,
  validateLevelFields, validatePhone, formatGradeClass,
  courseLabel, yearLabel
} from './education.js';

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const msgBox = document.getElementById('auth-message');

/**
 * Repopulate and show/hide the level-specific registration inputs.
 * Driven entirely by js/education.js, which the profile page and the admin
 * modal share, so the three can never disagree about the option lists.
 */
function renderRegLevelFields() {
  const levelSel = document.getElementById('reg-educational-level');
  const level = levelSel ? levelSel.value : '';
  const waiting = level ? 'Select...' : 'Select Educational Level first';

  fillSelect(document.getElementById('reg-course'),     COURSES[level], { placeholder: waiting });
  fillSelect(document.getElementById('reg-year-level'), YEARS[level],   { placeholder: waiting });
  fillSelect(document.getElementById('reg-block'),      BLOCKS,         { placeholder: 'Select Block...' });

  // Hide + disable what the level does not need.
  applyLevelFields(registerForm, level);

  const courseLbl = document.getElementById('reg-course-label');
  if (courseLbl) courseLbl.textContent = courseLabel(level);
  const yearLbl = document.getElementById('reg-year-label');
  if (yearLbl) yearLbl.textContent = yearLabel(level);
}

function showMessage(text, kind = 'error') {
  const styles = {
    error: 'bg-rose-50 border border-rose-200 text-rose-700',
    success: 'bg-emerald-50 border border-emerald-200 text-emerald-700',
    info: 'bg-indigo-50 border border-indigo-200 text-indigo-700'
  };
  msgBox.className = `mx-6 mb-6 border rounded-lg p-3 text-sm ${styles[kind]}`;
  msgBox.innerText = text;
  msgBox.classList.remove('hidden');
}

function init() {
  // Wire the UI FIRST so the portal cards / tabs always stay clickable,
  // even if Supabase config is missing or the CDN import failed.
  // (index.html also wires a no-import fallback; skip duplicates via dataset.)
  wireTabs();
  // Sleek animated floating toast: surface a pending logout toast after redirect.
  try {
    const pending = localStorage.getItem('campusqr-toast');
    if (pending) {
      localStorage.removeItem('campusqr-toast');
      const { message, type } = JSON.parse(pending);
      if (message) setTimeout(() => toast(message, type || 'success'), 350);
    }
  } catch { /* storage unavailable */ }
  if (loginForm) loginForm.addEventListener('submit', onLogin);
  if (registerForm) registerForm.addEventListener('submit', onRegister);

  // Educational Level drives every dependent input below it.
  const levelSel = document.getElementById('reg-educational-level');
  if (levelSel) levelSel.addEventListener('change', renderRegLevelFields);
  try { renderRegLevelFields(); } catch { /* non-fatal */ }

  if (!CONFIG_OK || !supabase) {
    document.getElementById('config-warning')?.classList.remove('hidden');
    loginForm?.querySelector('button[type="submit"]')?.setAttribute('disabled', '');
    registerForm?.querySelector('button[type="submit"]')?.setAttribute('disabled', '');
    showMessage(
      'Cannot reach the authentication service. Check your internet connection and supabase-config.js, then reload.',
      'error'
    );
    return;
  }

  // already signed in? go straight to the app
  supabase.auth.getSession().then(({ data }) => {
    if (data.session) location.replace('app.html');
  }).catch(() => { /* stay on login page */ });
}

function showAuthTab(which) {
  const loginTab = document.getElementById('tab-login-btn');
  const regTab = document.getElementById('tab-register-btn');
  const tabsWrap = document.getElementById('auth-tabs');
  const isPersonnel = regTab && regTab.style.display === 'none';
  const isLogin = isPersonnel ? true : which === 'login';
  loginForm?.classList.toggle('hidden', !isLogin);
  registerForm?.classList.toggle('hidden', isLogin);
  msgBox?.classList.add('hidden');
  // Personnel Portal is login-only: keep the hidden Login tab element removed from layout so Welcome back stays clean.
  if (tabsWrap) tabsWrap.classList.add('hidden');
  if (loginTab) loginTab.className = 'hidden';
  if (regTab) regTab.className = `py-3 border-b-2 ${!isLogin ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-indigo-600'}`;
}

function wireOnce(el, evt, fn) {
  if (!el || el.dataset.authWired || el.dataset.fbWired) return;
  el.dataset.authWired = '1';
  el.addEventListener(evt, fn);
}

function wireTabs() {
  const show = (which) => showAuthTab(which);
  wireOnce(document.getElementById('tab-login-btn'), 'click', () => show('login'));
  wireOnce(document.getElementById('tab-register-btn'), 'click', () => show('register'));
  // In-form cross-links below the submit buttons (same toggle, tabs stay in sync).
  wireOnce(document.getElementById('link-to-register'), 'click', () => show('register'));
  wireOnce(document.getElementById('link-to-login'), 'click', () => show('login'));
  wirePortals(show);
}

// Portal chooser: PERSONNEL (left, login-only) / STUDENT (right, login+register).
// Only toggles which tab is visible — signIn/signUp logic below is untouched.
function wirePortals(show) {
  const panel = document.getElementById('auth-panel');
  const chooser = document.getElementById('portal-chooser');
  const label = document.getElementById('auth-panel-label');
  const note = document.getElementById('personnel-note');
  const regTab = document.getElementById('tab-register-btn');
  const backBtn = document.getElementById('back-to-portals');
  if (!panel || !chooser) return; // older markup without portals: tabs still work

  const open = (portal, which) => {
    const isPersonnel = portal === 'personnel';
    if (label) label.textContent = isPersonnel ? 'Personnel portal' : 'Student portal';
    if (note) note.classList.toggle('hidden', !isPersonnel);
    // Personnel: hide the Register tab so only Login is reachable.
    if (regTab) regTab.style.display = isPersonnel ? 'none' : '';
    // Personnel is login-only: hide the in-form "Don't have an account?" link too.
    document.getElementById('link-to-register-wrap')?.classList.toggle('hidden', isPersonnel);
    show(isPersonnel ? 'login' : which);
    panel.classList.remove('hidden');
    chooser.classList.add('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  wireOnce(document.getElementById('portal-personnel-login'), 'click', () => open('personnel', 'login'));
  wireOnce(document.getElementById('portal-student-login'), 'click', () => open('student', 'login'));
  wireOnce(document.getElementById('portal-student-register'), 'click', () => open('student', 'register'));
  wireOnce(backBtn, 'click', () => {
    panel.classList.add('hidden');
    chooser.classList.remove('hidden');
    msgBox?.classList.add('hidden');
  });
}

async function onLogin(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type="submit"]');
  const email = form.email.value.trim();
  const password = form.password.value;

  // Guard locally so we never send a blank request to Supabase.
  if (!email || !password) {
    showMessage('Please enter both your email and password.', 'info');
    return;
  }

  setBusy(btn, true, 'Signing in...');
  try {
    // signIn() calls supabase.auth.signInWithPassword() and throws on error.
    const { session } = await signIn(email, password);

    // A successful call should always yield a session. If it does not, the
    // dashboard would immediately bounce us back, so fail loudly instead.
    if (!session) throw new Error('Sign-in did not return a session. Please try again.');

    // Confirm the session really persisted before navigating.
    const { data: { session: live } } = await supabase.auth.getSession();
    if (!live) throw new Error('Could not restore your session. Please try again.');

    toast('Signed in successfully.', 'success');
    location.replace('app.html');
  } catch (err) {
    showMessage(err.message || 'Login failed. Please check your details.');
    setBusy(btn, false); // re-enable so the user can retry
  }
}

async function onRegister(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type="submit"]');
  const fullName = form.full_name.value.trim();
  const email = form.email.value.trim();
  const phone = form.phone ? form.phone.value.trim() : '';
  const password = form.password.value;
  const confirm = form.confirm.value;
  const studentNumber = form.student_number.value.trim();

  if (!fullName) { showMessage('Please enter your full name.'); return; }
  if (!studentNumber) { showMessage('Please enter your school ID number.'); return; }
  if (password.length < 6) { showMessage('Password must be at least 6 characters.'); return; }
  if (password !== confirm) { showMessage('Passwords do not match.'); return; }

  const phoneError = validatePhone(phone);
  if (phoneError) { showMessage(phoneError); return; }

  const edu = readLevelFields(form);
  const levelError = validateLevelFields(edu);
  if (levelError) { showMessage(levelError); return; }

  // Denormalised copies kept in step with the structured columns, so the admin
  // reports (js/admin.js, js/reports.js) keep showing a "Grade/Class" value
  // without needing to know about the new columns.
  const department = edu.course || null;
  const gradeClass = formatGradeClass(edu.educational_level, edu.year_level, edu.block, edu.section) || null;

  setBusy(btn, true, 'Creating account...');
  try {
    const { session } = await signUp(email, password, fullName, {
      phone, studentNumber, department, gradeClass, ...edu
    });
    // Always send the user back to the Login portal after a successful
    // registration. Supabase auto-signs-in when email confirmation is OFF
    // (returns a session), which used to jump straight into app.html.
    // Sign out to clear that session, then switch to the Login tab.
    if (session) {
      try { await signOut(); } catch { /* best-effort cleanup */ }
    }
    form.reset();
    renderRegLevelFields();
    showAuthTab('login');
    // Pre-fill the login email so the user just enters their password.
    if (loginForm && loginForm.email) loginForm.email.value = email;
    showMessage(
      session
        ? 'Account created successfully. Please log in with your new account.'
        : 'Account created. Please check your email to confirm, then log in.',
      'success'
    );
    toast('Account created. Please log in.', 'success');
    setBusy(btn, false);
  } catch (err) {
    showMessage(err.message || 'Registration failed.');
    setBusy(btn, false);
  }
}

// This file is loaded as a deferred module script, so the DOM is usually already
// parsed and DOMContentLoaded has often ALREADY fired by the time we get here.
// Registering a plain 'DOMContentLoaded' listener would therefore never run the
// initializer (and the form would silently do nothing). Boot immediately when the
// document is ready, otherwise wait for the event.
window.__authBooted = false;
function boot() {
  try {
    init();
    window.__authBooted = true;
  } catch (err) {
    console.error('authPage boot failed', err);
    try {
      showMessage('Login page failed to start. Reload the page; if it persists, check your internet connection (CDN scripts may be blocked).', 'error');
    } catch { /* msg box itself missing */ }
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
