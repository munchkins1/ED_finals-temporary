# CampusQR — Supabase SQL (ready-to-paste schema)

Copy **the entire `sql` code block** in **Part 1** and run it in the
Supabase **SQL Editor**, then run the small follow-up blocks in
**Parts 2–4** (each says whether you can skip it).

> This file is the single source: it consolidates
> `sql/01_schema.sql`, `02_functions.sql`, `03_rls_policies.sql`,
> `05_realtime.sql`, `07_security_hardening.sql`, `08_admin_delete_user.sql`,
> `10_education_levels.sql` and `11_crud_policies.sql`.
> Skip `04_seed.sql` (demo data — optional), `06_backfill_profiles.sql`
> (one-time repair, folded into the `ALTER TABLE … IF NOT EXISTS` + backfill
> steps below) and `09_registration_student_no.sql` (superseded by `10`,
> whose trigger copy already saves `student_no`).

**Take a backup first** (existing projects):
Dashboard → `Database` → `Backups` → `Create backup`.

---

## Part 1 — Full schema (run this; safe to re-run)

Paste everything inside this block into the SQL Editor and press **Run**.
Every statement is idempotent (`IF NOT EXISTS` / `OR REPLACE` /
`DROP … IF EXISTS`), so re-running it on a live database upgrades it
instead of failing.

