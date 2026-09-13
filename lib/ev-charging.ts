import type { LiveSeriesPoint } from "@/components/telemetry/use-live-telemetry";

export type EVDerivedStatus = "charging" | "connected" | "idle" | "offline" | "unknown";

export type EVSession = {
  session_id: string;
  started_at: string;
  ended_at: string;
  energy_wh: number;
  duration_s: number;
  max_current_a: number | null;
  avg_grid_v: number | null;
  max_handle_temp_c: number | null;
  alerts: unknown[];
};

export type EVDailyPoint = {
  day: string;
  session_count: number;
  ev_kwh: number;
  charging_seconds: number;
};

export type EVVitalsSnapshot = {
  timestamp: string;
  contactor_closed: boolean | null;
  vehicle_connected: boolean | null;
  session_energy_wh: number | null;
  vehicle_current_a: number | null;
  grid_v: number | null;
  handle_temp_c: number | null;
  pcba_temp_c: number | null;
  lifetime_energy_wh: number | null;
};

/** Live charger block broadcast by the relay over WebSocket (`ev` key). */
export type EVTelemetryBlock = {
  charger_status: "online" | "offline";
  contactor_closed: boolean;
  vehicle_connected: boolean;
  session_energy_wh: number | null;
  vehicle_current_a: number | null;
  grid_v: number | null;
  pcba_temp_c: number | null;
  handle_temp_c: number | null;
  lifetime_energy_wh: number | null;
  lifetime_charge_starts: number | null;
  lifetime_charging_time_s: number | null;
  last_poll_at: string | null;
  recent_closed_session_ids: string[];
};

export type EVLiveState = {
  status: EVDerivedStatus;
  snapshot: EVVitalsSnapshot | null;
};

const STALE_MS = 15 * 60 * 1000;

export function deriveEVStatus(input: {
  charger_status?: string | null;
  contactor_closed?: boolean | null;
  vehicle_connected?: boolean | null;
  last_poll_at?: string | null;
  now?: number;
}): EVDerivedStatus {
  const { charger_status, contactor_closed, vehicle_connected, last_poll_at } = input;
  const now = input.now ?? Date.now();

  if (charger_status === "offline") return "offline";
  if (last_poll_at) {
    const age = now - new Date(last_poll_at).getTime();
    if (Number.isFinite(age) && age > STALE_MS) return "offline";
  } else if (!contactor_closed && !vehicle_connected && charger_status !== "online") {
    return "unknown";
  }
  if (contactor_closed) return "charging";
  if (vehicle_connected) return "connected";
  return "idle";
}

export function evLivePowerW(snapshot: {
  vehicle_current_a: number | null;
  grid_v: number | null;
}): number | null {
  if (typeof snapshot.vehicle_current_a !== "number" || typeof snapshot.grid_v !== "number") {
    return null;
  }
  return snapshot.vehicle_current_a * snapshot.grid_v;
}

/** Map daily EV points onto the shared area-chart series shape. */
export function evDailyToSeries(points: EVDailyPoint[]): LiveSeriesPoint[] {
  return points
    .slice()
    .reverse()
    .map((point) => ({
      timestamp: `${point.day}T12:00:00`,
      solar_production_w: 0,
      net_grid_w: 0,
      home_consumption_w: 0,
      ev_kwh: point.ev_kwh,
    }));
}

/** Group completed sessions by start day (UTC), newest first (RPC shape). */
export function deriveEVDailyFromSessions(sessions: EVSession[]): EVDailyPoint[] {
  const byDay = new Map<string, { count: number; wh: number; seconds: number }>();
  for (const session of sessions) {
    const day = session.started_at.slice(0, 10);
    const bucket = byDay.get(day) ?? { count: 0, wh: 0, seconds: 0 };
    bucket.count += 1;
    bucket.wh += session.energy_wh;
    bucket.seconds += session.duration_s;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([day, bucket]) => ({
      day,
      session_count: bucket.count,
      ev_kwh: Math.round(bucket.wh) / 1000,
      charging_seconds: bucket.seconds,
    }));
}

// ---------------------------------------------------------------------------
// Deterministic mock fixtures (EV_MOCK_DATA=1 dev only, never production)
// ---------------------------------------------------------------------------

/** Live-charging mock block: car plugged in and charging right now. */
export function createMockEVTelemetry(now = new Date()): EVTelemetryBlock {
  return {
    charger_status: "online",
    contactor_closed: true,
    vehicle_connected: true,
    session_energy_wh: 6300,
    vehicle_current_a: 32,
    grid_v: 242.1,
    pcba_temp_c: 31.4,
    handle_temp_c: 27.8,
    lifetime_energy_wh: 1285400,
    lifetime_charge_starts: 158,
    lifetime_charging_time_s: 622400,
    last_poll_at: now.toISOString(),
    recent_closed_session_ids: [],
  };
}

export function createMockEVSnapshot(now = new Date()): EVVitalsSnapshot {
  return {
    timestamp: now.toISOString(),
    contactor_closed: true,
    vehicle_connected: true,
    session_energy_wh: 6300,
    vehicle_current_a: 32,
    grid_v: 242.1,
    handle_temp_c: 27.8,
    pcba_temp_c: 31.4,
    lifetime_energy_wh: 1285400,
  };
}

/**
 * Eight midday sessions across the last eleven days (stable shape). The
 * constant local start hour keeps every session on its own UTC day in any
 * timezone; the live-charging mock block covers the "charging now" state.
 */
export function createMockEVSessions(now = new Date()): EVSession[] {
  const specs: Array<[daysAgo: number, startHour: number, energyKwh: number, hours: number]> = [
    [1, 12.0, 11.8, 3.1],
    [2, 12.0, 9.4, 2.5],
    [3, 12.0, 6.2, 1.6],
    [5, 12.0, 13.2, 3.4],
    [6, 12.0, 7.6, 2.0],
    [8, 12.0, 12.4, 3.2],
    [9, 12.0, 10.1, 2.7],
    [11, 12.0, 11.5, 3.0],
  ];
  return specs.map(([daysAgo, startHour, energyKwh, hours], index) => {
    const started = new Date(now);
    started.setDate(started.getDate() - daysAgo);
    started.setHours(0, 0, 0, 0);
    started.setHours(startHour);
    const durationS = Math.round(hours * 3600);
    return {
      session_id: `00000000-0000-4000-8000-mockev000${index}`,
      started_at: started.toISOString(),
      ended_at: new Date(started.getTime() + durationS * 1000).toISOString(),
      energy_wh: energyKwh * 1000,
      duration_s: durationS,
      max_current_a: 32,
      avg_grid_v: 242.1,
      max_handle_temp_c: 27.5 + index * 0.3,
      alerts: [],
    };
  });
}
