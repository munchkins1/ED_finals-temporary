-- ============================================================
-- CampusQR - 04_seed.sql  (demo data)
-- Run this LAST, AFTER creating the three demo users in the dashboard.
-- ============================================================
--
-- STEP 1 - Create the users (most reliable method):
--   Supabase Dashboard -> Authentication -> Users -> "Add user" -> "Create new user"
--   Create these three (use any password you like, and tick "Auto Confirm User"):
--       admin@campusqr.test
--       teacher@campusqr.test
--       student@campusqr.test
--
--   (Alternative: leave "Confirm email" turned OFF in Authentication -> Providers ->
--    Email, then just register through the app's Register page. New accounts are
--    always created as students - run this script afterwards to promote roles.)
--
-- STEP 2 - Run the statements below.
--
-- IMPORTANT: the role updates below are wrapped in a transaction that
-- temporarily disables the trg_protect_profile_fields trigger.
-- public.protect_profile_fields() (02_functions.sql) rejects any change to
-- role / is_active unless public.is_admin() is true, and is_admin() resolves via
-- auth.uid() -- which is NULL when running from the SQL Editor. Without disabling
-- the trigger, every UPDATE below would raise
-- 'Only administrators can change user roles' and roll back.
-- The trigger is re-enabled before COMMIT, so the guard is never left off.
--
-- These statements also only match rows that already exist in public.profiles.
-- If a demo user was created in the dashboard BEFORE 01_schema.sql was run it has
-- no profile row yet -- run 06_backfill_profiles.sql first.

begin;

-- temporarily lift the self-escalation guard, for this transaction only
alter table public.profiles disable trigger trg_protect_profile_fields;

-- assign roles + fill profile details
update public.profiles
   set role = 'admin', full_name = 'System Administrator', title = 'ICT Administrator'
 where email = 'admin@campusqr.test';

update public.profiles
   set role = 'teacher', full_name = 'Maria Santos',
       department = 'Science', title = 'Science Teacher'
 where email = 'teacher@campusqr.test';

update public.profiles
   set role = 'student', full_name = 'Sam Rivera',
       student_no = 'STU-2026-001', grade_class = 'Grade 11-A'
 where email = 'student@campusqr.test';

-- restore the self-escalation guard before committing
alter table public.profiles enable trigger trg_protect_profile_fields;

commit;

-- ---------- verify: all three demo rows should now have a role ----------
-- select email, role, full_name from public.profiles order by email;

-- a sample OPEN event owned by the teacher (so you can test scanning immediately)
insert into public.events (name, description, venue, start_datetime, end_datetime, status, created_by)
select 'Annual Science Fair',
       'School-wide science exhibition and judging in the main auditorium.',
       'Main Auditorium',
       now(), now() + interval '4 hours', 'open', p.id
  from public.profiles p
 where p.email = 'teacher@campusqr.test'
   and not exists (select 1 from public.events e where e.name = 'Annual Science Fair');
