-- ============================================================
-- AVIGHNAA RESCUE LAYER — Migration 005
-- Adds the "rescue requested" state so the main dashboard can tell
-- ALERT DETECTED apart from RESCUE REQUESTED without guessing.
--
-- The incident itself is still created automatically by the risk engine
-- (ALERT -> INCIDENT). The dashboard's [REQUEST RESCUE TEAM] button
-- flips these two columns on the EXISTING incident instead of creating
-- a duplicate one.
--
-- SAFE TO RUN TWICE. No placeholders, no fake uuids.
-- Run in: Supabase Dashboard > SQL Editor > paste this file > Run
-- ============================================================

alter table public.incidents
  add column if not exists rescue_requested boolean not null default false;

alter table public.incidents
  add column if not exists rescue_requested_at timestamptz;

comment on column public.incidents.rescue_requested is
  'true once a control-room user or admin pressed REQUEST RESCUE TEAM';

comment on column public.incidents.rescue_requested_at is
  'timestamp of the rescue request (drives the response-time metric)';

-- Active incidents drive the main dashboard emergency panel.
create index if not exists idx_incidents_active
  on public.incidents (status, created_at desc);


-- ────────────────────────────────────────────────────────────
-- Verify: the RESULT tab must show the two new columns.
-- ────────────────────────────────────────────────────────────

select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'incidents'
  and column_name in ('rescue_requested', 'rescue_requested_at')
order by column_name;
