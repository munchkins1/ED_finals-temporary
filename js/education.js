// js/education.js
// Single source of truth for the four educational levels and the inputs each
// one needs. Shared by the registration form (index.html), the profile page
// (app.html / js/app.js) and the admin user modal (js/admin.js) so the three
// can never drift apart.
//
// This replaces the `hierarchyData` object that used to be copy-pasted into
// both js/authPage.js and js/app.js. The option lists and the grade_class
// formatting now have exactly one definition.

/** The four branches, in the order they appear in the dropdown. */
export const LEVELS = [
  { value: 'college',     label: 'College' },
  { value: 'senior_high', label: 'Senior High School' },
  { value: 'junior_high', label: 'Junior High School' },
  { value: 'elementary',  label: 'Elementary' }
];

/** College course, or SHS track. NULL for JHS / Elementary. */
export const COURSES = {
  college:     ['BSIT', 'BSHM', 'BEED', 'BPED', 'BSED', 'BSEntrep'],
  senior_high: ['STEM', 'ABM', 'TVL', 'HUMSS']
};

/** College year, or grade level. Doubles as the "Grade Level" field. */
export const YEARS = {
  college:     ['1', '2', '3', '4'],
  senior_high: ['11', '12'],
  junior_high: ['7', '8', '9', '10'],
  elementary:  ['1', '2', '3', '4', '5', '6']
};

/** College block only. */
export const BLOCKS = ['A', 'B', 'C', 'D', 'E', 'F'];

export function isValidLevel(value) {
  return LEVELS.some(l => l.value === value);
}

export function labelForLevel(level) {
  return (LEVELS.find(l => l.value === level) || {}).label || '';
}

/** "Department / Course" for College, "Track" for SHS. */
export function courseLabel(level) {
  return level === 'senior_high' ? 'Track' : 'Department / Course';
}

/** "Year Level" for College, "Grade Level" for the school levels. */
export function yearLabel(level) {
  return level === 'college' ? 'Year Level' : 'Grade Level';
}

/** Which extra inputs the given level needs. */
export function fieldsForLevel(level) {
  return {
    course:    level === 'college' || level === 'senior_high',
    yearLevel: true,
    block:     level === 'college',
    section:   level === 'senior_high' || level === 'junior_high' || level === 'elementary'
  };
}

/**
 * Build the denormalised `grade_class` display string.
 *
 * Kept in sync with the columns by construction: registration, the profile
 * page and the admin modal all call this. js/admin.js and js/reports.js keep
 * reading the column for their "Grade/Class" table column.
 *
 * The course is intentionally left out - js/admin.js already renders
 * `department` on its own line directly underneath.
 */
export function formatGradeClass(level, yearLevel, block, section) {
  const year = (yearLevel || '').trim();
  const blk  = (block || '').trim();
  const sec  = (section || '').trim();
  if (!year && !blk && !sec) return '';
  if (level === 'college') {
    return [year && `Year ${year}`, blk && `Block ${blk}`].filter(Boolean).join(' · ');
  }
  return [year && `Grade ${year}`, sec && `Section ${sec}`].filter(Boolean).join(' · ');
}

/**
 * Recover year / block / section from the denormalised `grade_class` — the
 * counterpart of formatGradeClass().
 *
 * The legacy backfill in sql/01 only writes `educational_level`, so rows that
 * predate sql/10_education_levels.sql still carry their data solely in
 * `grade_class`. Both shapes are handled: the ones formatGradeClass()
 * produces ("Year 3 · Block A", "Grade 11 · Section A") and the older
 * free-text "Grade 11-A".
 *
 * Used by the profile card (js/app.js) and the Manage Users "Details" column
 * (js/admin.js) so migrated accounts still show their year/block/section.
 *
 * @returns {{year: string, block: string, section: string}}
 */
export function parseGradeClass(value) {
  const gc = String(value || '').trim();
  const out = { year: '', block: '', section: '' };
  if (!gc) return out;

  const yr = gc.match(/^\s*(?:year|grade)\s+(\d+)/i);
  if (yr) out.year = yr[1];

  const blk = gc.match(/\bblock\s+(\S+)/i);
  if (blk) out.block = blk[1];

  const sec = gc.match(/\bsection\s+(.+)$/i)
           || gc.match(/^\s*(?:year|grade)\s+\d+\s*-\s*(.+)$/i);
  if (sec) out.section = sec[1].trim();

  return out;
}

/** Repopulate a <select> from an option list, optionally preserving the value. */
export function fillSelect(select, options, { placeholder = 'Select...', keep = false } = {}) {
  if (!select) return;
  const previous = keep ? select.value : '';
  select.innerHTML = '';
  if (placeholder) {
    const blank = new Option(placeholder, '');
    blank.disabled = true;
    select.appendChild(blank);
  }
  (options || []).forEach(v => select.appendChild(new Option(v, v)));
  if (previous && (options || []).includes(previous)) select.value = previous;
}

/** Keep a stored legacy value selectable even if it is not in the list. */
export function ensureOption(select, value) {
  if (!select || !value) return;
  for (const opt of select.options) if (opt.value === value) return;
  select.add(new Option(value, value));
}

/**
 * Show only the rows the level needs, and disable the hidden controls.
 *
 * Disabling matters: a `required` control inside a `hidden` container still
 * blocks submit with "An invalid form control with name='' is not focusable".
 *
 * Each row wrapper carries data-edu-field="course|yearLevel|block|section".
 */
export function applyLevelFields(scope, level) {
  if (!scope) return;
  const fields = fieldsForLevel(level);
  scope.querySelectorAll('[data-edu-field]').forEach(row => {
    const on = Boolean(fields[row.dataset.eduField]);
    row.classList.toggle('hidden', !on);
    row.querySelectorAll('select, input').forEach(ctl => { ctl.disabled = !on; });
  });
}

/** Read the level fields out of a scope. Disabled rows read as null. */
export function readLevelFields(scope) {
  const get = (name) => {
    const el = scope && scope.querySelector(`[data-edu-input="${name}"]`);
    return el && !el.disabled ? el.value.trim() : '';
  };
  const level = get('educational_level');
  return {
    educational_level: level || null,
    course:    get('course')    || null,
    year_level: get('year_level') || null,
    block:     get('block')     || null,
    section:   get('section')   || null
  };
}

/**
 * Validate the level-specific fields.
 * @returns {string|null} an error message, or null when the selection is valid.
 */
export function validateLevelFields(fields) {
  if (!fields.educational_level) return 'Please select your educational level.';
  if (!isValidLevel(fields.educational_level)) return 'Please select a valid educational level.';
  const need = fieldsForLevel(fields.educational_level);
  if (need.yearLevel && !fields.year_level) return `Please select your ${yearLabel(fields.educational_level).toLowerCase()}.`;
  if (need.course && !fields.course) return `Please select your ${courseLabel(fields.educational_level).toLowerCase()}.`;
  if (need.block && !fields.block) return 'Please select your block.';
  if (need.section && !fields.section) return 'Please enter your section.';
  return null;
}

/** Loose phone validation - formats vary too much to be strict about. */
export function validatePhone(phone) {
  if (!phone) return null;                       // optional
  // Allowed characters first, then count DIGITS: a formatted number such as
  // "+63 917 123 4567" is 16 characters but only 12 digits, so bounding the
  // raw string length would reject valid input.
  if (!/^[0-9+()\-\s]+$/.test(phone)) {
    return 'Please enter a valid phone number (7-15 digits).';
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    return 'Please enter a valid phone number (7-15 digits).';
  }
  return null;
}