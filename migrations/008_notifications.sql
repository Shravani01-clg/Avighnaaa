-- ============================================================
-- AVIGHNAA RESCUE LAYER — Migration 008
-- Adds the cross-login notification feed.
--
-- A notification is written when a rescue action happens on ONE
-- login and the OTHER login must see it:
--   * rescue login assigns / reassigns a team  -> audience 'user'
--     (the control-room/admin dashboard shows it immediately)
--   * control room raises a rescue request     -> audience 'rescue_team'
--     (the rescue portal shows it in the bell feed)
--
-- Row Level Security is enabled with NO policies on purpose, exactly
-- like incidents / incident_events in migration 001: the table is
-- backend-only (service-role key). No anon/authenticated client can
-- read it directly — the /api/notifications endpoint is the only door.
--
-- SAFE TO RUN TWICE. No placeholders, no fake uuids.
-- Run in: Supabase Dashboard > SQL Editor > paste this file > Run
-- ============================================================

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  incident_id text,
  audience    text not null,
  type        text not null,
  title       text not null,
  message     text not null,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

comment on column public.notifications.audience is
  'which login receives it: user (control room/admin) or rescue_team';
comment on column public.notifications.incident_id is
  'human-readable incident id (AV-1024) the notification belongs to';
comment on column public.notifications.read is
  'per-audience read flag — the control room shares one console';

alter table public.notifications enable row level security;

-- Newest-first feed per login, with the unread badge counted off the
-- same query.
create index if not exists idx_notifications_audience
  on public.notifications (audience, read, created_at desc);


-- ────────────────────────────────────────────────────────────
-- Verify: the RESULT tab must list the new table + index.
-- ────────────────────────────────────────────────────────────

select
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'notifications'
order by ordinal_position;
