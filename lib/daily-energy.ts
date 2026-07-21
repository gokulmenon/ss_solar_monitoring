export type DailyEnergySummaryPoint = {
  day: string;
  daily_grid_import_kwh: number;
  daily_grid_export_kwh: number;
  daily_solar_kwh: number;
  daily_home_consumption_kwh: number;
  sample_count: number;
};

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

function parseNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
