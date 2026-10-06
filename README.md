# CampusQR — School Event Attendance System (QR Code Based)

A complete, role-based web application that lets a school manage **event attendance using QR codes**.
Students scan the QR code of an event to check in; teachers and administrators create events, display
the QR code and monitor attendance.

Built with **Supabase (PostgreSQL + Auth + Row Level Security)** and a **responsive vanilla-JS front end**
(no build step required).

---

## 1. Roles and capabilities

| Feature | Student | Teacher | Administrator |
|---|:--:|:--:|:--:|
| Register / Login / Logout | ✅ | ✅ | ✅ |
| View & edit own profile | ✅ | ✅ | ✅ |
| View available (open) events | ✅ | ✅ | ✅ |
| **Scan an event QR code** | ✅ | — | — |
| **Record attendance** | ✅ | — | — |
| View **own** attendance history | ✅ | — | — |
| Create / Edit / View / Close events | — | ✅ (own) | ✅ (all) |
| Generate + display event QR code | — | ✅ | ✅ |
| View attendance records | — | ✅ (own events) | ✅ (all) |
| Attendance summaries | — | ✅ | ✅ |
| Manage users (roles, activation, personal + educational details) | — | — | ✅ |
| Correct / delete attendance records | — | ✅ (own events) | ✅ |
| System activity log / reports | — | — | ✅ |

---

## 2. Technology

| Layer | Technology |
|---|---|
| Front end | HTML5, Tailwind CSS (CDN), vanilla JavaScript ES modules, responsive / mobile-friendly |
| QR generation | `qrcodejs` |
| QR scanning | `html5-qrcode` (uses the device camera) |
| Authentication | Supabase Auth (email + password, JWT sessions with auto-refresh) |
| Database | Supabase PostgreSQL |
| Authorization | Row Level Security (RLS) policies + `SECURITY DEFINER` RPC functions |
| Live updates | Supabase Realtime (`postgres_changes`) |

---

## 3. Project structure

```
school-qr-attendance/
├── index.html                 Login + Registration page
├── app.html                   Role-aware dashboard (all app sections)
├── package.json               Optional: `npm start` runs a local static server
├── supabase-config.example.js Template for your Supabase credentials
├── supabase-config.js         YOUR real credentials (git-ignored)
├── .gitignore                 Ignores secrets / node_modules
├── README.md
├── SUPABASE_SQL.md            Copy-paste mirror of sql/10 + the sql/11 CRUD fix + verify queries
├── sql/
│   ├── 01_schema.sql          Tables, enums, signup trigger, education columns + grants
│   ├── 02_functions.sql       Helpers, check_in() RPC, admin RPCs, audit trigger
│   ├── 03_rls_policies.sql    Row Level Security policies
│   ├── 04_seed.sql            Demo roles + a sample open event
│   ├── 05_realtime.sql        Optional: live attendance, event, profile & audit updates
│   ├── 06_backfill_profiles.sql   Creates profiles rows missing for older accounts
│   ├── 07_security_hardening.sql  Column-level grants + RLS WITH CHECK defence
│   ├── 08_admin_delete_user.sql   Admin-only delete RPC
│   ├── 09_registration_student_no.sql  Signup trigger variant (superseded by 10)
│   ├── 10_education_levels.sql  Educational level, course, year, block, section
│   └── 11_crud_policies.sql   Re-applies every RLS policy + grant the app needs (Manage Users CRUD fix)
└── js/
    ├── supabaseClient.js      Creates the Supabase client from the config
    ├── ui.js                  Toasts, loading/empty states, escaping, formatting
    ├── education.js           Educational level definitions + form/validation helpers
    ├── auth.js                Login / signup / logout / session guard
    ├── authPage.js            Logic for index.html
    ├── events.js              Event CRUD + event QR generation
    ├── scan.js                Camera scanning + check_in() call
    ├── attendance.js          Student history + staff records/corrections
    ├── admin.js               User management
    ├── reports.js             Summaries, CSV export, audit log
    ├── realtime.js            Global Supabase Realtime channel
    └── app.js                 Bootstrap, navigation and event wiring
```

