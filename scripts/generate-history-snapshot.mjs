import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const WINDOW_HOURS = 24;
const BUCKET_MINUTES = 60;
const CSV_BACKUP_DIR = process.env.CSV_BACKUP_DIR?.trim() || "./logs/meter-backups";
const CSV_BACKUP_PREFIX = process.env.CSV_BACKUP_PREFIX?.trim() || "meter";
const CSV_LOG_PATH = process.env.CSV_LOG_PATH?.trim();
const OUTPUT_PATH = path.join(process.cwd(), "public", "history-snapshot.json");

function parseNumber(value) {
  if (value === undefined || value === null) return null;

  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRelayCsv(content) {
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length <= 1) return [];

  return rows.slice(1).flatMap((line) => {
    const [timestampRaw, gridRaw, voltageRaw, solarRaw] = line.split(",").map((value) => value.trim());
    const netGrid = parseNumber(gridRaw);

    if (!timestampRaw || netGrid === null) return [];

    return [
      {
        timestamp: timestampRaw,
        net_grid_w: netGrid,
        solar_production_w: parseNumber(solarRaw),
        phase_a_voltage_v: parseNumber(voltageRaw),
        sample_count: 1,
      },
    ];
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadRelayCsvRows() {
  if (CSV_LOG_PATH && (await fileExists(CSV_LOG_PATH))) {
    const content = await readFile(CSV_LOG_PATH, "utf8");
    return parseRelayCsv(content);
  }

  if (!(await fileExists(CSV_BACKUP_DIR))) {
    return [];
  }

  const files = await readdir(CSV_BACKUP_DIR);
  const csvFiles = files
    .filter((file) => file.startsWith(`${CSV_BACKUP_PREFIX}_`) && file.endsWith(".csv"))
    .sort()
    .slice(-2);

  const rows = [];

  for (const file of csvFiles) {
    const content = await readFile(path.join(CSV_BACKUP_DIR, file), "utf8");
    rows.push(...parseRelayCsv(content));
  }

  return rows;
}

function buildEmptySnapshot() {
  return {
    source: "csv",
    generated_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    points: [],
    summary: {
      imported_kwh: 0,
      exported_kwh: 0,
      solar_kwh: 0,
      average_voltage_v: null,
      peak_import_w: 0,
      peak_export_w: 0,
      peak_solar_w: 0,
      sample_count: 0,
    },
  };
}

function roundTwoDecimals(value) {
  return Math.round(value * 100) / 100;
}

function roundWholeWatts(value) {
  return Math.round(value);
}

function buildSnapshot(rows) {
  const cutoff = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
  const recentRows = rows
    .map((row) => ({ ...row, date: new Date(row.timestamp) }))
    .filter((row) => Number.isFinite(row.date.getTime()) && row.date.getTime() >= cutoff)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (recentRows.length === 0) {
    return buildEmptySnapshot();
  }

  const bucketSizeMs = BUCKET_MINUTES * 60 * 1000;
  const buckets = new Map();

  let importedKwh = 0;
  let exportedKwh = 0;
  let solarKwh = 0;
  let voltageTotal = 0;
  let voltageCount = 0;
  let peakImportW = 0;
  let peakExportW = 0;
  let peakSolarW = 0;
  let totalSampleCount = 0;

  for (const row of recentRows) {
    const rowWeight = Math.max(1, Math.round(row.sample_count || 1));
    totalSampleCount += rowWeight;
    const bucketStart = Math.floor(row.date.getTime() / bucketSizeMs) * bucketSizeMs;
    const current = buckets.get(bucketStart) ?? {
      timestamp: new Date(bucketStart).toISOString(),
      netGridSum: 0,
      solarSum: 0,
      solarCount: 0,
      voltageSum: 0,
      voltageCount: 0,
      sampleCount: 0,
    };

    current.netGridSum += row.net_grid_w * rowWeight;
    current.sampleCount += rowWeight;

    if (row.solar_production_w !== null) {
      current.solarSum += row.solar_production_w * rowWeight;
      current.solarCount += rowWeight;
    }

    if (row.phase_a_voltage_v !== null) {
      current.voltageSum += row.phase_a_voltage_v * rowWeight;
      current.voltageCount += rowWeight;
    }

    buckets.set(bucketStart, current);

    const positiveW = Math.max(row.net_grid_w, 0);
    const negativeW = Math.max(-row.net_grid_w, 0);
    const solarW = Math.max(row.solar_production_w ?? 0, 0);

    importedKwh += (positiveW * rowWeight) / 3_600_000;
    exportedKwh += (negativeW * rowWeight) / 3_600_000;
    solarKwh += (solarW * rowWeight) / 3_600_000;
    peakImportW = Math.max(peakImportW, positiveW);
    peakExportW = Math.max(peakExportW, negativeW);
    peakSolarW = Math.max(peakSolarW, solarW);

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
      solar_production_w:
        bucket.solarCount > 0 ? roundWholeWatts(bucket.solarSum / bucket.solarCount) : null,
      phase_a_voltage_v:
        bucket.voltageCount > 0 ? roundTwoDecimals(bucket.voltageSum / bucket.voltageCount) : null,
      sample_count: bucket.sampleCount,
    }));

  return {
    source: "csv",
    generated_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    points,
    summary: {
      imported_kwh: roundTwoDecimals(importedKwh),
      exported_kwh: roundTwoDecimals(exportedKwh),
      solar_kwh: roundTwoDecimals(solarKwh),
      average_voltage_v: voltageCount > 0 ? roundTwoDecimals(voltageTotal / voltageCount) : null,
      peak_import_w: peakImportW,
      peak_export_w: peakExportW,
      peak_solar_w: peakSolarW,
      sample_count: totalSampleCount,
    },
  };
}

async function main() {
  const rows = await loadRelayCsvRows();
  const snapshot = buildSnapshot(rows);

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  console.log(`Generated history snapshot with ${snapshot.points.length} points -> ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Failed to generate history snapshot:", error);
  process.exitCode = 1;
});
