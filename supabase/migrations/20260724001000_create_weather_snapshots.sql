create table if not exists public.weather_snapshots (
  timestamp timestamptz primary key,
  temperature_2m numeric(6, 2),
  cloud_cover numeric(5, 2),
  cloud_cover_low numeric(5, 2),
  cloud_cover_mid numeric(5, 2),
  cloud_cover_high numeric(5, 2),
  shortwave_radiation numeric(8, 2),
  direct_radiation numeric(8, 2),
  diffuse_radiation numeric(8, 2),
  wind_speed_10m numeric(6, 2),
  precipitation numeric(8, 3),
  created_at timestamptz not null default now()
);

create index if not exists weather_snapshots_timestamp_idx
  on public.weather_snapshots (timestamp desc);