---

## 4. Database design

```
auth.users  ──1:1──►  profiles          (role + profile information)
profiles   ──1:N──►  events            (created_by)
events     ──1:N──►  attendance        (event_id)
profiles   ──1:N──►  attendance        (student_id / recorded_by)
profiles   ──1:N──►  audit_logs        (actor_id)
```

| Table | Purpose |
|---|---|
| `profiles` | One row per user: `role`, `full_name`, `email`, `phone`, `student_no`, `is_active`, plus the educational columns `educational_level`, `course`, `year_level`, `block`, `section` and the denormalised display pair `department` + `grade_class` |
| `events` | `name`, `description`, `venue`, `start_datetime`, `end_datetime`, `status` (draft/open/closed), `qr_token` |
| `attendance` | `student_id`, `event_id`, `status` (present/late/absent/excused), `method`, `recorded_at` |
| `audit_logs` | System activity trail for administrators |

### Educational level model

Registration and the profile page share one definition, `js/education.js`. The
chosen level decides which extra inputs appear:

| Educational Level | → `course` | → `year_level` | → `block` | → `section` |
|---|---|---|---|---|
| College | BSIT, BSHM, BEED, BPED, BSED, BSEntrep | 1–4 | A–F | — |
| Senior High School | STEM, ABM, TVL, HUMSS | 11–12 | — | free text |
| Junior High School | — | 7–10 | — | free text |
| Elementary | — | 1–6 | — | free text |

`year_level` doubles as "Year Level" (College) and "Grade Level" (the school
levels); the label follows the level. `course` is the College course or the
SHS track.

Two denormalised columns are **also** written on every save, and must never be
typed by hand:

- `department` ← mirrors `course`
- `grade_class` ← `formatGradeClass()`, e.g. `Year 3 · Block A` or `Grade 11 · Section B`

`grade_class` exists because the CSV reports render a "Grade/Class" column, and
because the Manage Users table falls back to it — through `parseGradeClass()` —
for accounts whose structured columns are still empty. Regenerate it through
`formatGradeClass()` so it can never drift from the structured columns. `role`
and `is_active` are never sent from the browser — the signup trigger hardcodes
`role = 'student'`.

The Manage Users **Details** column renders one labelled line per field, chosen
by the row's `educational_level` (`renderUserDetails()` in `js/admin.js`):

| Educational Level | Details column |
|---|---|
| College | Student ID · Course · Year Level (1st–4th Year) · Block |
| Senior High School | Student ID · Track · Grade Level (Grade 11–12) · Section |
| Junior High School | Student ID · Grade Level · Section |
| Elementary | Student ID · Grade Level · Section |

**Editing a user** (Manage Users → *Edit*) writes both halves of a row: the
*Personal Information* block (full name, phone, School ID Number, title — the
sign-in **email is read-only** because it lives in Supabase Auth and is outside
the column-level `grant update`) and the *Educational Information* block. The
save is validated with the same `validateLevelFields()` / `validatePhone()`
rules as registration. The `UPDATE` response itself is **not** trusted —
PostgREST answers "no content" for a write that succeeded, while an RLS-blocked
write answers success with zero rows — so the row is reloaded and compared
against what was submitted: a save that landed is always reported as success
(whichever columns changed), and one that did not names exactly which fields the
database refused. Then:

1. reloads and re-renders the **Manage Users** table immediately;
2. reaches every other open session through the `profiles` realtime event, so
   the edited user's **Profile → Personal Information** and **Education Level /
   Information** card update live;
3. when an administrator edits **their own** row, the realtime echo is
   suppressed on that client, so `applyLocalProfileUpdate()` (js/app.js)
   patches the session copy directly.

