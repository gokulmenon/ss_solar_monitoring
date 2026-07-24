export type WeatherSnapshot = {
  timestamp: string;
  temperature_2m: number | null;
  cloud_cover: number | null;
  cloud_cover_low: number | null;
  cloud_cover_mid: number | null;
  cloud_cover_high: number | null;
  shortwave_radiation: number | null;
  direct_radiation: number | null;
  diffuse_radiation: number | null;
  wind_speed_10m: number | null;
  precipitation: number | null;
};

export type DailyWeatherSummary = {
  day: string;
  min_temperature_2m: number | null;
  max_temperature_2m: number | null;
  avg_temperature_2m: number | null;
  avg_cloud_cover: number | null;
  peak_radiation: number | null;
  total_precipitation: number;
  sample_count: number;
};

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const SUPABASE_WEATHER_TABLE_NAME =
  process.env.SUPABASE_WEATHER_TABLE_NAME?.trim() || "weather_snapshots";

const WEATHER_SELECT = [
  "timestamp",
  "temperature_2m",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "shortwave_radiation",
  "direct_radiation",
  "diffuse_radiation",
  "wind_speed_10m",
  "precipitation",
].join(",");

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSnapshot(row: Record<string, unknown>): WeatherSnapshot {
  return {
    timestamp: String(row.timestamp),
    temperature_2m: parseNullableNumber(row.temperature_2m),
    cloud_cover: parseNullableNumber(row.cloud_cover),
    cloud_cover_low: parseNullableNumber(row.cloud_cover_low),
    cloud_cover_mid: parseNullableNumber(row.cloud_cover_mid),
    cloud_cover_high: parseNullableNumber(row.cloud_cover_high),
    shortwave_radiation: parseNullableNumber(row.shortwave_radiation),
    direct_radiation: parseNullableNumber(row.direct_radiation),
    diffuse_radiation: parseNullableNumber(row.diffuse_radiation),
    wind_speed_10m: parseNullableNumber(row.wind_speed_10m),
    precipitation: parseNullableNumber(row.precipitation),
  };
}

async function fetchWeatherRows(searchParams: URLSearchParams): Promise<WeatherSnapshot[]> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return [];
  }

  const url = new URL(`/rest/v1/${SUPABASE_WEATHER_TABLE_NAME}`, SUPABASE_URL);
  for (const [key, value] of searchParams.entries()) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Weather Supabase request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  return payload.map(parseSnapshot);
}

export async function loadLatestWeather(): Promise<WeatherSnapshot | null> {
  const params = new URLSearchParams({
    select: WEATHER_SELECT,
    order: "timestamp.desc",
    limit: "1",
  });
  const rows = await fetchWeatherRows(params);
  return rows[0] ?? null;
}

export async function loadWeatherHistory(hours = 24): Promise<WeatherSnapshot[]> {
  const cutoff = new Date(Date.now() - Math.max(hours, 1) * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    select: WEATHER_SELECT,
    timestamp: `gte.${cutoff}`,
    order: "timestamp.asc",
  });
  return fetchWeatherRows(params);
}

export async function loadWeatherRange(start: string, end: string): Promise<WeatherSnapshot[]> {
  const params = new URLSearchParams({
    select: WEATHER_SELECT,
    timestamp: `gte.${new Date(start).toISOString()}`,
    order: "timestamp.asc",
  });
  params.append("timestamp", `lte.${new Date(end).toISOString()}`);

  return fetchWeatherRows(params);
}

export function summarizeWeatherByDay(points: WeatherSnapshot[]): DailyWeatherSummary[] {
  const buckets = new Map<
    string,
    {
      temperatures: number[];
      clouds: number[];
      radiation: number[];
      precipitation: number;
      sampleCount: number;
    }
  >();

  for (const point of points) {
    const day = new Date(point.timestamp).toLocaleDateString("en-CA");
    const bucket =
      buckets.get(day) ??
      {
        temperatures: [],
        clouds: [],
        radiation: [],
        precipitation: 0,
        sampleCount: 0,
      };

    if (point.temperature_2m !== null) bucket.temperatures.push(point.temperature_2m);
    if (point.cloud_cover !== null) bucket.clouds.push(point.cloud_cover);
    if (point.shortwave_radiation !== null) bucket.radiation.push(point.shortwave_radiation);
    bucket.precipitation += point.precipitation ?? 0;
    bucket.sampleCount += 1;
    buckets.set(day, bucket);
  }

  return Array.from(buckets.entries())
    .map(([day, bucket]) => ({
      day,
      min_temperature_2m: bucket.temperatures.length ? Math.min(...bucket.temperatures) : null,
      max_temperature_2m: bucket.temperatures.length ? Math.max(...bucket.temperatures) : null,
      avg_temperature_2m: bucket.temperatures.length
        ? bucket.temperatures.reduce((sum, value) => sum + value, 0) / bucket.temperatures.length
        : null,
      avg_cloud_cover: bucket.clouds.length
        ? bucket.clouds.reduce((sum, value) => sum + value, 0) / bucket.clouds.length
        : null,
      peak_radiation: bucket.radiation.length ? Math.max(...bucket.radiation) : null,
      total_precipitation: bucket.precipitation,
      sample_count: bucket.sampleCount,
    }))
    .sort((a, b) => b.day.localeCompare(a.day));
}
