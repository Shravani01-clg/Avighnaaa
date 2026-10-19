-- ============================================================
-- AVIGHNAA RESCUE LAYER — Migration 001
-- Run this in the Supabase SQL Editor (same project, no new DB).
-- Adds: profiles (roles), rescue_teams, device_locations,
--       incidents, incident_events
-- Existing tables (sensor_readings, risk_predictions, alerts,
-- devices, workers) are NOT modified.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. PROFILES (role-based authentication)
-- ────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'user'
             check (role in ('user', 'admin', 'rescue_team')),
  team_id    text,            -- FK added after rescue_teams exists
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profile row for every new auth user (default role: user)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'user')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ────────────────────────────────────────────────────────────
-- 2. RESCUE TEAMS
-- ────────────────────────────────────────────────────────────

create table if not exists public.rescue_teams (
  id               uuid primary key default gen_random_uuid(),
  team_id          text not null unique,           -- RT-01, RT-02 ...
  team_name        text not null,
  team_type        text not null
                   check (team_type in ('FIRE_RESCUE', 'MEDICAL', 'WATER_RESCUE', 'SECURITY')),
  status           text not null default 'AVAILABLE'
                   check (status in ('AVAILABLE', 'BUSY', 'OFFLINE')),
  current_location text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- profiles.team_id → rescue_teams
alter table public.profiles
  drop constraint if exists profiles_team_id_fkey;
alter table public.profiles
  add constraint profiles_team_id_fkey
  foreign key (team_id) references public.rescue_teams (team_id)
  on delete set null;

-- ────────────────────────────────────────────────────────────
-- 3. DEVICE LOCATIONS (configured installation location — NOT GPS)
-- ────────────────────────────────────────────────────────────

create table if not exists public.device_locations (
  device_id  text primary key,
  building   text,
  floor      text,
  room       text,
  zone       text,
  latitude   double precision,   -- optional, only if actually configured
  longitude  double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────
-- 4. INCIDENTS (operational emergency cases created from alerts)
-- ────────────────────────────────────────────────────────────

create table if not exists public.incidents (
  id                    uuid primary key default gen_random_uuid(),
  incident_id           text not null unique,      -- AV-1024 ...
  alert_id              text,
  device_id             text not null,
  hazard_type           text not null,
  severity              text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  risk_score            numeric,
  person_detected       boolean not null default false,
  location              text,
  ai_summary            text,
  recommended_team_type text,
  assigned_team_id      text references public.rescue_teams (team_id) on delete set null,
  status                text not null default 'AWAITING_RESPONSE'
                        check (status in (
                          'AWAITING_RESPONSE', 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE',
                          'ON_SCENE', 'RESCUE_IN_PROGRESS', 'PERSON_SAFE',
                          'RESOLVED', 'ESCALATED', 'CANCELLED'
                        )),
  detected_at           timestamptz not null default now(),  -- first detection
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Deduplication lookup: active incidents per device/hazard
create index if not exists idx_incidents_device_hazard
  on public.incidents (device_id, hazard_type, status);

create index if not exists idx_incidents_status
  on public.incidents (status, created_at desc);

create index if not exists idx_incidents_created
  on public.incidents (created_at desc);

create index if not exists idx_incidents_team
  on public.incidents (assigned_team_id);

-- ────────────────────────────────────────────────────────────
-- 5. INCIDENT EVENTS (timeline)
-- ────────────────────────────────────────────────────────────

create table if not exists public.incident_events (
  id           uuid primary key default gen_random_uuid(),
  incident_id  text not null references public.incidents (incident_id) on delete cascade,
  event_type   text not null,   -- DETECTED, CREATED, ASSIGNED, ACCEPTED, EN_ROUTE,
                                -- ARRIVED, RESCUE_STARTED, PERSON_SAFE, RESOLVED,
                                -- ESCALATED, CANCELLED, DETECTION_UPDATED, ASSIGNED (reassign)
  performed_by text,            -- email or 'system'
  timestamp    timestamptz not null default now(),
  notes        text
);

create index if not exists idx_incident_events_incident
  on public.incident_events (incident_id, timestamp);

-- ────────────────────────────────────────────────────────────
-- 6. ROW LEVEL SECURITY
--    Backend uses the service-role key (bypasses RLS).
--    Users can read their own profile only.
-- ────────────────────────────────────────────────────────────

alter table public.profiles        enable row level security;
alter table public.rescue_teams    enable row level security;
alter table public.device_locations enable row level security;
alter table public.incidents       enable row level security;
alter table public.incident_events enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- Portal reads go through the backend (service key), so no client
-- policies are granted for incidents / teams / events on purpose.

-- ────────────────────────────────────────────────────────────
-- 7. ROLE ASSIGNMENT (run AFTER creating auth users)
-- ────────────────────────────────────────────────────────────
-- UPDATE public.profiles SET role = 'admin'
--   WHERE email = 'admin@example.com';
--
-- UPDATE public.profiles SET role = 'rescue_team', team_id = 'RT-01'
--   WHERE email = 'rescue@example.com';