Key integrity rules:
- `UNIQUE (event_id, student_id)` on `attendance` → **database-level duplicate prevention**.
- Foreign keys on every relationship, with `ON DELETE CASCADE` where appropriate.
- `CHECK (end_datetime >= start_datetime)` on `events`.

---

## 5. Setup (run it yourself)

### Step 1 — Create a Supabase project
1. Go to <https://supabase.com> → **New project** → choose a free plan.
2. Wait for the database to be created.

### Step 2 — Create the database objects
Open **SQL Editor** in the dashboard and run these files **in order**:

| Order | File | What it does |
|---|---|---|
| 1 | `sql/01_schema.sql` | Tables, enums, indexes, signup trigger, **education columns + grants** |
| 2 | `sql/02_functions.sql` | `check_in()`, admin functions, audit trigger |
| 3 | `sql/03_rls_policies.sql` | Row Level Security policies |
| 4 | `sql/04_seed.sql` | Demo roles + sample event (after step 3 below) |
| 5 | `sql/05_realtime.sql` | *Optional* – live attendance, event, profile & audit updates |
| 6 | `sql/06_backfill_profiles.sql` | *If* an account has no profile row (created before the trigger existed) |
| 7 | `sql/07_security_hardening.sql` | Column-level UPDATE grants + RLS `WITH CHECK` |
| 8 | `sql/08_admin_delete_user.sql` | Admin-only account-deletion RPC |
| 9 | `sql/10_education_levels.sql` | **Educational level/course/year/block/section columns + backfill** |
| 10 | `sql/11_crud_policies.sql` | **Re-applies every RLS policy + grant — run last; fixes "Save blocked - kept the old value"** |

> Each file is safe to re-run.
>
> **Already have a database?** Just re-run `sql/01_schema.sql`. It now carries the
> `ALTER TABLE … IF NOT EXISTS` upgrade path, the backfill of existing rows and
> the column-level grants, so a database built from an older copy picks up the
> educational fields on its own — `sql/10_education_levels.sql` and
> `SUPABASE_SQL.md` are the standalone equivalents and do exactly the same
> thing. Until one of them runs, the registration form fails with
> *permission denied for table profiles*.
>
> Prefer copy-paste? **`SUPABASE_SQL.md`** holds the same SQL in one fenced block,
> ready for the Supabase SQL Editor, with the verification queries and their
> expected results underneath. It is a mirror — keep it in step with `sql/10`.
>
> `sql/09_registration_student_no.sql` is kept only for history; `01`, `07` and
> `10` all carry the same `handle_new_user()` definition, so run **`10` last**.

### Step 3 — Create the demo accounts
**Dashboard → Authentication → Users → “Add user” → “Create new user”**, tick **Auto Confirm User**,
and create:

| Email | Password | Role |
|---|---|---|
| `admin@campusqr.test` | `Admin@123` | Administrator |
| `teacher@campusqr.test` | `Teacher@123` | Teacher |
| `student@campusqr.test` | `Student@123` | Student |

Then run `sql/04_seed.sql` to assign those roles and create a sample **open** event.

### Step 4 — Configure the app keys
1. Copy `supabase-config.example.js` → `supabase-config.js`.
2. **Dashboard → Project Settings → API** and copy:
   - **Project URL**
   - the **anon / public** key
3. Paste them into `supabase-config.js`.

> ⚠️ Use **only the anon key**. Never use the `service_role` key, and never commit `supabase-config.js`
> (it is already listed in `.gitignore`).

### Step 5 — Run the app
The camera requires a secure context (`https://` or `localhost`), so open it through a local server:

```bash
npm start          # uses `serve` on http://localhost:5173
```

or use any static server, e.g. VS Code **Live Server** (right-click `index.html` → *Open with Live Server*),
or `python -m http.server 5173`.

Then open <http://localhost:5173> and log in.

