export type DailyEnergySummaryPoint = {
  day: string;
  daily_grid_import_kwh: number;
  daily_grid_export_kwh: number;
  daily_solar_kwh: number;
  daily_home_consumption_kwh: number;
  sample_count: number;
};

export type EnergyTotals = {
  this_month_solar_kwh: number;
  this_month_home_consumption_kwh: number;
  lifetime_solar_kwh: number;
  lifetime_home_consumption_kwh: number;
  tracked_day_count: number;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

function parseNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const EMPTY_ENERGY_TOTALS: EnergyTotals = {
  this_month_solar_kwh: 0,
  this_month_home_consumption_kwh: 0,
  lifetime_solar_kwh: 0,
  lifetime_home_consumption_kwh: 0,
  tracked_day_count: 0,
};

export async function loadEnergyTotals(): Promise<EnergyTotals> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return EMPTY_ENERGY_TOTALS;
  }

  const url = new URL("/rest/v1/rpc/get_home_energy_totals", SUPABASE_URL);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ timezone_name: "America/New_York" }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Energy totals RPC failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  const row = payload[0];
  if (!row) return EMPTY_ENERGY_TOTALS;

  return {
    this_month_solar_kwh: parseNumber(row.this_month_solar_kwh),
    this_month_home_consumption_kwh: parseNumber(row.this_month_home_consumption_kwh),
    lifetime_solar_kwh: parseNumber(row.lifetime_solar_kwh),
    lifetime_home_consumption_kwh: parseNumber(row.lifetime_home_consumption_kwh),
    tracked_day_count: parseNumber(row.tracked_day_count),
  };
}

export async function loadDailyEnergySummary(dayLimit = 30): Promise<DailyEnergySummaryPoint[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return [];
  }

  const url = new URL("/rest/v1/rpc/get_daily_energy_summary", SUPABASE_URL);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      timezone_name: "America/New_York",
      day_limit: dayLimit,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Daily energy RPC failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;

  return payload.map((row) => ({
    day: String(row.day),
    daily_grid_import_kwh: parseNumber(row.daily_grid_import_kwh),
    daily_grid_export_kwh: parseNumber(row.daily_grid_export_kwh),
    daily_solar_kwh: parseNumber(row.daily_solar_kwh),
    daily_home_consumption_kwh: parseNumber(row.daily_home_consumption_kwh),
    sample_count: parseNumber(row.sample_count),
  }));
}
