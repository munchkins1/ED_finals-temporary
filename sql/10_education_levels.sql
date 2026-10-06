-- ============================================================
-- CampusQR - School Event Attendance System
-- 10_education_levels.sql : structured educational details
--
-- Run this in the Supabase SQL Editor AFTER 01-09. Safe to re-run.
--
-- *** ALREADY HAVE A LIVE DATABASE? -> RUN ONLY THIS FILE. ***
-- ------------------------------------------------------------
-- The copies of handle_new_user() in 01, 07 and 09 now INSERT into
-- educational_level / course / year_level / block / section. Those columns do
-- not exist until THIS file creates them. If you re-run 01, 07 or 09 first,
-- every new signup fails with:
--
--     column "educational_level" of relation "profiles" does not exist
--
-- Until this file has been run, the registration form saves none of the
-- educational fields and the Profile tab shows "N/A" for them, because the
-- live trigger is still the old two-column one.
--
-- Fresh install order: 01 -> 02 -> 03 -> 04 -> 05 (optional) -> 06 ->
--                       07 -> 08 -> 10 -> 11   (09 is superseded by 10)
-- Existing database:   10 only.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Signup used to capture only two free-text academic fields, `department`
-- and `grade_class`. That cannot express the real model, which has four
-- branches with different inputs:
--
--   College            -> Course (BSIT, BSED, ...) + Year Level 1-4 + Block A-F
--   Senior High School -> Track  (STEM, ABM, ...) + Grade Level 11-12 + Section
--   Junior High School -> Grade Level 7-10 + Section
--   Elementary         -> Grade Level 1-6 + Section
--
-- This adds one column per distinct concept, so the data is finally
-- queryable and filterable (e.g. "every Grade 7 student"):
--
--   educational_level  which branch the student belongs to (enum)
--   course             College course OR SHS track
--   year_level         College year (1-4) OR grade level (11-12 / 7-10 / 1-6)
--   block              College only, A-F
--   section            SHS / JHS / Elementary only, free text
--
-- BACKWARDS COMPATIBILITY
-- ---------------------
-- `grade_class` is STILL written, now as a human-readable composite built by
-- formatGradeClass() in js/education.js:
--
--   College              -> "Year 3 . Block A"
--   SHS / JHS / Element  -> "Grade 11 . Section B"
--
-- Four existing call sites read `grade_class` for their "Grade/Class"
-- column (js/admin.js x3, js/reports.js x1), so keeping it populated means
-- no query changes and no broken reports. It is a DENORMALISED copy of the
-- columns above: always regenerate it through formatGradeClass(), never
-- hand-write it.
--
-- The course is deliberately NOT part of the composite, because js/admin.js
-- already renders `department` on its own line directly underneath.
-- ============================================================


-- ---------- enum (safe to re-run) ----------
do $$ begin
  create type public.educational_level as enum
    ('college', 'senior_high', 'junior_high', 'elementary');
exception when duplicate_object then null; end $$;


-- ---------- new columns ----------
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
comment on column public.profiles.grade_class      is 'Denormalised display string built by formatGradeClass(); kept for reports.';


-- ---------- safe enum cast ----------
-- handle_new_user() reads educational_level straight from client-supplied auth
-- metadata. A hand-crafted signUp with educational_level = 'superuser' would
-- otherwise abort the INSERT and break the signup. Swallow the bad value and
-- store NULL instead.
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


-- ---------- backfill: infer the level of existing rows ----------
-- Legacy rows stored "College Department" / "Senior High" / "Junior High" /
-- "Kindergarten" in `department`, and things like "Grade 11-A" in
-- `grade_class`. Infer the level from either. The new academic columns stay
-- NULL for these rows: their existing `grade_class` still displays correctly,
-- so there is no need to guess at a section/block split.
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

-- OPTIONAL: only if you also want the old rows split into real columns.
-- Best-effort parse of "Grade 11-A" / "Grade 7" into year_level + section.
-- Run the SELECT first and eyeball it before running the UPDATE.
--
-- select id, grade_class, educational_level,
--        nullif((regexp_match(coalesce(grade_class, ''), '^grade\s+(\d+)'))[1], '')::int  as year,
--        nullif((regexp_match(coalesce(grade_class, ''), '^grade\s+\d+\s*[-]?\s*(\S+)$'))[1], '') as section
--   from public.profiles
--  where educational_level in ('senior_high', 'junior_high', 'elementary');


-- ---------- harden the signup trigger ----------
-- Also picks up `phone`, which the trigger never copied before: there was no
-- phone field on the registration form, and the read-only profile card does
-- not let a student edit it afterwards, so a phone could never be set at all.
--
-- Mirrors the identical copies in 01_schema.sql, 07_security_hardening.sql and
-- 09_registration_student_no.sql - keep all four identical. Re-running an
-- older copy after this one would silently drop the new fields, which is
-- exactly the bug 09 fixed for student_no.
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


-- ---------- column-level privileges (LAYER A) ----------
-- The app now writes eleven columns, not six. Any column missing from this
-- list fails with "permission denied for table profiles" the moment a student
-- saves their profile, so it must list every self-editable field.
revoke update on public.profiles from anon, authenticated;

grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;


-- ============================================================
-- VERIFY (read-only - run these to confirm)
--
-- 1. the new columns exist:
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
-- 3. legacy rows were classified:
-- select educational_level, count(*) from public.profiles group by 1;
--    expect: NULL only for rows with no department AND no "Grade N" string
--
-- 4. try_education_level() swallows garbage instead of aborting a signup:
-- select public.try_education_level('college');   -- college
-- select public.try_education_level('superuser');  -- NULL (and no error)
-- ============================================================