```sql
-- ============================================================
-- CampusQR — complete schema: enums, tables, helpers, RLS/CRUD
-- policies, grants, signup trigger, realtime. Safe to re-run.
-- ============================================================

-- ==================== 1. enum types ====================
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

-- Casts client-supplied text to the enum without raising on a bad value,
-- so a hand-crafted signup cannot abort the trigger.
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


-- ---------- new columns ----------
-- `section` and `block` are non-reserved keywords in PostgreSQL.
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


-- ==================== 2. tables ====================
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
  -- educational details (structured):
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

-- Upgrade path: `create table if not exists` skips an existing table, so a
-- database built from an older schema gains the columns here.
-- `section` and `block` are non-reserved keywords in PostgreSQL.
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

create table if not exists public.audit_logs (
  id         bigint generated always as identity primary key,
  actor_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  entity     text,
  entity_id  text,
  details    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_events_created_by   on public.events(created_by);
create index if not exists idx_events_status       on public.events(status);
create index if not exists idx_attendance_event    on public.attendance(event_id);
create index if not exists idx_attendance_student  on public.attendance(student_id);


-- ---------- backfill: infer the level of existing rows ----------
-- Legacy rows stored "College Department" / "Senior High" / "Junior High" /
-- "Kindergarten" in `department`, and "Grade 11-A" in `grade_class`.
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

-- ==================== 3. helper functions (RLS calls these) ====================
-- SECURITY DEFINER: they read public.profiles without re-entering the
-- policies, which is what prevents the
-- "infinite recursion detected in policy" error.
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

create or replace function public.is_student()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (role = 'student' and is_active)
                   from public.profiles where id = auth.uid()), false);
$$;

-- Protect role / is_active from self-escalation at the trigger level.
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Only administrators can change user roles';
    end if;
    if new.is_active is distinct from old.is_active then
      raise exception 'Only administrators can change account status';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_profile_fields on public.profiles;
create trigger trg_protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ==================== 4. check-in RPC ====================
create or replace function public.check_in(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_student public.profiles;
  v_event   public.events;
  v_token   uuid;
begin
  -- 1. authenticated?
  if v_uid is null then
    return jsonb_build_object('result','unauthorized',
      'message','You must be signed in to record attendance.');
  end if;

  -- 2. caller must be an active student
  select * into v_student from public.profiles where id = v_uid;
  if not found then
    return jsonb_build_object('result','unauthorized','message','Profile not found.');
  end if;
  if v_student.role <> 'student' or not v_student.is_active then
    return jsonb_build_object('result','unauthorized',
      'message','Only active student accounts can record attendance.');
  end if;

  -- 3. valid QR token?
  begin
    v_token := p_token::uuid;
  exception when others then
    return jsonb_build_object('result','invalid',
      'message','That QR code is not a valid CampusQR event code.');
  end;

  select * into v_event from public.events where qr_token = v_token;
  if not found then
    return jsonb_build_object('result','invalid',
      'message','Invalid QR code - no matching event found.');
  end if;

  -- 4. event must be open
  if v_event.status <> 'open' then
    return jsonb_build_object('result','closed',
      'message','This event is closed for attendance.');
  end if;
  if v_event.end_datetime is not null and now() > v_event.end_datetime then
    return jsonb_build_object('result','closed',
      'message','This event has already ended.');
  end if;

  -- 5. duplicate prevention
  if exists (select 1 from public.attendance
             where event_id = v_event.id and student_id = v_uid) then
    return jsonb_build_object('result','duplicate','event',v_event.name,
      'message','You have already checked in to this event.');
  end if;

  -- 6. record attendance
  insert into public.attendance (event_id, student_id, status, method, recorded_by)
  values (v_event.id, v_uid, 'present', 'qr', v_uid);

  -- 7. audit trail
  insert into public.audit_logs (actor_id, action, entity, entity_id, details)
  values (v_uid, 'attendance.checkin', 'attendance', v_event.id::text,
          jsonb_build_object('event', v_event.name, 'student', v_student.full_name));

  return jsonb_build_object('result','success','event',v_event.name,
    'event_id', v_event.id, 'message','Attendance recorded successfully.');
end;
$$;

-- ==================== 5. admin RPCs ====================
-- Change a user's role.
create or replace function public.admin_set_role(p_user_id uuid, p_role public.user_role)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    return jsonb_build_object('result','unauthorized','message','Administrator privileges required.');
  end if;
  if p_user_id = auth.uid() and p_role <> 'admin' then
    return jsonb_build_object('result','error','message','You cannot remove your own administrator role.');
  end if;
  update public.profiles set role = p_role where id = p_user_id;
  insert into public.audit_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'user.set_role', 'profiles', p_user_id::text,
          jsonb_build_object('role', p_role));
  return jsonb_build_object('result','success','message','Role updated.');
end;
$$;

-- Activate / deactivate an account.
create or replace function public.admin_set_active(p_user_id uuid, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    return jsonb_build_object('result','unauthorized','message','Administrator privileges required.');
  end if;
  if p_user_id = auth.uid() and p_active = false then
    return jsonb_build_object('result','error','message','You cannot deactivate your own account.');
  end if;
  update public.profiles set is_active = p_active where id = p_user_id;
  insert into public.audit_logs(actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'user.set_active', 'profiles', p_user_id::text,
          jsonb_build_object('is_active', p_active));
  return jsonb_build_object('result','success',
    'message', case when p_active then 'Account activated.' else 'Account deactivated.' end);
end;
$$;

-- Permanently delete a user account (profiles + attendance cascade).
create or replace function public.admin_delete_user(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_admin_count int;
  v_event_count int;
begin
  if not public.is_admin() then
    return jsonb_build_object('result', 'unauthorized', 'message', 'Administrator privileges required.');
  end if;
  if p_user_id = auth.uid() then
    return jsonb_build_object('result', 'error', 'message', 'You cannot delete your own account.');
  end if;
  select count(*) into v_admin_count
    from public.profiles
    where role = 'admin' and is_active and id <> p_user_id;
  if v_admin_count = 0 then
    return jsonb_build_object('result', 'error', 'message', 'You cannot delete the last active administrator.');
  end if;
  select count(*) into v_event_count
    from public.events
    where created_by = p_user_id;
  if v_event_count > 0 then
    return jsonb_build_object('result', 'error', 'message',
      'This account owns ' || v_event_count || ' event(s). Delete or reassign them first.');
  end if;
  delete from auth.users where id = p_user_id;
  if not found then
    return jsonb_build_object('result', 'error', 'message', 'Account not found.');
  end if;
  insert into public.audit_logs(actor_id, action, entity, entity_id, details)
    values (auth.uid(), 'user.delete', 'profiles', p_user_id::text,
            jsonb_build_object('deleted_user_id', p_user_id));
  return jsonb_build_object('result', 'success', 'message', 'Account deleted permanently.');
exception when others then
  return jsonb_build_object('result', 'error', 'message', SQLERRM);
end;
$$;

-- anon has no business changing roles, status or deleting accounts.
revoke execute on function public.admin_set_role(uuid, public.user_role) from anon;
revoke execute on function public.admin_set_active(uuid, boolean) from anon;
revoke execute on function public.admin_delete_user(uuid) from anon;


-- ==================== 6. RLS / CRUD policies ====================
-- A table with RLS enabled and no policies returns/mutates NOTHING for
-- clients (silently). The policies below restore CRUD per role.
alter table public.profiles   enable row level security;
alter table public.events     enable row level security;
alter table public.attendance enable row level security;
alter table public.audit_logs enable row level security;

-- ==================== profiles ====================
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
-- without it, edits on other users' rows silently match 0 rows and the app
-- reports "Save blocked - the database kept the old value".
drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- INSERT: deliberately none for clients. handle_new_user() (SECURITY DEFINER)
--         creates the row at signup, so RLS is never consulted.
-- DELETE: deliberately none for clients. Accounts are removed by deleting the
--         auth.users row (ON DELETE CASCADE) or via admin_delete_user().

-- ---------- harden the signup trigger ----------
-- Also copies `phone`, which the old trigger never did. The copies in
-- 01_schema.sql, 07_security_hardening.sql and 09_registration_student_no.sql
-- must stay byte-identical to this one.
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


-- ==================== events ====================
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

-- ==================== attendance ====================
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
-- No INSERT policy on purpose: check-ins only via check_in() RPC.

-- ==================== audit_logs ====================
drop policy if exists audit_select_admin on public.audit_logs;
create policy audit_select_admin on public.audit_logs
  for select using (public.is_admin());


-- ---------- grants ----------
grant usage on schema public to authenticated;
grant select on public.profiles, public.events,
               public.attendance, public.audit_logs to authenticated;
grant insert, update, delete on public.events, public.attendance to authenticated;

revoke update on public.profiles from anon, authenticated;

grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;

-- ---------- audit trigger ----------
create or replace function public.audit_event_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs(actor_id, action, entity, entity_id, details)
    values (auth.uid(), 'event.create', 'events', new.id::text,
            jsonb_build_object('name', new.name, 'status', new.status));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into public.audit_logs(actor_id, action, entity, entity_id, details)
      values (auth.uid(), 'event.status', 'events', new.id::text,
              jsonb_build_object('name', new.name, 'from', old.status, 'to', new.status));
    else
      insert into public.audit_logs(actor_id, action, entity, entity_id, details)
      values (auth.uid(), 'event.update', 'events', new.id::text,
              jsonb_build_object('name', new.name));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_audit_events on public.events;
create trigger trg_audit_events
  after insert or update on public.events
  for each row execute function public.audit_event_change();

-- ==================== realtime (optional, safe to re-run) ====================
-- If the publication does not exist, enable Realtime first:
-- Database -> Replication -> enable supabase_realtime, then re-run this block.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendance'
  ) then
    alter publication supabase_realtime add table public.attendance;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'audit_logs'
  ) then
    alter publication supabase_realtime add table public.audit_logs;
  end if;
end;
$$;
```

