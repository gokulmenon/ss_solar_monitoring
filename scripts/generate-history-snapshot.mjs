import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const WINDOW_HOURS = 30 * 24;
const BUCKET_MINUTES = 60;
const CSV_BACKUP_DIR = process.env.CSV_BACKUP_DIR?.trim() || "./logs/meter-backups";
const CSV_BACKUP_PREFIX = process.env.CSV_BACKUP_PREFIX?.trim() || "meter";
const CSV_LOG_PATH = process.env.CSV_LOG_PATH?.trim();
const PORT_CSV_BACKUP_DIR = process.env.PORT_CSV_BACKUP_DIR?.trim() || "./logs/inverter-port-backups";
const PORT_CSV_BACKUP_PREFIX = process.env.PORT_CSV_BACKUP_PREFIX?.trim() || "inverter_ports";
const WEATHER_CSV_BACKUP_DIR = process.env.WEATHER_CSV_BACKUP_DIR?.trim() || "./logs/weather-backups";
const WEATHER_CSV_BACKUP_PREFIX = process.env.WEATHER_CSV_BACKUP_PREFIX?.trim() || "weather";
const OUTPUT_PATH = path.join(process.cwd(), "public", "history-snapshot.json");
const PORT_OUTPUT_PATH = path.join(process.cwd(), "public", "port-history-snapshot.json");
const WEATHER_OUTPUT_PATH = path.join(process.cwd(), "public", "weather-history-snapshot.json");

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
    .slice(-35);

  const rows = [];

  for (const file of csvFiles) {
    const content = await readFile(path.join(CSV_BACKUP_DIR, file), "utf8");
    rows.push(...parseRelayCsv(content));
  }

  return rows;
}

async function loadDailyCsvRows(directory, prefix, parser) {
  if (!(await fileExists(directory))) {
    return [];
  }

  const files = await readdir(directory);
  const csvFiles = files
    .filter((file) => file.startsWith(`${prefix}_`) && file.endsWith(".csv"))
    .sort()
    .slice(-35);
  const rows = [];

  for (const file of csvFiles) {
    const content = await readFile(path.join(directory, file), "utf8");
    rows.push(...parser(content));
  }

  return rows;
}

function parsePortCsv(content) {
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length <= 1) return [];

  return rows.slice(1).flatMap((line) => {
    const [timestamp, inverterSerial, portNumberRaw, dcPowerRaw, dcVoltageRaw, dailyEnergyRaw] = line
      .split(",")
      .map((value) => value.trim());
    const portNumber = parseNumber(portNumberRaw);
    const dcPower = parseNumber(dcPowerRaw);
    const dcVoltage = parseNumber(dcVoltageRaw);
    const dailyEnergy = parseNumber(dailyEnergyRaw);

    if (
      !timestamp ||
      !inverterSerial ||
      portNumber === null ||
      dcPower === null ||
      dcVoltage === null ||
      dailyEnergy === null
    ) {
      return [];
    }

    return [
      {
        timestamp,
        inverter_serial: inverterSerial,
        port_number: Math.round(portNumber),
        dc_power_w: dcPower,
        dc_voltage_v: dcVoltage,
        energy_daily_wh: dailyEnergy,
      },
    ];
  });
}

