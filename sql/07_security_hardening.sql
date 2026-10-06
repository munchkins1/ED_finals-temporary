-- ============================================================
-- CampusQR - School Event Attendance System
-- 07_security_hardening.sql : defence-in-depth for roles
--
-- Run this AFTER 01, 02 and 03. It is safe to re-run.
-- Run it in the Supabase SQL Editor.
--
-- GOAL
-- Two independent layers must BOTH stop a logged-in student from making
-- themselves a teacher or admin:
--
--   Layer A (column privileges) - Postgres itself refuses the UPDATE because
--           the role / is_active columns are not writable by `authenticated`.
--           Enforced before RLS or any trigger is consulted.
--
--   Layer B (RLS WITH CHECK)    - even if the privileges were widened again,
--           the policy refuses any update whose resulting `role` differs from
--           the caller's current role.
--
-- Previously these protections existed only as the BEFORE UPDATE trigger
-- public.protect_profile_fields() in 02_functions.sql. A trigger is a single
-- point of failure: drop it, or never run 02, and any authenticated user could
-- PATCH their own role to 'admin'. The layers below do not depend on it.
-- ============================================================


-- ============================================================
-- LAYER A - column-level privileges
-- ============================================================

-- Remove the blanket table-level UPDATE privilege Supabase grants by default.
revoke update on public.profiles from anon, authenticated;

-- Re-grant UPDATE on ONLY the harmless, self-editable columns. The app writes
-- exactly these eleven:
--   js/auth.js signUp()      -> writes via handle_new_user() instead (not a PATCH)
--   js/app.js   saveProfile()      -> full_name, phone, student_no, title,
--                                     department + the five educational columns
--                                     (grade_class is derived via formatGradeClass)
--   js/admin.js saveUserProfile()  -> same eleven
-- NOT granted: role, is_active, email, id, created_at
-- A student PATCHing { "role": "admin" } now fails with
-- "permission denied for table profiles".
-- The five educational columns were added by 10_education_levels.sql; this copy
-- is kept in sync so a full re-run of this file does not strip them.
grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;

-- ============================================================
-- LAYER B - RLS policies
-- ============================================================

-- SELECT: unchanged - a user may read their own row; staff may read all.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_select_staff on public.profiles;
create policy profiles_select_staff on public.profiles
  for select using (public.is_staff());

-- UPDATE (self): a user may edit their own row, but role must be unchanged.
-- WITH CHECK re-reads the caller's CURRENT role via current_role() and requires
-- the NEW row to carry the same value, so a student cannot smuggle in
-- role = 'admin'.
-- current_role() (02_functions.sql) is SECURITY DEFINER, which lets it read
-- public.profiles without re-triggering this policy - that is what prevents the
-- classic "infinite recursion detected in policy" error.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid() and role = public.current_role());

-- Admin blanket policy (is_admin() is defined in 02_functions.sql).
drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- INSERT: nobody inserts through the client; handle_new_user() (SECURITY
-- DEFINER) creates the row at signup, and admin_set_role() edits it.
-- DELETE: deliberately none for clients. Accounts are removed by deleting the
-- auth.users row, which cascades (profiles.id references auth.users(id)).

-- ============================================================
-- HARDEN THE SIGNUP TRIGGER
-- ============================================================
-- handle_new_user() already hardcodes role = 'student' and ignores any
-- client-supplied role. This re-creates it defensively, stripping 'role' from
-- the user metadata before it can reach the INSERT, and is safe to re-run.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, email, full_name, role, student_no, phone,
    educational_level, course, year_level, block, section,
    department, grade_class
  )
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      split_part(new.email, '@', 1)
    ),
    'student',  -- public signups are ALWAYS students, whatever metadata claims
    nullif(new.raw_user_meta_data ->> 'student_no', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    -- from the registration "Educational Level" dropdown
    public.try_education_level(new.raw_user_meta_data ->> 'educational_level'),
    nullif(new.raw_user_meta_data ->> 'course', ''),
    nullif(new.raw_user_meta_data ->> 'year_level', ''),
    nullif(new.raw_user_meta_data ->> 'block', ''),
    nullif(new.raw_user_meta_data ->> 'section', ''),
    -- legacy free-text pair, still used by the admin reports
    nullif(new.raw_user_meta_data ->> 'department', ''),
    nullif(new.raw_user_meta_data ->> 'grade_class', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- RESTRICT THE ADMIN RPCs
-- ============================================================
-- anon has no business changing roles or account status.
revoke execute on function public.admin_set_role(uuid, public.user_role) from anon;
revoke execute on function public.admin_set_active(uuid, boolean) from anon;

-- ============================================================
-- VERIFY (read-only - run these to confirm the hardening)
-- ============================================================
--
-- 1. role / is_active must NOT appear in the granted update columns:
-- select column_name from information_schema.column_privileges
--  where table_schema = 'public' and table_name = 'profiles'
--    and grantee = 'authenticated' and privilege_type = 'UPDATE'
--  order by column_name;
--    expect: block, course, department, educational_level, full_name,
--            grade_class, phone, section, student_no, title, year_level
--    must NOT contain: role, is_active, email, id
--
-- 2. the signup trigger must exist and hardcode 'student':
-- select tgname from pg_trigger
--  where tgrelid = 'auth.users'::regclass and not tgisinternal;
--
-- 3. a student attempting self-promotion must fail with
--    "permission denied for table profiles" (run while signed in as a student):
--    update public.profiles set role = 'admin' where id = auth.uid();