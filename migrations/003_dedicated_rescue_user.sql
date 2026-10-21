-- ============================================================
-- AVIGHNAA RESCUE LAYER — Migration 003
-- Dedicated RESCUE TEAM login account.
--
-- WHY: the control-room account (controlroom@rockfall.com) is role=admin, so
-- signing in with it from the Rescue Portal always lands in the Admin console.
-- Rescue operators need their OWN account so nobody has to reset passwords.
--
-- HOW TO USE (2 steps, in this order):
--   Step 1 — Supabase Dashboard > Authentication > Users > "Add user"
--            Email:       rescue.team@avighnaa.com
--            Password:    <your own password — keep it in .env, not in this repo>
--            ☑ Auto Confirm User
--   Step 2 — Supabase Dashboard > SQL Editor > paste THIS file > Run
--
-- The account password is deliberately NOT stored in this repository: it lives
-- in .env (gitignored) as RESCUE_TEAM_PASSWORD.
--
-- This file is IDEMPOTENT: safe to run before or after the auth user exists.
-- It NEVER inserts a made-up uuid — it looks the real id up from auth.users
-- by email. If the auth user does not exist yet it does nothing harmful,
-- it just reports MISSING so you know to do Step 1.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. Make the signup trigger role-aware
-- When a user is created through the dashboard with App Metadata
-- { "role": "rescue_team", "team_id": "RT-01" }, the profile is
-- created with that role instead of the default 'user'.
-- ────────────────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_role   text;
  v_team   text;
begin
  -- Only trust roles from the explicit allow-list.
  v_role := coalesce(new.raw_app_meta_data ->> 'role', 'user');
  if v_role not in ('user', 'admin', 'rescue_team') then
    v_role := 'user';
  end if;

  v_team := new.raw_app_meta_data ->> 'team_id';
  if v_role <> 'rescue_team' then
    v_team := null;
  end if;

  insert into public.profiles (id, email, role, team_id)
  values (new.id, new.email, v_role, v_team)
  on conflict (id) do update
    set email   = excluded.email,
        role    = excluded.role,
        team_id = excluded.team_id,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ────────────────────────────────────────────────────────────
-- 2. ensure_profile(email, role, team_id)
-- Creates OR repairs the profile row for an existing auth user.
-- Returns a status string instead of raising an error, so it is safe
-- to call for an address that has not been created yet.
-- ────────────────────────────────────────────────────────────

create or replace function public.ensure_profile(
  p_email  text,
  p_role   text default 'rescue_team',
  p_team   text default 'RT-01'
)
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_id  uuid;
  v_email text;
  v_role text;
begin
  if p_role not in ('user', 'admin', 'rescue_team') then
    p_role := 'user';
  end if;

  -- Look up the REAL auth user. No uuid is ever invented.
  select u.id, u.email into v_id, v_email
  from auth.users u
  where lower(u.email) = lower(p_email)
  order by u.created_at
  limit 1;

  if v_id is null then
    return 'MISSING — no auth user with email ' || p_email
           || '. Add the user in the dashboard first, then run this file again.';
  end if;

  -- Make sure auth metadata agrees with the profile (used by admin tooling).
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                        || jsonb_build_object('role', p_role)
  where id = v_id
    and coalesce(raw_app_meta_data ->> 'role', '') <> p_role;

  -- Only rescue_team may hold a team_id.
  insert into public.profiles (id, email, role, team_id)
  values (v_id, v_email, p_role,
          case when p_role = 'rescue_team' then p_team else null end)
  on conflict (id) do update
    set email      = excluded.email,
        role       = excluded.role,
        team_id    = excluded.team_id,
        updated_at = now();

  return 'OK — ' || v_email || ' is now role=' || p_role
         || case when p_role = 'rescue_team'
                 then ' team=' || p_team
                 else '' end;
end;
$$;


-- ────────────────────────────────────────────────────────────
-- 3. Provision the dedicated rescue account
-- Change the email below if you prefer a different address.
-- ────────────────────────────────────────────────────────────

do $$
begin
  raise notice '%', public.ensure_profile('rescue.team@avighnaa.com', 'rescue_team', 'RT-01');
end;
$$;


-- ────────────────────────────────────────────────────────────
-- 4. Verify — read the RESULT tab to confirm.
-- ────────────────────────────────────────────────────────────

select
  p.email,
  p.role,
  p.team_id,
  t.team_name,
  (u.email_confirmed_at is not null) as email_confirmed
from public.profiles p
left join public.rescue_teams t on t.team_id = p.team_id
left join auth.users u on u.id = p.id
where lower(p.email) = 'rescue.team@avighnaa.com';
