import { access, readdir, readFile } from "fs/promises";
import path from "path";

export type HistoryPoint = {
  timestamp: string;
  net_grid_w: number;
  phase_a_voltage_v: number | null;
  sample_count: number;
};

export type HistorySummary = {
  imported_kwh: number;
  exported_kwh: number;
  average_voltage_v: number | null;
  peak_import_w: number;
  peak_export_w: number;
  sample_count: number;
};

export type HistoryResponse = {
  source: "csv" | "supabase";
  generated_at: string;
  window_hours: number;
  points: HistoryPoint[];
  summary: HistorySummary;
};

export type HistorySource = "csv" | "supabase";

type RawHistoryRow = {
  timestamp: string;
  net_grid_w: number;
  phase_a_voltage_v: number | null;
  sample_count: number;
};

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_BUCKET_MINUTES = 60;
const SUPABASE_TABLE_NAME = process.env.SUPABASE_TABLE_NAME?.trim() || "meter_readings";

function roundTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

function roundWholeWatts(value: number) {
  return Math.round(value);
}

function parseNumber(value: string | number | null | undefined) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRelayCsv(content: string): RawHistoryRow[] {
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length <= 1) return [];

  return rows.slice(1).flatMap((line) => {
    const [timestampRaw, gridRaw, voltageRaw] = line.split(",").map((value) => value.trim());
    const netGrid = parseNumber(gridRaw);
    if (!timestampRaw || netGrid === null) return [];

    return [
      {
        timestamp: timestampRaw,
        net_grid_w: netGrid,
        phase_a_voltage_v: parseNumber(voltageRaw),
        sample_count: 1,
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

async function loadRelayCsvRows(): Promise<RawHistoryRow[]> {
  const explicitPath = process.env.CSV_LOG_PATH?.trim();
  if (explicitPath && (await fileExists(explicitPath))) {
    const content = await readFile(explicitPath, "utf8");
    return parseRelayCsv(content);
  }

  const backupDir = process.env.CSV_BACKUP_DIR?.trim() || "./logs/meter-backups";
  const csvPrefix = process.env.CSV_BACKUP_PREFIX?.trim() || "meter";

  if (!(await fileExists(backupDir))) {
    return [];
  }

  const files = await readdir(backupDir);
  const csvFiles = files
    .filter((file) => file.startsWith(`${csvPrefix}_`) && file.endsWith(".csv"))
    .sort()
    .slice(-2);

  const rows: RawHistoryRow[] = [];

  for (const file of csvFiles) {
    const content = await readFile(path.join(backupDir, file), "utf8");
    rows.push(...parseRelayCsv(content));
  }

  return rows;
}

function buildEmptyHistoryResponse(source: HistorySource): HistoryResponse {
  return {
    source,
    generated_at: new Date().toISOString(),
    window_hours: DEFAULT_WINDOW_HOURS,
    points: [],
    summary: {
      imported_kwh: 0,
      exported_kwh: 0,
      average_voltage_v: null,
      peak_import_w: 0,
      peak_export_w: 0,
      sample_count: 0,
    },
  };
}

function buildHistoryResponse(source: HistorySource, rows: RawHistoryRow[]): HistoryResponse {
  const cutoff = Date.now() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000;
  const recentRows = rows
    .map((row) => ({
      ...row,
      date: new Date(row.timestamp),
    }))
    .filter((row) => Number.isFinite(row.date.getTime()) && row.date.getTime() >= cutoff)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (recentRows.length === 0) {
    return buildEmptyHistoryResponse(source);
  }

  const bucketSizeMs = DEFAULT_BUCKET_MINUTES * 60 * 1000;
  const buckets = new Map<
    number,
    {
      timestamp: string;
      netGridSum: number;
      voltageSum: number;
      voltageCount: number;
      sampleCount: number;
    }
  >();

  let importedKwh = 0;
  let exportedKwh = 0;
  let voltageTotal = 0;
  let voltageCount = 0;
  let peakImportW = 0;
  let peakExportW = 0;
  let totalSampleCount = 0;

  for (const row of recentRows) {
    const rowWeight = Math.max(1, Math.round(row.sample_count || 1));
    totalSampleCount += rowWeight;
    const bucketStart = Math.floor(row.date.getTime() / bucketSizeMs) * bucketSizeMs;
    const current = buckets.get(bucketStart) ?? {
      timestamp: new Date(bucketStart).toISOString(),
      netGridSum: 0,
      voltageSum: 0,
      voltageCount: 0,
      sampleCount: 0,
    };

    current.netGridSum += row.net_grid_w * rowWeight;
    current.sampleCount += rowWeight;

    if (row.phase_a_voltage_v !== null) {
      current.voltageSum += row.phase_a_voltage_v * rowWeight;
      current.voltageCount += rowWeight;
    }

    buckets.set(bucketStart, current);

    const positiveW = Math.max(row.net_grid_w, 0);
    const negativeW = Math.max(-row.net_grid_w, 0);

    importedKwh += (positiveW * rowWeight) / 3_600_000;
    exportedKwh += (negativeW * rowWeight) / 3_600_000;
    peakImportW = Math.max(peakImportW, positiveW);
    peakExportW = Math.max(peakExportW, negativeW);

    if (row.phase_a_voltage_v !== null) {
      voltageTotal += row.phase_a_voltage_v * rowWeight;
      voltageCount += rowWeight;
    }
  }

  const points = Array.from(buckets.values())
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map((bucket) => ({
      timestamp: bucket.timestamp,
      net_grid_w: roundWholeWatts(bucket.netGridSum / bucket.sampleCount),
      phase_a_voltage_v:
        bucket.voltageCount > 0 ? roundTwoDecimals(bucket.voltageSum / bucket.voltageCount) : null,
      sample_count: bucket.sampleCount,
    }));

  return {
    source,
    generated_at: new Date().toISOString(),
    window_hours: DEFAULT_WINDOW_HOURS,
    points,
    summary: {
      imported_kwh: roundTwoDecimals(importedKwh),
      exported_kwh: roundTwoDecimals(exportedKwh),
      average_voltage_v: voltageCount > 0 ? roundTwoDecimals(voltageTotal / voltageCount) : null,
      peak_import_w: peakImportW,
      peak_export_w: peakExportW,
      sample_count: totalSampleCount,
    },
  };
}

async function loadHistoryFromCsv(): Promise<HistoryResponse> {
  const rows = await loadRelayCsvRows();
  return buildHistoryResponse("csv", rows);
}

async function loadHistoryFromSupabase(): Promise<HistoryResponse> {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn("Supabase history env vars are missing. Returning an empty history payload.");
    return buildEmptyHistoryResponse("supabase");
  }

  const cutoffIso = new Date(Date.now() - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const queryUrl = new URL(`/rest/v1/${SUPABASE_TABLE_NAME}`, supabaseUrl);
  queryUrl.searchParams.set("select", "timestamp,net_grid_w,phase_a_voltage_v,sample_count");
  queryUrl.searchParams.set("timestamp", `gte.${cutoffIso}`);
  queryUrl.searchParams.set("order", "timestamp.asc");

  try {
    const response = await fetch(queryUrl.toString(), {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Supabase request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as Array<{
      timestamp?: string;
      net_grid_w?: number | string | null;
      phase_a_voltage_v?: number | string | null;
      sample_count?: number | string | null;
    }>;

    const rows = payload.flatMap((row) => {
      const netGrid = parseNumber(row.net_grid_w);
      if (!row.timestamp || netGrid === null) return [];
      const sampleCount = parseNumber(row.sample_count);

      return [
        {
          timestamp: row.timestamp,
          net_grid_w: netGrid,
          phase_a_voltage_v: parseNumber(row.phase_a_voltage_v),
          sample_count: Math.max(1, Math.round(sampleCount ?? 1)),
        },
      ];
    });

    return buildHistoryResponse("supabase", rows);
  } catch (error) {
    console.error("Failed to load Supabase history:", error);
    return buildEmptyHistoryResponse("supabase");
  }
}

export function resolveHistorySource(hostname: string | undefined): HistorySource {
  const override = process.env.HISTORY_SOURCE?.trim().toLowerCase();
  if (override === "csv" || override === "supabase") {
    return override;
  }

  const normalizedHost = hostname?.toLowerCase();
  if (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost?.endsWith(".local")
  ) {
    return "csv";
  }

  return "supabase";
}

export async function loadHistoryResponse(source: HistorySource): Promise<HistoryResponse> {
  return source === "csv" ? loadHistoryFromCsv() : loadHistoryFromSupabase();
}
