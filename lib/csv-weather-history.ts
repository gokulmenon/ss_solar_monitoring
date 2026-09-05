import { access, readdir, readFile } from "fs/promises";
import path from "path";

import { resolveCsvHistoryMode } from "@/lib/history";
import type { WeatherSnapshot } from "@/lib/weather";

export type CsvWeatherHistoryResponse = {
  source: "csv";
  generated_at: string;
  window_hours: number;
  points: WeatherSnapshot[];
};

const WINDOW_HOURS = 30 * 24;
const WEATHER_CSV_BACKUP_DIR = process.env.WEATHER_CSV_BACKUP_DIR?.trim() || "./logs/weather-backups";
const WEATHER_CSV_BACKUP_PREFIX = process.env.WEATHER_CSV_BACKUP_PREFIX?.trim() || "weather";
const WEATHER_SNAPSHOT_PATH = path.join(process.cwd(), "public", "weather-history-snapshot.json");

function parseNumber(value: string | undefined) {
  if (value === undefined || value === "") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyResponse(): CsvWeatherHistoryResponse {
  return {
    source: "csv",
    generated_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    points: [],
  };
}

function parseWeatherCsv(content: string): WeatherSnapshot[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) return [];

  return lines.slice(1).flatMap((line) => {
    const values = line.split(",").map((value) => value.trim());
    if (!values[0]) return [];
    return [
      {
        timestamp: values[0],
        temperature_2m: parseNumber(values[1]),
        cloud_cover: parseNumber(values[2]),
        cloud_cover_low: parseNumber(values[3]),
        cloud_cover_mid: parseNumber(values[4]),
        cloud_cover_high: parseNumber(values[5]),
        shortwave_radiation: parseNumber(values[6]),
        direct_radiation: parseNumber(values[7]),
        diffuse_radiation: parseNumber(values[8]),
        wind_speed_10m: parseNumber(values[9]),
        precipitation: parseNumber(values[10]),
      },
    ];
  });
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function filterRecentRows(rows: WeatherSnapshot[]) {
  const cutoff = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
  return rows
    .filter((row) => {
      const timestamp = new Date(row.timestamp).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    })
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

async function loadLocalHistory(): Promise<CsvWeatherHistoryResponse> {
  if (!(await fileExists(WEATHER_CSV_BACKUP_DIR))) return emptyResponse();
  const files = await readdir(WEATHER_CSV_BACKUP_DIR);
  const csvFiles = files
    .filter((file) => file.startsWith(`${WEATHER_CSV_BACKUP_PREFIX}_`) && file.endsWith(".csv"))
    .sort()
    .slice(-35);
  const rows: WeatherSnapshot[] = [];

  for (const file of csvFiles) {
    rows.push(...parseWeatherCsv(await readFile(path.join(WEATHER_CSV_BACKUP_DIR, file), "utf8")));
  }

  return {
    source: "csv",
    generated_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    points: filterRecentRows(rows),
  };
}

async function loadSnapshotHistory(): Promise<CsvWeatherHistoryResponse> {
  if (!(await fileExists(WEATHER_SNAPSHOT_PATH))) return emptyResponse();
  try {
    const payload = JSON.parse(await readFile(WEATHER_SNAPSHOT_PATH, "utf8")) as Partial<CsvWeatherHistoryResponse>;
    if (!Array.isArray(payload.points)) return emptyResponse();
    return payload as CsvWeatherHistoryResponse;
  } catch {
    return emptyResponse();
  }
}

export async function loadCsvWeatherHistory(hostname?: string): Promise<CsvWeatherHistoryResponse> {
  return resolveCsvHistoryMode(hostname) === "live" ? loadLocalHistory() : loadSnapshotHistory();
}