---

## Verify it worked

Run each of these as a **separate** query. All are read-only.

**1. The five columns exist**

```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles'
   and column_name in ('educational_level','course','year_level','block','section')
 order by column_name;
```

Expected — `educational_level` is `USER-DEFINED` (the enum), the rest `text`:

| column_name | data_type |
|---|---|
| block | text |
| course | text |
| educational_level | USER-DEFINED |
| section | text |
| year_level | text |

**2. Students can edit exactly 11 columns — never `role` or `is_active`**

```sql
select column_name
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'profiles'
   and grantee = 'authenticated' and privilege_type = 'UPDATE'
 order by column_name;
```

Expected 11 rows: `block, course, department, educational_level, full_name,
grade_class, phone, section, student_no, title, year_level`.
Must **not** contain `role`, `is_active`, `email`, `id`, `created_at`.

**3. Existing accounts got classified by the backfill**

```sql
select educational_level, count(*) from public.profiles group by 1 order by 1;
```

Expected: `NULL` only for rows that had neither a recognisable `department`
nor a `Grade N` string.

**4. The safe cast swallows bad input instead of breaking signup**

```sql
select public.try_education_level('college');      -- college
select public.try_education_level('superuser');    -- NULL, no error
```

---

## After running it

1. **Hard-refresh** the browser — `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac).
   The Profile tab caches `app.html`, so a normal refresh may still show the old markup.
2. Open **Profile** → you should see an **Education Level / Information** section
   with *Educational Level* first, followed by Course / Year / Block / Section
   for whichever level is set.
3. If it still says **"Not set"** with an amber warning, your account predates the
   migration or an admin has not filled it in — go to
   **Admin → Manage Users → Edit** and choose the Educational Level.
4. Register one test account per level and confirm the Profile tab matches the
   registration form exactly (password is never shown, by design).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `permission denied for table profiles` on save | The `grant update` did not run. Re-run this file. |
| `column "educational_level" does not exist` at signup | You ran `sql/01`, `07` or `09` before this. Run this file again. |
| Profile still shows the old layout | Hard-refresh to bust the `app.html` cache. |
| An old account shows the wrong level | Set it in **Admin → Manage Users → Edit**; the backfill only infers what it can. |

---

## Fix: "Save blocked - the database kept the old value for: …" (table CRUD)

**Where:** `Admin → Manage Users → Edit → Save`.

**What it means:** the app prints that message only after re-reading the row
and finding that **none of the submitted values were written**. Postgres reports
an `UPDATE` that matched no rows as *success with 0 rows* — never as an error —
and Row Level Security produces exactly that when no `UPDATE` policy covers the
row. One column, one row or all of them: the whole statement is filtered out
together, which is why the fields named in the message are simply the ones you
had changed.

| Cause | How to confirm |
|---|---|
| The `profiles_admin_all` policy is missing (a partial/older `03`/`07`, or a later script replaced the policies) → only `profiles_update_self` applies → rows that are not your own are silently filtered out | **Diagnose step 1** returns fewer than 4 rows |
| `public.is_admin()` is false for the account you signed in with: `role <> 'admin'` **or** `is_active = false` | **Diagnose step 2** does not show `admin` + `t` for your row |
| Different symptom: a column missing from `grant update` | the save fails with `permission denied for table profiles` instead |

### Diagnose first

Run each query separately (read-only):

**1 — which policies does `public.profiles` have?**

```sql
select policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename = 'profiles'
 order by policyname;
