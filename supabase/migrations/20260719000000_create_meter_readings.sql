create table if not exists public.meter_readings (
  timestamp timestamptz primary key,
  sample_count integer not null default 1,
  net_grid_w integer not null,
  phase_a_voltage_v numeric(8, 2),
  created_at timestamptz not null default now()
);

create index if not exists meter_readings_timestamp_idx
  on public.meter_readings (timestamp desc);
