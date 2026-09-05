import { access, readdir, readFile } from "fs/promises";
import path from "path";

import { resolveCsvHistoryMode } from "@/lib/history";

export type PortHistoryPoint = {
  timestamp: string;
  inverter_serial: string;
  port_number: number;
  dc_power_w: number;
  dc_voltage_v: number;
  energy_daily_wh: number;
};

export type PortHistorySummary = {
  active_port_count: number;
  tracked_port_count: number;
  total_dc_power_w: number;
  peak_port_power_w: number;
  total_daily_energy_wh: number;
};

export type PortHistoryResponse = {
  source: "csv";
  generated_at: string;
  window_hours: number;
  points: PortHistoryPoint[];
  latest: PortHistoryPoint[];
  summary: PortHistorySummary;
};

const WINDOW_HOURS = 30 * 24;
const BUCKET_MINUTES = 60;
const PORT_CSV_BACKUP_DIR = process.env.PORT_CSV_BACKUP_DIR?.trim() || "./logs/inverter-port-backups";
const PORT_CSV_BACKUP_PREFIX = process.env.PORT_CSV_BACKUP_PREFIX?.trim() || "inverter_ports";
const PORT_SNAPSHOT_PATH = path.join(process.cwd(), "public", "port-history-snapshot.json");

function parseNumber(value: string | undefined) {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function roundTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

function emptySummary(): PortHistorySummary {
  return {
    active_port_count: 0,
    tracked_port_count: 0,
    total_dc_power_w: 0,
    peak_port_power_w: 0,
    total_daily_energy_wh: 0,
  };
}

function emptyResponse(): PortHistoryResponse {
  return {
    source: "csv",
    generated_at: new Date().toISOString(),
    window_hours: WINDOW_HOURS,
    points: [],
    latest: [],
    summary: emptySummary(),
  };
}

function parsePortCsv(content: string): PortHistoryPoint[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) return [];

  return lines.slice(1).flatMap((line) => {
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

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function buildHistory(rows: PortHistoryPoint[]): PortHistoryResponse {
  const cutoff = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;
  const recentRows = rows
    .map((row) => ({ ...row, date: new Date(row.timestamp) }))
    .filter((row) => Number.isFinite(row.date.getTime()) && row.date.getTime() >= cutoff)
    .sort((left, right) => left.date.getTime() - right.date.getTime());

  if (recentRows.length === 0) return emptyResponse();

  const bucketSizeMs = BUCKET_MINUTES * 60 * 1000;
  const hourlyRows = new Map<string, PortHistoryPoint>();
  const latestByPort = new Map<string, PortHistoryPoint>();

  for (const row of recentRows) {
    const portKey = `${row.inverter_serial}:${row.port_number}`;
    const bucketStart = Math.floor(row.date.getTime() / bucketSizeMs) * bucketSizeMs;
    const point: PortHistoryPoint = {
      timestamp: new Date(bucketStart).toISOString(),
      inverter_serial: row.inverter_serial,
      port_number: row.port_number,
      dc_power_w: roundTwoDecimals(row.dc_power_w),
      dc_voltage_v: roundTwoDecimals(row.dc_voltage_v),
      energy_daily_wh: roundTwoDecimals(row.energy_daily_wh),
    };

    hourlyRows.set(`${bucketStart}:${portKey}`, point);
    latestByPort.set(portKey, {
      ...point,
      timestamp: row.timestamp,
    });
  }

  const latest = Array.from(latestByPort.values()).sort(
    (left, right) =>
      left.inverter_serial.localeCompare(right.inverter_serial) || left.port_number - right.port_number,
  );
  const summary = latest.reduce<PortHistorySummary>(
    (current, point) => ({
      active_port_count: current.active_port_count + (point.dc_power_w > 0 ? 1 : 0),
      tracked_port_count: current.tracked_port_count + 1,
      total_dc_power_w: current.total_dc_power_w + point.dc_power_w,
      peak_port_power_w: Math.max(current.peak_port_power_w, point.dc_power_w),
      total_daily_energy_wh: current.total_daily_energy_wh + point.energy_daily_wh,
    }),
    emptySummary(),
  );

  return {
    source: "csv",
    generated_at: new Date().toISOString(),
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

async function loadLocalHistory(): Promise<PortHistoryResponse> {
  if (!(await fileExists(PORT_CSV_BACKUP_DIR))) return emptyResponse();

  const files = await readdir(PORT_CSV_BACKUP_DIR);
  const csvFiles = files
    .filter((file) => file.startsWith(`${PORT_CSV_BACKUP_PREFIX}_`) && file.endsWith(".csv"))
    .sort()
    .slice(-35);
  const rows: PortHistoryPoint[] = [];

  for (const file of csvFiles) {
    rows.push(...parsePortCsv(await readFile(path.join(PORT_CSV_BACKUP_DIR, file), "utf8")));
  }

  return buildHistory(rows);
}

async function loadSnapshotHistory(): Promise<PortHistoryResponse> {
  if (!(await fileExists(PORT_SNAPSHOT_PATH))) return emptyResponse();

  try {
    const payload = JSON.parse(await readFile(PORT_SNAPSHOT_PATH, "utf8")) as Partial<PortHistoryResponse>;
    if (!Array.isArray(payload.points) || !Array.isArray(payload.latest) || !payload.summary) {
      return emptyResponse();
    }
    return payload as PortHistoryResponse;
  } catch {
    return emptyResponse();
  }
}

export async function loadPortHistory(hostname?: string): Promise<PortHistoryResponse> {
  return resolveCsvHistoryMode(hostname) === "live" ? loadLocalHistory() : loadSnapshotHistory();
}
