create or replace function public.get_home_energy_totals(
  timezone_name text default 'America/New_York'
)
returns table (
  this_month_solar_kwh numeric,
  this_month_home_consumption_kwh numeric,
  lifetime_solar_kwh numeric,
  lifetime_home_consumption_kwh numeric,
  tracked_day_count bigint
)
language sql
stable
set search_path = ''
as $$
  with boundaries as (
    select date_trunc('month', now() at time zone timezone_name)::date as month_start
  )
  select
    coalesce(sum(des.solar_kwh) filter (where des.day >= boundaries.month_start), 0)
      as this_month_solar_kwh,
    coalesce(sum(des.home_kwh) filter (where des.day >= boundaries.month_start), 0)
      as this_month_home_consumption_kwh,
    coalesce(sum(des.solar_kwh), 0) as lifetime_solar_kwh,
    coalesce(sum(des.home_kwh), 0) as lifetime_home_consumption_kwh,
    count(des.day) as tracked_day_count
  from public.daily_energy_summary des
  cross join boundaries;
$$;
