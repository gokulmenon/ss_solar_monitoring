"use client";

import { useEffect, useMemo, useState } from "react";
import { WifiHigh } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";
import { HoymilesFlowVisualizer } from "@/components/live/hoymiles-flow-visualizer";
import type { DailyEnergySummaryPoint, EnergyTotals } from "@/lib/daily-energy";

const UPTIME_STATUS_URL = "https://stats.uptimerobot.com/nS4Sm3g9El";
type UptimeMonitor = {
  id: string;
  name: string;
  url: string | null;
  status: number | null;
  status_label: string;
  tone: "up" | "down" | "warning" | "paused" | "pending" | "unknown";
  average_response_time_ms: number | null;
  uptime_24h: number | null;
  uptime_7d: number | null;
  uptime_30d: number | null;
};

type UptimePayload =
  | {
      status: "ok";
      generated_at: string;
      monitors: UptimeMonitor[];
    }
  | {
      status: "error";
      message: string;
      detail?: unknown;
    };

const EMPTY_ENERGY_TOTALS: EnergyTotals = {
  this_month_solar_kwh: 0,
  this_month_home_consumption_kwh: 0,
  lifetime_solar_kwh: 0,
  lifetime_home_consumption_kwh: 0,
  tracked_day_count: 0,
};

function formatUptimePercent(value: number | null) {
  if (typeof value !== "number") return "--";
  return `${value.toFixed(2)}%`;
}

function uptimeBadgeVariant(tone: UptimeMonitor["tone"]): "success" | "danger" | "warning" | "secondary" {
  switch (tone) {
    case "up":
      return "success";
    case "down":
      return "danger";
    case "warning":
      return "warning";
    default:
      return "secondary";
  }
}

function uptimeDotClass(tone: UptimeMonitor["tone"]) {
  switch (tone) {
    case "up":
      return "bg-emerald-400";
    case "down":
      return "bg-rose-400";
    case "warning":
      return "bg-amber-400";
    case "paused":
    case "pending":
      return "bg-slate-400";
    default:
      return "bg-slate-500";
  }
}

