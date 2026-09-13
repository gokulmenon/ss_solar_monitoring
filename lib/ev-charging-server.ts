import {
  createMockEVSessions,
  createMockEVSnapshot,
  deriveEVDailyFromSessions,
  type EVDailyPoint,
  type EVSession,
  type EVVitalsSnapshot,
} from "@/lib/ev-charging";

function isMockMode() {
  return process.env.EV_MOCK_DATA === "1";
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const SESSIONS_TABLE = process.env.EV_SUPABASE_SESSIONS_TABLE?.trim() || "ev_charging_sessions";
const SNAPSHOTS_TABLE =
  process.env.EV_SUPABASE_SNAPSHOTS_TABLE?.trim() || "ev_vitals_snapshots";

function parseNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  return null;
}

function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY ?? "",
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function parseSession(row: Record<string, unknown>): EVSession {
  const alerts = row.alerts;
  return {
    session_id: String(row.session_id),
    started_at: String(row.started_at),
    ended_at: String(row.ended_at),
    energy_wh: parseNumber(row.energy_wh),
    duration_s: Math.trunc(parseNumber(row.duration_s)),
    max_current_a: parseNullableNumber(row.max_current_a),
    avg_grid_v: parseNullableNumber(row.avg_grid_v),
    max_handle_temp_c: parseNullableNumber(row.max_handle_temp_c),
    alerts: Array.isArray(alerts) ? alerts : [],
  };
}

function parseSnapshot(row: Record<string, unknown>): EVVitalsSnapshot {
  return {
    timestamp: String(row.timestamp),
    contactor_closed: parseNullableBool(row.contactor_closed),
    vehicle_connected: parseNullableBool(row.vehicle_connected),
    session_energy_wh: parseNullableNumber(row.session_energy_wh),
    vehicle_current_a: parseNullableNumber(row.vehicle_current_a),
    grid_v: parseNullableNumber(row.grid_v),
    handle_temp_c: parseNullableNumber(row.handle_temp_c),
    pcba_temp_c: parseNullableNumber(row.pcba_temp_c),
    lifetime_energy_wh: parseNullableNumber(row.lifetime_energy_wh),
  };
}

export async function loadEVSessions(limit = 50): Promise<EVSession[]> {
  if (isMockMode()) return createMockEVSessions().slice(0, Math.max(limit, 1));
  if (!isConfigured()) return [];

  const url = new URL(`/rest/v1/${SESSIONS_TABLE}`, SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("order", "started_at.desc");
  url.searchParams.set("limit", String(Math.max(limit, 1)));

  const response = await fetch(url.toString(), { headers: supabaseHeaders(), cache: "no-store" });
  if (!response.ok) {
    throw new Error(`EV sessions request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  return payload.map(parseSession);
}

export async function loadEVLatestSnapshot(): Promise<EVVitalsSnapshot | null> {
  if (isMockMode()) return createMockEVSnapshot();
  if (!isConfigured()) return null;

  const url = new URL(`/rest/v1/${SNAPSHOTS_TABLE}`, SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("order", "timestamp.desc");
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), { headers: supabaseHeaders(), cache: "no-store" });
  if (!response.ok) {
    throw new Error(`EV snapshot request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  if (payload.length === 0) return null;
  return parseSnapshot(payload[0]);
}

export async function loadEVDailySummary(dayLimit = 30): Promise<EVDailyPoint[]> {
  if (isMockMode()) {
    return deriveEVDailyFromSessions(createMockEVSessions()).slice(0, Math.max(dayLimit, 1));
  }
  if (!isConfigured()) return [];

  const url = new URL("/rest/v1/rpc/get_ev_daily_summary", SUPABASE_URL);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: supabaseHeaders(),
    body: JSON.stringify({
      timezone_name: "America/New_York",
      day_limit: dayLimit,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`EV daily summary RPC failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  return payload.map((row) => ({
    day: String(row.day),
    session_count: Math.trunc(parseNumber(row.session_count)),
    ev_kwh: parseNumber(row.ev_kwh),
    charging_seconds: Math.trunc(parseNumber(row.charging_seconds)),
  }));
}

export async function loadEVSessionTotals(): Promise<{
  session_count: number;
  tracked_kwh: number;
  charging_seconds: number;
}> {
  if (isMockMode()) {
    const sessions = createMockEVSessions();
    let trackedWh = 0;
    let chargingSeconds = 0;
    for (const session of sessions) {
      trackedWh += session.energy_wh;
      chargingSeconds += session.duration_s;
    }
    return {
      session_count: sessions.length,
      tracked_kwh: Math.round(trackedWh) / 1000,
      charging_seconds: chargingSeconds,
    };
  }
  if (!isConfigured()) {
    return { session_count: 0, tracked_kwh: 0, charging_seconds: 0 };
  }

  const url = new URL(`/rest/v1/${SESSIONS_TABLE}`, SUPABASE_URL);
  url.searchParams.set("select", "energy_wh,duration_s");

  const response = await fetch(url.toString(), { headers: supabaseHeaders(), cache: "no-store" });
  if (!response.ok) {
    throw new Error(`EV totals request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as Array<Record<string, unknown>>;
  let trackedWh = 0;
  let chargingSeconds = 0;
  for (const row of payload) {
    trackedWh += parseNumber(row.energy_wh);
    chargingSeconds += Math.trunc(parseNumber(row.duration_s));
  }

  return {
    session_count: payload.length,
    tracked_kwh: Math.round(trackedWh) / 1000,
    charging_seconds: chargingSeconds,
  };
}
