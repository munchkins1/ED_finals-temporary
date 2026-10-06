-- ============================================================
-- CampusQR - 05_realtime.sql  (OPTIONAL)
-- Lets attendance, events, account status and the audit log update live.
-- Run this in the Supabase SQL Editor if you want live updates.
-- The app works fine without it - it just needs a page refresh.
-- ============================================================

do $$
begin
  -- only add the table once, otherwise the command errors out
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'attendance'
  ) then
    alter publication supabase_realtime add table public.attendance;
  end if;

  -- Same for the events table so the event board refreshes live too.
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;

  -- Same for profiles so a deactivated account is signed out immediately.
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;

  -- Same for audit_logs so the admin System Activity Log updates live.
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'audit_logs'
  ) then
    alter publication supabase_realtime add table public.audit_logs;
  end if;
end;
$$;

-- ============================================================
-- VERIFY: run this afterwards - you should get one row per table:
--     attendance | audit_logs | events | profiles
-- ============================================================
-- select schemaname, tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' order by tablename;
--
-- If this script errors with "publication supabase_realtime does not exist",
-- enable Realtime in the Supabase Dashboard first:
--     Database -> Replication -> enable the supabase_realtime publication,
--     then run this file again.