### Step 6 (optional) — Skip email confirmation
**Authentication → Providers → Email → uncheck “Confirm email”** so students can register and log in
immediately without receiving a confirmation email.

---

## 6. How the QR attendance flow works

1. **Teacher/Admin creates an event** — name, description, venue, start/end time, status.
2. **The system generates a QR code** — each event gets a unique random `qr_token` (a UUID). The QR
   encodes `CAMPUSQR:<qr_token>`.
3. **The student scans the QR code** — using the in-app camera scanner (`Scan QR` tab), or by typing the
   event code manually if no camera is available.
4. **The system validates the event** — the browser calls the `check_in()` database function, which
   validates the token, the event status and the caller's role.
5. **Attendance is recorded** — a row is inserted into `attendance` for the logged-in student, and an
   audit-log entry is written.
6. **The student receives confirmation** — a success toast plus an on-screen result panel.

### Validation results returned by `check_in()`

| Result | Meaning |
|---|---|
| `success` | Attendance recorded |
| `duplicate` | The student already checked in to this event |
| `closed` | The event is closed, draft, or already ended |
| `invalid` | The QR code / token does not match any event |
| `unauthorized` | The caller is not an active student, or is signed out |

---

## 7. Security

| Requirement | How it is met |
|---|---|
| Authentication | Supabase Auth (email + password, bcrypt-hashed passwords, never stored in our code) |
| Role-based authorization | Every table has RLS policies driven by `public.role` / `is_staff()` / `is_admin()` |
| Database access protection | RLS enabled on `profiles`, `events`, `attendance`, `audit_logs`; the anon key cannot bypass it |
| Input validation | Client-side form validation **and** database constraints (enums, `NOT NULL`, `CHECK`, `UNIQUE`) |
| Duplicate attendance prevention | `UNIQUE (event_id, student_id)` + the `check_in()` check |
| Secure session handling | Supabase JWT sessions, persisted with auto-refresh; the app redirects when the session ends |
| Proper logout | `supabase.auth.signOut()` clears the session, then the app returns to `index.html` |
| Protected DB operations | Attendance can only be created through the validated `check_in()` function — there is **no** client INSERT policy |
| Privilege escalation prevention | A trigger blocks users from changing their own `role` or `is_active` |
| XSS protection | All database text is escaped with `esc()` before being inserted into the DOM |
| SQL injection | All queries go through the Supabase client (parameterised) or `SECURITY DEFINER` functions |
| Audit trail | `audit_logs` records check-ins, event changes and user-role changes |

### Important secret-handling rule
`supabase-config.js` contains only the **anon/public key**, which is designed to be used in a browser
**because RLS is enabled**. The `service_role` key, database password and any other secret must **never**
appear in this repository. `.gitignore` already excludes `supabase-config.js` and `.env*`.

---

## 8. Event-driven programming

The app is built around events. The ten you can demonstrate during a presentation:

| # | Event | Where |
|---|---|---|
| 1 | **User presses Login** | `js/authPage.js` → `onLogin()` |
| 2 | **User presses Register** | `js/authPage.js` → `onRegister()` |
| 3 | **Session established / restored** | `supabase.auth.onAuthStateChange()` in `js/app.js` |
| 4 | **User presses Logout** | `js/app.js` → `doLogout()` |
| 5 | **Event is created** (QR generated) | `js/events.js` → `saveEvent()` |
| 6 | **Event status changes** (open/closed) | `js/events.js` → `setEventStatus()` |
| 7 | **QR scanner detects a QR code** | `html5-qrcode` callback → `checkIn()` in `js/scan.js` |
| 8 | **Database record inserted successfully** | `check_in()` returns `success` → toast + result panel |
| 9 | **Duplicate / invalid / closed / unauthorized detected** | `check_in()` returns that result → warning/error toast |
| 10 | **Data is refreshed** | The single `campusqr-global-sync` channel (`js/realtime.js`) fires `events:changed` / `attendance:changed` so every view refreshes |

