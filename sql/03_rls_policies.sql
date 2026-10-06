-- ============================================================
-- CampusQR - 03_rls_policies.sql
-- Row Level Security: role-based authorization + database access protection.
-- Run this AFTER 02_functions.sql.
-- ============================================================

alter table public.profiles   enable row level security;
alter table public.events     enable row level security;
alter table public.attendance enable row level security;
alter table public.audit_logs enable row level security;

-- ===================== profiles =====================
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_select_staff on public.profiles;
create policy profiles_select_staff on public.profiles
  for select using (public.is_staff());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
-- (the trg_protect_profile_fields trigger blocks role/is_active self-changes)

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- ===================== events =====================
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

-- ===================== attendance =====================
-- students read only their own rows; teachers read rows for their own events; admins all
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
-- NOTE: there is deliberately NO insert policy on attendance, so clients can
-- only create a record through the validated check_in() RPC.

-- ===================== audit_logs =====================
drop policy if exists audit_select_admin on public.audit_logs;
create policy audit_select_admin on public.audit_logs
  for select using (public.is_admin());
-- Inserts happen only via SECURITY DEFINER functions/triggers, never the client.
