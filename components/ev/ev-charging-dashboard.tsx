"use client";

import { useCallback, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SeriesAreaCard } from "@/components/charts/series-area-card";
import { useVisiblePoll } from "@/components/hooks/use-visible-poll";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";
import {
  deriveEVStatus,
  evDailyToSeries,
  evLivePowerW,
  type EVDailyPoint,
  type EVDerivedStatus,
  type EVLiveState,
  type EVSession,
} from "@/lib/ev-charging";

type EVStats = {
  lifetime_energy_kwh: number | null;
  tracked_session_count: number;
  tracked_kwh: number;
  tracked_charging_seconds: number;
  daily: EVDailyPoint[];
};

const EMPTY_STATS: EVStats = {
  lifetime_energy_kwh: null,
  tracked_session_count: 0,
  tracked_kwh: 0,
  tracked_charging_seconds: 0,
  daily: [],
};

const LED_DOT: Record<EVDerivedStatus, string> = {
  charging: "animate-pulse bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]",
  connected: "bg-sky-500 shadow-[0_0_12px_rgba(14,165,233,0.8)]",
  idle: "border-2 border-slate-600 bg-transparent",
  offline: "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.8)]",
  unknown: "bg-slate-600",
};

function formatKwh(value: number | null | undefined, digits = 1) {
  if (typeof value !== "number") return "-- kWh";
  return `${value.toFixed(digits)} kWh`;
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatTimestamp(timestamp: string | null | undefined) {
  if (!timestamp) return "Awaiting update";
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EVChargingDashboard() {
  const { telemetry } = useLiveTelemetry();
  const [live, setLive] = useState<EVLiveState | null>(null);
  const [sessions, setSessions] = useState<EVSession[]>([]);
  const [stats, setStats] = useState<EVStats>(EMPTY_STATS);

  const loadLive = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch("/api/ev/live", { signal, cache: "no-store" });
      if (!response.ok) return;
      setLive((await response.json()) as EVLiveState);
    } catch (error) {
      if ((error as Error).name !== "AbortError") console.error(error);
    }
  }, []);

  const loadHistory = useCallback(async (signal: AbortSignal) => {
    try {
      const [sessionsResponse, statsResponse] = await Promise.all([
        fetch("/api/ev/sessions?limit=50", { signal, cache: "no-store" }),
        fetch("/api/ev/stats?days=30", { signal, cache: "no-store" }),
      ]);
      if (sessionsResponse.ok) {
        const payload = (await sessionsResponse.json()) as { sessions: EVSession[] };
        setSessions(payload.sessions);
      }
      if (statsResponse.ok) {
        setStats((await statsResponse.json()) as EVStats);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") console.error(error);
    }
  }, []);

  // Live snapshot refreshes every minute; session history and aggregates
  // every 5 minutes. All polling pauses while the tab is hidden.
  useVisiblePoll(loadLive, 60 * 1000);
  useVisiblePoll(loadHistory, 5 * 60 * 1000);

  // Prefer the real-time WebSocket block; fall back to the API snapshot.
  const wsBlock = telemetry.ev;
  const wsStatus = wsBlock
    ? deriveEVStatus({
        charger_status: wsBlock.charger_status,
        contactor_closed: wsBlock.contactor_closed,
        vehicle_connected: wsBlock.vehicle_connected,
        last_poll_at: wsBlock.last_poll_at,
      })
    : null;

  const status: EVDerivedStatus = wsStatus ?? live?.status ?? "unknown";
  const snapshot = live?.snapshot ?? null;

  const liveCurrentA = wsBlock?.vehicle_current_a ?? snapshot?.vehicle_current_a ?? null;
  const liveGridV = wsBlock?.grid_v ?? snapshot?.grid_v ?? null;
  const liveSessionWh = wsBlock?.session_energy_wh ?? snapshot?.session_energy_wh ?? null;
  const liveHandleTempC = wsBlock?.handle_temp_c ?? snapshot?.handle_temp_c ?? null;
  const livePowerW = evLivePowerW({ vehicle_current_a: liveCurrentA, grid_v: liveGridV });
  const lastUpdate = wsBlock?.last_poll_at ?? snapshot?.timestamp ?? null;

  const statusLabel =
    status === "charging" && livePowerW !== null
      ? `Charging at ${(livePowerW / 1000).toFixed(2)} kW`
      : status === "charging"
        ? "Charging"
        : status === "connected"
          ? "Plugged In - Idle"
          : status === "idle"
            ? "Unplugged"
            : status === "offline"
              ? "Offline"
              : "Waiting for relay";

  const vitalsPills: Array<{ label: string; value: string }> = [
    {
      label: "Handle",
      value: liveHandleTempC !== null ? `${liveHandleTempC.toFixed(1)} °C` : "--",
    },
    { label: "Grid", value: liveGridV !== null ? `${liveGridV.toFixed(1)} V` : "--" },
    { label: "Current", value: liveCurrentA !== null ? `${liveCurrentA.toFixed(1)} A` : "--" },
  ];

  return (
    <div className="space-y-4">
      <Card className="border-white/10 bg-slate-950/80">
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4">
          <span
            aria-hidden
            className={`h-4 w-4 shrink-0 rounded-full ${LED_DOT[status]}`}
          />
          <div className="min-w-0 flex-1 basis-40">
            <div className="truncate text-lg font-semibold text-slate-50">{statusLabel}</div>
            <p className="truncate text-xs text-slate-400">
              {status === "charging"
                ? `${formatKwh((liveSessionWh ?? 0) / 1000)} this session`
                : `Last update ${formatTimestamp(lastUpdate)}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {vitalsPills.map((pill) => (
              <span
                key={pill.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-300"
              >
                <span className="uppercase tracking-[0.14em] text-slate-500">{pill.label}</span>
                <span className="font-medium text-slate-100">{pill.value}</span>
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-1">
            <CardTitle className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
              Lifetime dispensed
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold text-slate-50">
            {formatKwh(stats.lifetime_energy_kwh, 0)}
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-1">
            <CardTitle className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
              Tracked sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold text-slate-50">
            {stats.tracked_session_count.toLocaleString()}
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-1">
            <CardTitle className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
              Tracked energy
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold text-slate-50">
            {formatKwh(stats.tracked_kwh)}
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-1">
            <CardTitle className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
              Charging time
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xl font-semibold text-slate-50">
            {formatDuration(stats.tracked_charging_seconds)}
          </CardContent>
        </Card>
      </div>

      <SeriesAreaCard
        title="Daily EV charging"
        subtitle="kWh per day from recorded sessions"
        data={evDailyToSeries(stats.daily)}
        dataKey="ev_kwh"
        stroke="#34d399"
        fill="#34d399"
        formatter={(value) => `${value.toFixed(1)} kWh`}
        defaultRange="7d"
      />

      <Card className="border-white/10 bg-slate-950/80">
        <CardHeader className="pb-2">
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            Charging history
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {sessions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center text-sm text-slate-400">
              No charging sessions recorded yet. Sessions appear here after the
              next completed charge.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                  <tr className="border-b border-white/10">
                    <th className="py-3 pr-4 font-medium">Start</th>
                    <th className="px-4 py-3 font-medium">Energy</th>
                    <th className="px-4 py-3 font-medium">Duration</th>
                    <th className="px-4 py-3 font-medium">Peak current</th>
                    <th className="py-3 pl-4 text-right font-medium">Avg voltage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06] text-slate-300">
                  {sessions.map((session) => (
                    <tr key={session.session_id}>
                      <td className="py-3 pr-4 font-medium text-slate-100">
                        {formatTimestamp(session.started_at)}
                      </td>
                      <td className="px-4 py-3 text-emerald-300">
                        {formatKwh(session.energy_wh / 1000)}
                      </td>
                      <td className="px-4 py-3">{formatDuration(session.duration_s)}</td>
                      <td className="px-4 py-3">
                        {typeof session.max_current_a === "number"
                          ? `${session.max_current_a.toFixed(1)} A`
                          : "--"}
                      </td>
                      <td className="py-3 pl-4 text-right text-slate-400">
                        {typeof session.avg_grid_v === "number"
                          ? `${session.avg_grid_v.toFixed(1)} V`
                          : "--"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