Custom DOM events (`events:changed`, `attendance:changed`, `data:refreshed`) are dispatched to keep
every view in sync after a change. Realtime also mirrors `profiles` (a rename or role change on your
own row applies instantly) and `audit_logs` (the admin System Activity Log). Toasts fire when the live
channel drops or recovers, when a remote event status changes (draft -> open / open -> closed), and
when staff receive a new check-in recorded from another device.

---

## 9. User interface & feedback

The interface is responsive (mobile, tablet and desktop), consistent, and uses one visual language
(indigo/teal/amber/rose) across all roles. Feedback is provided for every state:

| State | What you see |
|---|---|
| Loading | Spinner rows such as “Loading attendance records…” and busy buttons |
| Success | Green toast, e.g. “Attendance recorded successfully.” |
| Error | Red toast, e.g. “Could not save event: …” |
| Empty data | Friendly messages: “No events yet…”, “You have no attendance records yet.” |
| Invalid QR | Red result panel: “Invalid QR code – no matching event found.” |
| Duplicate attendance | Amber panel: “You have already checked in to this event.” |
| Closed event | Grey panel: “This event is closed for attendance.” |
| Unauthorized | Red panel: “Only active student accounts can record attendance.” |

---

## 10. Troubleshooting

| Problem | Solution |
|---|---|
| “Supabase is not configured” banner | `supabase-config.js` is missing or still has the placeholder values. Copy the example file and fill in your URL + anon key. |
| Login says *Invalid login credentials* | Check the email/password, and make sure the user was created and confirmed in Supabase → Authentication → Users. |
| Registration asks you to confirm your email | Turn off **Confirm email** in Authentication → Providers → Email. |
| Saving the profile says *permission denied for table profiles* | You have not run `sql/10_education_levels.sql` (or an older `09` re-ran after it). The new columns are missing from the column-level `grant update`. Run `10` again. |
| Manage Users → Save says *the database kept the old value for: …* | The write was filtered out by RLS, so nothing changed. Run `sql/07_security_hardening.sql` **then** `sql/10_education_levels.sql`, and confirm with:<br>`select policyname from pg_policies where schemaname='public' and tablename='profiles';` (needs `profiles_admin_all`)<br>`select public.is_admin();` while signed in (must be `t`) |
| A student's Grade/Block/Section is empty on their profile | The signup trigger must be the current one. `01`, `07` and `10` all define `handle_new_user()`; run **`10` last** so the newest definition wins. |
| Old accounts show Educational Level as *N/A* | `10` only classifies rows it can infer from `department` / `grade_class`. Set the rest through **Admin → Manage Users → Edit**. |
| The scanner will not start the camera | Run the app on `localhost` or over HTTPS and allow camera permission. A manual “event code” entry box is provided as a fallback. |
| “No events are currently open for check-in” (student) | Only events with status **open** are visible to students. Open an event as a teacher. |
| Live updates do not appear | Run `sql/05_realtime.sql`. The app still works; it just needs a refresh. |
| Every account is a student | That is the secure default. Use `sql/04_seed.sql` or an administrator to promote a user to teacher/admin. |
| Tables cannot be created | Make sure you ran the SQL files in the order 01 → 05 in the **SQL Editor** of the correct project. |

---

## 11. Notes / assumptions

- **Public registration always creates a `student` account.** Teacher and administrator accounts are
  promoted by an administrator (this prevents anyone from self-registering as an admin).
- **Check-in is tied to the logged-in student**, which is what makes the attendance accurate and auditable.
- The QR token never encodes personal data — it is a random UUID per event.
- Only the **anon** key is used client-side, and it is safe to expose *only because RLS is enabled*.

---

**CampusQR Attend** — School Event Attendance System. Built with Supabase (PostgreSQL + Auth + RLS).