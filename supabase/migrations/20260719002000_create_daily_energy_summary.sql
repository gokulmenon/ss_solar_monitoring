create table if not exists public.daily_energy_summary (
  day date primary key,
  imported_kwh numeric(12, 3) not null default 0,
  exported_kwh numeric(12, 3) not null default 0,
  solar_kwh numeric(12, 3) not null default 0,
  home_kwh numeric(12, 3) not null default 0,
  sample_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists daily_energy_summary_day_idx
  on public.daily_energy_summary (day desc);
