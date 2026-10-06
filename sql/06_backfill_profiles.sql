-- ============================================================
-- CampusQR - School Event Attendance System
-- 06_backfill_profiles.sql : create missing profiles rows
--
-- WHY THIS FILE EXISTS
-- --------------------
-- public.handle_new_user() is wired up as an AFTER INSERT trigger on
-- auth.users (see 01_schema.sql). It therefore only ever creates a
-- profiles row for users that are created AFTER the trigger exists.
--
-- Any account that was created BEFORE 01_schema.sql was first run --
-- e.g. an account you made by hand in the Supabase Dashboard while
-- setting the project up -- has no profiles row. When such a user signs
-- in, js/auth.js getProfile() returns null and the app shows
-- "Could not load your profile. Please sign in again."
--
-- That is a data problem, NOT an RLS problem: the profiles_select_self
-- policy in 03_rls_policies.sql correctly allows a user to read their own
-- row, but there is no row to read.
--
-- This script backfills any missing rows and is safe to re-run.
-- Run it in the Supabase SQL Editor.
-- ============================================================

-- ---------- report what is missing (run this first, it is read-only) ----------
-- select u.email, u.email_confirmed_at, p.id as profile_id
--   from auth.users u
--   left join public.profiles p on p.id = u.id;
-- A NULL profile_id beside your email confirms the problem.

-- ---------- backfill ----------
-- Mirrors public.handle_new_user() (01_schema.sql): public signups are always
-- created as students, and an administrator promotes roles later.
insert into public.profiles (id, email, full_name, role)
select u.id,
       u.email,
       coalesce(u.raw_user_meta_data ->> 'full_name', split_part(u.email, '@', 1)),
       'student'
  from auth.users u
 where u.email is not null          -- profiles.email is NOT NULL; phone-only users have no email
on conflict (id) do nothing;        -- never overwrite an existing profile

-- ---------- confirm ----------
-- select count(*) as total_users,
--        count(p.id) as profiles_present,
--        count(*) filter (where p.id is null) as still_missing
--   from auth.users u
--   left join public.profiles p on p.id = u.id;

-- ---------- promote yourself to administrator ----------
-- This only matches once the backfill above has created your row.
-- Replace the email, then run this block.
--
-- WHY THE TRIGGER IS DISABLED HERE:
-- public.protect_profile_fields() (see 02_functions.sql) blocks any change to
-- role / is_active unless public.is_admin() is true. is_admin() resolves via
-- auth.uid(), which is NULL when a statement is run from the SQL Editor, so a
-- plain UPDATE would raise 'Only administrators can change user roles' and roll
-- back. The trigger is disabled only for the duration of this transaction and
-- is re-enabled before COMMIT, so the self-escalation guard is never left off.
--
-- begin;
--   alter table public.profiles disable trigger trg_protect_profile_fields;
--
--   update public.profiles
--      set role = 'admin', full_name = 'System Administrator'
--    where email = 'your@email.com';
--
--   alter table public.profiles enable trigger trg_protect_profile_fields;
-- commit;