export function HomeDashboard() {
  const { telemetry, bridgeState } = useLiveTelemetry();
  const [dailyEnergy, setDailyEnergy] = useState<DailyEnergySummaryPoint[]>([]);
  const [energyTotals, setEnergyTotals] = useState<EnergyTotals>(EMPTY_ENERGY_TOTALS);
  const [uptime, setUptime] = useState<UptimePayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadDailyEnergy() {
      try {
        const response = await fetch("/api/daily-energy?days=7", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) return;

        const payload = (await response.json()) as { points: DailyEnergySummaryPoint[] };
        setDailyEnergy(payload.points);
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error);
      }
    }

    void loadDailyEnergy();
    const intervalId = window.setInterval(loadDailyEnergy, 5 * 60 * 1000);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadEnergyTotals() {
      try {
        const response = await fetch("/api/energy-totals", {
          signal: controller.signal,
          cache: "no-store",
        });

        if (!response.ok) return;
        setEnergyTotals((await response.json()) as EnergyTotals);
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error);
      }
    }

    void loadEnergyTotals();
    const intervalId = window.setInterval(loadEnergyTotals, 5 * 60 * 1000);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadUptime() {
      try {
        const response = await fetch("/api/uptime", {
          signal: controller.signal,
          cache: "no-store",
        });

        const payload = (await response.json()) as UptimePayload;
        setUptime(payload);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setUptime({
            status: "error",
            message: "Unable to load UptimeRobot monitor data.",
            detail: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    }

    void loadUptime();

    const intervalId = window.setInterval(() => {
      void loadUptime();
    }, 60_000);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  const todayKey = useMemo(
    () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()),
    [],
  );
  const todaySummary = dailyEnergy.find((point) => point.day === todayKey);
  const liveTodaySolarWh = telemetry.hoymiles_daily_yield_wh ?? telemetry.hoymiles?.daily_yield_wh;
  const todaySolarYieldKwh =
    typeof liveTodaySolarWh === "number" ? liveTodaySolarWh / 1000 : todaySummary?.daily_solar_kwh ?? null;
  const todayConsumptionKwh = todaySummary?.daily_home_consumption_kwh ?? null;
  const todayNetGridKwh =
    todaySolarYieldKwh !== null && todayConsumptionKwh !== null
      ? todaySolarYieldKwh - todayConsumptionKwh
      : null;
  const bridgeLabel =
    bridgeState === "hardware_offline"
      ? "Bridge Disconnected"
      : bridgeState === "connected"
        ? "System Online"
        : "Mock Stream";

  return (
    <div className="space-y-4">
      <HoymilesFlowVisualizer
        solarProductionW={telemetry.solar_production_w}
        homeConsumptionW={telemetry.home_consumption_w}
        timestamp={telemetry.timestamp}
        todaySolarYieldKwh={todaySolarYieldKwh}
        todayConsumptionKwh={todayConsumptionKwh}
        todayNetGridKwh={todayNetGridKwh}
        energyTotals={energyTotals}
        connectionLabel={bridgeLabel}
      />

      {bridgeState === "hardware_offline" ? (
        <Card className="border-rose-500/30 bg-rose-500/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-rose-200">
              Bridge Offline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-rose-100/90">
              The relay has reported repeated Modbus failures. Displaying the last good reading
              until the bridge recovers.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-3">
        <Card className="border-white/10 bg-slate-950/80">
          <CardHeader className="pb-2">
            <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
              Bridge status
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-3">
            <WifiHigh className="h-8 w-8 text-sky-300" />
            <div>
              <div className="text-2xl font-semibold text-slate-50">Connected</div>
              <p className="text-sm text-slate-400">WebSocket relay is feeding the app.</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-white/10 bg-slate-950/80">
        <CardHeader>
          <CardTitle className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
            External uptime monitoring
          </CardTitle>
          <CardDescription>
            Native UptimeRobot monitor status rendered from the API, without leaving the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {uptime === null ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-slate-400">
              Loading live uptime data...
            </div>
          ) : uptime.status === "error" ? (
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-6 text-sm text-rose-100/90">
              <p className="font-medium">{uptime.message}</p>
              <p className="mt-2 text-rose-200/80">
                Add `UPTIMEROBOT_READ_ONLY_API_KEY` to the app environment to render native monitor stats.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {uptime.monitors.map((monitor) => (
                  <div
                    key={monitor.id}
                    className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${uptimeDotClass(
                              monitor.tone,
                            )}`}
                          />
                          <p className="truncate text-sm font-semibold text-slate-50">
                            {monitor.name}
                          </p>
                        </div>
                        <p className="mt-1 truncate text-xs text-slate-400">
                          {monitor.url ?? "No URL exposed by monitor"}
                        </p>
                      </div>
                      <Badge variant={uptimeBadgeVariant(monitor.tone)}>{monitor.status_label}</Badge>
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">24h</p>
                        <p className="mt-1 font-semibold text-slate-100">
                          {formatUptimePercent(monitor.uptime_24h)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">7d</p>
                        <p className="mt-1 font-semibold text-slate-100">
                          {formatUptimePercent(monitor.uptime_7d)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">30d</p>
                        <p className="mt-1 font-semibold text-slate-100">
                          {formatUptimePercent(monitor.uptime_30d)}
                        </p>
                      </div>
                    </div>

                    <p className="mt-3 text-xs text-slate-400">
                      Response time:{" "}
                      {typeof monitor.average_response_time_ms === "number"
                        ? `${Math.round(monitor.average_response_time_ms)} ms`
                        : "--"}
                    </p>
                  </div>
                ))}
              </div>

              <p className="text-sm text-slate-400">
                Public page:{" "}
                <a
                  href={UPTIME_STATUS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sky-300 underline decoration-sky-400/40 underline-offset-4 transition hover:text-sky-200"
                >
                  stats.uptimerobot.com/nS4Sm3g9El
                </a>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