function parseWeatherCsv(content) {
  const rows = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (rows.length <= 1) return [];

  return rows.slice(1).flatMap((line) => {
    const values = line.split(",").map((value) => value.trim());
    const timestamp = values[0];
    if (!timestamp) return [];

    return [
      {
        timestamp,
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

function recentTimestampedRows(rows) {
  const cutoff = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
  return rows
    .map((row) => ({ ...row, date: new Date(row.timestamp) }))
    .filter((row) => Number.isFinite(row.date.getTime()) && row.date.getTime() >= cutoff)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function buildPortSnapshot(rows) {
  const recentRows = recentTimestampedRows(rows);
  const generatedAt = new Date().toISOString();
  const emptySummary = {
    active_port_count: 0,
    tracked_port_count: 0,
    total_dc_power_w: 0,
    peak_port_power_w: 0,
    total_daily_energy_wh: 0,
  };

  if (recentRows.length === 0) {
    return { source: "csv", generated_at: generatedAt, window_hours: WINDOW_HOURS, points: [], latest: [], summary: emptySummary };
  }

  const bucketSizeMs = BUCKET_MINUTES * 60 * 1000;
  const hourlyRows = new Map();
  const latestByPort = new Map();

  for (const row of recentRows) {
    const portKey = `${row.inverter_serial}:${row.port_number}`;
    const bucketStart = Math.floor(row.date.getTime() / bucketSizeMs) * bucketSizeMs;
    const bucketKey = `${bucketStart}:${portKey}`;
    const point = {
      timestamp: new Date(bucketStart).toISOString(),
      inverter_serial: row.inverter_serial,
      port_number: row.port_number,
      dc_power_w: roundTwoDecimals(row.dc_power_w),
      dc_voltage_v: roundTwoDecimals(row.dc_voltage_v),
      energy_daily_wh: roundTwoDecimals(row.energy_daily_wh),
    };

    // Rows are chronological: replacing keeps the latest reading within each hour.
    hourlyRows.set(bucketKey, point);
    latestByPort.set(portKey, {
      timestamp: row.timestamp,
      inverter_serial: row.inverter_serial,
      port_number: row.port_number,
      dc_power_w: roundTwoDecimals(row.dc_power_w),
      dc_voltage_v: roundTwoDecimals(row.dc_voltage_v),
      energy_daily_wh: roundTwoDecimals(row.energy_daily_wh),
    });
  }

  const latest = Array.from(latestByPort.values()).sort(
    (left, right) =>
      left.inverter_serial.localeCompare(right.inverter_serial) || left.port_number - right.port_number,
  );
  const summary = latest.reduce(
    (current, point) => ({
      active_port_count: current.active_port_count + (point.dc_power_w > 0 ? 1 : 0),
      tracked_port_count: current.tracked_port_count + 1,
      total_dc_power_w: current.total_dc_power_w + point.dc_power_w,
      peak_port_power_w: Math.max(current.peak_port_power_w, point.dc_power_w),
      total_daily_energy_wh: current.total_daily_energy_wh + point.energy_daily_wh,
    }),
    emptySummary,
  );

  return {
    source: "csv",
    generated_at: generatedAt,
    window_hours: WINDOW_HOURS,
    points: Array.from(hourlyRows.values()).sort(
      (left, right) =>
        new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime() ||
        left.inverter_serial.localeCompare(right.inverter_serial) ||
        left.port_number - right.port_number,
    ),
    latest,
    summary: {
      ...summary,
      total_dc_power_w: roundTwoDecimals(summary.total_dc_power_w),
      peak_port_power_w: roundTwoDecimals(summary.peak_port_power_w),
      total_daily_energy_wh: roundTwoDecimals(summary.total_daily_energy_wh),
    },
  };
}

function buildWeatherSnapshot(rows) {
  const recentRows = recentTimestampedRows(rows);
  return {
    source: "csv",
    generated_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    points: recentRows.map(({ date: _date, ...row }) => row),
  };
}

async function main() {
  const [rows, portRows, weatherRows] = await Promise.all([
    loadRelayCsvRows(),
    loadDailyCsvRows(PORT_CSV_BACKUP_DIR, PORT_CSV_BACKUP_PREFIX, parsePortCsv),
    loadDailyCsvRows(WEATHER_CSV_BACKUP_DIR, WEATHER_CSV_BACKUP_PREFIX, parseWeatherCsv),
  ]);
  const snapshot = buildSnapshot(rows);
  const portSnapshot = buildPortSnapshot(portRows);
  const weatherSnapshot = buildWeatherSnapshot(weatherRows);

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await Promise.all([
    writeFile(OUTPUT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"),
    writeFile(PORT_OUTPUT_PATH, `${JSON.stringify(portSnapshot, null, 2)}\n`, "utf8"),
    writeFile(WEATHER_OUTPUT_PATH, `${JSON.stringify(weatherSnapshot, null, 2)}\n`, "utf8"),
  ]);

  console.log(`Generated meter history snapshot with ${snapshot.points.length} points -> ${OUTPUT_PATH}`);
  console.log(`Generated port history snapshot with ${portSnapshot.points.length} points -> ${PORT_OUTPUT_PATH}`);
  console.log(`Generated weather history snapshot with ${weatherSnapshot.points.length} points -> ${WEATHER_OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error("Failed to generate history snapshot:", error);
  process.exitCode = 1;
});
