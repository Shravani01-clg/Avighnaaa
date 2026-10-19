-- ============================================================
-- AVIGHNAA RESCUE LAYER — Migration 002 (seed data)
-- Run AFTER 001_rescue_layer.sql
-- Demo rescue teams + a sample configured device location.
-- ============================================================

insert into public.rescue_teams (team_id, team_name, team_type, status, current_location)
values
  ('RT-01', 'Fire & Rescue',    'FIRE_RESCUE',  'AVAILABLE', 'Building A / Station Bay 1'),
  ('RT-02', 'Medical',          'MEDICAL',      'AVAILABLE', 'Building A / Clinic'),
  ('RT-03', 'Water Rescue',     'WATER_RESCUE', 'AVAILABLE', 'Building B / Pump House'),
  ('RT-04', 'Security / Emergency', 'SECURITY', 'AVAILABLE', 'Main Gate / Control Room')
on conflict (team_id) do nothing;

-- Replace ESP32_01 with your actual device_id (matches sensor readings)
insert into public.device_locations (device_id, building, floor, room, zone)
values ('ESP32_01', 'Building A', '2', '204', 'Zone A')
on conflict (device_id) do nothing;

insert into public.device_locations (device_id, building, floor, room, zone)
values ('RF-001', 'Building A', '2', '204', 'Zone A')
on conflict (device_id) do nothing;
