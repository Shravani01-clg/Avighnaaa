-- ============================================================
-- AVIGHNAA RESCUE SYSTEM — Migration 006
--   1) Final role architecture: ONLY 'user' and 'rescue_team'
--   2) Rescue equipment management tables
--
-- SAFE TO RUN TWICE. No placeholders, no fake uuids.
-- Run in: Supabase Dashboard > SQL Editor > paste this file > Run
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1. TWO-ROLE ARCHITECTURE
-- Any account still carrying the removed 'admin' role becomes a
-- rescue_team account, which under the final architecture owns
-- rescue control. Nothing is deleted — only re-labelled.
-- ────────────────────────────────────────────────────────────

update public.profiles
   set role = 'rescue_team',
       team_id = coalesce(team_id, 'RT-01'),
       updated_at = now()
 where role = 'admin';


-- Replace the role CHECK constraint with the two allowed values.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'rescue_team'));

comment on column public.profiles.role is
  'Avighnaa has exactly two roles: user | rescue_team. There is no admin role.';


-- ────────────────────────────────────────────────────────────
-- 2. RESCUE EQUIPMENT
-- Inventory the rescue team checks before responding. Belongs to
-- the RESCUE_TEAM role only.
-- ────────────────────────────────────────────────────────────

create table if not exists public.rescue_equipment (
  id                     uuid primary key default gen_random_uuid(),
  equipment_id           text not null unique,       -- FE-01, FA-01, GM-02 ...
  equipment_name         text not null,
  equipment_type         text not null,              -- PROTECTION | MEDICAL | RESCUE | COMMS | LIGHTING | WATER
  quantity               integer not null default 1 check (quantity >= 0),
  status                 text not null default 'AVAILABLE'
                         check (status in ('AVAILABLE','IN_USE','MAINTENANCE','DAMAGED','UNAVAILABLE')),
  condition              text not null default 'GOOD'
                         check (condition in ('NEW','GOOD','FAIR','POOR')),
  assigned_team_id       text,
  location               text,
  last_inspection_date   date,
  next_inspection_date   date,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_rescue_equipment_status
  on public.rescue_equipment (status);


-- ────────────────────────────────────────────────────────────
-- 3. PRE-DEPARTURE EQUIPMENT CHECKLIST
-- One row per incident mission; the team must complete every
-- required item before it may mark EN_ROUTE.
-- ────────────────────────────────────────────────────────────

create table if not exists public.equipment_checklists (
  id              uuid primary key default gen_random_uuid(),
  incident_id     text not null references public.incidents (incident_id) on delete cascade,
  team_id         text,
  required_items  jsonb not null default '[]'::jsonb,  -- hazard-based recommendations
  checked_items   jsonb not null default '[]'::jsonb,
  status          text not null default 'PENDING'
                  check (status in ('PENDING','IN_PROGRESS','COMPLETE')),
  completed_by    text,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (incident_id)
);


-- ────────────────────────────────────────────────────────────
-- 4. EQUIPMENT ↔ INCIDENT USAGE
-- Recorded only when the workflow actually checks equipment out,
-- never automatically.
-- ────────────────────────────────────────────────────────────

create table if not exists public.equipment_usage (
  id                   uuid primary key default gen_random_uuid(),
  incident_id          text references public.incidents (incident_id) on delete set null,
  equipment_id         text not null,
  team_id              text,
  quantity_used        integer not null default 1 check (quantity_used >= 0),
  checked_out_at       timestamptz not null default now(),
  returned_at          timestamptz,
  condition_after_use  text check (condition_after_use in ('NEW','GOOD','FAIR','POOR')),
  notes                text,
  created_at           timestamptz not null default now()
);

create index if not exists idx_equipment_usage_incident
  on public.equipment_usage (incident_id, checked_out_at desc);


-- ────────────────────────────────────────────────────────────
-- 5. EQUIPMENT HISTORY (readiness / inspection / maintenance)
-- ────────────────────────────────────────────────────────────

create table if not exists public.equipment_events (
  id           uuid primary key default gen_random_uuid(),
  equipment_id text not null,
  event_type   text not null,   -- INSPECTED | MAINTENANCE | ASSIGNED | CHECKED_OUT | RETURNED | STATUS_CHANGED
  notes        text,
  performed_by text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_equipment_events_equipment
  on public.equipment_events (equipment_id, created_at desc);


-- ────────────────────────────────────────────────────────────
-- 6. SEED INVENTORY (prototype starter kit)
-- Real rows, not placeholders — a realistic mine rescue kit.
-- ────────────────────────────────────────────────────────────

insert into public.rescue_equipment
  (equipment_id, equipment_name, equipment_type, quantity, status, condition, location, last_inspection_date, next_inspection_date)
values
  ('FE-01',  'Fire Extinguisher',        'PROTECTION', 4, 'AVAILABLE', 'GOOD', 'Station Bay 1', current_date - 30, current_date + 60),
  ('GM-01',  'Gas Mask',                 'PROTECTION', 3, 'AVAILABLE', 'GOOD', 'Station Bay 1', current_date - 25, current_date + 35),
  ('GM-02',  'Gas Mask (spare)',         'PROTECTION', 1, 'MAINTENANCE','FAIR', 'Workshop',       current_date - 90, current_date + 5),
  ('FA-01',  'First Aid Kit',            'MEDICAL',    3, 'AVAILABLE', 'GOOD', 'Clinic',         current_date - 20, current_date + 70),
  ('FA-02',  'Stretcher',                'MEDICAL',    1, 'AVAILABLE', 'GOOD', 'Clinic',         current_date - 45, current_date + 45),
  ('RR-01',  'Rescue Rope (30m)',        'RESCUE',     2, 'AVAILABLE', 'GOOD', 'Equipment Bay',  current_date - 15, current_date + 75),
  ('ER-01',  'Emergency Radio',          'COMMS',      4, 'AVAILABLE', 'GOOD', 'Control Room',   current_date - 10, current_date + 80),
  ('FL-01',  'Flashlight (high lumen)',  'LIGHTING',   6, 'AVAILABLE', 'GOOD', 'Equipment Bay',  current_date - 60, current_date + 30),
  ('HS-01',  'Safety Helmet',            'PROTECTION', 6, 'AVAILABLE', 'GOOD', 'Equipment Bay',  current_date - 50, current_date + 40),
  ('LS-01',  'Life Jacket',              'WATER',      3, 'IN_USE',     'GOOD', 'Pump House',     current_date - 35, current_date + 55),
  ('WT-01',  'Water Rescue Paddle',      'WATER',      2, 'AVAILABLE', 'GOOD', 'Pump House',     current_date - 28, current_date + 62),
  ('MS-01',  'Multi-gas Monitor',        'COMMS',      1, 'DAMAGED',    'POOR', 'Workshop',       current_date - 120, current_date - 10)
on conflict (equipment_id) do nothing;


-- ────────────────────────────────────────────────────────────
-- Verify
-- ────────────────────────────────────────────────────────────

select role, count(*) from public.profiles group by role order by role;

select status, count(*) as items
from public.rescue_equipment
group by status
order by status;