```

Expected — exactly these four:

| policyname | cmd |
|---|---|
| profiles_admin_all | all |
| profiles_select_self | select |
| profiles_select_staff | select |
| profiles_update_self | update |

**2 — is the account you sign in with an active admin?**

```sql
select email, role, is_active
  from public.profiles
 order by role, email;
```

Your own row must read `role = admin` and `is_active = t`, otherwise
`is_admin()` is `false` in the app and every update to somebody else's row is
filtered out — exactly the symptom above.

> The SQL Editor runs as `postgres` with `auth.uid() = NULL`, so
> `select public.is_admin();` always returns `false` there. That is expected —
> judge from the account rows in query 2 instead.

### The SQL

Copy **everything inside the code block below** and paste it into the Supabase
**SQL Editor**, then press **Run**.

> Mirrors `sql/11_crud_policies.sql`. If you change one, change the other.
> Safe to re-run: it only re-creates the helpers, policies and grants the app
> already relies on, and it grants nothing new to students (`role`,
> `is_active`, `email` stay unwritable, and `attendance` still has no client
> `INSERT` policy — check-ins go through the `check_in()` RPC).

```sql
-- ============================================================
-- CampusQR - restore full CRUD (mirrors sql/11_crud_policies.sql).
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
-- WHAT THIS BLOCK DOES
--   Puts every policy, helper function and grant the app depends on back in
--   one idempotent place, so CRUD works no matter which earlier file was
--   skipped. It grants nothing new to students: role/is_active/email stay
--   unwritable, and attendance keeps having no client INSERT policy (records
--   are created only through the check_in() RPC).
-- ============================================================

-- ---------- 0. Role helper functions the policies call (02_functions.sql) ----------
-- SECURITY DEFINER: they read public.profiles without re-entering the policies,
-- which prevents the "infinite recursion detected in policy" error.
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

-- ---------- 1. Row Level Security must be ON ----------
-- A table with RLS enabled and no policies returns/mutates NOTHING for
-- clients (silently) - the failure mode above.
alter table public.profiles   enable row level security;
alter table public.events     enable row level security;
alter table public.attendance enable row level security;
alter table public.audit_logs enable row level security;

