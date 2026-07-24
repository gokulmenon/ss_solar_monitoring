create or replace function public.get_daily_energy_summary(
  timezone_name text default 'America/New_York',
  day_limit integer default 30
)
returns table (
  day date,
  daily_grid_import_kwh numeric,
  daily_grid_export_kwh numeric,
  daily_solar_kwh numeric,
  daily_home_consumption_kwh numeric,
  sample_count bigint
)
language sql
stable
set search_path = ''
as $$
  with lagged_readings as (
    select
      (mr.timestamp at time zone timezone_name)::date as day,
      mr.net_grid_w as actual_home_load_w,
      coalesce(mr.solar_production_w, 0) as solar_production_w,
      coalesce(mr.sample_count, 1) as raw_sample_count,
      extract(epoch from (mr.timestamp - lag(mr.timestamp) over (order by mr.timestamp))) as true_seconds
    from public.meter_readings mr
    where mr.timestamp >= now() - make_interval(days => greatest(day_limit, 1) + 1)
  ),
  normalized_readings as (
    select
      day,
      actual_home_load_w,
      solar_production_w,
      raw_sample_count,
      least(coalesce(true_seconds, 900), 1800) as sample_seconds
    from lagged_readings
  )
  select
    nr.day,
    round(
      sum(greatest(nr.actual_home_load_w - nr.solar_production_w, 0) * nr.sample_seconds / 3600000.0),
      3
    ) as daily_grid_import_kwh,
    round(
      sum(greatest(nr.solar_production_w - nr.actual_home_load_w, 0) * nr.sample_seconds / 3600000.0),
      3
    ) as daily_grid_export_kwh,
    round(
      sum(nr.solar_production_w * nr.sample_seconds / 3600000.0),
      3
    ) as daily_solar_kwh,
    round(
      sum(nr.actual_home_load_w * nr.sample_seconds / 3600000.0),
      3
    ) as daily_home_consumption_kwh,
    sum(nr.raw_sample_count)::bigint as sample_count
  from normalized_readings nr
  where nr.day >= (now() at time zone timezone_name)::date - greatest(day_limit, 1)
  group by nr.day
  order by nr.day desc;
$$;
