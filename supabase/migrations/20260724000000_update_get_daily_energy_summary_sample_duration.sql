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
as $$
  with normalized_readings as (
    select
      (mr.timestamp at time zone timezone_name)::date as day,
      mr.net_grid_w,
      coalesce(mr.solar_production_w, 0) as solar_production_w,
      greatest(coalesce(mr.sample_count, 1), 1) * 60.0 as sample_seconds
    from public.meter_readings mr
    where mr.timestamp >= now() - make_interval(days => greatest(day_limit, 1))
  )
  select
    nr.day,
    round(
      sum(
        case
          when nr.net_grid_w > 0 then nr.net_grid_w * nr.sample_seconds / 3600000.0
          else 0
        end
      ),
      3
    ) as daily_grid_import_kwh,
    round(
      sum(
        case
          when nr.net_grid_w < 0 then abs(nr.net_grid_w) * nr.sample_seconds / 3600000.0
          else 0
        end
      ),
      3
    ) as daily_grid_export_kwh,
    round(
      sum(nr.solar_production_w * nr.sample_seconds / 3600000.0),
      3
    ) as daily_solar_kwh,
    round(
      sum(greatest(nr.solar_production_w + nr.net_grid_w, 0) * nr.sample_seconds / 3600000.0),
      3
    ) as daily_home_consumption_kwh,
    sum(nr.sample_seconds / 60.0)::bigint as sample_count
  from normalized_readings nr
  group by nr.day
  order by nr.day desc;
$$;