-- ---------- 2. profiles - the policies behind Manage Users CRUD ----------
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

-- INSERT: none for clients - handle_new_user() (SECURITY DEFINER) creates the
--         row at signup, so RLS is never consulted.
-- DELETE: none for clients - accounts are removed by deleting the auth.users
--         row (ON DELETE CASCADE) or via admin_delete_user().

-- ---------- 3. events - teachers own their events, admins manage all ----------
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

-- ---------- 4. attendance - students their own rows, teachers their events, admins all ----------
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

-- ---------- 5. audit_logs - admin read only; writes come from triggers ----------
drop policy if exists audit_select_admin on public.audit_logs;
create policy audit_select_admin on public.audit_logs
  for select using (public.is_admin());


-- ============================================================
-- 7. Table- and column-level privileges (Layer A)
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
-- A student PATCHing { "role": "admin" } fails with
-- "permission denied for table profiles" before RLS is even consulted.
revoke update on public.profiles from anon, authenticated;

grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;
__NEXT__

-- ---------- 6. table- and column-level privileges (Layer A) ----------
grant usage on schema public to authenticated;
grant select on public.profiles, public.events,
               public.attendance, public.audit_logs to authenticated;
grant insert, update, delete on public.events, public.attendance to authenticated;
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;
```

### Verify it worked

Run each of these as a **separate** query (all are read-only). If any check
fails, re-run **The SQL** block above, then check again.

**1 — all four `profiles` policies are present**

```sql
select policyname, cmd
  from pg_policies
 where schemaname = 'public' and tablename = 'profiles'
 order by policyname;
```

Expected — exactly these four rows: `profiles_admin_all | all`,
`profiles_select_self | select`, `profiles_select_staff | select`,
`profiles_update_self | update`. Missing `profiles_admin_all` is the #1 cause
of the "kept the old value" message: only `profiles_update_self` applies, so
every row that is not your own is silently filtered out of the `UPDATE`.

**2 — `authenticated` can UPDATE exactly the eleven editable columns**

```sql
select column_name
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'profiles'
   and grantee = 'authenticated' and privilege_type = 'UPDATE'
 order by column_name;
```

Expected 11 rows: `block, course, department, educational_level, full_name,
grade_class, phone, section, student_no, title, year_level`.
Must **not** contain `role`, `is_active`, `email`, `id`, `created_at`.
A missing column here fails differently — `permission denied for table
profiles` raised as an error, not the silent "kept the old value".

**3 — the account you sign in with is an active admin**

```sql
select email, role, is_active
  from public.profiles
 order by role, email;
```

Your own row must read `role = admin` **and** `is_active = t`. Otherwise
`public.is_admin()` is `false` inside the app and every `UPDATE` on somebody
else's row is filtered out — exactly the symptom above.
To re-activate your own row (the SQL Editor runs as `postgres` and bypasses
RLS):

```sql
update public.profiles set is_active = true where email = 'you@school.edu';
```

> The SQL Editor runs as `postgres` with `auth.uid() = NULL`, so
> `select public.is_admin();` always returns `false` there. That is expected —
> judge from the account rows in check 3 instead.

### After running it

1. **Hard-refresh** the browser — `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R`
   (Mac) — so `app.html` / `js/admin.js` are not served from cache.
2. Go to **Admin → Manage Users → Edit**, change **Year / Grade Level** and
   **Grade / Class**, then **Save** — the row should update with no "kept the
   old value" message, whether you changed one column, one row, or all of them.
3. Check the edited user's **Profile** tab (Personal Information +
   Educational Information) — the same values appear without a reload.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Save blocked - the database kept the old value for: …` persists | Re-run **Diagnose first**: fewer than 4 policies, or your own row not `admin` + active — then re-run **The SQL**. |
| `permission denied for table profiles` on save | Step 6 grants did not run. Re-run **The SQL** above. |
| `column "educational_level" does not exist` anywhere | The education columns were never added. Run the first SQL block in this file, then this one. |
| `infinite recursion detected in policy for relation "profiles"` | An old policy reads `profiles` directly. Re-running **The SQL** replaces it with the `SECURITY DEFINER` helpers. |
| Older policy re-appears after this file | Run the files in order `01 … 11`; this file must be last. |
