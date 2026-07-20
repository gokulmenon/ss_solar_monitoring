alter table public.meter_readings
  add column if not exists solar_production_w integer;
