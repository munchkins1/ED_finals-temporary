-- ============================================================
-- CampusQR - 11_crud_policies.sql
-- Restore full CRUD (SELECT / INSERT / UPDATE / DELETE) on the app tables.
-- Safe to re-run. Run this AFTER 01-10, in the Supabase SQL Editor.
--
-- SYMPTOM this fixes:
--   Admin -> Manage Users -> Edit -> Save reports
--     "Save blocked - the database kept the old value for: <fields>"
--
-- WHAT THAT MEANS
--   The app only prints that after re-reading the row and finding the values
--   it submitted were NOT written. Postgres reports an UPDATE that matched no
--   rows as *success with 0 rows* - never as an error - and that is exactly
--   what RLS does when no UPDATE policy covers the target row. Two causes:
--
--     1. the profiles_admin_all policy is missing (an earlier 03/07 never ran
--        or was replaced), so only profiles_update_self applies and rows that
--        are not your own are filtered out silently;
--     2. public.is_admin() returns false for the signed-in account, because
--        role <> 'admin' or is_active = false.
--
--   A missing *column* grant behaves differently and raises
--   "permission denied for table profiles" instead - see step 6.
--
-- WHAT THIS SCRIPT DOES
--   Puts every policy, helper function and grant the app depends on back in
--   one idempotent place, so CRUD works no matter which earlier file was
--   skipped. It grants nothing new to students: role/is_active/email stay
--   unwritable, and attendance keeps having no client INSERT policy (records
--   are created only through the check_in() RPC).
-- ============================================================


-- ============================================================
-- 0. Role helper functions the policies call (02_functions.sql)
-- ============================================================
-- SECURITY DEFINER: they read public.profiles without re-entering the policies,
-- which is what prevents the "infinite recursion detected in policy" error.
create or replace function public.current_role()
returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (role = 'admin' and is_active)
                   from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_staff()  -- teacher OR admin
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (role in ('teacher','admin') and is_active)
                   from public.profiles where id = auth.uid()), false);
$$;


-- ============================================================
-- 1. Row Level Security must be ON
-- ============================================================
-- A table with RLS enabled and no policies returns/mutates NOTHING for
-- clients (silently), which is the failure mode above.
alter table public.profiles   enable row level security;
alter table public.events     enable row level security;
alter table public.attendance enable row level security;
alter table public.audit_logs enable row level security;


-- ============================================================
-- 2. profiles - the policies behind Manage Users CRUD
-- ============================================================
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_select_staff on public.profiles;
create policy profiles_select_staff on public.profiles
  for select using (public.is_staff());

-- Users may edit their OWN row; the resulting role must be unchanged, so a
-- student cannot smuggle in role = 'admin'.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid() and role = public.current_role());

-- *** This is the policy that makes Admin -> Manage Users -> Edit work. ***
-- Permissive policies are OR'd, so it lets an active admin UPDATE any row -
-- which is what turns the silent "0 rows" into a write that lands.
drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- INSERT: deliberately none for clients. handle_new_user() (SECURITY DEFINER)
--         creates the row at signup, so RLS is never consulted.
-- DELETE: deliberately none for clients. Accounts are removed by deleting the
--         auth.users row (ON DELETE CASCADE) or via admin_delete_user().


-- ============================================================
-- 3. events - teachers own their events, admins manage all
-- ============================================================
drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select using (
    status = 'open' or created_by = auth.uid() or public.is_admin()
  );

drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  for insert with check (public.is_staff() and created_by = auth.uid());

drop policy if exists events_update on public.events;
create policy events_update on public.events
  for update using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists events_delete on public.events;
create policy events_delete on public.events
  for delete using (created_by = auth.uid() or public.is_admin());


-- ============================================================
-- 4. attendance - students their own rows, teachers their events, admins all
-- ============================================================
drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select using (
    student_id = auth.uid()
    or public.is_admin()
    or exists (select 1 from public.events e
               where e.id = attendance.event_id and e.created_by = auth.uid())
  );

drop policy if exists attendance_update on public.attendance;
create policy attendance_update on public.attendance
  for update using (
    public.is_admin()
    or exists (select 1 from public.events e
               where e.id = attendance.event_id and e.created_by = auth.uid())
  ) with check (
    public.is_admin()
    or exists (select 1 from public.events e
               where e.id = attendance.event_id and e.created_by = auth.uid())
  );

drop policy if exists attendance_delete on public.attendance;
create policy attendance_delete on public.attendance
  for delete using (
    public.is_admin()
    or exists (select 1 from public.events e
               where e.id = attendance.event_id and e.created_by = auth.uid())
  );
-- No INSERT policy on purpose: check-ins can only be created through the
-- validated check_in() RPC (SECURITY DEFINER).


-- ============================================================
-- 5. audit_logs - admin read only; writes come from triggers
-- ============================================================
drop policy if exists audit_select_admin on public.audit_logs;
create policy audit_select_admin on public.audit_logs
  for select using (public.is_admin());


-- ============================================================
-- 6. Table- and column-level privileges (Layer A)
-- ============================================================
-- Table-level read for the signed-in role. Row visibility is still decided
-- entirely by the policies above.
grant usage on schema public to authenticated;
grant select on public.profiles, public.events,
               public.attendance, public.audit_logs to authenticated;

-- Table-level CRUD for the two tables the app edits directly. RLS policies
-- decide which rows each role may touch - attendance has no INSERT policy, so
-- clients still cannot create records outside check_in().
grant insert, update, delete on public.events, public.attendance to authenticated;

-- profiles is protected COLUMN-wise instead: strip the blanket UPDATE and
-- re-grant only the eleven self-editable columns. role, is_active, email, id
-- and created_at stay unwritable for everyone but postgres.
revoke update on public.profiles from anon, authenticated;

grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;


-- ============================================================
-- 7. VERIFY (read-only - run each block as a separate query)
-- ============================================================
-- 7a. all four profiles policies present? Expect exactly:
--       profiles_admin_all      | all
--       profiles_select_self    | select
--       profiles_select_staff   | select
--       profiles_update_self    | update
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'profiles'
--  order by policyname;
--
-- 7b. the eleven writable columns (role / is_active / email must be absent):
-- select column_name from information_schema.column_privileges
--  where table_schema = 'public' and table_name = 'profiles'
--    and grantee = 'authenticated' and privilege_type = 'UPDATE'
--  order by column_name;
--
-- 7c. every account's role + active flag. The account you sign in with must
--     show role = 'admin' AND is_active = true, otherwise is_admin() is false
--     in the app and every UPDATE on somebody else's row is filtered out
--     silently - exactly the "kept the old value" symptom:
-- select email, role, is_active from public.profiles order by role, email;
--
--     If your own row shows is_active = false, activate it (the SQL Editor
--     runs as postgres and bypasses RLS):
--       update public.profiles set is_active = true where email = 'you@school.edu';
--
-- NOTE: the SQL Editor runs as postgres with auth.uid() = NULL, so
--         select public.is_admin();   -- always false here - that is expected.
--       Judge 7c from the account rows instead.


