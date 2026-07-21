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
  select
    (mr.timestamp at time zone timezone_name)::date as day,
    round(
      sum(
        case
          when mr.net_grid_w > 0 then mr.net_grid_w * 0.25 / 1000.0
          else 0
        end
      ),
      3
    ) as daily_grid_import_kwh,
    round(
      sum(
        case
          when mr.net_grid_w < 0 then abs(mr.net_grid_w) * 0.25 / 1000.0
          else 0
        end
      ),
      3
    ) as daily_grid_export_kwh,
    round(
      sum(coalesce(mr.solar_production_w, 0) * 0.25 / 1000.0),
      3
    ) as daily_solar_kwh,
    round(
      sum((coalesce(mr.solar_production_w, 0) + mr.net_grid_w) * 0.25 / 1000.0),
      3
    ) as daily_home_consumption_kwh,
    count(*) as sample_count
  from public.meter_readings mr
  where mr.timestamp >= now() - make_interval(days => greatest(day_limit, 1))
  group by (mr.timestamp at time zone timezone_name)::date
  order by day desc;
$$;
