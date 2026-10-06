-- ============================================================
-- CampusQR - 02_functions.sql
-- Helper functions, the secure check-in RPC, admin RPCs, audit trigger.
-- Run this AFTER 01_schema.sql.
-- ============================================================

-- ---------- role helper functions (used by RLS policies) ----------
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

-- ---------- protect sensitive profile fields from self-escalation ----------
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

-- ---------- THE check-in RPC: all validation happens here, atomically ----------
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

-- ---------- admin: change a user's role ----------
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

-- ---------- admin: activate / deactivate an account ----------
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

-- ---------- audit trail for event create / update / status change ----------
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


