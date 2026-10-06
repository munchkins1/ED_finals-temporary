-- ============================================================
-- CampusQR - School Event Attendance System
-- 01_schema.sql : Enum types, tables, constraints, indexes, signup trigger,
--                 plus the educational columns and their column-level grants.
-- Run this FIRST in the Supabase SQL Editor.
--
-- SAFE TO RE-RUN ON A LIVE DATABASE:
--   every CREATE TABLE / CREATE INDEX is guarded by IF NOT EXISTS, the five
--   educational columns are added by ALTER ... IF NOT EXISTS, and the signup
--   trigger / functions are CREATE OR REPLACE. A database built from an older
--   copy of this file therefore picks up the educational fields just by
--   running this file again - no separate migration needed.
-- ============================================================

-- ---------- Enum types (safe to re-run) ----------
do $$ begin
  create type public.user_role as enum ('student', 'teacher', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.event_status as enum ('draft', 'open', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.attendance_status as enum ('present', 'late', 'absent', 'excused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.educational_level as enum
    ('college', 'senior_high', 'junior_high', 'elementary');
exception when duplicate_object then null; end $$;

-- Casts client-supplied text to the enum without raising on a bad value, so a
-- hand-crafted signup cannot abort the trigger. See 10_education_levels.sql.
create or replace function public.try_education_level(value text)
returns public.educational_level
language plpgsql
immutable
as $$
begin
  return nullif(value, '')::public.educational_level;
exception when others then
  return null;
end;
$$;

-- ---------- profiles (one row per auth user, holds role + profile data) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique not null,
  full_name   text not null default '',
  role        public.user_role not null default 'student',
  student_no  text,
  grade_class text,
  department  text,
  title       text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  -- ---------- educational details (structured; see 10_education_levels.sql) ----------
  -- college     -> course + year_level 1-4 + block A-F
  -- senior_high -> course (track) + year_level 11-12 + section
  -- junior_high -> year_level 7-10 + section
  -- elementary  -> year_level 1-6 + section
  educational_level public.educational_level,
  course     text,
  year_level text,
  block      text,
  section    text
);
comment on table public.profiles is 'Application profile + role for every authenticated user.';
comment on column public.profiles.grade_class is 'Denormalised display string (e.g. "Year 3 . Block A") built by formatGradeClass() in js/education.js; kept for the admin reports.';

-- ---------- educational columns: upgrade path for an EXISTING database ----------
-- `create table if not exists` does nothing when the table is already there, so
-- a database created from an older copy of this file would never receive these
-- columns and the registration form would fail with
--   column "educational_level" of relation "profiles" does not exist
-- On a fresh install every statement below is a no-op, because the columns are
-- already declared in the CREATE TABLE above.
-- `section` and `block` are non-reserved keywords in PostgreSQL, so they are
-- safe as bare column names.
alter table public.profiles add column if not exists educational_level public.educational_level;
alter table public.profiles add column if not exists course     text;
alter table public.profiles add column if not exists year_level text;
alter table public.profiles add column if not exists block      text;
alter table public.profiles add column if not exists section    text;

comment on column public.profiles.educational_level is 'college | senior_high | junior_high | elementary';
comment on column public.profiles.course           is 'College course (BSIT, ...) or SHS track (STEM, ...)';
comment on column public.profiles.year_level       is 'College year 1-4, or grade level 11-12 / 7-10 / 1-6';
comment on column public.profiles.block            is 'College block A-F; NULL for every other level';
comment on column public.profiles.section          is 'Free-text section for SHS / JHS / Elementary; NULL for College';

-- ---------- backfill: classify rows that predate the structured columns ----------
-- Legacy rows stored "College Department" / "Senior High" / "Junior High" /
-- "Kindergarten" in `department`, and "Grade 11-A" in `grade_class`.
-- The new academic columns stay NULL for these rows: their existing
-- grade_class still displays correctly, so there is no need to guess at a
-- section/block split.
--
-- Only educational_level is written, and trg_protect_profile_fields (created
-- in 02_functions.sql) guards role / is_active only - so this UPDATE does not
-- need the trigger disabled, even when 01 is re-run on a mature database.
with legacy as (
  select
    p.id,
    case
      when p.department ilike '%college%' then 'college'::public.educational_level
      when p.department ilike '%senior%'  then 'senior_high'::public.educational_level
      when p.department ilike '%junior%'  then 'junior_high'::public.educational_level
      when p.department ilike '%kinder%'  then 'elementary'::public.educational_level
      when g.n between 1  and 6            then 'elementary'::public.educational_level
      when g.n between 7  and 10           then 'junior_high'::public.educational_level
      when g.n between 11 and 12           then 'senior_high'::public.educational_level
    end as lvl
  from public.profiles p
  left join lateral (
    -- "Grade 11-A" -> 11. NULL when the string does not start with a grade.
    select nullif((regexp_match(coalesce(p.grade_class, ''), '^grade\s+(\d+)'))[1], '')::int as n
  ) g on true
)
update public.profiles p
   set educational_level = l.lvl
  from legacy l
 where p.id = l.id
   and p.educational_level is null
   and l.lvl is not null;

-- ---------- column-level privileges for profiles ----------
-- Identical to the copy in 07_security_hardening.sql, repeated here so that
-- running 01 on its own also restores the grants. Any column missing from this
-- list fails with "permission denied for table profiles" the moment a student
-- saves their profile, so it must list every self-editable field.
revoke update on public.profiles from anon, authenticated;

grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;

-- ---------- events ----------
create table if not exists public.events (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text not null default '',
  venue          text not null default '',
  start_datetime timestamptz not null,
  end_datetime   timestamptz,
  status         public.event_status not null default 'draft',
  qr_token       uuid not null default gen_random_uuid() unique,
  created_by     uuid not null references public.profiles(id) on delete cascade,
  created_at     timestamptz not null default now(),
  constraint events_time_check check (end_datetime is null or end_datetime >= start_datetime)
);

-- ---------- attendance (unique per event+student => duplicate prevention) ----------
create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  status      public.attendance_status not null default 'present',
  method      text not null default 'qr',
  recorded_at timestamptz not null default now(),
  recorded_by uuid references public.profiles(id) on delete set null,
  constraint attendance_unique_per_event unique (event_id, student_id)
);

-- ---------- audit_logs (system records / admin reports) ----------
create table if not exists public.audit_logs (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  entity     text,
  entity_id  text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------- indexes ----------
create index if not exists idx_events_created_by   on public.events(created_by);
create index if not exists idx_events_status       on public.events(status);
create index if not exists idx_attendance_event    on public.attendance(event_id);
create index if not exists idx_attendance_student  on public.attendance(student_id);

-- ---------- auto-create a profile whenever a user signs up ----------
-- Keep this byte-for-byte identical to the copies in
-- 07_security_hardening.sql, 09_registration_student_no.sql and
-- 10_education_levels.sql: whichever is run last wins, so an out-of-date copy
-- silently drops fields (that is the bug 09 fixed for student_no).
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
-- VERIFY (read-only - run these to confirm)
-- ============================================================
--
-- 1. the five educational columns exist:
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'profiles'
--    and column_name in ('educational_level','course','year_level','block','section')
--  order by column_name;
--    expect: block, course, educational_level (USER-DEFINED), section, year_level
--
-- 2. role / is_active must NOT be writable by a student, but the eleven
--    self-editable columns must be:
-- select column_name from information_schema.column_privileges
--  where table_schema = 'public' and table_name = 'profiles'
--    and grantee = 'authenticated' and privilege_type = 'UPDATE'
--  order by column_name;
--    expect: block, course, department, educational_level, full_name,
--            grade_class, phone, section, student_no, title, year_level
--    must NOT contain: role, is_active, email, id, created_at
--
-- 3. existing rows were classified by the backfill:
-- select educational_level, count(*) from public.profiles group by 1;
--    expect: NULL only for rows with no department AND no "Grade N" string
--
-- 4. try_education_level() swallows garbage instead of aborting a signup:
-- select public.try_education_level('college');   -- college
-- select public.try_education_level('superuser'); -- NULL, no error
