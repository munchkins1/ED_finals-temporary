-- ============================================================
-- CampusQR - 08_admin_delete_user.sql
-- Secure account deletion for administrators.
-- Run this AFTER 07_security_hardening.sql in the Supabase SQL Editor.
-- ============================================================

-- ---------- admin: permanently delete a user account ----------
-- Deletes the auth.users row; the profiles row (and its attendance rows)
-- cascade from profiles.id -> auth.users(id). Returns jsonb {result, message}
-- so the client can toast a friendly message without parsing errors.
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
  -- events.created_by cascades: deleting an event owner would wipe school
  -- events and their attendance, so block and ask for cleanup first.
  select count(*) into v_event_count
    from public.events
    where created_by = p_user_id;
  if v_event_count > 0 then
    return jsonb_build_object('result', 'error', 'message',
      'This account owns ' || v_event_count || ' event(s). Delete or reassign them first.');
  end if;
  -- Runs as the function owner (postgres) via SECURITY DEFINER, which is the
  -- only role allowed to touch auth.users. The profiles row (and the user's
  -- own attendance rows) cascade from profiles.id -> auth.users(id).
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

-- anon has no business deleting accounts.
revoke execute on function public.admin_delete_user(uuid) from anon;
