-- ============================================================
-- AVIGHNAA RESCUE LAYER — Migration 004 (repair)
--
-- WHY YOU NEED THIS
--   The live database has public.incident_events.incident_id typed as
--   uuid, but the app logs events with text IDs like 'AV-1024'.
--   Every timeline insert therefore failed with:
--       invalid input syntax for type uuid: "AV-1024"
--   which silently emptied every incident timeline and broke the
--   rescue portal's mission timeline.
--
--   migration 001 already declares this column as text. This file
--   repairs a database that drifted away from it.
--
-- SAFE TO RUN TWICE. It checks the real column type first and does
-- nothing if the schema is already correct.
--
-- Run in: Supabase Dashboard > SQL Editor > paste this file > Run
-- ============================================================

do $$
declare
  v_type   text;
  v_fk     text;
begin
  -- What is it actually right now?
  select c.data_type into v_type
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name   = 'incident_events'
    and c.column_name  = 'incident_id';

  if v_type is null then
    raise exception
      'public.incident_events does not exist. Run migration 001 first, then this file.';
  end if;

  if v_type <> 'uuid' then
    raise notice 'OK - incident_events.incident_id is already %, nothing to change.', v_type;
    return;
  end if;

  -- Drop whatever foreign key currently sits on this column (its name
  -- may differ from the default, so look it up instead of assuming).
  for v_fk in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.incident_events'::regclass
      and con.contype  = 'f'
  loop
    execute format('alter table public.incident_events drop constraint %I', v_fk);
    raise notice 'Dropped stale foreign key %.', v_fk;
  end loop;

  -- uuid -> text, then re-point the FK at the human-readable incident_id.
  alter table public.incident_events
    alter column incident_id type text using incident_id::text;

  alter table public.incident_events
    add constraint incident_events_incident_id_fkey
    foreign key (incident_id)
    references public.incidents (incident_id)
    on delete cascade;

  create index if not exists idx_incident_events_incident
    on public.incident_events (incident_id, timestamp);

  raise notice 'REPAIRED - incident_events.incident_id changed from uuid to text.';
end;
$$;


-- ────────────────────────────────────────────────────────────
-- Verify: read the RESULT tab. incident_id must show format=text
-- and the last row must say 'OK'.
-- ────────────────────────────────────────────────────────────

select
  table_name,
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'incident_events'
  and column_name  = 'incident_id';
